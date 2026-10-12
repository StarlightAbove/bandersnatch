#!/usr/bin/env python3
"""PulseFi-style Wi-Fi heartbeat sensing daemon for the Bandersnatch deck.

The kiosk UI polls GET http://127.0.0.1:8765/pulse while PULSE mode is on.
Sampling only runs while someone is polling, so it costs nothing otherwise.

Signal sources (--source auto tries csi, then falls back to rssi):

  csi   Per-subcarrier Channel State Information from nexmon_csi firmware,
        captured from the frames the router sends over the existing link.
        Needs root and the patched firmware (see setup notes in README.md).
        This is the source PulseFi is built on.

  rssi  Signal level of the existing connection from /proc/net/wireless.
        No setup, but it is one value per received frame, quantised to 1 dB,
        so a heartbeat can't be reliably recovered. Its strongest periodic
        component is reported as unverified and never as a lock.

Pipeline (after PulseFi's preprocessing; the paper's trained neural network
is not included, so expect lower accuracy than published):
  resample to a uniform rate → detrend → clip outliers (motion check)
  → keep the cardiac band 0.8–3 Hz (48–180 BPM) → pick the subcarriers with
  the strongest periodic component → combined spectral peak → BPM
  with a confidence score from the peak's prominence.

Requires Python 3.9+ and numpy (sudo apt install python3-numpy).
"""

import argparse
import json
import os
import signal
import socket
import struct
import subprocess
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

BAND_HZ = (0.8, 3.0)
WINDOW_S = 20.0
MIN_FILL = 0.6  # fraction of the window needed before the first estimate
TRACE_S = 6.0
TRACE_POINTS = 150
TOP_SUBCARRIERS = 8
LOCK_CONFIDENCE = 0.2
IDLE_STOP_S = 15.0
NO_SIGNAL_S = 3.0
CSI_PORT = 5500
CSI_PROBE_S = 5.0


def default_gateway(iface):
    try:
        with open('/proc/net/route') as f:
            for line in f.readlines()[1:]:
                parts = line.split()
                if parts[0] == iface and parts[1] == '00000000':
                    return socket.inet_ntoa(struct.pack('<I', int(parts[2], 16)))
    except OSError:
        pass
    return None


class Sampler:
    """Collects (timestamp, vector) samples on a background thread."""

    name = 'base'
    rate_hz = 20.0

    def __init__(self, iface):
        self.iface = iface
        self.buf = deque()
        self.lock = threading.Lock()
        self.stop_evt = threading.Event()
        self.thread = None
        self.pinger = None
        self.error = None
        self.started_at = 0.0

    @property
    def running(self):
        return self.thread is not None and self.thread.is_alive()

    def start(self):
        if self.running:
            return
        self.stop_evt.clear()
        self.error = None
        with self.lock:
            self.buf.clear()
        self.started_at = time.monotonic()
        self._start_traffic()
        self.thread = threading.Thread(target=self._run_safe, daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_evt.set()
        if self.pinger:
            self.pinger.terminate()
            self.pinger = None
        if self.thread:
            self.thread.join(timeout=2)
            self.thread = None

    def push(self, vec):
        now = time.monotonic()
        with self.lock:
            self.buf.append((now, vec))
            while self.buf and now - self.buf[0][0] > WINDOW_S + 2:
                self.buf.popleft()

    def snapshot(self):
        with self.lock:
            return list(self.buf)

    def _start_traffic(self):
        # Frames from the router are what get measured, so keep a steady
        # stream of replies coming. Sub-200 ms ping intervals need root.
        gw = default_gateway(self.iface)
        if not gw:
            return
        interval = '0.02' if os.geteuid() == 0 else '0.2'
        try:
            self.pinger = subprocess.Popen(
                ['ping', '-q', '-i', interval, '-I', self.iface, gw],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except OSError:
            self.pinger = None

    def _run_safe(self):
        try:
            self.run()
        except Exception as exc:  # surfaced to the UI rather than crashing
            self.error = str(exc)

    def run(self):
        raise NotImplementedError


class RssiSampler(Sampler):
    name = 'rssi'
    rate_hz = 20.0

    def read_level(self):
        with open('/proc/net/wireless') as f:
            for line in f:
                parts = line.split()
                if parts and parts[0] == f'{self.iface}:':
                    return float(parts[3].rstrip('.'))
        raise RuntimeError(f'{self.iface} not found in /proc/net/wireless')

    def run(self):
        period = 1.0 / self.rate_hz
        while not self.stop_evt.is_set():
            self.push(np.array([self.read_level()]))
            time.sleep(period)


def parse_udp_payload(frame, port):
    """Return the UDP payload of an Ethernet/IPv4 frame sent to `port`."""
    if len(frame) < 42 or frame[12:14] != b'\x08\x00':
        return None
    ihl = (frame[14] & 0x0F) * 4
    if frame[23] != 17:
        return None
    udp = 14 + ihl
    if struct.unpack('!H', frame[udp + 2:udp + 4])[0] != port:
        return None
    return frame[udp + 8:]


def parse_nexmon_csi(payload):
    """Decode a nexmon_csi UDP payload (bcm43455c0: int16 I/Q pairs).

    Header (18 bytes): magic 0x1111, rssi, frame control, source MAC,
    sequence, core/stream, chanspec, chip version.
    """
    if len(payload) < 18 + 64 * 4 or payload[:2] != b'\x11\x11':
        return None
    mac = payload[4:10].hex(':')
    iq = np.frombuffer(payload[18:18 + (len(payload) - 18) // 4 * 4], dtype='<i2')
    csi = iq[0::2].astype(np.float32) + 1j * iq[1::2].astype(np.float32)
    return mac, np.abs(csi)


class CsiSampler(Sampler):
    name = 'csi'
    rate_hz = 50.0

    def __init__(self, iface, mac=None):
        super().__init__(iface)
        self.mac = mac.lower() if mac else None

    def run(self):
        sock = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.ntohs(0x0003))
        sock.bind((self.iface, 0))
        sock.settimeout(0.5)
        width = None
        try:
            while not self.stop_evt.is_set():
                try:
                    frame = sock.recv(65535)
                except socket.timeout:
                    continue
                payload = parse_udp_payload(frame, CSI_PORT)
                if payload is None:
                    continue
                parsed = parse_nexmon_csi(payload)
                if parsed is None:
                    continue
                mac, amp = parsed
                if self.mac and mac != self.mac:
                    continue
                # Bandwidth changes alter the subcarrier count; restart the window.
                if width != amp.size:
                    width = amp.size
                    with self.lock:
                        self.buf.clear()
                self.push(amp)
        finally:
            sock.close()


def estimate(samples, fs):
    """Heart-rate estimate from (t, vector) samples. Returns a dict for the UI."""
    if len(samples) < 2:
        return {'status': 'calibrating', 'progress': 0.0}
    t = np.array([s[0] for s in samples])
    span = t[-1] - t[0]
    if span < WINDOW_S * MIN_FILL:
        return {'status': 'calibrating', 'progress': round(float(span / (WINDOW_S * MIN_FILL)), 2)}

    X = np.stack([s[1] for s in samples]).astype(np.float64)
    grid = np.arange(max(t[0], t[-1] - WINDOW_S), t[-1], 1.0 / fs)
    X = np.column_stack([np.interp(grid, t, X[:, j]) for j in range(X.shape[1])])
    n = len(grid)

    # Linear detrend of every column at once.
    A = np.column_stack([grid - grid.mean(), np.ones(n)])
    X = X - A @ np.linalg.lstsq(A, X, rcond=None)[0]

    # Robust clip; lots of clipping means the body (or deck) is moving.
    med = np.median(X, axis=0)
    mad = np.median(np.abs(X - med), axis=0) * 1.4826
    # Quantised sources (RSSI moves in whole dB) often have a MAD of zero;
    # floor it so ordinary 1 dB steps aren't all treated as outliers.
    mad = np.maximum(mad, 0.5 * X.std(axis=0)) + 1e-9
    outliers = np.abs(X - med) > 4 * mad
    X = np.clip(X, med - 4 * mad, med + 4 * mad)
    live = X.std(axis=0) > 1e-6
    if not live.any():
        return {'status': 'flat', 'message': 'signal is not varying'}
    if outliers[:, live].mean() > 0.05:
        return {'status': 'motion'}
    X = X[:, live]

    nfft = 1 << max(12, int(np.ceil(np.log2(n))))
    P = np.abs(np.fft.rfft(X * np.hanning(n)[:, None], nfft, axis=0)) ** 2
    freqs = np.fft.rfftfreq(nfft, 1.0 / fs)
    band = (freqs >= BAND_HZ[0]) & (freqs <= BAND_HZ[1])
    Pb = P[band]
    snr = Pb.max(axis=0) / (Pb.mean(axis=0) + 1e-12)
    top = np.argsort(snr)[-TOP_SUBCARRIERS:]
    combined = (Pb[:, top] / (Pb[:, top].sum(axis=0) + 1e-12)).mean(axis=1)

    i = int(np.argmax(combined))
    shift = 0.0
    if 0 < i < len(combined) - 1:
        a, b, c = combined[i - 1:i + 2]
        denom = a - 2 * b + c
        shift = 0.5 * (a - c) / denom if denom else 0.0
    df = freqs[1] - freqs[0]
    bpm = (freqs[band][i] + shift * df) * 60.0
    prominence = combined[i] / (combined.mean() + 1e-12)
    confidence = float(np.clip((prominence - 3.0) / 9.0, 0.0, 1.0))

    # Band-passed trace of the strongest subcarrier for the UI scope.
    best = X[:, top[-1]]
    F = np.fft.rfft(best)
    f_raw = np.fft.rfftfreq(n, 1.0 / fs)
    F[(f_raw < BAND_HZ[0]) | (f_raw > BAND_HZ[1])] = 0
    trace = np.fft.irfft(F, n)[-int(TRACE_S * fs):]
    trace = np.interp(np.linspace(0, len(trace) - 1, TRACE_POINTS), np.arange(len(trace)), trace)
    peak = np.abs(trace).max() or 1.0

    return {
        'status': 'tracking',
        'bpm': round(float(bpm), 1),
        'confidence': round(confidence, 2),
        'trace': [round(float(v), 3) for v in trace / peak],
        'channels': int(X.shape[1]),
    }


class Controller:
    def __init__(self, args):
        self.args = args
        self.sampler = None
        self.note = None
        self.last_poll = 0.0
        self.recent = deque(maxlen=5)
        self.cache = (0.0, None)
        self.lock = threading.Lock()
        threading.Thread(target=self._idle_watch, daemon=True).start()

    def shutdown(self):
        with self.lock:
            if self.sampler:
                self.sampler.stop()

    def _make(self, source):
        if source == 'csi':
            return CsiSampler(self.args.iface, self.args.mac)
        return RssiSampler(self.args.iface)

    def _ensure_running(self):
        if self.sampler and self.sampler.running:
            return
        source = self.args.source
        if source == 'auto':
            source = 'csi' if os.geteuid() == 0 else 'rssi'
            if source == 'rssi':
                self.note = 'not root: CSI capture unavailable'
        self.sampler = self._make(source)
        self.recent.clear()
        self.sampler.start()

    def _maybe_fallback(self):
        # Auto mode: if nexmon_csi isn't producing frames, use RSSI instead.
        s = self.sampler
        if (
            self.args.source == 'auto'
            and s.name == 'csi'
            and not s.snapshot()
            and (s.error or time.monotonic() - s.started_at > CSI_PROBE_S)
        ):
            s.stop()
            self.note = 'no CSI frames (nexmon_csi not active): using RSSI'
            self.sampler = self._make('rssi')
            self.sampler.start()

    def _idle_watch(self):
        while True:
            time.sleep(1)
            with self.lock:
                idle = time.monotonic() - self.last_poll > IDLE_STOP_S
                if idle and self.sampler and self.sampler.running:
                    self.sampler.stop()

    def poll(self):
        with self.lock:
            now = time.monotonic()
            self.last_poll = now
            if self.cache[1] is not None and now - self.cache[0] < 0.5:
                return self.cache[1]
            self._ensure_running()
            self._maybe_fallback()
            s = self.sampler
            samples = s.snapshot()

            if s.error:
                result = {'status': 'error', 'message': s.error}
            elif not samples and now - s.started_at > NO_SIGNAL_S:
                result = {'status': 'no-signal'}
            elif samples and now - samples[-1][0] > NO_SIGNAL_S:
                result = {'status': 'no-signal'}
            else:
                result = estimate(samples, s.rate_hz)

            if result['status'] == 'tracking':
                # Only CSI can lock. RSSI updates only when a frame arrives and
                # moves in whole dB, and pure noise through this pipeline still
                # yields prominent "peaks", so its result is shown as unverified.
                # Below the lock threshold CSI peaks are mostly noise too.
                result['locked'] = s.name == 'csi' and result['confidence'] >= LOCK_CONFIDENCE
                if result['locked']:
                    self.recent.append(result['bpm'])
                    result['bpm'] = round(float(np.median(self.recent)))
                else:
                    result['peak_bpm'] = round(result['bpm'])
                    result['bpm'] = None

            result['source'] = s.name
            result['iface'] = self.args.iface
            if self.note:
                result['note'] = self.note
            self.cache = (now, result)
            return result


def make_handler(controller):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, code, body):
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path.split('?')[0] == '/pulse':
                self._send(200, controller.poll())
            elif self.path == '/health':
                self._send(200, {'ok': True})
            else:
                self._send(404, {'error': 'not found'})

        def log_message(self, *args):
            pass

    return Handler


def _raise_interrupt(*_):
    raise KeyboardInterrupt


def main():
    p = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    p.add_argument('--iface', default='wlan0')
    p.add_argument('--source', choices=['auto', 'csi', 'rssi'], default='auto')
    p.add_argument('--mac', help='only use CSI from this transmitter (your router)')
    p.add_argument('--host', default='127.0.0.1')
    p.add_argument('--port', type=int, default=8765)
    args = p.parse_args()

    controller = Controller(args)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(controller))
    # Exit cleanly on SIGTERM too, so the ping helper doesn't outlive us.
    signal.signal(signal.SIGTERM, _raise_interrupt)
    print(f'pulsed: http://{args.host}:{args.port}/pulse ({args.source}, {args.iface})')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        controller.shutdown()


if __name__ == '__main__':
    main()
