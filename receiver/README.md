# OBS chat widget receiver

A standalone Bun HTTP receiver for `mod-chat-widget`. It writes complete batches to stdout, keeps bounded
character chat history in SQLite, and serves a read-only WoW-style chat panel for OBS.
The entire `receiver/` directory can be copied to another machine. Runtime dependencies are built into Bun;
no AzerothCore installation, database server, frontend build, or package installation is needed to run it.

## Run

Install Bun 1.4.2 or newer. From this directory:

```sh
bun run --silent start
```

The default listener is `http://127.0.0.1:3000`. Ingestion uses `POST /chat`; the panel uses `GET /widget`.
Startup, shutdown, and error messages go to stderr. Batches go to stdout, one compact JSON object per line.
The `--silent` flag keeps stdout free of script banners. To save the original batches as well as widget history:

```sh
bun run --silent start >> chat-batches.jsonl
```

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `CHAT_LOGGER_HOST` | `127.0.0.1` | Listening hostname/IP; use `0.0.0.0` for remote IPv4 access |
| `CHAT_LOGGER_PORT` | `3000` | TCP port, from 1 to 65535 |
| `CHAT_LOGGER_BEARER_TOKEN` | empty | Require `Authorization: Bearer <token>` on ingestion |
| `CHAT_LOGGER_DB_PATH` | `./data/chat.sqlite` | SQLite file, relative to the working directory; parents are created |
| `CHAT_LOGGER_RETENTION_DAYS` | `7` | Retention measured from receipt, from 1 to 36500 days |
| `CHAT_LOGGER_MAX_EVENTS` | `100000` | Maximum retained events across all sources and characters |

Settings are read at startup. `:memory:` can be used as the database path for disposable sessions.
A database open/schema error prevents startup. File-backed storage uses WAL mode, with `-wal` and `-shm`
sidecars alongside the database. Stop the receiver before copying its database for backup.

Widget and history routes intentionally require **no viewing token**. Anyone who can reach the receiver
can query captured character chat, including whispers and officer chat. The ingestion token protects only
`POST /chat`; keep this deployment on your private network. Remote HTTPS can be supplied by a reverse proxy.

## Connect the module

For a receiver on the same machine, set these values in `mod_chat_widget.conf` and restart worldserver:

```ini
ChatLogger.Enable = 1
ChatLogger.CaptureOutgoing = 1
ChatLogger.CaptureIncoming = 1
ChatLogger.Endpoint = "http://127.0.0.1:3000/chat"
ChatLogger.SourceId = "realm-1"
ChatLogger.BearerToken = ""
```

Use a unique source ID for each installation. Incoming capture helps learn names but never produces widget
lines. Set matching bearer tokens in the module and receiver if ingestion authentication is enabled.
In separate containers or on different machines, replace loopback with the receiver's reachable address.

## Add to OBS

1. Add a **Browser** source to the scene.
2. Set its URL to `http://127.0.0.1:3000/widget?source=realm-1&character=Alice`.
3. Start with **Width 800**, **Height 300**, and resize as needed. No custom CSS is required.
4. Use a separate Browser source and URL for each character.

The panel has a translucent background, channel colors, outlined text, and bottom-aligned
messages. It restores up to 100 recent events and polls every second. Messages do not fade, and there are
no input fields, clickable chat links, or editing controls. The panel keeps its current messages during
an outage, shows a small reconnecting status, and resumes automatically. OBS refreshes restore history.

Both `source` and exactly one of `character` or `guid` are required. Character names match case-insensitively
within a source. The widget resolves a name to a GUID and uses that identity until the page reloads.
Unknown names show a waiting message and are retried; ambiguous names require a GUID. There is no
unfiltered fallback. Use URL encoding for names, source IDs, and the module's full GUID strings.

Discover known character identities:

```sh
curl 'http://127.0.0.1:3000/api/characters?source=realm-1'
```

The returned `guid` can replace `character` in the widget URL. Only characters observed with a named session
appear in discovery. Identities learned solely from explicitly named packet actors still help label messages.

To try the widget without a realm, submit the synthetic outgoing example:

```sh
curl --include http://127.0.0.1:3000/chat \
  --header 'Content-Type: application/json' \
  --data-binary @examples/widget-batch.json
```

Then open the Alice widget URL above. Reposting the same example does not duplicate its messages.
`examples/batch.json` remains an incoming-only example: it appears in stdout but does not create a chat line.
If authentication is enabled, supply `--header "Authorization: Bearer $CHAT_LOGGER_BEARER_TOKEN"` as well.

## What the panel represents

The panel uses outgoing recipient copies: Alice sees events addressed to Alice's session, not every message
sent by Alice or mentioning her. Incoming submissions, rejected commands, and other recipients' copies are
excluded. Source IDs keep matching names and GUIDs on different realms separate.

The receiver renders available chat and emote text, MOTD lines, textual notices, and channel join/leave
confirmations addressed to the character. Incoming whispers and outgoing confirmations have distinct prefixes.
Names are learned from sessions and explicitly named actors;
unknown names appear as `Unknown player`. Session identities take precedence over actor-name hints.
Character identity can be absent during login/logout; events without a recipient GUID are not shown.
The module records character identity during database loading, before sending the login MOTD. Older module
builds captured the MOTD with a null character GUID; those old events cannot be assigned using only an
account ID. Rebuild and restart worldserver after updating the module, restart the receiver, and log in again
to capture the MOTD and channel notices. Replaying a saved batch restores previously omitted channel notices
when they include a character GUID, but cannot recover unidentified MOTD events.

WoW color codes and hyperlink labels are rendered safely as text and colored spans. Links are inert,
texture/atlas markup is omitted, and HTML remains literal text. Presentation labels are English; captured
message text is preserved. Events marked `malformed` or `unsupported` are not displayed. Decoded
`trailing_bytes` events can be displayed if their necessary fields are available.

This is a receiver-side approximation of the character's chat. It cannot reproduce client chat-tab filters,
addon layouts, language scrambling, client-generated loot/combat lines, or localized emotes/notices supplied
only as client lookup IDs, except the channel join/leave confirmations described above. Channel names are
available, but client-specific channel numbers are not.
An outgoing observation is a server send attempt, not proof that the client received or displayed it.

## HTTP contract

`POST /chat` accepts uncompressed UTF-8 JSON with `Content-Type: application/json`. It validates schema
version 1, a nonempty source ID of at most 256 UTF-8 bytes, an events array, and common event metadata.
Optional packet fields and unknown extensions remain unchanged in stdout. Unsupported or malformed packet
observations are still accepted for stdout. Invalid common metadata rejects the entire batch; empty batches
are valid. Text newlines are JSON-escaped and do not split stdout records.

A `204` acknowledges a complete stdout write/flush followed by an atomic SQLite transaction. SQLite keeps
only outgoing display data and learned identities, not raw packets, account IDs, or incoming submissions.
Original batches, including retries, remain intact on stdout. History deduplicates by `(source_id, event_id)`
while events are retained. If stdout succeeds but SQLite fails, a retry may add another stdout line; the
history transaction never partially commits. A lost HTTP acknowledgement is also safe to retry.

| Response | Meaning |
| --- | --- |
| `204` | Stdout and SQLite processing completed; empty body |
| `400` | Invalid JSON/UTF-8 or interrupted upload |
| `401` | Missing or incorrect ingestion bearer token |
| `404` / `405` | Unknown path / unsupported method |
| `408` | Body receive deadline exceeded |
| `413` | Body exceeds 8 MiB, including streamed bodies |
| `415` | Unsupported content type or compression |
| `422` | Unsupported schema version or invalid common metadata |
| `503` | Ingestion slots occupied, shutdown, stdout failure, or storage failure; `Retry-After: 1` |

Four ingestion requests may be active, including uploads and writes waiting on stdout. Uploads have a
ten-second total receive deadline. Writes and commits are serialized. Stdout failure disables ingestion
until restart; storage failures can recover on retry. Bun manages transport-level connection/header limits.
`SIGINT` and `SIGTERM` stop admission and allow five seconds for pending requests, output, and database cleanup;
exceeding that deadline forces exit with status 1. Diagnostics exclude request bodies and credentials.

### Read APIs

All read APIs use `GET`, return JSON, and send `Cache-Control: no-store`.

- `/api/characters?source=realm-1` returns `{ "characters": [{ "guid": "…", "name": "Alice" }] }`.
  Optional `character=Alice` performs an exact case-insensitive name lookup, returning at most two matches
  to distinguish a unique identity from an ambiguous one.
- `/api/chat?source=realm-1&character=Alice` resolves a character name. Missing names return `404`, ambiguous
  names return `409`. Missing source/selection or supplying both name and GUID returns `400`.
- `/api/chat?source=realm-1&guid=…` reads a recipient directly. Unknown GUIDs return empty history.
- Add `after=<cursor>` to receive events after a previous response. Treat cursors as opaque.

Chat responses contain `character`, `messages`, `cursor`, `reset`, and `hasMore`. Each message contains its
numeric `id`, `capturedAt`, CSS `color`, plain-text `prefix`, and WoW-formatted `text`. Initial responses return
up to the latest 100 events, oldest first. Incremental responses return up to 100 subsequent events; when
`hasMore` is true, immediately request the next page. Advance the cursor even when a page is empty.
When `reset` is true, replace displayed history with the response's messages.

Insertion order supplies cursors, independently of capture timestamps. SQLite persists cursor identity
across restarts; replacing the database or pruning history causes a fresh snapshot. Age pruning happens on
ingestion and at most once per minute during reads. Count pruning happens on ingestion. Identity storage is
also bounded by the same age and count settings. Events discarded by retention are no longer deduplicated.

## Development and tests

Install the pinned development dependencies and run the checks:

```sh
bun install --frozen-lockfile
bun run check
bun run test
```

The isolated tests use `bun:test`, temporary SQLite databases, ephemeral loopback listeners, standard
`fetch`, Bun sockets, injected asynchronous outputs, and Bun subprocesses. They cover ingestion validation,
output backpressure/failure, interrupted uploads, shutdown, recipient isolation, identity resolution,
whispers, formatting, deduplication, transaction rollback, retention, cursor recovery, and standalone restart.
No running game server is used. Browser assets are ordinary JavaScript and CSS, served directly by Bun.

Authored code is GPL-2.0-or-later; see `LICENSE`.
