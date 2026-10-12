import { useEffect, useState } from 'react'

// Served by pulse/pulsed.py on the Pi. Override with VITE_PULSE_URL in .env.
const PULSE_URL = import.meta.env.VITE_PULSE_URL || 'http://127.0.0.1:8765/pulse'
const POLL_MS = 1000

export type PulseStatus =
  | 'connecting'
  | 'offline'
  | 'calibrating'
  | 'tracking'
  | 'motion'
  | 'flat'
  | 'no-signal'
  | 'error'

export type PulseReading = {
  status: PulseStatus
  source?: 'csi' | 'rssi'
  bpm?: number | null
  locked?: boolean
  peak_bpm?: number
  confidence?: number
  progress?: number
  trace?: number[]
  channels?: number
  note?: string
  message?: string
}

// Polls the daemon only while `active`, so it stops sampling when unused.
export function usePulse(active: boolean) {
  const [reading, setReading] = useState<PulseReading>({ status: 'connecting' })

  useEffect(() => {
    if (!active) return
    let cancelled = false
    let timer: number | undefined

    const poll = async () => {
      try {
        const res = await fetch(PULSE_URL, { cache: 'no-store' })
        const data = (await res.json()) as PulseReading
        if (!cancelled) setReading(data)
      } catch {
        if (!cancelled) setReading({ status: 'offline' })
      }
      if (!cancelled) timer = window.setTimeout(poll, POLL_MS)
    }
    poll()

    return () => {
      cancelled = true
      window.clearTimeout(timer)
      setReading({ status: 'connecting' })
    }
  }, [active])

  return reading
}
