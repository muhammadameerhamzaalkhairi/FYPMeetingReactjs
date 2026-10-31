import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@supabase/supabase-js'
import './App.css'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY
const db = url && key ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }) : null
const filters = ['All', 'Running', 'Upcoming', 'Done']
const safeNumber = (value) => Number.isFinite(Number(value)) ? Number(value) : 0
const dateLabel = (value) => value ? new Intl.DateTimeFormat('en', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(`${value}T00:00:00`)) : 'Today'
const clock = (seconds) => `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
const timeLabel = (value) => value ? new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' }).format(new Date(`2000-01-01T${value}`)) : 'Time TBD'

function App() {
  const [session, setSession] = useState(null)
  const [authLoading, setAuthLoading] = useState(Boolean(db))
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [authError, setAuthError] = useState('')
  const [signingIn, setSigningIn] = useState(false)
  const [meeting, setMeeting] = useState(null)
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('All')
  const [expanded, setExpanded] = useState(null)
  const [now, setNow] = useState(0)

  useEffect(() => {
    if (!db) return
    db.auth.getSession().then(({ data, error: sessionError }) => {
      if (sessionError) setAuthError(sessionError.message)
      setSession(data?.session || null)
      setAuthLoading(false)
    }).catch((e) => { setAuthError(e?.message || 'Could not restore your sign-in.'); setAuthLoading(false) })
    const { data: { subscription } } = db.auth.onAuthStateChange((_event, nextSession) => setSession(nextSession))
    return () => subscription.unsubscribe()
  }, [])

  const signIn = async (event) => {
    event.preventDefault()
    if (signingIn) return
    const cleanEmail = email.trim()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail) || !password) { setAuthError('Enter a valid email address and password.'); return }
    setSigningIn(true); setAuthError('')
    try {
      const { data, error: loginError } = await db.auth.signInWithPassword({ email: cleanEmail, password })
      if (loginError) throw loginError
      setSession(data.session)
    } catch (e) { setAuthError(e?.message || 'Sign in failed. Check your email and password.') }
    finally { setSigningIn(false) }
  }

  const refresh = useCallback(async (initial = false) => {
    if (!db) { setError('Dashboard is not configured. Add the Supabase URL and anon key to the local .env file.'); setLoading(false); return }
    if (!session) { setLoading(false); return }
    try {
      if (initial) setLoading(true)
      const { data: active, error: activeError } = await db.from('meetings_overview').select('*').in('status', ['running', 'paused']).limit(1).maybeSingle()
      if (activeError) throw activeError
      let schedule = []
      if (active) {
        const { data, error: rowsError } = await db.from('meeting_schedule').select('*').eq('meeting_id', active.id).order('group_no').order('id')
        if (rowsError) throw rowsError
        schedule = Array.isArray(data) ? data : []
      } else {
        const { data, error: nextError } = await db.from('meetings_overview').select('*').eq('status', 'upcoming').gte('meeting_date', new Date().toISOString().slice(0, 10)).order('meeting_date').limit(1).maybeSingle()
        if (nextError) throw nextError
        setMeeting({ nextMeeting: data })
      }
      if (active) setMeeting(active)
      else setMeeting(null)
      setRows(schedule)
      setError('')
    } catch (e) {
      setError(e?.message || 'Unable to load meeting data. Check your connection and database access.')
    } finally { setLoading(false) }
  }, [session])

  useEffect(() => {
    if (session) window.setTimeout(() => refresh(true), 0)
    const poll = window.setInterval(() => refresh(), 15000)
    const ticker = window.setInterval(() => setNow(Date.now()), 1000)
    const channel = db?.channel('readonly-meetings').on('postgres_changes', { event: '*', schema: 'public', table: 'meetings' }, () => refresh()).on('postgres_changes', { event: '*', schema: 'public', table: 'meeting_schedule' }, () => refresh()).subscribe()
    return () => { window.clearInterval(poll); window.clearInterval(ticker); if (channel) db.removeChannel(channel) }
  }, [refresh, session])

  const groups = useMemo(() => Object.values(rows.reduce((acc, row) => {
    const id = safeNumber(row.group_no)
    if (!acc[id]) acc[id] = { number: id, students: [], ...row }
    acc[id].students.push(row)
    return acc
  }, {})).sort((a, b) => a.number - b.number), [rows])
  const visible = groups.filter((group) => {
    const status = String(group.status || '').toLowerCase()
    const matchesFilter = filter === 'All' || status === filter.toLowerCase()
    const haystack = [group.number, group.project, group.supervisor, ...group.students.flatMap((s) => [s.student_name, s.reg_no, s.tech])].join(' ').toLowerCase()
    return matchesFilter && haystack.includes(query.trim().toLowerCase())
  }).sort((a, b) => ({ running: 0, upcoming: 1, done: 2, skipped: 3 }[a.status] ?? 4) - ({ running: 0, upcoming: 1, done: 2, skipped: 3 }[b.status] ?? 4) || a.number - b.number)
  const running = groups.find((group) => group.status === 'running')
  const nextMeeting = meeting?.nextMeeting
  const active = meeting && !nextMeeting ? meeting : null
  const elapsed = (group) => {
    if (!group?.started_at) return '—'
    const stop = active?.status === 'paused' && active.paused_at ? new Date(active.paused_at).getTime() : now
    return clock(Math.max(0, Math.floor((stop - new Date(group.started_at).getTime()) / 1000) - safeNumber(group.paused_seconds)))
  }

  if (authLoading) return <main className="auth-screen"><div className="auth-card"><div className="brand-mark">L</div><p>Restoring your secure session…</p></div></main>
  if (!db) return <main className="auth-screen"><div className="auth-card"><Brand /><h1>Setup required</h1><p className="auth-hint">Add your Supabase URL and anon key to the local <code>.env</code> file, then restart the development server.</p></div></main>
  if (!session) return <main className="auth-screen"><form className="auth-card" onSubmit={signIn}><Brand /><div className="auth-eyebrow">LIVEMEET WORKSPACE</div><h1>Welcome back</h1><p className="auth-hint">Sign in to view the live meeting dashboard.</p>{authError && <div className="auth-error" role="alert">{authError}</div>}<label>Email<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label><label>Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label><button className="sign-in" type="submit" disabled={signingIn}>{signingIn ? 'Signing in…' : 'Sign in'}</button><p className="secure-note">Your session is secured by Supabase authentication.</p></form></main>

  return <main className="app-shell">
    <aside className="rail"><a className="brand" href="#top" aria-label="LiveMeet home"><span className="brand-mark">L</span><span>live<span>meet</span></span></a><div className="rail-caption">WORKSPACE</div><div className="nav-item selected"><span className="nav-icon">◉</span><span>Live overview</span><i /></div><div className="rail-bottom"><div className="avatar">LM</div><div className="rail-user"><b>LiveMeet</b><small>Read-only view</small></div><span className="dots">···</span></div></aside>
    <section className="main-area" id="top"><header className="topbar"><div className="crumb">Workspace <span>/</span> <b>Live overview</b></div><div className="top-actions"><span className="connected"><i /> Live sync</span><button className="sign-out" onClick={async () => { await db.auth.signOut(); setMeeting(null); setRows([]) }}>Sign out</button><span className="top-avatar">LM</span></div></header>
      <div className="content"><div className="heading-row"><div><div className="eyebrow">{dateLabel(active?.meeting_date || nextMeeting?.meeting_date || new Date().toISOString().slice(0, 10))}</div><h1>What’s happening now?</h1><p className="subtitle">A live view of today’s project presentations.</p></div><div className="readonly"><span>◉</span> VIEW ONLY</div></div>
        {error && <div className="alert" role="alert"><span>!</span><div><b>We couldn’t load the latest data</b><p>{error}</p></div><button onClick={() => refresh(true)}>Retry</button></div>}
        <section className="stats" aria-label="Meeting summary"><Stat icon="✓" label="Completed" value={active ? safeNumber(active.groups_done) : 0} tone="mint" /><Stat icon="◷" label="Remaining" value={active ? safeNumber(active.groups_remaining) : 0} tone="peach" /><Stat icon="▦" label="Total groups" value={active ? safeNumber(active.groups_total) : 0} tone="lavender" /></section>
        <section className="live-panel"><div className="panel-top"><div className="panel-title"><span className="signal">◉</span><div><div className="section-kicker">CURRENT MEETING</div><h2>{loading ? 'Loading meeting…' : active?.title || 'No meeting is live right now'}</h2></div></div>{active && <span className={`status-pill ${active.status === 'paused' ? 'paused' : 'live'}`}><i />{active.status === 'paused' ? 'Paused' : 'Live'}</span>}</div>
          {loading ? <div className="panel-message">Checking for an active meeting…</div> : active ? <div className="live-body">{running ? <><div className="running-label"><span className="pulse" />IN PROGRESS <span>·</span> GROUP {running.number}</div><div className="running-project">{running.project || 'Untitled project'}</div><div className="live-meta"><span>♙ {running.supervisor || 'Supervisor not listed'}</span><span>◷ Started {running.started_at ? timeLabel(running.started_at.slice(11, 19)) : '—'}</span><span className="timer">{elapsed(running)}</span></div></> : <div className="no-group"><div className="no-group-icon">✓</div><div><b>{active.status === 'paused' ? 'Meeting is paused' : 'No group is running right now'}</b><p>{active.groups_remaining > 0 ? 'The next presentation will appear here when it begins.' : 'All groups in this meeting are complete.'}</p></div></div>}</div> : <div className="no-meeting"><div className="empty-icon">◷</div><div><h3>There’s no meeting today</h3><p>No meeting is currently live. {nextMeeting ? 'Here’s the next one on the schedule.' : 'The next scheduled meeting will appear here when it is added.'}</p>{nextMeeting && <div className="next-meeting"><span className="next-date">{new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(new Date(`${nextMeeting.meeting_date}T00:00:00`))}</span><span><b>{nextMeeting.title}</b><small>{dateLabel(nextMeeting.meeting_date)} · {safeNumber(nextMeeting.groups_total)} groups</small></span><span className="upcoming-pill">UPCOMING</span></div>}</div></div>}</section>
        <div className="list-heading"><div><h2>Meeting schedule</h2><p>{active ? `${groups.length} groups · updated automatically` : 'Group details will show when a meeting is live.'}</p></div><span className="group-count">{visible.length} GROUPS</span></div>
        <div className="toolbar"><label className="search"><span>⌕</span><input aria-label="Search groups" placeholder="Search projects, students, supervisor…" value={query} onChange={(e) => setQuery(e.target.value)} /><kbd>⌘ K</kbd></label><div className="filters" role="group" aria-label="Filter groups">{filters.map((item) => <button key={item} className={filter === item ? 'filter active' : 'filter'} onClick={() => setFilter(item)}>{item}</button>)}</div></div>
        <section className="group-list">{loading && !groups.length ? <div className="list-state">Loading groups…</div> : !active ? <div className="list-state">Groups will be listed here when a meeting is live.</div> : !visible.length ? <div className="list-state">No groups match your search or filter.</div> : visible.map((group) => <GroupCard key={group.number} group={group} expanded={expanded === group.number} onToggle={() => setExpanded(expanded === group.number ? null : group.number)} timer={group.status === 'running' ? elapsed(group) : group.status === 'done' && group.duration_sec != null ? clock(safeNumber(group.duration_sec)) : null} />)}</section>
        <footer><span>LiveMeet <i>·</i> Read-only dashboard</span><span>Data refreshes automatically <span className="refresh-dot" /></span></footer>
      </div>
    </section>
  </main>
}

function Stat({ icon, label, value, tone }) { return <div className="stat-card"><div className={`stat-icon ${tone}`}>{icon}</div><div className="stat-copy"><b>{value}</b><span>{label}</span></div><span className="stat-spark">↗</span></div> }
function Brand() { return <a className="brand auth-brand" href="#top"><span className="brand-mark">L</span><span>live<span>meet</span></span></a> }
function GroupCard({ group, expanded, onToggle, timer }) { return <article className={`group-card ${group.status === 'running' ? 'is-running' : ''}`}><button className="group-summary" onClick={onToggle} aria-expanded={expanded}><span className="group-number">{String(group.number).padStart(2, '0')}</span><span className="group-main"><b>{group.project || 'Untitled project'}</b><span>{group.supervisor || 'Supervisor not listed'} <i>·</i> {timeLabel(group.meeting_time)}</span></span><span className={`group-status ${group.status || 'upcoming'}`}><i />{group.status || 'Unknown'}</span>{timer && <span className="group-time">{timer}</span>}<span className={`chevron ${expanded ? 'open' : ''}`}>⌄</span></button>{expanded && <div className="student-list">{group.students.length ? group.students.map((student, i) => <div className="student" key={student.id || student.reg_no || i}><div className="student-avatar">{(student.student_name || '?').trim().slice(0, 1).toUpperCase()}</div><div className="student-name"><b>{student.student_name || 'Student not listed'}</b><small>{student.reg_no || 'Registration not listed'}</small></div><span className="tech-tag">{student.tech || 'Technology not listed'}</span></div>) : <div className="student-empty">No student details available.</div>}</div>}</article> }

export default App
