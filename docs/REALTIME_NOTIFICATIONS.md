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

KukGit registers connection-local SQLite TEMP triggers on the `notifications` table and a bounded Node SQLite custom function. Inserts and `read_at` changes invoke the in-process event hub after the database statement completes.

This captures notifications created by:

- browser/API actions
- pull-request and review workflows
- CI status alerts
- invitation and collaboration workflows
- token-expiry scheduling
- backup, webhook and LFS operations

There is no browser HTTP polling requirement and no server outbox polling for WebSocket events. The existing REST endpoint remains available for missed-event resynchronization and fallback.

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

## Current deployment boundary

The private-alpha runtime uses SQLite and an in-process connection registry. A multi-instance deployment will require a shared publish/subscribe transport so an event written on one application node reaches sockets connected to another node. Do not deploy multiple active KukGit application nodes until that distributed fan-out layer is implemented.