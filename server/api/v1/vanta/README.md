# VANTA room and sync API

`sessions.php` creates or joins a room. Protocol 3 responses include a short-lived
`syncToken` bound to the room, Firebase UID, participant ID, installation ID, and
protocol version. Older protocols and releases are rejected.

`sync.php` accepts JSON `POST` requests:

- `initialize`: common identity fields, `baseRevision: 1`, and `chunks`. The server
  writes the exact `{"_vantaChunked":true}` marker and revision 2 with an ETag
  precondition.
- `update`: common identity fields, `baseRevision`, and
  `delta: { changes, removed }`. The server commits revision metadata, `latest`,
  and changed chunk paths in one Firebase multi-location `PATCH`.

Common identity fields are `roomId`, `installationId`, and `participantId`.
Send the sync token as `Authorization: Bearer <syncToken>`. The current client also
repeats the same short-lived token in a fallback header or body because some shared
hosting proxies strip `Authorization`; this is a transport fallback, not support for
an older VANTA protocol. The token identity must match an active protocol 3 participant.

`gateway.php` is the browser-facing read/presence gateway. Project,
participant, and chat traffic stays behind LLNKKR. Session reads,
revision reads, participant acquire/heartbeat/release, and room cleanup are
authorized with the same signed `syncToken` and performed by LLNKKR.

`stream.php` exposes one browser-facing SSE connection per participant. Its
`all` channel multiplexes participants, the latest 20 chat messages, room
metadata, and project revision/delta events. The
extension manifest requires only `playentry.org/ws/*` and `llnk.kr/*` for its
normal operation.

`chat.php` accepts `roomId`, `installationId`, `participantId`, and a plain-text
`text` value under the same signed identity. Only active participants may send.
Messages are limited to 100 Unicode characters and three lines. Per participant,
the server allows one message per second, 20 per minute, and 100 per ten minutes.
Each message replaces one of 20 fixed slots under the room's Cursor Firebase
chat path. The sequence is allocated atomically in SQL, so the server never
rewrites the full history, and Firebase Rules deny direct client chat access.

`presence.php` receives a signed heartbeat from the current extension every 30
seconds. It maps an active room participant to the request IP for `/vanta777`
and accounts for the otherwise client-to-Firebase connection overhead. A leave
event expires the SQL presence immediately.

`settings.php` returns and updates the room maximum and room-wide Live cursor
mode. Only the room owner installation may change either setting. New rooms
start with Live cursor enabled. Enabling it requires available quota for every
active participant. Cursor coordinates never pass through LLNKKR.

`cursor-access.php` is the Live cursor control entry point for release 54 /
extension 1.0.29. After checking the signed identity, active Firebase slot,
live SQL presence, global Live cursor switch, rate limit, and quota, it returns a
short-lived Cursor Firebase ID token bound to one room, participant, release,
and shard. The extension receives the required
`https://*.firebasedatabase.app/*` Chrome permission at installation. Live cursor
is stored as a room-wide owner setting and is applied to every participant.
No service-account secret is ever sent to the extension. One token is reserved
when the cursor connection starts and then about once per twelve active minutes.
Turning Live cursor off stops both coordinate writes and the Firebase cursor stream.

The room registry assigns the active Sync and Cursor shard when a room is
created. Existing rooms keep their assigned shards. Sync A holds durable
room/project/chat state, while Cursor A holds short-lived pointer state.
`/vanta777` can select Sync A/B and Cursor A/B for newly created rooms and can
disable Live cursor globally. Future B/C routing uses the same wildcard
Chrome permission, so adding another `firebasedatabase.app` project does not
require another extension host-permission change.

VANTA keeps daily IP usage rows and enforces them over one configurable quota
period: day, Monday-based week, or calendar month. One token represents 1 MiB
of estimated Firebase download traffic and the default period allowance is 100
tokens. The default quota period is week. Room
joins are estimated from the current stored chunk size, sync writes from patch
bytes multiplied by active recipients, and small fixed estimates cover chat and
presence overhead. The estimate intentionally includes a conservative JSON/TLS
multiplier but is not Firebase's authoritative billable counter. `/vanta777`
can switch the quota period, change the global or per-IP period limit, grant or
reclaim the current period's tokens, pause an IP, and reset the current period.
`quota.php` lets the extension show the requesting IP's period and remaining
percentage without returning the IP address. Quota checks run on create, join, sync,
chat, and signed presence requests.

Limits are 10 MiB per initialize request, 2 MiB per update request, 512 initial
chunks, and 64 changed/removed chunks per update. Default rate limits are 300
sync requests per installation per minute and 1,500 per IP per minute. They can
be overridden with `LLNK_VANTA_SYNC_INSTALL_MINUTE_LIMIT` and
`LLNK_VANTA_SYNC_IP_MINUTE_LIMIT`.

The server also keeps a per-room SQL chunk registry. Every update is serialized
per room and must remain within 512 stored chunks and 8 MiB of stored chunk text,
including manifest-free concurrent/orphan additions. The registry is removed
when the empty Firebase room is deleted. If a process stops after Firebase has
accepted an update but before SQL commits, the next update performs one
recovery-only snapshot read, revalidates the same limits, rebuilds the registry,
and retries once instead of leaving the room permanently stuck.

The Firebase server ID token is cached in APCu when available. Without APCu, the
server uses an encrypted, HMAC-authenticated `0600` cache file in a private
HMAC-named `0700` directory under the system temporary directory, with `flock`
single-flight refresh. Set `LLNK_VANTA_PRIVATE_CACHE_DIR` to an absolute directory
outside the web document root to override that location; an insecure location is
ignored and never receives a plaintext token.

Deploy the matching Firebase Rules before switching clients to the proxy. The
rules must allow the LLNKKR server claim to update snapshots and closing locks,
block participant acquisition while `meta.closingUntil` is in the future, and
deny direct client writes to protocol 3 snapshots.
