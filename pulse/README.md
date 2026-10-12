# pulsed: PulseFi heartbeat daemon

Feeds the **PULSE** mode of the Status screen's scanner (the ORBIT / PULSE switch).
The UI polls `http://127.0.0.1:8765/pulse` (override with `VITE_PULSE_URL`) and the
daemon only samples while it is being polled.

## Install on the Pi

```sh
sudo apt install python3-numpy
sudo cp pulse/pulsed.service /etc/systemd/system/   # edit the ExecStart path first
sudo systemctl enable --now pulsed
curl -s localhost:8765/pulse                         # quick check
```

## Signal sources

| Source | Setup | What you get |
| --- | --- | --- |
| `csi` | nexmon_csi firmware, root | Per-subcarrier CSI. Can lock onto a heart rate. |
| `rssi` | none | Signal level of the existing connection. Shown as an **unverified** peak, never a lock. |

`--source auto` (the default) uses CSI when running as root and frames are arriving,
otherwise RSSI. The UI shows which one is active.

RSSI is the fallback because it's all the existing connection exposes without
patched firmware. The driver only updates it when a frame arrives, in whole dB steps,
and on test hardware pure noise through the pipeline still produced peaks with
confidence up to 0.68. Any number it shows can't be trusted as a heart rate.

## Enabling CSI (nexmon_csi)

CSI capture needs [nexmon_csi](https://github.com/seemoo-lab/nexmon_csi) firmware
for the Pi's Broadcom/Cypress 43455 Wi-Fi chip. nexmon_csi officially targets the
Pi 3B+/4. The Pi 5 uses the same chip, but check the project's issues for current
Pi 5 kernel support before relying on it.

Once installed, point collection at your router on its current channel:

```sh
iw dev wlan0 info                      # current channel and width
iw dev wlan0 link                      # router MAC ("Connected to ...")
mcp -C 1 -N 1 -c <channel>/<width> -m <router-mac>   # prints a parameter string
sudo nexutil -Iwlan0 -s500 -b -l34 -v<parameter-string>
sudo iw dev wlan0 interface add mon0 type monitor && sudo ip link set mon0 up
```

Then restart the daemon with `--mac <router-mac>` so only that transmitter is used.
CSI collection can disrupt normal traffic on the same chip, so a USB Wi-Fi adapter or
Ethernet for the deck's own uplink is the safer setup.

## Accuracy

This is the PulseFi signal chain (cardiac band-pass, subcarrier selection, spectral peak),
not the paper's trained model, which isn't included. Expect it to need a still subject
fairly close to the line between the deck and the router. Not a medical device.
