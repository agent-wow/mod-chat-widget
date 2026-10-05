# Chat logger reference receiver

A standalone TypeScript HTTP server that accepts `mod-chat-logger` batches and writes them to stdout.
It needs no AzerothCore installation, database, build, or runtime dependencies. This entire `receiver/`
directory can be copied to another machine and run independently.

## Run

Install Bun 1.4.2 and Node.js 24 or newer. Bun manages dependencies and runs the package scripts;
the server and test scripts execute with Node.js. No compilation is needed. From this directory:

```sh
bun run --silent start
```

The default listener is `http://127.0.0.1:3000/chat`. Accepted batches go to stdout, one JSON object per line;
startup, shutdown, and error messages go to stderr. To save the batches:

```sh
bun run --silent start >> chat-batches.jsonl
```

The `--silent` flag keeps stdout free of script banners.
For example, configure a different port and optional shared token through environment variables:

```sh
CHAT_LOGGER_PORT=8080 CHAT_LOGGER_BEARER_TOKEN=replace-me bun run --silent start
```

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `CHAT_LOGGER_HOST` | `127.0.0.1` | Listening hostname/IP; use `0.0.0.0` to accept remote IPv4 connections |
| `CHAT_LOGGER_PORT` | `3000` | TCP port, from 1 to 65535 |
| `CHAT_LOGGER_BEARER_TOKEN` | empty | Require `Authorization: Bearer <token>` when set |

The receiver serves HTTP. For a remote deployment, put it behind an HTTPS reverse proxy and configure
the module with that HTTPS URL. Supply the token through your deployment's environment and use the same
value in `ChatLogger.BearerToken`. Requests, credentials, and chat contents are never included in diagnostics.
Chat contents are intentionally present in stdout.

## Connect the module

For a receiver on the same machine, set these values in `mod_chat_logger.conf` and restart worldserver:

```ini
ChatLogger.Enable = 1
ChatLogger.Endpoint = "http://127.0.0.1:3000/chat"
ChatLogger.SourceId = "realm-1"
ChatLogger.BearerToken = ""
```

Use a unique source ID for each sending installation. If authentication is configured on the receiver,
set the matching bearer token in the module. A container's `127.0.0.1` refers to that container; use the
receiver's reachable hostname when the two processes run in different containers or on different machines.

You can try the receiver without AzerothCore:

```sh
curl --include http://127.0.0.1:3000/chat \
  --header 'Content-Type: application/json' \
  --data-binary @examples/batch.json
```

With authentication enabled, also pass `--header "Authorization: Bearer $CHAT_LOGGER_BEARER_TOKEN"` from a
shell with that variable exported. The example contains an incoming guild message from Alice.

## HTTP and stdout contract

`POST /chat` accepts uncompressed UTF-8 JSON with `Content-Type: application/json`. It validates schema
version 1, a nonempty source ID of at most 256 UTF-8 bytes, an events array, and common event metadata
(identity, timestamp, direction/observation, opcode, kind, session, and decoding status). Opcode-specific
fields are preserved without additional interpretation. Null values, unknown extra fields, WoW formatting
codes, and events with `malformed`, `unsupported`, or `trailing_bytes` packet decoding status are accepted.
An invalid event rejects the entire batch. Empty event arrays are valid.

Each successful request writes the complete envelope as a compact JSON line:

```text
{"schema_version":1,"source_id":"realm-1","events":[...]}
```

Text newlines are JSON-escaped, so they do not split the record. No events are merged, enriched, or marked
as delivered. The `source_id`, `event_id`, incoming submissions, and individual outgoing recipient copies
remain exactly as submitted. JSON whitespace may change.

| Response | Meaning |
| --- | --- |
| `204` | The entire batch was written to stdout; empty response body |
| `400` | Invalid JSON/UTF-8 or an interrupted request |
| `401` | Missing or incorrect configured bearer token |
| `404` / `405` | Wrong path / method; only `POST /chat` is supported |
| `413` | Body exceeds 8 MiB, including chunked requests |
| `415` | Unsupported content type or compression |
| `422` | Unsupported schema version or invalid batch metadata |
| `503` | All four request slots are occupied or stdout failed; includes `Retry-After: 1` |

The body limit accommodates the module's maximum configurable batch size. The server permits four active
requests, up to 32 connections, 16 KiB headers, and a ten-second request/header receive timeout. Stdout
backpressure keeps a request slot occupied until its write completes; the server does not acknowledge early.
After a stdout failure, new batches receive `503` until the receiver restarts. `SIGINT`/`SIGTERM` stop the
listener and allow five seconds to finish pending requests/writes before forcing exit with status 1.

The module retries network errors, `408`, `429`, and `5xx`; other non-2xx responses discard its batch.
This reference intentionally logs retries again: it has no deduplication or durable storage. Consumers
can deduplicate individual events using `(source_id, event_id)`. A stdout write is not a guarantee of disk
durability or in-game delivery, and a lost HTTP acknowledgement can result in duplicate lines.

## Development and tests

Run the isolated HTTP tests through Bun without installing dependencies:

```sh
bun run test
```

For strict TypeScript checking, install the development dependencies pinned in `bun.lock`:

```sh
bun install --frozen-lockfile
bun run check
bun run test
```

Tests use ephemeral loopback ports and injected writable streams. They cover payload preservation,
recipient copies, retry IDs, authentication, invalid input, body limits, backpressure, stdout failure,
and interrupted uploads. No AzerothCore process or database is used.

Authored code is GPL-2.0-or-later; see `LICENSE`.
