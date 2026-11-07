import { createNotificationSound } from './notificationSound.js'

const ENABLED_KEY = 'livemeet.notifications.enabled'
const READ_KEY = 'livemeet.notifications.read'
const LIMIT = 100
const supported = (row) => row?.id != null && ['custom', 'group_start'].includes(row.kind)

export function createNotifications({
  db,
  storage,
  target = globalThis.window,
  NotificationAPI = globalThis.Notification,
  createSound = createNotificationSound,
} = {}) {
  const readStorage = (key, fallback) => {
    try { return JSON.parse((storage ?? globalThis.localStorage)?.getItem(key)) ?? fallback } catch { return fallback }
  }
  const writeStorage = (key, value) => {
    try { (storage ?? globalThis.localStorage)?.setItem(key, JSON.stringify(value)) } catch { /* Private/full storage is optional. */ }
  }
  const savedRead = readStorage(READ_KEY, [])
  const read = new Set(Array.isArray(savedRead) ? savedRead.map(String) : [])
  const received = new Set()
  const listeners = new Set()
  const browserNotifications = new Set()
  const permission = () => NotificationAPI?.permission || 'unsupported'
  let snapshot = {
    enabled: readStorage(ENABLED_KEY, true) !== false,
    items: [], loading: false, error: '', permission: permission(),
  }
  let sound = null
  let channel = null
  let generation = 0
  let request = 0
  let running = false
  let historyController = null
  let teardown = Promise.resolve()

  const update = (patch) => {
    snapshot = { ...snapshot, ...patch }
    listeners.forEach((listener) => listener())
  }
  const persistRead = () => writeStorage(READ_KEY, [...read].slice(-1000))
  const closeBrowserNotifications = () => {
    browserNotifications.forEach((notification) => notification.close())
    browserNotifications.clear()
  }
  const markRead = (id, value = true) => {
    if (value) read.add(String(id))
    else read.delete(String(id))
    persistRead()
    update({ items: snapshot.items.map((item) => String(item.id) === String(id) ? { ...item, read: value } : item) })
  }
  const merge = (rows) => {
    const items = new Map(snapshot.items.map((item) => [String(item.id), item]))
    rows.filter(supported).forEach((row) => {
      items.set(String(row.id), { ...row, read: read.has(String(row.id)) })
    })
    return [...items.values()].sort((a, b) =>
      String(b.created_at || '').localeCompare(String(a.created_at || '')) ||
      String(b.id).localeCompare(String(a.id), undefined, { numeric: true }),
    ).slice(0, LIMIT)
  }

  async function loadHistory() {
    if (!db || !running || !snapshot.enabled) return
    const epoch = generation
    const id = ++request
    historyController?.abort()
    historyController = new AbortController()
    update({ loading: true })
    try {
      const { data, error } = await db.from('notifications').select('id,kind,message,created_at,meeting_id,group_no')
        .in('kind', ['custom', 'group_start']).order('created_at', { ascending: false }).limit(LIMIT)
        .abortSignal(historyController.signal)
      if (epoch !== generation || id !== request || !running || !snapshot.enabled) return
      if (error) throw error
      // History/reconnect synchronization never calls sound or the browser API.
      update({ items: merge(data || []), loading: false, error: '' })
    } catch {
      if (epoch === generation && id === request && running && snapshot.enabled) {
        update({ loading: false, error: 'Unable to load notifications. Please try again.' })
      }
    }
  }

  function receive(row) {
    if (!supported(row)) return
    const id = String(row.id)
    if (received.has(id)) return
    // Retain IDs while OFF too, so a duplicate cannot alert after re-enabling.
    received.add(id)
    if (!snapshot.enabled) return
    update({ items: merge([row]) })
    sound?.enqueue()
    if (permission() !== 'granted') return
    try {
      const notification = new NotificationAPI('LiveMeet', {
        body: row.message, tag: `livemeet-${id}`, silent: true,
      })
      browserNotifications.add(notification)
      notification.onclose = () => browserNotifications.delete(notification)
      notification.onclick = () => {
        target?.focus()
        markRead(id)
        notification.close()
      }
    } catch { /* Unsupported platforms or denied OS permission do not affect in-app delivery. */ }
  }

  const refreshPermission = () => update({ permission: permission() })
  async function start() {
    running = true
    const epoch = ++generation
    // StrictMode can subscribe/unsubscribe/subscribe before this microtask.
    // Also wait for a previous channel's async removal before reusing its name.
    await teardown
    if (!running || epoch !== generation) return
    sound = createSound()
    sound.setEnabled(snapshot.enabled)
    target?.addEventListener('focus', refreshPermission)
    if (!db) return
    // A single subscription per mounted store, independent of renders/toggles.
    channel = db.channel('student-notifications')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications' }, (payload) => {
        if (running && epoch === generation) receive(payload.new)
      })
      .subscribe((status) => {
        if (!running || epoch !== generation) return
        if (status === 'SUBSCRIBED') void loadHistory()
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          update({ error: 'Live notifications are reconnecting.' })
        }
      })
    void loadHistory()
  }
  function stop() {
    running = false
    generation += 1
    request += 1
    historyController?.abort()
    target?.removeEventListener('focus', refreshPermission)
    sound?.dispose()
    sound = null
    closeBrowserNotifications()
    if (channel) {
      const retiring = channel
      teardown = Promise.resolve(db.removeChannel(retiring)).then((status) => {
        if (status !== 'ok') retiring.teardown?.()
      }).catch(() => retiring.teardown?.())
    }
    channel = null
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      if (listeners.size === 1) start()
      return () => {
        listeners.delete(listener)
        if (!listeners.size) stop()
      }
    },
    setEnabled(value, event) {
      const enabled = Boolean(value)
      writeStorage(ENABLED_KEY, enabled)
      request += 1
      historyController?.abort()
      sound?.setEnabled(enabled)
      update({ enabled, loading: false, error: '' })
      if (enabled) {
        if (event) sound?.unlock(event)
        void loadHistory()
      } else closeBrowserNotifications()
    },
    async requestPermission() {
      if (!snapshot.enabled || !NotificationAPI) return
      try {
        if (permission() === 'default') await NotificationAPI.requestPermission()
      } catch { /* Permission prompts may be unavailable in embedded/insecure contexts. */ }
      refreshPermission()
    },
    markRead,
    markAllRead() {
      snapshot.items.forEach((item) => read.add(String(item.id)))
      persistRead()
      update({ items: snapshot.items.map((item) => ({ ...item, read: true })) })
    },
    loadHistory,
  }
}
