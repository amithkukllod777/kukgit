# Real-time WebSocket Notifications

KukGit delivers in-app notification changes over an authenticated WebSocket while retaining the REST notification API as the authoritative resynchronization fallback.

## Endpoint

```text
GET /api/notifications/socket
```

Use `wss://` in production. The browser sends its normal HttpOnly `kukgit_session` cookie during the WebSocket upgrade; no token is placed in the URL, JavaScript storage or WebSocket subprotocol.

## Security model

The upgrade is accepted only when:

- `Origin` exactly matches `KUKGIT_BASE_URL`
- WebSocket version is 13
- the handshake key is valid
- the KukGit browser session is valid
- the configured per-user and instance connection limits are not exceeded

In One Kuklabs Account mode, KukGit validates:

- central `/v1/auth/me`
- `kukgit` product access
- the current central device session
- rotating refresh-token recovery after access-token expiry

Active sockets are revalidated periodically. Central logout, device revocation, identity mismatch or blocked product access closes the socket and removes an invalid local bridge where applicable.

A user is registered only in their own in-memory connection set. Notification events are never broadcast globally.

## Event capture

A permanent SQLite trigger on `notifications` writes a row into
`notification_fanout` on every insert and every `read_at` change. Every instance
polls that log every 400ms and delivers what it finds to its own sockets.

**Permanent, not `TEMP`.** A `TEMP` trigger only fires for writes made on the
connection that created it, which is exactly why a notification written by one
instance never reached a socket held by another. The trigger is also plain SQL
with no custom function, so a backup, a script or `npm run seed` can still write
a notification — a trigger calling a function only the server registers would
turn those into crashes.

**One delivery path, not two.** The instance that wrote the row reads it back
from the same log as everybody else. A local fast path plus a remote one would be
two behaviours to keep in sync, and the local one is exactly the one that gets
tested.

The cursor starts at the newest row and lives in memory only. A client fetches
its inbox on connect, so anything from before an instance was listening is
already on screen; persisting the cursor would make every restart a burst of
stale badges.

This captures notifications created by:

- browser/API actions
- pull-request and review workflows
- CI status alerts
- invitation and collaboration workflows
- token-expiry scheduling
- backup, webhook and LFS operations

There is no browser HTTP polling requirement. The REST endpoint remains available
for missed-event resynchronisation and fallback, and that is not a formality: the
inbox is the delivery guarantee and the socket is an accelerator. A fan-out
failure is logged and retried on the next tick, never thrown, so the worst
outcome is that a badge updates on reload instead of immediately.

## Wire events

The server intentionally sends metadata-light events:

```json
{
  "type": "notifications.snapshot",
  "sequence": 42,
  "reason": "connected",
  "unreadCount": 3,
  "serverTime": "2026-07-28T00:00:00.000Z"
}
```

```json
{
  "type": "notifications.changed",
  "sequence": 43,
  "reason": "created",
  "notificationId": "ntf_...",
  "unreadCount": 4,
  "serverTime": "2026-07-28T00:00:01.000Z"
}
```

The full notification body is fetched from the authenticated REST API. Connection logs and hub statistics do not include notification titles, bodies, cookies or tokens.

Clients may send only:

```json
{"type":"resync"}
```

or:

```json
{"type":"ping"}
```

Binary, fragmented, unmasked, oversized or unsupported messages close the connection with a protocol error.

## Browser behavior

The browser client:

- connects only while the authenticated app shell is mounted
- updates the unread badge immediately
- refreshes an open drawer through the REST API
- requests a snapshot after connecting
- reconnects with bounded exponential backoff and jitter
- pauses reconnect attempts while offline
- resynchronizes after reconnecting
- continues to work through the existing REST interface when WebSocket connectivity is unavailable

## Configuration

```text
KUKGIT_REALTIME_HEARTBEAT_MS=25000
KUKGIT_REALTIME_AUTH_REVALIDATE_MS=60000
KUKGIT_REALTIME_MAX_CONNECTIONS_PER_USER=10
KUKGIT_REALTIME_MAX_CONNECTIONS=5000
KUKGIT_REALTIME_MAX_MESSAGE_BYTES=4096
```

Use conservative limits for a single-node private-alpha deployment. Increase them only after measuring file descriptors, reverse-proxy limits and memory consumption.

## Reverse proxy

NGINX must preserve the upgrade:

```nginx
location /api/notifications/socket {
    proxy_pass http://kukgit:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header Origin $http_origin;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 90s;
    proxy_send_timeout 90s;
}
```

Do not cache the endpoint. Keep the proxy idle timeout comfortably above the heartbeat interval.

## Shutdown and deploys

On shutdown KukGit:

1. stops accepting upgrades
2. sends close code `1001` to active clients
3. removes TEMP triggers
4. closes the HTTP server

Browsers reconnect automatically after the new instance becomes available.

## Operational checks

- confirm the browser receives HTTP `101` for the socket endpoint
- verify `notifications.snapshot` arrives after connection
- create a notification and confirm only the intended user receives `notifications.changed`
- mark a notification read in one tab and confirm other tabs update
- revoke the central device session and confirm the socket closes
- verify the reverse proxy forwards `Upgrade` and `Connection` headers
- monitor active connection count, rejected upgrades and connection closures without logging content

## Multiple instances

An event written on one node reaches sockets on another, so a second application
node is no longer excluded by this layer.

What to know when running more than one:

- **Latency is the poll interval**, 400ms by default. There is no push in SQLite;
  this is the entire budget, and it is deliberately below the threshold at which
  a badge feels delayed.
- **Fan-out rows are pruned by age**, ten minutes, by whichever instance gets
  there. Deleting by age is idempotent, so no lease is needed — and a lease here
  would mean one instance's failure stops the table growing.
- **A burst is bounded** at 500 rows per tick, so an instance recovering from a
  pause cannot push ten thousand events into a socket at once.
- **`instance.realtime.fanout` in the operator health payload** reports each
  instance's cursor. Two instances whose cursors are far apart is the visible
  symptom of one being stuck, and it is otherwise invisible.

Sticky sessions are not required. A socket may connect to any instance.
