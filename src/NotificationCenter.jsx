import { useEffect, useRef, useState, useSyncExternalStore } from 'react'

export default function NotificationCenter({ store }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [open, setOpen] = useState(false)
  const container = useRef(null)
  const bell = useRef(null)
  const unread = state.enabled ? state.items.filter((item) => !item.read).length : 0

  useEffect(() => {
    if (!open) return
    const dismiss = (event) => {
      if (!container.current?.contains(event.target)) setOpen(false)
    }
    const onKey = (event) => {
      if (event.key === 'Escape') {
        setOpen(false)
        bell.current?.focus()
      }
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="notification-center" ref={container}>
      <button ref={bell} className="notification-bell" type="button"
        aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
        aria-expanded={open} aria-controls="notification-panel" onClick={() => setOpen(!open)}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
        </svg>
        {unread > 0 && <span className="notification-count" aria-hidden="true">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <section className="notification-panel" id="notification-panel" aria-label="Notifications">
          <div className="notification-heading"><b>Notifications</b>
            <button type="button" className="notification-link" onClick={() => { setOpen(false); bell.current?.focus() }}>Close</button>
          </div>
          <label className="notification-toggle">
            <span>Notifications {state.enabled ? 'ON' : 'OFF'}</span>
            <input type="checkbox" role="switch" checked={state.enabled} onChange={(event) => {
              store.setEnabled(event.target.checked, event.nativeEvent)
              if (event.target.checked) void store.requestPermission()
            }} />
          </label>
          {!state.enabled ? <p className="notification-note">Notifications are off.</p> : <>
            {state.permission === 'default' && <button type="button" className="notification-link" onClick={() => void store.requestPermission()}>Enable browser notifications</button>}
            {state.permission === 'denied' && <p className="notification-note">Browser notifications are blocked. You can allow them in your browser’s site settings.</p>}
            {state.permission === 'unsupported' && <p className="notification-note">Browser notifications are unavailable here.</p>}
            {unread > 0 && <button type="button" className="notification-link" onClick={store.markAllRead}>Mark all as read</button>}
            {state.error && <p className="notification-note" role="alert">{state.error} <button type="button" className="notification-link" onClick={store.loadHistory}>Retry</button></p>}
            {state.loading && !state.items.length && <p className="notification-note">Loading notifications…</p>}
            {!state.loading && !state.items.length && <p className="notification-note">No notifications yet.</p>}
            <ul className="notification-list">
              {state.items.map((item) => (
                <li key={item.id} className={item.read ? '' : 'unread'}>
                  <p>{item.message}</p>
                  {item.created_at && <time dateTime={item.created_at}>{new Date(item.created_at).toLocaleString()}</time>}
                  <button type="button" className="notification-link" onClick={() => store.markRead(item.id, !item.read)}>
                    Mark as {item.read ? 'unread' : 'read'}
                  </button>
                </li>
              ))}
            </ul>
          </>}
        </section>
      )}
    </div>
  )
}
