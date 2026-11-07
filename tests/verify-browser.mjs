// Run against `npm run dev`. Uses an isolated Chrome profile and in-memory
// Supabase fixtures; never writes to the real backend or the user's browser.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep, basename } from 'node:path'

const origin = 'http://127.0.0.1:5173'
const profile = await mkdtemp(join(tmpdir(), 'livemeet-browser-test-'))
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--autoplay-policy=document-user-activation-required', '--mute-audio',
  '--no-first-run', '--no-default-browser-check', 'about:blank',
], { windowsHide: true })
let socket, browserSocket
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
async function removeProfile() {
  const resolved = resolve(profile)
  if (!resolved.startsWith(resolve(tmpdir()) + sep) || !basename(resolved).startsWith('livemeet-browser-test-')) throw new Error('Unexpected profile cleanup path')
  await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
function connect(url) {
  const ws = new WebSocket(url)
  let id = 0
  const pending = new Map(), handlers = new Map()
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id) {
      const call = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) call?.reject(new Error(message.error.message))
      else call?.resolve(message.result)
    } else handlers.get(message.method)?.(message.params)
  })
  return new Promise((done, reject) => {
    ws.addEventListener('error', reject, { once: true })
    ws.addEventListener('open', () => done({
      ws,
      on: (name, fn) => handlers.set(name, fn),
      send: (method, params = {}) => new Promise((resolveCall, rejectCall) => {
        const next = ++id
        pending.set(next, { resolve: resolveCall, reject: rejectCall })
        ws.send(JSON.stringify({ id: next, method, params }))
      }),
    }), { once: true })
  })
}

try {
  const endpoint = await new Promise((done, reject) => {
    let output = ''
    const timeout = setTimeout(() => reject(new Error('Chrome startup timed out')), 15000)
    chrome.once('error', reject)
    chrome.stderr.on('data', (chunk) => {
      output += chunk
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/)
      if (match) { clearTimeout(timeout); done(match[1]) }
    })
  })
  browserSocket = await connect(endpoint)
  const { targetId } = await browserSocket.send('Target.createTarget', { url: 'about:blank' })
  const tabs = await (await fetch(`http://127.0.0.1:${new URL(endpoint).port}/json/list`)).json()
  socket = await connect(tabs.find((tab) => tab.id === targetId).webSocketDebuggerUrl)
  const errors = []
  socket.on('Runtime.exceptionThrown', ({ exceptionDetails }) => errors.push(exceptionDetails.text))
  await socket.send('Runtime.enable')
  await socket.send('Page.enable')
  await socket.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 1000, deviceScaleFactor: 1, mobile: false })
  const evaluate = async (expression) => {
    const response = await socket.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || 'Browser evaluation failed')
    return response.result.value
  }
  const until = async (expression, timeout = 20000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return
      await delay(100)
    }
    const diagnostics = await evaluate(`({ plays: __test.plays, audio: __test.audio.map(a => ({ duration: a.duration, currentTime: a.currentTime, paused: a.paused, readyState: a.readyState, error: a.error?.message })) })`)
    throw new Error(`Timed out: ${expression}; ${JSON.stringify(diagnostics)}`)
  }
  const click = async (selector) => {
    const point = await evaluate(`(() => { const el = ${selector}; if (!el) throw Error('Missing control'); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
    await socket.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
    await socket.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  }
  await socket.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__test = { channels: [], audio: [], plays: [], playing: 0, maxPlaying: 0, browser: [] };
    const NativeAudio = window.Audio;
    window.Audio = function(src) {
      const audio = new NativeAudio(src), original = audio.play.bind(audio);
      __test.audio.push(audio);
      audio.play = () => { const attempt = { volume: audio.volume }; __test.plays.push(attempt); return original().then(() => { attempt.ok = true }, error => { attempt.error = error.name; throw error }) };
      let playing = false;
      audio.addEventListener('playing', () => { if (audio.volume && !playing) { playing = true; __test.playing++; __test.maxPlaying = Math.max(__test.maxPlaying, __test.playing) } });
      const stop = () => { if (playing) { playing = false; __test.playing-- } };
      audio.addEventListener('ended', stop); audio.addEventListener('pause', stop);
      return audio;
    };
    window.Audio.prototype = NativeAudio.prototype;
    const NativeNotification = window.Notification;
    window.Notification = new Proxy(NativeNotification, { construct(Target, args) { __test.browser.push(args[1]); return Reflect.construct(Target, args) } });
    const old = { id: 1, kind: 'custom', message: 'Old announcement', created_at: '2026-11-01T10:00:00Z' };
    window.__notificationTestDb = {
      from(table) {
        const q = { select() { return q }, in() { return q }, limit() { return q }, eq() { return q }, order() { return q }, gte() { return q },
          maybeSingle() { return Promise.resolve({ data: null }) }, abortSignal() { return Promise.resolve({ data: [old] }) } };
        return q;
      },
      channel(name) {
        if (__test.channels.some(c => c.name === name && !c.removed)) throw Error('Duplicate active channel: ' + name);
        const c = { name, handlers: [], on(type, filter, fn) { c.handlers.push({ filter, fn }); return c }, subscribe(fn) { c.status = fn; queueMicrotask(() => fn?.('SUBSCRIBED')); return c } };
        __test.channels.push(c); return c;
      },
      async removeChannel(c) { c.removed = true; return 'ok' }
    };
    window.__emit = (id, kind = 'custom') => __test.channels.filter(c => !c.removed).forEach(c => c.handlers.filter(h => h.filter.table === 'notifications').forEach(h => h.fn({ new: { id, kind, message: kind + ' notice ' + id, created_at: new Date().toISOString() } })));
  ` })
  await socket.send('Fetch.enable', { patterns: [{ urlPattern: '*/src/App.jsx*', requestStage: 'Request' }] })
  socket.on('Fetch.requestPaused', async ({ requestId, request }) => {
    try {
      const source = await (await fetch(request.url)).text()
      const modified = source.replace(/const db =[\s\S]*?(?=const notifications =)/, 'const db = window.__notificationTestDb;\n')
      assert.notEqual(source, modified, 'Test Supabase injection must succeed')
      await socket.send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/javascript' }], body: Buffer.from(modified).toString('base64') })
    } catch (error) { errors.push(error.message); await socket.send('Fetch.failRequest', { requestId, errorReason: 'Failed' }) }
  })
  await socket.send('Page.navigate', { url: origin })
  await until(`document.querySelector('.notification-bell') && __test.channels.length === 2 && __test.audio.length === 1`)
  await delay(400)
  assert.equal(await evaluate('__test.plays.length'), 0, 'Initial history must stay silent')
  await evaluate(`__emit(2); __emit(2); __emit(3, 'group_start')`)
  await until(`__test.plays[0]?.error === 'NotAllowedError'`)
  assert.equal(await evaluate('__test.plays.length'), 1)
  await click(`document.querySelector('.notification-bell')`)
  await until(`__test.plays.filter(p => p.ok && p.volume === 1).length === 2 && __test.audio[0].paused`, 30000)
  assert.equal(await evaluate('__test.maxPlaying'), 1)
  assert.equal(await evaluate(`document.querySelectorAll('.notification-list li').length`), 3)
  console.log('PASS: silent history, native Chrome autoplay block/unlock, both kinds and duplicate suppression')
  await click(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Mark all as read')`)
  assert.equal(await evaluate(`document.querySelector('.notification-count') === null`), true)
  await click(`document.querySelector('.notification-list .notification-link')`)
  assert.equal(await evaluate(`document.querySelector('.notification-count').textContent`), '1')
  await click(`document.querySelector('[role=switch]')`)
  await evaluate(`__emit(4); __emit(5, 'group_start')`)
  assert.equal(await evaluate(`document.querySelector('.notification-list') === null && document.querySelector('.notification-count') === null`), true)
  assert.equal(await evaluate('__test.plays.length'), 3)
  console.log('PASS: read/unread controls and OFF suppressing display and audio')
  await browserSocket.send('Browser.setPermission', { permission: { name: 'notifications' }, setting: 'granted', origin })
  await click(`document.querySelector('[role=switch]')`)
  await evaluate(`__emit(6, 'group_start'); __emit(6, 'group_start'); __emit(7); __emit(8, 'group_start')`)
  await until(`__test.plays.filter(p => p.ok && p.volume === 1).length === 5 && __test.audio[0].paused`, 45000)
  assert.equal(await evaluate('__test.browser.length'), 3)
  assert.equal(await evaluate('__test.browser.every(n => n.silent)'), true)
  assert.equal(await evaluate('__test.audio.length'), 1)
  assert.equal(await evaluate('__test.maxPlaying'), 1)
  await browserSocket.send('Browser.setPermission', { permission: { name: 'notifications' }, setting: 'denied', origin })
  await evaluate(`window.dispatchEvent(new Event('focus')); __emit(9)`)
  await until(`__test.plays.filter(p => p.ok && p.volume === 1).length === 6`)
  assert.equal(await evaluate('__test.browser.length'), 3)
  assert.equal(await evaluate(`document.querySelector('.notification-panel').textContent.includes('blocked')`), true)
  console.log('PASS: ON resumes, rapid arrivals serialize on one audio element, native granted/denied browser permission')
  const screenshot = join(tmpdir(), `livemeet-notifications-${Date.now()}.png`)
  await writeFile(screenshot, Buffer.from((await socket.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
  await socket.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: true })
  assert.equal(await evaluate(`document.querySelector('.notification-panel').getBoundingClientRect().left >= 0 && document.querySelector('.notification-panel').getBoundingClientRect().right <= 360`), true)
  assert.equal(await evaluate(`document.querySelector('.phone').scrollWidth <= document.querySelector('.phone').clientWidth`), true)
  const mobileScreenshot = join(tmpdir(), `livemeet-notifications-mobile-${Date.now()}.png`)
  await writeFile(mobileScreenshot, Buffer.from((await socket.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
  await socket.send('Page.reload')
  await until(`document.querySelector('.notification-bell') && __test.channels.length === 2 && __test.audio.length === 1`)
  await click(`document.querySelector('.notification-bell')`)
  await until(`__test.plays[0]?.ok && __test.audio[0].paused`)
  assert.equal(await evaluate('__test.plays[0].volume'), 0, 'Early interaction should prime silently')
  await evaluate(`__emit(11, 'group_start')`)
  await until(`__test.plays.filter(p => p.ok && p.volume === 1).length === 1`)
  await socket.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await socket.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  assert.equal(await evaluate(`document.querySelector('.notification-panel') === null && document.activeElement === document.querySelector('.notification-bell')`), true)
  assert.deepEqual(errors, [])
  console.log('PASS: early-interaction silent unlock, Escape/focus, StrictMode channel setup, desktop/mobile fit, no uncaught browser exceptions')
  console.log(JSON.stringify({ screenshot, mobileScreenshot, duration: await evaluate('__test.audio[0].duration') }))
} finally {
  socket?.ws.close()
  if (browserSocket) {
    await browserSocket.send('Browser.close').catch(() => {})
    browserSocket.ws.close()
  }
  chrome.kill()
  await delay(500)
  await removeProfile()
}
