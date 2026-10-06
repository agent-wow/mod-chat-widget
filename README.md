# mod-chat-widget
An external AzerothCore module for observing incoming player chat submissions and outgoing chat/notices,
then forwarding JSON batches to an HTTP service. It requires no SQL or core changes. This directory is
intentionally ignored by the parent AzerothCore repository; manage or distribute it as a separate module.

## Installation and configuration

Place this directory at `modules/mod-chat-widget`. AzerothCore discovers its `src/` loader and installs
`conf/mod_chat_widget.conf.dist` using the standard module build. Static and dynamic module modes are
supported. No dependency download takes place during CMake configuration.

After building/installing through your normal AzerothCore workflow, copy the installed `.conf.dist` to
`mod_chat_widget.conf` in the server's module configuration directory. Set:

```ini
ChatLogger.Enable = 1
ChatLogger.Endpoint = "https://collector.example.org/chats"
ChatLogger.SourceId = "production-realm-1"
ChatLogger.BearerToken = "your-token"
```

When upgrading from `mod-chat-logger`, rename the module directory and rerun your normal CMake
configuration/build/install workflow. Move your installed `mod_chat_logger.conf` to `mod_chat_widget.conf`
before starting the rebuilt server. Existing `ChatLogger.*` options and receiver `CHAT_LOGGER_*`
environment variables keep their names and values. Update any `MODULE_MOD-CHAT-LOGGER` or
`DISABLED_AC_MODULES` overrides to use the new module name (`MODULE_MOD-CHAT-WIDGET` or `mod-chat-widget`).

The endpoint above is an example. A standalone [Bun receiver and OBS chat widget](receiver/README.md) is included
for reference and can run independently of AzerothCore. Settings are read at startup;
`.reload config` does not change the running logger. The module is enabled by default. An empty or
whitespace-only endpoint leaves it inactive: no worker, queue, or network activity is started, and gameplay
continues normally. Set `ChatLogger.Enable = 0` to explicitly disable it even with an endpoint configured.
`CaptureIncoming` and `CaptureOutgoing` can independently disable either direction. Omitting `SourceId`
uses `realm-<RealmID>`; use a distinct source ID for each installation.

HTTPS verifies the peer certificate and hostname. `CAFile` optionally supplies a PEM trust bundle in
addition to OpenSSL's default trust paths (particularly useful on Windows). HTTP is also supported.
URL userinfo, fragments, whitespace, and header injection through the bearer token are rejected.
Redirects are never followed, so credentials are not forwarded to another endpoint. Startup errors
disable only the logger; diagnostic logs never include tokens, endpoint URLs, response bodies, or chat text.

## What is observed

| Direction | Observation | Session identity |
| --- | --- | --- |
| Incoming | `client_submission` | The authenticated submitting player |
| Outgoing | `send_attempt` | The session to which the server is attempting to send |

Incoming packets are copied in `CanPacketReceive`, before the chat handler validates or rewrites text.
The observer always returns true. This includes `.commands`, whispers to unavailable players, muted-player
submissions, AFK/DND changes, and text emote submissions. Earlier session checks or an earlier script veto
can prevent a packet reaching this hook. This is not a raw network trace or an acceptance/rejection audit.

Outgoing packets are copied in `OnPacketSent`. This hook precedes the socket check and other script vetoes:
an event does not confirm receipt, display, or reading. Each recipient copy remains a separate event.
If Alice sends `hello` to a guild with Alice, Bob, and Cara receiving it, the log contains one incoming
submission and three outgoing copies. Offline members add no outgoing events. Identical messages are
never collapsed, and there is no inferred correlation ID between incoming and outgoing observations.

Selected packets:

- Incoming: `CMSG_MESSAGECHAT`, `CMSG_TEXT_EMOTE`.
- Outgoing: `SMSG_MESSAGECHAT`, `SMSG_GM_MESSAGECHAT`, `SMSG_TEXT_EMOTE`, `SMSG_CHANNEL_NOTIFY`,
  `SMSG_CHANNEL_LIST`, `SMSG_CHANNEL_MEMBER_COUNT`, `SMSG_NOTIFICATION`, `SMSG_MOTD`,
  `SMSG_CHAT_SERVER_MESSAGE`, `SMSG_ZONE_UNDER_ATTACK`, `SMSG_DEFENSE_MESSAGE`,
  `SMSG_CHAT_PLAYER_NOT_FOUND`, `SMSG_CHAT_PLAYER_AMBIGUOUS`, `SMSG_CHAT_WRONG_FACTION`,
  `SMSG_CHAT_RESTRICTED`, `SMSG_CHAT_NOT_IN_PARTY`.

Addon-language messages, animation-only emotes, headless sessions, unrelated packets, and client-generated
loot/combat/status lines are excluded. Chat formatting codes and the original language/text are preserved.
The core may rewrite language or text between incoming and outgoing observations.

## HTTP contract

The module sends `POST` with `Content-Type: application/json`, optionally
`Authorization: Bearer <token>`. Each body has this shape:

```json
{
  "schema_version": 1,
  "source_id": "production-realm-1",
  "events": [
    {
      "event_id": "97022b65-0e9a-4a32-bf17-836688338308:1",
      "captured_at": "2026-10-05T10:00:00.123Z",
      "direction": "incoming",
      "observation": "client_submission",
      "opcode": "CMSG_MESSAGECHAT",
      "opcode_id": 149,
      "event_kind": "chat",
      "session": {
        "account_id": 10,
        "character_guid": "GUID Full: 0x0000000000000001 Type: Player Low: 1",
        "character_name": "Alice",
        "locale": "enUS"
      },
      "sender": {
        "guid": "GUID Full: 0x0000000000000001 Type: Player Low: 1",
        "name": "Alice"
      },
      "target": null,
      "channel": null,
      "text": "hello",
      "chat_type": "GUILD",
      "chat_type_id": 4,
      "language": 7,
      "notice": null,
      "emote": null,
      "decoding_status": "ok",
      "raw_packet_base64": null
    }
  ]
}
```

- Event IDs combine a cryptographically random process UUID with a queue sequence. Gaps are allowed.
  Retries preserve the exact body and IDs. The receiver should deduplicate by `source_id` and `event_id`.
- `captured_at` is UTC at the hook, with millisecond precision. Queue sequence gives capture enqueue order,
  not a causal ordering across concurrent producers.
- `session` is the sender on incoming events and recipient on outgoing events. It never contains IPs,
  account names, or credentials. Chat text itself is forwarded verbatim, including submitted commands.
- GUIDs use AzerothCore's `ObjectGuid::ToString()` format. Null GUID/name members indicate missing data.
  Normal player chat packets contain sender GUIDs without sender names. Embedded NPC/GM names are retained.
- Recipient character identity uses snapshots from player lifecycle hooks so outgoing callbacks never
  dereference a player on another thread. The database-load hook records identity before MOTD and other
  login packets; the login hook refreshes it and the logout hook clears it. Character fields can still
  be null before character loading or during logout; account ID and locale remain available.
  No database queries or background world-object lookups occur.
- `target` is an explicit packet target, such as a whisper destination, and is distinct from the session
  recipient. Incoming whisper names survive even when the player cannot be resolved. Outgoing packets
  with a zero target GUID produce an actor object with null members. Guild/group IDs are not in these packets.
- `event_kind` is `chat`, `text_emote`, or `notice`. `chat_type` is the enum name without `CHAT_MSG_`;
  `chat_type_id` and `language` are numeric wire values. Notice IDs/emote IDs are identifiers rather than
  reconstructed client-localized prose. MOTD uses `notice.lines`; channel listings use `notice.members`.
- Applicable decoded details also include `chat_flags`, `chat_tag`, and `achievement_id`. Notices expose
  IDs, actor/target GUIDs, flags, names, counts, or lines according to their packet layout.
- `decoding_status` is `ok`, `malformed`, `unsupported`, or `trailing_bytes`. Non-`ok` events include the
  captured bytes as `raw_packet_base64`. Invalid UTF-8 falls back to this representation. Unknown defense
  packet layouts are preserved as `unsupported`, without guessing a layout absent from this core.

Any final HTTP 2xx acknowledges the entire batch; no response body is required. Partial acknowledgement
is unsupported. Network failures, 408, 429, and 5xx retry the same batch with exponential delays from
1 to 60 seconds. `Retry-After` accepts seconds or an HTTP date and is capped at 60 seconds. Other statuses,
including redirects and authentication errors, discard that batch and increment rejection counters.

## Capacity, failure, and shutdown

Defaults: 10,000 events, 16 MiB queue budget, batches of up to 100 events / 512 KiB, one-second flush,
64 KiB maximum packet. Producers copy and enqueue under short locks and never wait for network I/O or
queue space. At capacity, the newest event is dropped. Pending batches retain their queue reservation.

The byte budget includes captured packet/metadata capacity, conservative per-entry overhead, and two
reserved batch buffers (serialization and HTTP request). It is not a limit on the worldserver's total RSS:
bounded temporary decoding objects, TLS/HTTP state, allocator overhead, and the identity cache are additional.
Events that cannot fit in an encoded batch are dropped individually so they cannot permanently block delivery.

Valid settings: positive queue/event/packet limits; at most 1,000,000 queued events, 1 GiB queue budget,
64 KiB packets, 8 MiB batches, and 60-second flush. Batch events cannot exceed queue events; batch bytes
must be at least 1024 and less than half the queue budget. Source ID must be valid UTF-8 and 1–256 bytes.
Connect timeout must be positive and no greater than the total request timeout (at most 60 seconds).

One worker performs all decoding and delivery. DNS/TCP/TLS have a three-second connection deadline;
the entire request has a five-second deadline by default. Response headers are limited to 16 KiB and
response bodies are ignored. Shutdown stops admission, allows five seconds to drain, then cancels requests
and counts remaining events as lost. Retry delays are interruptible by this deadline.

**DNS cleanup limitation:** Boost.Asio delegates hostname lookup to the operating system. The application
deadline cancels the request, and a cancelled resolver cannot accumulate further requests or payloads.
However, OS resolver cleanup can outlast that deadline during final transport destruction. Numeric-IP
endpoints avoid hostname lookup; for HTTPS their certificate must be valid for that IP. The five-second
drain window is therefore not a hard upper bound on process shutdown during a stalled OS DNS lookup.

No disk persistence is provided. Crashes lose buffered events; sustained outages can exhaust the queue.
Retrying after an ambiguous network failure can duplicate events at the receiver. This is best-effort
capture and delivery, not a durable or exactly-once audit log.

`module.chatlogger` logs counters every 60 seconds and at shutdown: queue size/accounted bytes, retries,
decode/capture failures, and captured/sent/overflow/oversized/rejected/shutdown-dropped totals by direction.
Delivery errors are rate-limited to once per 30 seconds and contain only status/action information.
For visibility, configure the normal AzerothCore logger hierarchy to include this category at INFO.

## Validation

The module's `.cmake` file registers tests with `ACORE_MODULE_TEST_SOURCES` when `BUILD_TESTING=ON`.
Tests stay outside `src/` and do not enter production source discovery. They cover core packet builders,
incoming submissions, malformed data, Unicode, notices/emotes, recipient copies, concurrent producers,
byte/count limits, batching, retries, fake-clock shutdown, and isolated loopback HTTP/HTTPS peers. HTTPS tests
cover trust and hostname verification using a public test-only certificate/key. The tests require
neither a running realm nor a database. Build/test execution follows the repository's explicit-build policy.

After explicitly configuring/building a testing checkout, run the `ChatLogger*` Google Test filters in
`unit_tests`. No live-stack e2e tests are added.

Run the existing C++ style checker with this module as its working directory to check authored `src/`:

```sh
cd modules/mod-chat-widget
python3 ../../apps/codestyle/codestyle-cpp.py
```

## Dependencies and licensing

Authored code is GPL-2.0-or-later; see `LICENSE`. Boost and OpenSSL come from the existing AzerothCore build.
The vendored JSON header is nlohmann JSON 3.12.0 (MIT), with its license in `vendor/nlohmann/LICENSE.MIT`.
See `vendor/README.md` for its source and pinned checksum.
