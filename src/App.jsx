import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@supabase/supabase-js'
import NotificationCenter from './NotificationCenter.jsx'
import { createNotifications } from './notifications.js'
import './App.css'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY
// Public, read-only client: anon key only, no stored session.
const db = url && key
  ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
  : null
const notifications = createNotifications({ db })

const FILTERS = ['All', 'Running', 'Upcoming', 'Paused', 'Done']
const RANK = { running: 0, paused: 1, upcoming: 2, done: 3, skipped: 4 }
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DEFAULT_SLOT_MS = 15 * 60000
const ADAPTIVE_MIN_SAMPLES = 2   // after this many done groups, the average is used
const ADAPTIVE_RECENT = 5        // average only the last N done groups
const ALLOW_EARLY = true         // false = expected time never goes before the scheduled time

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
const localToday = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const fmtDate = (iso) => {
  const d = iso ? new Date(`${iso}T00:00:00`) : new Date()
  return `${DAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`
}
const fmtTime = (t) => {
  if (!t) return 'Time TBD'
  const [h, m] = String(t).split(':').map(Number)
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`
}
const fmtClock = (ms) => {
  const d = new Date(ms)
  return `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() >= 12 ? 'PM' : 'AM'}`
}
const clock = (s) => {
  const t = Math.max(0, Math.floor(s))
  const p = (n) => String(n).padStart(2, '0')
  return `${p(Math.floor(t / 3600))}:${p(Math.floor(t / 60) % 60)}:${p(t % 60)}`
}
const total = (s) => {
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  return m < 60 ? `${m}min` : `${Math.floor(m / 60)}h ${m % 60}min`
}
// meeting_date 'YYYY-MM-DD' + meeting_time 'HH:MM:SS' -> local ms
const toMs = (d, t) => new Date(`${d}T${String(t).slice(0, 8)}`).getTime()

async function loadData() {
  // 1) Active meeting (running/paused), same rule as the Flutter Live screen.
  let { data: meeting, error } = await db.from('meetings_overview').select('*')
    .in('status', ['running', 'paused']).limit(1).maybeSingle()
  if (error) throw error
  // 2) Otherwise today's meeting (e.g. already finished).
  if (!meeting) {
    const r = await db.from('meetings_overview').select('*').eq('meeting_date', localToday())
      .order('id', { ascending: false }).limit(1).maybeSingle()
    if (r.error) throw r.error
    meeting = r.data
  }
  if (meeting) {
    const { data, error: e } = await db.from('meeting_schedule').select('*')
      .eq('meeting_id', meeting.id).order('group_no').order('id')
    if (e) throw e
    return { meeting, rows: data || [], next: null }
  }
  // 3) Nothing today: show next upcoming one.
  const r = await db.from('meetings_overview').select('*').eq('status', 'upcoming')
    .gte('meeting_date', localToday()).order('meeting_date').limit(1).maybeSingle()
  if (r.error) throw r.error
  return { meeting: null, rows: [], next: r.data }
}

function App() {
  const [data, setData] = useState({ meeting: null, rows: [], next: null })
  const [loading, setLoading] = useState(Boolean(db))
  const [error, setError] = useState(db ? '' : 'App is not configured. Add the Supabase URL and anon key to .env.')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('All')
  const [expanded, setExpanded] = useState(null)
  const [now, setNow] = useState(() => Date.now())
  const requestId = useRef(0)

  const refresh = useCallback(async () => {
    if (!db) return
    const id = ++requestId.current
    try {
      const next = await loadData()
      if (id !== requestId.current) return // a newer request superseded this one
      setData(next)
      setError('')
    } catch (e) {
      if (id !== requestId.current) return
      setError(e?.message || 'Unable to load meeting data.')
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!db) return
    let debounce = 0
    // Batch bursts of events (e.g. resume/end touch both tables) into one fetch.
    const scheduleRefresh = () => {
      window.clearTimeout(debounce)
      debounce = window.setTimeout(refresh, 250)
    }

    const initial = window.setTimeout(refresh, 0)
    const poll = window.setInterval(refresh, 15000) // fallback if Realtime is unavailable
    const tick = window.setInterval(() => setNow(Date.now()), 1000)

    // Realtime: INSERT, UPDATE and DELETE on both base tables (views can't be subscribed to).
    let channel
    // Defer setup so StrictMode's first cleanup runs before creating a channel.
    const connect = window.setTimeout(() => {
      channel = db.channel('public-viewer')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'meetings' }, scheduleRefresh)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'meeting_schedule' }, scheduleRefresh)
        .subscribe((status) => {
          // Fires on first connect and after every automatic rejoin: re-sync to catch missed events.
          if (status === 'SUBSCRIBED') scheduleRefresh()
        })
    }, 0)

    const onVisible = () => { if (document.visibilityState === 'visible') scheduleRefresh() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', scheduleRefresh)

    return () => {
      window.clearTimeout(initial); window.clearTimeout(debounce)
      window.clearTimeout(connect)
      window.clearInterval(poll); window.clearInterval(tick)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', scheduleRefresh)
      if (channel) db.removeChannel(channel)
    }
  }, [refresh])

  const { meeting, rows, next } = data

  const groups = useMemo(() => {
    const map = new Map()
    rows.forEach((r) => {
      const n = num(r.group_no)
      if (!map.has(n)) map.set(n, { number: n, head: r, students: [] })
      map.get(n).students.push(r)
    })
    return [...map.values()]
  }, [rows])

  // Expected start time for every upcoming group, recalculated every second.
  // number -> { expected: ms, delayMin: int }
  const expectedMap = useMemo(() => {
    const out = new Map()
    if (!meeting || (meeting.status !== 'running' && meeting.status !== 'paused')) return out
    // Use the day the meeting actually started (a meeting can be started on any date),
    // so scheduled times and "now" are on the same day.
    const date = meeting.started_at
      ? (() => {
          const d = new Date(meeting.started_at)
          return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        })()
      : meeting.meeting_date
    const ordered = [...groups]
      .filter((g) => g.head.meeting_time)
      .sort((a, b) => a.number - b.number)
    if (!ordered.length) return out

    const sched = ordered.map((g) => toMs(date, g.head.meeting_time))

    // Slot length of group i = gap to the next group's scheduled time.
    // Last group (or a bad gap) reuses the previous gap, else 15 min.
    const slotOf = (i) => {
      if (i + 1 < ordered.length && sched[i + 1] > sched[i]) return sched[i + 1] - sched[i]
      if (i > 0 && sched[i] > sched[i - 1]) return sched[i] - sched[i - 1]
      return DEFAULT_SLOT_MS
    }

    // Average of the most recent finished groups (pauses already excluded by the DB).
    const doneSecs = ordered
      .filter((g) => g.head.status === 'done' && num(g.head.duration_sec) > 0)
      .sort((a, b) => String(a.head.ended_at).localeCompare(String(b.head.ended_at)))
      .slice(-ADAPTIVE_RECENT)
      .map((g) => num(g.head.duration_sec))
    const avgMs = doneSecs.length >= ADAPTIVE_MIN_SAMPLES
      ? (doneSecs.reduce((a, b) => a + b, 0) / doneSecs.length) * 1000
      : null
    const slotFor = (i) => avgMs ?? slotOf(i)

    // While the whole meeting is paused the clock stands still.
    const clockNow = meeting.status === 'paused' && meeting.paused_at
      ? new Date(meeting.paused_at).getTime()
      : now

    // Time still needed by groups that are running/paused: slot minus time already used (never below 0).
    let cursor = clockNow
    ordered.forEach((g, i) => {
      const h = g.head
      let usedMs
      if (h.status === 'running' && h.started_at) {
        usedMs = Math.max(0, clockNow - new Date(h.started_at).getTime() - num(h.paused_seconds) * 1000)
      } else if (h.status === 'paused') {
        usedMs = num(h.duration_sec) * 1000
      } else {
        return
      }
      cursor += Math.max(0, slotFor(i) - usedMs)
    })

    // Chain the upcoming groups one after another.
    ordered.forEach((g, i) => {
      if (g.head.status !== 'upcoming') return
      const expected = ALLOW_EARLY ? cursor : Math.max(cursor, sched[i])
      out.set(g.number, { expected, delayMin: Math.round((expected - sched[i]) / 60000) })
      cursor = expected + slotFor(i)
    })
    return out
  }, [groups, meeting, now])

  const visible = useMemo(() => {
    const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
    return groups.filter((g) => {
      const status = String(g.head.status || '').toLowerCase()
      if (filter !== 'All' && status !== filter.toLowerCase()) return false
      const fields = [g.head.project, g.head.supervisor, ...g.students.flatMap((s) => [s.student_name, s.reg_no, s.tech])]
        .map((v) => String(v ?? '').toLowerCase())
      return words.every((w) => {
        if (/^\d+$/.test(w)) return w.length <= 3 ? Number(w) === g.number : fields.some((f) => f.includes(w))
        return [`group ${g.number}`, status, ...fields].some((f) => f.includes(w))
      })
    }).sort((a, b) => (RANK[a.head.status] ?? 5) - (RANK[b.head.status] ?? 5) || a.number - b.number)
  }, [groups, query, filter])

  const timerFor = (g) => {
    const h = g.head
    if (h.status === 'running' && h.started_at) {
      const end = meeting?.status === 'paused' && meeting.paused_at ? new Date(meeting.paused_at).getTime() : now
      return clock((end - new Date(h.started_at).getTime()) / 1000 - num(h.paused_seconds))
    }
    // A paused group shows its saved, frozen time.
    if (h.status === 'paused' && h.duration_sec != null) return clock(num(h.duration_sec))
    if (h.status === 'done' && h.duration_sec != null) return total(num(h.duration_sec))
    return null
  }

  const pill = meeting?.status === 'running' ? ['Live', 'live'] : meeting?.status === 'paused' ? ['Paused', 'paused'] : null

  return (
    <div className="stage">
      <main className="phone">
        <div className="page">
          <header className="brand-row">
            <img className="brand-logo" src="/logo.png" alt="Logo" />
            <div className="header-actions">
              <p className="date">{fmtDate(meeting?.meeting_date || next?.meeting_date)}</p>
              <NotificationCenter store={notifications} />
            </div>
          </header>
          <div className="title-row">
            <h1 className="title">What’s happening now?</h1>
            {pill ? <span className={`live-pill ${pill[1]}`}><i />{pill[0]}</span>
              : !loading && <span className="live-pill off"><i />Offline</span>}
          </div>

          <section className="stats" aria-label="Meeting summary">
            <Stat value={meeting ? num(meeting.groups_done) : 0} label="Done" />
            <Stat value={meeting ? num(meeting.groups_remaining) : 0} label="Remaining" />
            <Stat value={meeting ? num(meeting.groups_total) : 0} label="Total" />
          </section>

          <div className="sticky-bar">
            <input className="search" type="search" aria-label="Search" placeholder="Search..."
              value={query} onChange={(e) => setQuery(e.target.value)} />

            <div className="filters" role="group" aria-label="Filter groups">
              {FILTERS.map((f) => (
                <button key={f} className={`filter ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>{f}</button>
              ))}
            </div>
          </div>

          <section className="list">
            {loading ? <><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></>
              : error ? (
                <div className="state error" role="alert"><b>Couldn’t load meeting data</b>{error}
                  {db && <div><button className="btn" onClick={() => { setLoading(true); refresh() }}>Retry</button></div>}
                </div>)
              : !meeting ? (
                <div className="state"><b>No meeting is running</b>
                  Groups will appear here when a meeting goes live.
                  {next && <div className="next"><b>{next.title}</b>{fmtDate(next.meeting_date)} · {num(next.groups_total)} groups</div>}
                </div>)
              : !visible.length ? <div className="state">No groups match your search or filter.</div>
              : visible.map((g) => (
                <GroupCard key={g.number} group={g} timer={timerFor(g)}
                  expected={expectedMap.get(g.number)}
                  open={expanded === g.number}
                  onToggle={() => setExpanded(expanded === g.number ? null : g.number)} />
              ))}
          </section>

          <p className="foot">View only · updates automatically</p>
        </div>
      </main>
    </div>
  )
}

function Stat({ value, label }) {
  return <div className="stat"><b>{value}</b><span>{label}</span></div>
}

function GroupCard({ group, timer, expected, open, onToggle }) {
  const { head, students, number } = group
  const status = String(head.status || 'upcoming').toLowerCase()
  const running = status === 'running'
  return (
    <article className={`card ${running ? 'running' : ''}`}>
      <button className="summary" onClick={onToggle} aria-expanded={open}>
        <span className="num">{number}</span>
        <span className="info">
          <b>{head.project || 'Untitled project'}</b>
          <span className="chips">
            <span className={`chip status-${status}`}>{status[0].toUpperCase() + status.slice(1)}</span>
            <span>{head.supervisor || 'Supervisor not listed'} · {fmtTime(head.meeting_time)}</span>
            {timer && <span className="chip">{timer}</span>}
            {expected && (
              <span className="chip eta" title="Expected start time, updates live">
                 ~{fmtClock(expected.expected)}
              </span>
            )}
          </span>
        </span>
        <span className={`chevron ${open ? 'open' : ''}`} aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
            strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
      </button>
      {open && (
        <div className="students">
          {students.map((s, i) => (
            <div className="student" key={s.id ?? s.reg_no ?? i}>
              <span><b>{s.student_name || 'Student not listed'}</b><small>{s.reg_no || ''}</small></span>
              {s.tech && <span className="tech">{s.tech}</span>}
            </div>
          ))}
        </div>
      )}
    </article>
  )
}
export default App
