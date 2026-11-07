// One reusable media element; only live INSERT events should call enqueue().
export function createNotificationSound({
  createAudio = () => new Audio(`${import.meta.env.BASE_URL}sounds/notification.mp3`),
  target = document,
} = {}) {
  const audio = createAudio()
  audio.preload = 'auto'
  let enabled = false
  let disposed = false
  let pending = 0
  let active = null
  let blocked = false
  let unlocked = false

  const reset = () => {
    audio.pause()
    audio.currentTime = 0
    audio.volume = 1
  }

  const finish = () => {
    if (!active) return
    active = null
    reset()
    drain()
  }

  const start = (prime = false) => {
    const attempt = { prime }
    active = attempt
    audio.volume = prime ? 0 : 1
    const failed = (error) => {
      if (active !== attempt || disposed) return
      active = null
      reset()
      if (error?.name === 'NotAllowedError') {
        blocked = true
        if (!prime) pending += 1
      } else {
        // Missing/unsupported media must never break notification delivery.
        queueMicrotask(drain)
      }
    }
    // Call synchronously inside the trusted gesture, before any await.
    try {
      Promise.resolve(audio.play()).then(() => {
        if (active !== attempt || disposed) return
        unlocked = true
        blocked = false
        if (prime) finish()
      }).catch(failed)
    } catch (error) {
      failed(error)
    }
  }

  function drain() {
    if (disposed || !enabled || blocked || active || !pending) return
    pending -= 1
    start()
  }

  const onInteraction = (event) => {
    if (!event.isTrusted || disposed || !enabled || active) return
    if (event.type === 'keydown' && (event.repeat || event.key === 'Escape' || event.ctrlKey || event.metaKey || event.altKey)) return
    blocked = false
    if (pending) drain()
    else if (!unlocked) start(true)
  }
  const gestures = ['pointerdown', 'pointerup', 'touchend', 'keydown']
  gestures.forEach((type) => target.addEventListener(type, onInteraction, true))
  audio.addEventListener('ended', finish)
  audio.addEventListener('error', finish)

  return {
    setEnabled(value) {
      if (disposed) return
      enabled = Boolean(value)
      if (!enabled) {
        pending = 0
        active = null
        reset()
      }
    },
    // Exposed for an enable-toggle handler, which itself is a trusted gesture.
    unlock: onInteraction,
    enqueue() {
      if (disposed || !enabled) return
      pending += 1
      drain()
    },
    dispose() {
      if (disposed) return
      disposed = true
      enabled = false
      pending = 0
      active = null
      gestures.forEach((type) => target.removeEventListener(type, onInteraction, true))
      audio.removeEventListener('ended', finish)
      audio.removeEventListener('error', finish)
      reset()
      audio.removeAttribute('src')
      audio.load()
    },
  }
}
