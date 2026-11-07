import test from 'node:test'
import assert from 'node:assert/strict'
import { createNotifications } from '../src/notifications.js'
import { createNotificationSound } from '../src/notificationSound.js'

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
const row = (id, kind = 'custom') => ({ id, kind, message: `Notice ${id}`, created_at: `2026-11-08T10:00:${String(id).padStart(2, '0')}Z` })
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function soundFixture() {
  const handlers = new Map()
  const audioHandlers = new Map()
  let plays = 0, pauses = 0, released = false
  let result = () => Promise.resolve()
  const audio = {
    currentTime: 0, volume: 1,
    play() { plays++; return result() },
    pause() { pauses++ },
    addEventListener: (type, listener) => audioHandlers.set(type, listener),
    removeEventListener: (type) => audioHandlers.delete(type),
    removeAttribute(name) { assert.equal(name, 'src'); released = true },
    load() {},
  }
  let instances = 0
  const sound = createNotificationSound({
    createAudio: () => { instances++; return audio },
    target: {
      addEventListener: (type, listener) => handlers.set(type, listener),
      removeEventListener: (type) => handlers.delete(type),
    },
  })
  sound.setEnabled(true)
  return {
    sound, audio, handlers, audioHandlers,
    get plays() { return plays }, get pauses() { return pauses },
    get released() { return released }, get instances() { return instances },
    result: (fn) => { result = fn },
    end: () => audioHandlers.get('ended')?.(),
    gesture: (event = {}) => handlers.get('pointerdown')?.({ type: 'pointerdown', isTrusted: true, ...event }),
  }
}

function storeFixture({ history = [], permission = 'granted', saved = {} } = {}) {
  const storage = new Map(Object.entries(saved))
  const channels = [], sounds = [], browser = [], signals = [], targetListeners = new Map()
  let loads = 0, removes = 0, prompts = 0, response = () => Promise.resolve({ data: history })
  let activeChannels = 0, maxChannels = 0
  const db = {
    from(table) {
      assert.equal(table, 'notifications')
      const query = {
        select() { return query }, in() { return query }, order() { return query }, limit() { return query },
        abortSignal(signal) { loads++; signals.push(signal); return response() },
      }
      return query
    },
    channel(name) {
      assert.equal(name, 'student-notifications')
      activeChannels++; maxChannels = Math.max(maxChannels, activeChannels)
      const channel = {
        on(type, filter, listener) {
          assert.equal(type, 'postgres_changes')
          assert.deepEqual(filter, { event: 'INSERT', schema: 'public', table: 'notifications' })
          channel.receive = listener
          return channel
        },
        subscribe(listener) { channel.status = listener; return channel },
      }
      channels.push(channel)
      return channel
    },
    async removeChannel() { removes++; await Promise.resolve(); activeChannels--; return 'ok' },
  }
  class BrowserNotification {
    static permission = permission
    static async requestPermission() { prompts++; this.permission = 'granted'; return 'granted' }
    constructor(title, options) { this.title = title; this.options = options; browser.push(this) }
    close() { this.closed = true; this.onclose?.() }
  }
  const store = createNotifications({
    db,
    storage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    target: { addEventListener: (type, fn) => targetListeners.set(type, fn), removeEventListener: (type) => targetListeners.delete(type), focus() {} },
    NotificationAPI: BrowserNotification,
    createSound: () => {
      const sound = { count: 0, enabled: false, disposed: false, setEnabled(value) { this.enabled = value }, enqueue() { this.count++ }, unlock() {}, dispose() { this.disposed = true } }
      sounds.push(sound)
      return sound
    },
  })
  return {
    store, channels, sounds, browser, signals, targetListeners, storage, BrowserNotification,
    receive: (value) => channels.at(-1).receive({ new: value }),
    response: (fn) => { response = fn },
    get loads() { return loads }, get removes() { return removes }, get prompts() { return prompts },
    get activeChannels() { return activeChannels }, get maxChannels() { return maxChannels },
  }
}

test('history and reconnect history stay silent; both live kinds alert exactly once', async () => {
  const f = storeFixture({ history: [row(1), row(2, 'group_start')] })
  const stop = f.store.subscribe(() => {})
  await flush()
  assert.equal(f.store.getSnapshot().items.length, 2)
  assert.equal(f.sounds[0].count, 0)
  assert.equal(f.browser.length, 0)
  for (const notice of [row(3), row(4, 'group_start')]) {
    f.receive(notice); f.receive({ ...notice })
  }
  assert.equal(f.sounds[0].count, 2)
  assert.equal(f.browser.length, 2)
  assert.ok(f.browser.every((item) => item.options.silent))
  f.channels[0].status('SUBSCRIBED')
  await flush()
  assert.equal(f.store.getSnapshot().items.length, 4)
  assert.equal(f.sounds[0].count, 2)
  stop()
})

test('OFF suppresses display additions, sound and browser notifications; ON resumes', async () => {
  const f = storeFixture()
  const stop = f.store.subscribe(() => {})
  await flush()
  f.receive(row(1))
  f.store.setEnabled(false)
  f.receive(row(2)); f.receive(row(3, 'group_start'))
  assert.equal(f.store.getSnapshot().items.length, 1)
  assert.equal(f.sounds[0].enabled, false)
  assert.equal(f.sounds[0].count, 1)
  assert.equal(f.browser.length, 1)
  assert.ok(f.browser[0].closed)
  f.store.setEnabled(true)
  f.receive(row(2)) // Duplicate of a disabled event must remain silent.
  f.receive(row(4, 'group_start'))
  await flush()
  assert.equal(f.sounds[0].count, 2)
  assert.equal(f.browser.length, 2)
  assert.equal(f.channels.length, 1)
  stop()
})

test('read/unread and preference persist locally without database writes', async () => {
  const f = storeFixture({ history: [row(1)] })
  const stop = f.store.subscribe(() => {})
  await flush()
  f.store.markRead(1)
  await f.store.loadHistory()
  assert.equal(f.store.getSnapshot().items[0].read, true)
  f.store.markRead(1, false)
  assert.equal(f.store.getSnapshot().items[0].read, false)
  f.store.markAllRead()
  assert.equal(f.store.getSnapshot().items[0].read, true)
  assert.deepEqual(JSON.parse(f.storage.get('livemeet.notifications.read')), ['1'])
  f.store.setEnabled(false)
  assert.equal(f.storage.get('livemeet.notifications.enabled'), 'false')
  stop()
})

test('browser permission is requested only explicitly; denied permission keeps sound working', async () => {
  const f = storeFixture({ permission: 'default' })
  const stop = f.store.subscribe(() => {})
  await flush()
  f.receive(row(1))
  assert.equal(f.prompts, 0)
  assert.equal(f.browser.length, 0)
  await f.store.requestPermission()
  assert.equal(f.prompts, 1)
  assert.equal(f.store.getSnapshot().permission, 'granted')
  f.BrowserNotification.permission = 'denied'
  f.receive(row(2, 'group_start'))
  assert.equal(f.sounds[0].count, 2)
  assert.equal(f.browser.length, 0)
  await f.store.requestPermission()
  assert.equal(f.prompts, 1)
  stop()
})

test('StrictMode replay, multiple listeners and re-subscriptions create one active channel', async () => {
  const f = storeFixture()
  f.store.subscribe(() => {})()
  const stop = f.store.subscribe(() => {})
  await flush()
  const stopOther = f.store.subscribe(() => {})
  assert.equal(f.channels.length, 1)
  f.receive(row(1))
  stopOther()
  stop()
  const stopAgain = f.store.subscribe(() => {})
  await flush()
  assert.equal(f.maxChannels, 1)
  assert.equal(f.channels.length, 2)
  f.channels[0].receive({ new: row(2) }) // Stale callback after cleanup.
  f.receive(row(1)) // Already alerted before remount.
  assert.equal(f.sounds[1].count, 0)
  f.receive(row(3))
  assert.equal(f.sounds[1].count, 1)
  stopAgain()
  await flush()
  assert.equal(f.activeChannels, 0)
  assert.equal(f.removes, 2)
  assert.ok(f.sounds.every((sound) => sound.disposed))
  assert.equal(f.targetListeners.size, 0)
  assert.ok(f.signals.every((signal) => signal.aborted))
})

test('late initial responses do not lose a live event or change state after OFF/unmount', async () => {
  const f = storeFixture()
  const pending = deferred()
  f.response(() => pending.promise)
  const stop = f.store.subscribe(() => {})
  await flush()
  f.receive(row(1))
  pending.resolve({ data: [row(1), row(2)] })
  await flush()
  assert.equal(f.sounds[0].count, 1)
  assert.equal(f.store.getSnapshot().items.length, 2)
  const late = deferred()
  f.response(() => late.promise)
  void f.store.loadHistory()
  f.store.setEnabled(false)
  const snapshot = f.store.getSnapshot()
  late.resolve({ data: [row(3)] })
  await flush()
  assert.equal(f.store.getSnapshot(), snapshot)
  stop()
})

test('unsupported kinds, missing IDs and duplicate rapid events never alert twice', async () => {
  const f = storeFixture()
  const stop = f.store.subscribe(() => {})
  await flush()
  f.receive({ kind: 'custom' }); f.receive(row(1, 'other'))
  for (let id = 1; id <= 40; id++) { f.receive(row(id)); f.receive(row(id)) }
  assert.equal(f.sounds[0].count, 40)
  assert.equal(f.store.getSnapshot().items.length, 40)
  assert.equal(f.channels.length, 1)
  stop()
})

test('history failures show a retryable error without affecting live delivery', async () => {
  const f = storeFixture()
  f.response(() => Promise.resolve({ error: new Error('private backend detail') }))
  const stop = f.store.subscribe(() => {})
  await flush()
  assert.match(f.store.getSnapshot().error, /Unable to load/)
  f.receive(row(1))
  assert.equal(f.sounds[0].count, 1)
  f.response(() => Promise.resolve({ data: [] }))
  await f.store.loadHistory()
  assert.equal(f.store.getSnapshot().error, '')
  stop()
})

test('one media element serializes a burst with no overlap or extra plays', async () => {
  const f = soundFixture()
  for (let i = 0; i < 10; i++) f.sound.enqueue()
  await flush()
  assert.equal(f.plays, 1)
  for (let i = 0; i < 10; i++) { f.end(); await flush() }
  assert.equal(f.plays, 10)
  assert.equal(f.instances, 1)
  f.sound.dispose()
})

test('autoplay rejection waits for trusted interaction then plays queued tune once', async () => {
  const f = soundFixture()
  f.result(() => Promise.reject(new DOMException('Gesture required', 'NotAllowedError')))
  f.sound.enqueue(); f.sound.enqueue()
  await flush()
  assert.equal(f.plays, 1)
  f.gesture({ isTrusted: false })
  assert.equal(f.plays, 1)
  f.result(() => Promise.resolve())
  f.gesture()
  await flush()
  assert.equal(f.plays, 2) // First call was rejected, only this one is audible.
  f.end()
  await flush()
  assert.equal(f.plays, 3)
  f.end(); f.gesture()
  assert.equal(f.plays, 3)
  f.sound.dispose()
})

test('first interaction primes silently without playing an old notification', async () => {
  const f = soundFixture()
  f.gesture()
  assert.equal(f.audio.volume, 0)
  await flush()
  assert.equal(f.audio.volume, 1)
  assert.equal(f.audio.currentTime, 0)
  assert.equal(f.plays, 1)
  f.gesture()
  assert.equal(f.plays, 1)
  f.sound.enqueue()
  assert.equal(f.plays, 2)
  f.sound.dispose()
})

test('OFF clears blocked/queued sounds and interrupts current playback', async () => {
  const f = soundFixture()
  f.sound.enqueue(); f.sound.enqueue()
  await flush()
  f.sound.setEnabled(false)
  f.sound.enqueue(); f.gesture(); f.end()
  assert.equal(f.plays, 1)
  assert.ok(f.pauses > 0)
  f.sound.setEnabled(true)
  f.sound.enqueue()
  assert.equal(f.plays, 2)
  f.sound.dispose()
})

test('late play rejection after OFF cannot resurrect old queued sounds', async () => {
  const f = soundFixture()
  const pending = deferred()
  f.result(() => pending.promise)
  f.sound.enqueue()
  f.sound.setEnabled(false)
  pending.reject(new DOMException('blocked', 'NotAllowedError'))
  await flush()
  f.sound.setEnabled(true)
  f.result(() => Promise.resolve())
  f.gesture()
  await flush()
  assert.equal(f.plays, 2) // Silent primer only; discarded notification stays discarded.
  f.sound.dispose()
})

test('media errors are handled and cleanup releases audio and gesture listeners', async () => {
  const f = soundFixture()
  f.result(() => Promise.reject(new DOMException('Unsupported', 'NotSupportedError')))
  f.sound.enqueue(); f.sound.enqueue()
  await flush()
  assert.equal(f.plays, 2)
  f.sound.dispose(); f.sound.dispose()
  assert.equal(f.handlers.size, 0)
  assert.equal(f.audioHandlers.size, 0)
  assert.ok(f.released)
  f.sound.enqueue()
  assert.equal(f.plays, 2)
})

test('synchronous autoplay rejection also preserves the notification until interaction', async () => {
  const f = soundFixture()
  f.result(() => { throw new DOMException('Gesture required', 'NotAllowedError') })
  f.sound.enqueue()
  assert.equal(f.plays, 1)
  f.result(() => Promise.resolve())
  f.gesture()
  await flush()
  assert.equal(f.plays, 2)
  f.end()
  assert.equal(f.plays, 2)
  f.sound.dispose()
})
