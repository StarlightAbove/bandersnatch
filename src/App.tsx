import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'

type Tab = 'status' | 'systems' | 'comms' | 'logs' | 'control'
type Level = 'info' | 'warn' | 'alert'
type LogEntry = { id: number; time: string; msg: string; level: Level }

const TABS: { id: Tab; code: string; label: string }[] = [
  { id: 'status', code: '01', label: 'STATUS' },
  { id: 'systems', code: '02', label: 'SYSTEMS' },
  { id: 'comms', code: '03', label: 'COMMS' },
  { id: 'logs', code: '04', label: 'LOGS' },
  { id: 'control', code: '05', label: 'CONTROL' },
]

const BOOT_LINES = [
  'SEEGSON BIOS v4.11 ........................ OK',
  'MEMORY CHECK 8192MB ....................... OK',
  'MOUNTING /SEVASTOPOL/CORE ................. OK',
  'APOLLO LINK HANDSHAKE ..................... OK',
  'LOADING SEVASTOLINK INTERFACE .............',
  'WELCOME, OPERATOR.',
]

const MESSAGES = [
  {
    from: 'M. WAITS',
    subject: 'SECURITY NOTICE',
    body: 'All personnel are reminded that the Spire is off-limits after shift change. Marshal patrols have been doubled. Report any unauthorised access through this terminal.',
  },
  {
    from: 'SEEGSON IT',
    subject: 'SCHEDULED MAINTENANCE',
    body: 'Sevastolink services will be intermittent during the next maintenance cycle. Save all work locally. Do not power-cycle terminals during firmware transfer.',
  },
  {
    from: 'APOLLO',
    subject: 'ENVIRONMENTAL REPORT',
    body: 'Atmospheric processors nominal. Minor pressure variance detected in vent junction 4-C. Maintenance crew dispatched. No action required by operator.',
  },
]

const SYSTEMS = [
  { name: 'LIFE SUPPORT', state: 'NOMINAL', level: 'info' },
  { name: 'CORE PROCESSOR', state: 'NOMINAL', level: 'info' },
  { name: 'UPLINK / WLAN', state: 'ONLINE', level: 'info' },
  { name: 'BLUETOOTH', state: 'STANDBY', level: 'warn' },
  { name: 'POWER CELL', state: 'NOMINAL', level: 'info' },
  { name: 'STORAGE ARRAY', state: 'NOMINAL', level: 'info' },
  { name: 'GPIO BUS', state: 'IDLE', level: 'warn' },
  { name: 'VENT JUNCTION 4-C', state: 'FAULT', level: 'alert' },
] as const

const TOGGLES = ['LIGHTS', 'FANS', 'RELAY A', 'RELAY B', 'BEACON', 'AUX PWR'] as const

const pad = (n: number) => n.toString().padStart(2, '0')
const stamp = (d = new Date()) =>
  `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`

function useClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])
  return now
}

// Simulated telemetry. Replace with a fetch to a local service on the Pi
// (e.g. a small endpoint reading /sys/class/thermal) for real values.
function useTelemetry() {
  const [t, setT] = useState({ cpu: 22, mem: 41, temp: 48, net: 63 })
  useEffect(() => {
    const jitter = (v: number, span: number, min: number, max: number) =>
      Math.min(max, Math.max(min, v + (Math.random() - 0.5) * span))
    const id = setInterval(() => {
      setT((p) => ({
        cpu: jitter(p.cpu, 14, 3, 98),
        mem: jitter(p.mem, 4, 20, 90),
        temp: jitter(p.temp, 3, 38, 82),
        net: jitter(p.net, 20, 0, 100),
      }))
    }, 1500)
    return () => clearInterval(id)
  }, [])
  return t
}

function Boot({ onDone }: { onDone: () => void }) {
  const [shown, setShown] = useState(0)
  useEffect(() => {
    if (shown >= BOOT_LINES.length) {
      const t = setTimeout(onDone, 700)
      return () => clearTimeout(t)
    }
    const t = setTimeout(() => setShown((s) => s + 1), 260)
    return () => clearTimeout(t)
  }, [shown, onDone])

  return (
    <div className="boot" onPointerDown={onDone}>
      <div className="boot-logo">
        <span className="glyph">S</span>
        <div>
          <div className="boot-title">SEVASTOLINK</div>
          <div className="boot-sub">SEEGSON CORPORATION · SEVASTOPOL STATION</div>
        </div>
      </div>
      <pre className="boot-text">
        {BOOT_LINES.slice(0, shown).join('\n')}
        <span className="cursor">█</span>
      </pre>
      <div className="boot-hint">TOUCH TO SKIP</div>
    </div>
  )
}

function Meter({ label, value, unit = '%', warn = 75 }: {
  label: string
  value: number
  unit?: string
  warn?: number
}) {
  const hot = value >= warn
  return (
    <div className={`meter ${hot ? 'hot' : ''}`}>
      <div className="meter-head">
        <span>{label}</span>
        <span>
          {value.toFixed(0)}
          {unit}
        </span>
      </div>
      <div className="meter-track">
        {Array.from({ length: 20 }, (_, i) => (
          <i key={i} className={i < Math.round(value / 5) ? 'on' : ''} />
        ))}
      </div>
    </div>
  )
}

function Tracker() {
  const [blips, setBlips] = useState<{ x: number; y: number; id: number }[]>([])
  useEffect(() => {
    const id = setInterval(() => {
      setBlips(
        Math.random() < 0.6
          ? [{ x: 20 + Math.random() * 60, y: 15 + Math.random() * 45, id: Date.now() }]
          : [],
      )
    }, 2400)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="tracker">
      <div className="tracker-sweep" />
      {blips.map((b) => (
        <span key={b.id} className="blip" style={{ left: `${b.x}%`, top: `${b.y}%` }} />
      ))}
      <div className="tracker-label">MOTION · {blips.length ? `${Math.hypot(blips[0].x - 50, 100 - blips[0].y).toFixed(0)}M` : '--'}</div>
    </div>
  )
}

function HoldButton({ label, onFire }: { label: string; onFire: () => void }) {
  const [holding, setHolding] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  const start = () => {
    setHolding(true)
    timer.current = window.setTimeout(() => {
      setHolding(false)
      onFire()
    }, 1500)
  }
  const cancel = () => {
    setHolding(false)
    window.clearTimeout(timer.current)
  }

  return (
    <button
      type="button"
      className={`btn hold ${holding ? 'holding' : ''}`}
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
    >
      <span className="hold-fill" />
      <span className="hold-label">{label}</span>
      <span className="hold-hint">HOLD</span>
    </button>
  )
}

function App() {
  const [booted, setBooted] = useState(false)
  const [tab, setTab] = useState<Tab>('status')
  const [msg, setMsg] = useState(0)
  const [toggles, setToggles] = useState<Record<string, boolean>>({ LIGHTS: true, FANS: true })
  const [alert, setAlert] = useState(false)
  const [log, setLog] = useState<LogEntry[]>(() => [
    { id: 0, time: stamp(), msg: 'SEVASTOLINK SESSION OPENED', level: 'info' },
  ])
  const now = useClock()
  const tel = useTelemetry()
  const logRef = useRef<HTMLDivElement>(null)

  const addLog = useCallback((m: string, level: Level = 'info') => {
    setLog((l) => [...l.slice(-60), { id: Date.now() + Math.random(), time: stamp(), msg: m, level }])
  }, [])

  // Hook point for real hardware: send actions to a local backend here.
  const action = (name: string) => addLog(`CMD > ${name}`)

  const flip = (name: string) => {
    const next = !toggles[name]
    setToggles({ ...toggles, [name]: next })
    addLog(`${name} ${next ? 'ENGAGED' : 'DISENGAGED'}`)
  }

  const finishBoot = useCallback(() => setBooted(true), [])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [log, tab])

  useEffect(() => {
    const block = (e: Event) => e.preventDefault()
    window.addEventListener('contextmenu', block)
    return () => window.removeEventListener('contextmenu', block)
  }, [])

  if (!booted) return <Boot onDone={finishBoot} />

  const date = `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()}`

  return (
    <div className={`deck ${alert ? 'alerting' : ''}`}>
      <header className="topbar">
        <div className="brand">
          <span className="glyph">S</span>
          <div>
            <div className="brand-name">SEVASTOLINK</div>
            <div className="brand-sub">SEVASTOPOL · TERMINAL BX-01</div>
          </div>
        </div>
        <div className={`banner ${alert ? 'on' : ''}`}>
          {alert ? '▲ EMERGENCY LOCKDOWN ▲' : 'ALL SYSTEMS NOMINAL'}
        </div>
        <div className="clock">
          <div className="clock-time">{stamp(now)}</div>
          <div className="clock-date">{date}</div>
        </div>
      </header>

      <nav className="nav">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`btn nav-btn ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            <span className="nav-code">{t.code}</span>
            {t.label}
          </button>
        ))}
      </nav>

      <main className="panel">
        <div className="panel-title">
          <span>// {TABS.find((t) => t.id === tab)?.label}</span>
          <span className="dim">SEEGSON</span>
        </div>

        {tab === 'status' && (
          <div className="status">
            <div className="meters">
              <Meter label="CPU LOAD" value={tel.cpu} />
              <Meter label="MEMORY" value={tel.mem} />
              <Meter label="CORE TEMP" value={tel.temp} unit="°C" warn={70} />
              <Meter label="UPLINK" value={tel.net} />
            </div>
            <Tracker />
          </div>
        )}

        {tab === 'systems' && (
          <div className="systems">
            {SYSTEMS.map((s) => (
              <button
                key={s.name}
                type="button"
                className={`btn sys ${s.level}`}
                onClick={() => addLog(`DIAGNOSTIC: ${s.name} — ${s.state}`, s.level)}
              >
                <span>{s.name}</span>
                <span className="sys-state">{s.state}</span>
              </button>
            ))}
          </div>
        )}

        {tab === 'comms' && (
          <div className="comms">
            <div className="comms-list">
              {MESSAGES.map((m, i) => (
                <button
                  key={m.subject}
                  type="button"
                  className={`btn comms-item ${msg === i ? 'active' : ''}`}
                  onClick={() => setMsg(i)}
                >
                  <span className="dim">{m.from}</span>
                  {m.subject}
                </button>
              ))}
            </div>
            <div className="comms-body">
              <div className="dim">FROM: {MESSAGES[msg].from}</div>
              <div className="comms-subject">{MESSAGES[msg].subject}</div>
              <p>{MESSAGES[msg].body}</p>
            </div>
          </div>
        )}

        {tab === 'logs' && (
          <div className="log" ref={logRef}>
            {log.map((l) => (
              <div key={l.id} className={`log-line ${l.level}`}>
                <span className="dim">[{l.time}]</span> {l.msg}
              </div>
            ))}
            <span className="cursor">█</span>
          </div>
        )}

        {tab === 'control' && (
          <div className="control">
            {TOGGLES.map((name) => (
              <button
                key={name}
                type="button"
                className={`btn toggle ${toggles[name] ? 'on' : ''}`}
                onClick={() => flip(name)}
              >
                <span className="led" />
                <span>{name}</span>
                <span className="toggle-state">{toggles[name] ? 'ON' : 'OFF'}</span>
              </button>
            ))}
          </div>
        )}
      </main>

      <aside className="rail">
        <div className="rail-title">QUICK ACCESS</div>
        <button type="button" className="btn" onClick={() => action('SCAN NETWORK')}>SCAN</button>
        <button type="button" className="btn" onClick={() => action('SYNC DATA')}>SYNC</button>
        <button type="button" className="btn" onClick={() => action('OPEN SHELL')}>SHELL</button>
        <button type="button" className="btn" onClick={() => action('CAPTURE')}>CAPTURE</button>
        <div className="rail-spacer" />
        <HoldButton
          label={alert ? 'RELEASE' : 'LOCKDOWN'}
          onFire={() => {
            addLog(alert ? 'LOCKDOWN RELEASED' : 'EMERGENCY LOCKDOWN INITIATED', alert ? 'info' : 'alert')
            setAlert(!alert)
          }}
        />
      </aside>

      <footer className="footer">
        <span className="pulse" /> LINK ACTIVE
        <div className="ticker">
          <span>
            {log[log.length - 1]?.msg} · SEEGSON — SYNTHETICS YOU CAN TRUST · REPORT ALL
            MAINTENANCE ISSUES TO OPERATIONS · APOLLO IS MONITORING ·
          </span>
        </div>
        <span className="dim">v0.1</span>
      </footer>
    </div>
  )
}

export default App
