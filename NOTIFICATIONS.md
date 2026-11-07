# Student dashboard notifications

The header bell opens notification history, an unread count, read/unread actions,
and the Notifications ON/OFF switch. The switch and read IDs are stored locally
in this browser. They do not update the database. Up to 100 recent notifications
are displayed; the latest 1,000 read IDs are persisted.

Both `custom` and `group_start` use the existing
`public/sounds/notification.mp3`. There are no sound settings. A single reusable
audio element plays incoming notifications sequentially. Initial history,
reconnect history, reads, renders, and duplicate INSERT IDs do not enqueue
additional playback. IDs received through Realtime are retained for the lifetime
of the page, including while notifications are OFF.

OFF hides the notification list and counter, suppresses new display/browser
alerts, stops active audio, and discards queued audio. ON loads history silently
and enables alerts for subsequent new Realtime events. Notifications received
while OFF can appear in history after re-enabling, without a retroactive tune.

Before interaction, the browser may reject playback with `NotAllowedError`.
Blocked tunes wait for a trusted pointer, touch, or keyboard interaction. If the
user interacts before any notifications arrive, the same element is primed
silently. Playback errors are handled without interrupting notification display.
OFF/unmount cancels pending playback and releases media and event listeners.

Browser notification permission is requested only from the panel's explicit
permission button or when switching notifications ON. Denial does not disable
the in-app panel or tune. Browser notifications request `silent: true` so the
browser's default notification sound does not accompany the fixed tune.
The operating system/browser ultimately controls notification presentation.

`notifications.js` reuses the existing public Supabase client and subscribes only
to INSERTs on `public.notifications`. Setup waits for previous asynchronous
channel cleanup and survives React StrictMode's effect replay. History requests
are aborted when superseded, disabled, or unmounted; stale callbacks are ignored.
The existing meeting channel is deferred to avoid StrictMode creating duplicate
subscriptions with the installed Supabase client.

The existing table must already expose `id`, `kind`, `message`, `created_at`,
`meeting_id`, and `group_no`, allow the viewer's public key to SELECT the intended
rows, and publish notifications through Supabase Realtime. No schema, grants,
policies, publication settings, credentials, or backend records were changed.
The frontend still contains no database writes or service-role credentials.

Realtime notifications require an open page with an active connection. A closed
browser does not receive these alerts. Missed/offline records load silently on
reconnect; this implementation does not introduce background push delivery.

## Verification

- `npm test`: 15 automated tests pass. The project previously had no test script.
  Coverage includes both kinds, duplicate IDs, history/reconnect silence,
  initial-load races, ON/OFF, read state, permission handling, bursts, StrictMode,
  stale callbacks, aborted requests, media errors, and resource cleanup.
- `npm run lint`: passes, including the new test files. One pre-existing unused
  timer initialization was removed without changing timer behavior.
- `npm run build`: production build passes.
- `git diff --check`: passes.
- `npm run test:browser`: isolated headless Chrome tests with real MP3 decoding
  and real Chrome autoplay enforcement pass. Covered before/after-interaction
  unlocking, both kinds, duplicate suppression, rapid serial playback on one
  element, ON/OFF, read/unread, browser permission states, Escape/focus, and
  desktop/mobile fit. Chrome output is muted; this verifies media playback,
  not physical speaker audibility. Supabase events use in-memory fixtures, and
  browser permissions are controlled through Chrome's test protocol.
- A separate read-only check of the configured backend returned HTTP 200 for the
  notification query (zero rows) and `SUBSCRIBED` for the notification channel.
  No live notification INSERT was sent. End-to-end delivery from the Flutter
  sender and Safari/Firefox playback still require manual verification.

To repeat browser tests on this Windows machine, start `npm run dev` on
`127.0.0.1:5173`, then run `npm run test:browser`. The script uses installed
Chrome, a temporary isolated profile, fixture notifications, and native Node
APIs; no added dependencies or real backend writes are needed.

No commits or pushes were made.
