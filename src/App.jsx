import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@supabase/supabase-js'
import './App.css'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY
// Public, read-only client: anon key only, no stored session.
const db = url && key
  ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
  : null

const FILTERS = ['All', 'Running', 'Upcoming', 'Done']
const RANK = { running: 0, upcoming: 1, done: 2, skipped: 3 }
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

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
    const channel = db.channel('public-viewer')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'meetings' }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'meeting_schedule' }, scheduleRefresh)
      .subscribe((status) => {
        // Fires on first connect and after every automatic rejoin: re-sync to catch missed events.
        if (status === 'SUBSCRIBED') scheduleRefresh()
      })

    const onVisible = () => { if (document.visibilityState === 'visible') scheduleRefresh() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', scheduleRefresh)

    return () => {
      window.clearTimeout(initial); window.clearTimeout(debounce)
      window.clearInterval(poll); window.clearInterval(tick)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', scheduleRefresh)
      db.removeChannel(channel)
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
    }).sort((a, b) => (RANK[a.head.status] ?? 4) - (RANK[b.head.status] ?? 4) || a.number - b.number)
  }, [groups, query, filter])

  const timerFor = (g) => {
    const h = g.head
    if (h.status === 'running' && h.started_at) {
      const end = meeting?.status === 'paused' && meeting.paused_at ? new Date(meeting.paused_at).getTime() : now
      return clock((end - new Date(h.started_at).getTime()) / 1000 - num(h.paused_seconds))
    }
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
            <p className="date">{fmtDate(meeting?.meeting_date || next?.meeting_date)}</p>
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

function GroupCard({ group, timer, open, onToggle }) {
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
            <span className="chip">{status[0].toUpperCase() + status.slice(1)}</span>
            <span>{head.supervisor || 'Supervisor not listed'} · {fmtTime(head.meeting_time)}</span>
            {timer && <span className="chip">{timer}</span>}
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