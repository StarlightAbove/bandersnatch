import { useEffect, useState } from 'react'
import {
  degreesToRadians,
  ecfToLookAngles,
  eciToEcf,
  gstime,
  json2satrec,
  propagate,
  radiansToDegrees,
  type OMMJsonObject,
  type SatRec,
} from 'satellite.js'

export type Observer = { lat: number; lon: number; source: string }
export type SkySat = { id: number; name: string; az: number; el: number; range: number }
export type SkyStatus = 'locating' | 'fetching' | 'tracking' | 'no-position' | 'no-orbits'

// CelesTrak is free and keyless, but asks clients not to refetch a group more
// than every couple of hours, so the catalogue is cached in localStorage.
const GROUPS = ['stations', 'visual', 'gps-ops', 'weather']
const CATALOG_KEY = 'sky.catalog'
const CATALOG_TTL = 6 * 60 * 60 * 1000
const OBSERVER_KEY = 'sky.observer'

const store = {
  get<T>(key: string): T | null {
    try {
      const raw = localStorage.getItem(key)
      return raw ? (JSON.parse(raw) as T) : null
    } catch {
      return null
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // storage full or unavailable; caching is best-effort
    }
  },
}

function browserPosition(): Promise<Observer> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('no geolocation'))
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, source: 'GPS' }),
      reject,
      { timeout: 8000, maximumAge: 10 * 60 * 1000 },
    )
  })
}

// Two keyless IP geolocation providers, so one being down or blocked isn't fatal.
async function ipwhoPosition(): Promise<Observer> {
  const res = await fetch('https://ipwho.is/?fields=success,latitude,longitude')
  const data = await res.json()
  if (!data.success) throw new Error('ip lookup failed')
  return { lat: data.latitude, lon: data.longitude, source: 'IP' }
}

async function geojsPosition(): Promise<Observer> {
  const res = await fetch('https://get.geojs.io/v1/ip/geo.json')
  const data = await res.json()
  const lat = Number(data.latitude)
  const lon = Number(data.longitude)
  if (Number.isNaN(lat) || Number.isNaN(lon)) throw new Error('ip lookup failed')
  return { lat, lon, source: 'IP' }
}

// Order: fixed coords from .env (VITE_LAT / VITE_LON) → browser geolocation
// (often unavailable in Chromium on a Pi) → IP lookup → last known fix.
async function locate(): Promise<Observer> {
  const lat = Number(import.meta.env.VITE_LAT)
  const lon = Number(import.meta.env.VITE_LON)
  if (import.meta.env.VITE_LAT && !Number.isNaN(lat) && !Number.isNaN(lon)) {
    return { lat, lon, source: 'FIXED' }
  }
  for (const attempt of [browserPosition, ipwhoPosition, geojsPosition]) {
    try {
      const obs = await attempt()
      store.set(OBSERVER_KEY, obs)
      return obs
    } catch {
      // fall through to the next source
    }
  }
  const cached = store.get<Observer>(OBSERVER_KEY)
  if (cached) return { ...cached, source: 'CACHED' }
  throw new Error('location unavailable')
}

async function loadCatalog(): Promise<OMMJsonObject[]> {
  const cached = store.get<{ at: number; data: OMMJsonObject[] }>(CATALOG_KEY)
  if (cached && Date.now() - cached.at < CATALOG_TTL) return cached.data
  try {
    const lists = await Promise.all(
      GROUPS.map((g) =>
        fetch(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${g}&FORMAT=json`).then((r) => {
          if (!r.ok) throw new Error(`celestrak ${r.status}`)
          return r.json() as Promise<OMMJsonObject[]>
        }),
      ),
    )
    const byId = new Map<number, OMMJsonObject>()
    for (const sat of lists.flat()) byId.set(Number(sat.NORAD_CAT_ID), sat)
    const data = [...byId.values()]
    store.set(CATALOG_KEY, { at: Date.now(), data })
    return data
  } catch (err) {
    // Offline: stale elements are still good enough for a rough sky plot.
    if (cached) return cached.data
    throw err
  }
}

function lookAngles(sats: { id: number; name: string; rec: SatRec }[], obs: Observer): SkySat[] {
  const now = new Date()
  const gmst = gstime(now)
  const site = {
    latitude: degreesToRadians(obs.lat),
    longitude: degreesToRadians(obs.lon),
    height: 0,
  }
  const out: SkySat[] = []
  for (const s of sats) {
    const pv = propagate(s.rec, now)
    if (!pv) continue
    const look = ecfToLookAngles(site, eciToEcf(pv.position, gmst))
    const el = radiansToDegrees(look.elevation)
    if (el <= 0) continue
    out.push({ id: s.id, name: s.name, az: radiansToDegrees(look.azimuth), el, range: look.rangeSat })
  }
  return out.sort((a, b) => b.el - a.el)
}

export function useSky(onEvent?: (msg: string) => void) {
  const [status, setStatus] = useState<SkyStatus>('locating')
  const [observer, setObserver] = useState<Observer | null>(null)
  const [sats, setSats] = useState<SkySat[]>([])
  const [catalogSize, setCatalogSize] = useState(0)

  useEffect(() => {
    let cancelled = false
    let tick: number | undefined
    let refresh: number | undefined

    const start = async () => {
      try {
        let obs: Observer
        try {
          obs = await locate()
        } catch {
          if (!cancelled) {
            setStatus('no-position')
            onEvent?.('SATELLITE TRACKING: NO POSITION FIX')
          }
          return
        }
        if (cancelled) return
        setObserver(obs)
        onEvent?.(`POSITION FIX ${obs.lat.toFixed(2)}, ${obs.lon.toFixed(2)} [${obs.source}]`)
        setStatus('fetching')

        let recs: { id: number; name: string; rec: SatRec }[] = []
        const load = async () => {
          const catalog = await loadCatalog()
          recs = catalog.map((o) => ({
            id: Number(o.NORAD_CAT_ID),
            name: String(o.OBJECT_NAME),
            rec: json2satrec(o),
          }))
          if (cancelled) return
          setCatalogSize(recs.length)
          onEvent?.(`ORBITAL CATALOGUE LOADED: ${recs.length} OBJECTS`)
        }
        await load()
        if (cancelled) return

        const update = () => setSats(lookAngles(recs, obs))
        update()
        setStatus('tracking')
        tick = window.setInterval(update, 2000)
        refresh = window.setInterval(() => load().catch(() => {}), CATALOG_TTL)
      } catch {
        if (!cancelled) {
          setStatus('no-orbits')
          onEvent?.('SATELLITE TRACKING: ORBITAL DATA UNAVAILABLE')
        }
      }
    }
    start()

    return () => {
      cancelled = true
      window.clearInterval(tick)
      window.clearInterval(refresh)
    }
  }, [onEvent])

  return { status, observer, sats, catalogSize }
}
