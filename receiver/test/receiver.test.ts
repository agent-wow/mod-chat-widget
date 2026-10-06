// SPDX-License-Identifier: GPL-2.0-or-later

import { expect, test } from "bun:test";
import { readConfig } from "../src/config.ts";
import { MAX_BODY_BYTES } from "../src/receiver.ts";
import { ChatStore } from "../src/store.ts";
import { alice, bob, batch, fixture, outgoing, presence, rawRequest, sampleBatch, until } from "./helpers.ts";

test("submission and individual recipient copies remain unchanged in stdout", async () => {
  const { send, lines, diagnostics } = fixture();
  const value = sampleBatch();
  value.events[0].text = "|cffff0000héllo|r\nsecond line";
  value.events.push(outgoing("copy:1"), outgoing("copy:2", bob, "Bob"), {
    ...outgoing("copy:3"), session: { account_id: 13, character_guid: null, character_name: null, locale: "frFR" },
    extension: { kept: true },
  });
  const response = await send(JSON.stringify(value), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
  expect(response.status).toBe(204);
  expect(await response.text()).toBe("");
  expect(lines).toHaveLength(1);
  expect(lines[0]!.split("\n")).toHaveLength(2);
  expect(JSON.parse(lines[0]!)).toEqual(value);
  expect(diagnostics).toEqual([]);
});

test("decoding failures, nulls and unrecognized optional fields still reach stdout", async () => {
  const { send, lines } = fixture();
  const value = batch(...["ok", "malformed", "unsupported", "trailing_bytes"].map((status, i) => ({
    ...outgoing(`process:${i}`), event_kind: i % 2 ? "notice" : "text_emote", text: null,
    decoding_status: status, raw_packet_base64: status === "ok" ? null : "AP8=",
    sender: 10, target: [], channel: {}, notice: { lines: ["Welcome", 123] }, emote: { id: 1 },
  })));
  expect((await send(JSON.stringify(value))).status).toBe(204);
  expect(JSON.parse(lines[0]!)).toEqual(value);
});

test("retries remain stdout lines but do not duplicate widget messages", async () => {
  const { send, get, lines } = fixture();
  const body = JSON.stringify(batch(outgoing()));
  expect((await send(body)).status).toBe(204);
  expect((await send(body)).status).toBe(204);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toBe(lines[1]);
  expect((await (await get("/api/chat?source=realm-1&character=alice")).json()).messages).toHaveLength(1);
});

test("login notices resolve lowercase names, and an identified MOTD appears after the capture fix", async () => {
  const { send, get } = fixture();
  const login = await Bun.file(new URL("./fixtures/login.json", import.meta.url)).json();
  const body = JSON.stringify(login);
  expect((await send(body)).status).toBe(204);
  const response = await get("/api/chat?source=realm-1&character=peon");
  expect(response.status).toBe(200);
  const initial = await response.json();
  expect(initial.character).toEqual({ guid: alice, name: "Peon" });
  expect(initial.messages.map((line: { text: string }) => line.text)).toEqual([
    "Joined Channel: [General - GM Island]", "Joined Channel: [LocalDefense - GM Island]",
  ]);
  expect(initial.messages.every((line: { color: string }) => line.color === "#ffc0c0")).toBe(true);
  expect((await send(body)).status).toBe(204);
  const query = `/api/chat?source=realm-1&character=PEON&after=${encodeURIComponent(initial.cursor)}`;
  expect((await (await get(query)).json()).messages).toEqual([]);
  expect((await (await get(`/api/chat?source=realm-1&guid=${encodeURIComponent(bob)}`)).json()).messages)
    .toEqual([]);
  expect((await get("/api/chat?source=realm-2&character=peon")).status).toBe(404);

  // A new capture supplies the real recipient. Do not infer it from the account-only MOTD above.
  const motd = { ...login.events[0], event_id: "identified:motd", session: login.events[1].session };
  const leave = { ...login.events[1], event_id: "leave:general", notice: { id: 3, channel_id: 1, constant: 1 } };
  expect((await send(JSON.stringify(batch(motd, leave)))).status).toBe(204);
  const update = await (await get(query)).json();
  expect(update.messages.map((line: { text: string }) => line.text)).toEqual([
    login.events[0].notice.lines.join("\n"), "Left Channel: [General - GM Island]",
  ]);
});

test("ingestion authentication does not restrict widget reads or leak tokens", async () => {
  const { send, get, lines, diagnostics } = fixture({ bearerToken: "test-only-token" });
  for (const token of ["", "Bearer wrong", "Basic test-only-token"]) {
    const response = await send(undefined, { headers: { Authorization: token } });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  }
  expect(lines).toEqual([]);
  expect((await send(undefined, { headers: { Authorization: "Bearer test-only-token" } })).status).toBe(204);
  expect((await get("/widget?source=realm-1&character=Alice")).status).toBe(200);
  expect((await get("/api/characters?source=realm-1")).status).toBe(200);
  expect([...lines, ...diagnostics].join("")).not.toContain("test-only-token");
});

test("invalid JSON, UTF-8 and metadata reject the whole batch without output", async () => {
  const { send, lines } = fixture();
  for (const body of ["", "{broken", '{"events":NaN}', new Uint8Array([0xff])]) {
    expect((await send(body)).status).toBe(400);
  }
  for (const value of [null, [], {}, { ...sampleBatch(), schema_version: 2 },
    { ...sampleBatch(), source_id: "" }, batch(outgoing(), {}),
    batch({ ...outgoing(), observation: "delivered" }), batch({ ...outgoing(), event_kind: {} })]) {
    expect((await send(JSON.stringify(value))).status).toBe(422);
  }
  expect(lines).toEqual([]);
  expect((await send()).status).toBe(204);
});

test("presence observations require an identified login and valid lifecycle metadata", async () => {
  const { send, lines } = fixture();
  const login = presence();
  for (const invalid of [
    { presence: "maybe" }, { sequence: "0" }, { sequence: "invalid" }, { opcode: "SMSG_MESSAGECHAT" },
    { observation: "send_attempt" }, { direction: "incoming" }, { decoding_status: "malformed" },
    { session: { ...login.session, login_id: null } }, { session: { ...login.session, started_at: "invalid" } },
    { session: { ...login.session, character_guid: null } },
  ]) {
    expect((await send(JSON.stringify(batch({ ...login, ...invalid })))).status).toBe(422);
  }
  expect(lines).toEqual([]);
  expect((await send(JSON.stringify(batch(login)))).status).toBe(204);
});

test("routing, methods, content types and compression are validated", async () => {
  const { send, get } = fixture();
  expect((await get("/")).status).toBe(404);
  const response = await get("/chats");
  expect(response.status).toBe(405);
  expect(response.headers.get("allow")).toBe("POST");
  const invalidHeaders: Record<string, string>[] = [{ "Content-Type": "text/plain" }, { "Content-Encoding": "gzip" }];
  for (const headers of invalidHeaders) {
    expect((await send(undefined, { headers })).status).toBe(415);
  }
});

test("declared and streamed bodies over 8 MiB receive 413", async () => {
  const { receiver, send, lines } = fixture();
  const response = await rawRequest(receiver.server.port!,
    `POST /chats HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Type: application/json\r\n` +
    `Content-Length: ${MAX_BODY_BYTES + 1}\r\n\r\n`);
  expect(response).toContain("413");
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_BODY_BYTES).fill(32));
      controller.enqueue(new Uint8Array([32]));
      controller.close();
    },
  });
  expect((await send(stream)).status).toBe(413);
  expect(lines).toEqual([]);
});

test("the maximum body size is accepted", async () => {
  const { send, lines } = fixture();
  const body = JSON.stringify(sampleBatch());
  const padded = body + " ".repeat(MAX_BODY_BYTES - new TextEncoder().encode(body).byteLength);
  expect((await send(padded)).status).toBe(204);
  expect(JSON.parse(lines[0]!)).toEqual(sampleBatch());
});

test("backpressure holds four slots, serializes writes, and delays history publication", async () => {
  const gate = Promise.withResolvers<void>();
  let writes = 0;
  const { receiver, send, get } = fixture({ output: { async write() { ++writes; await gate.promise; } } });
  let acknowledged = 0;
  const pending = Array.from({ length: 4 }, (_, i) => send(JSON.stringify(batch(outgoing(`out:${i}`))))
    .then((response) => { ++acknowledged; return response; }));
  try {
    await until(() => receiver.activeRequests === 4 && writes === 1);
    expect(acknowledged).toBe(0);
    const before = await (await get(`/api/chat?source=realm-1&guid=${encodeURIComponent(alice)}`)).json();
    expect(before.messages).toEqual([]);
    const busy = await send();
    expect(busy.status).toBe(503);
    expect(busy.headers.get("retry-after")).toBe("1");
  } finally {
    gate.resolve();
  }
  expect((await Promise.all(pending)).every((response) => response.status === 204)).toBe(true);
  expect(writes).toBe(4);
});

test("stdout failure fails closed without including chat in diagnostics", async () => {
  const { send, diagnostics } = fixture({ output: { async write() { throw new Error("private chat"); } } });
  expect((await send()).status).toBe(503);
  expect((await send()).status).toBe(503);
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics.join("")).not.toContain("private chat");
});

test("storage failure returns 503 after stdout, and a retry can recover", async () => {
  class FailingStore extends ChatStore {
    fail = true;
    override ingest(value: Parameters<ChatStore["ingest"]>[0]): void {
      if (this.fail) { throw new Error("private database error"); }
      super.ingest(value);
    }
  }
  const store = new FailingStore();
  const { send, lines, diagnostics } = fixture({ store });
  const value = JSON.stringify(batch(outgoing()));
  expect((await send(value)).status).toBe(503);
  expect(store.history("realm-1", alice).messages).toEqual([]);
  store.fail = false;
  expect((await send(value)).status).toBe(204);
  expect(store.history("realm-1", alice).messages).toHaveLength(1);
  expect(lines).toHaveLength(2);
  expect(diagnostics.join("")).not.toContain("private database error");
});

test("a slow incomplete body reaches the receive deadline and frees its slot", async () => {
  const { receiver, send } = fixture({ bodyTimeoutMs: 50 });
  const response = await rawRequest(receiver.server.port!,
    "POST /chats HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Type: application/json\r\n" +
    "Content-Length: 1000\r\n\r\n{");
  expect(response).toContain("408");
  expect(receiver.activeRequests).toBe(0);
  expect((await send()).status).toBe(204);
});

test("aborted uploads free their slot and do not disable subsequent ingestion", async () => {
  const { receiver, send, lines } = fixture({ bodyTimeoutMs: 500 });
  const socket = await Bun.connect({
    hostname: "127.0.0.1", port: receiver.server.port!,
    socket: {
      open(socket) {
        socket.write("POST /chats HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n" +
          "Content-Length: 1000\r\n\r\n{");
      },
      data() {}, error() {},
    },
  });
  try { await until(() => receiver.activeRequests === 1); } finally { socket.terminate(); }
  await until(() => receiver.activeRequests === 0);
  expect(lines).toEqual([]);
  expect((await send()).status).toBe(204);
});

test("shutdown drains accepted writes and closes storage after the final commit", async () => {
  const gate = Promise.withResolvers<void>();
  const store = new ChatStore();
  let saved = 0;
  let started = false;
  const originalClose = store.close.bind(store);
  store.close = () => { saved = store.history("realm-1", alice).messages.length; originalClose(); };
  const { receiver, send } = fixture({ store, output: { async write() { started = true; await gate.promise; } } });
  const pending = send(JSON.stringify(batch(outgoing())));
  await until(() => started);
  let stopped = false;
  const stop = receiver.stop().then(() => { stopped = true; });
  expect(stopped).toBe(false);
  gate.resolve();
  expect((await pending).status).toBe(204);
  await stop;
  expect(saved).toBe(1);
});

test("widget queries require a source and a single unambiguous character", async () => {
  const { send, get } = fixture();
  for (const path of ["/api/chat", "/api/chat?source=realm-1", "/api/chat?source=realm-1&guid=a&character=A"]) {
    expect((await get(path)).status).toBe(400);
  }
  expect((await get("/api/chat?source=realm-1&character=Alice")).status).toBe(404);
  await send(JSON.stringify(batch(outgoing(), outgoing("other:1", bob, "Alice"))));
  expect((await get("/api/chat?source=realm-1&character=ALICE")).status).toBe(409);
  const response = await get(`/api/chat?source=realm-1&guid=${encodeURIComponent(alice)}`);
  expect(response.status).toBe(200);
  expect((await response.json()).messages).toHaveLength(1);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect((await (await get("/api/characters?source=other")).json()).characters).toEqual([]);
});

test("widget assets are local and protect against interpreting chat as page code", async () => {
  const { get } = fixture();
  const html = await get("/widget");
  expect(html.headers.get("content-security-policy")).toContain("script-src 'self'");
  expect(await html.text()).toContain('id="messages"');
  for (const path of ["/widget.css", "/widget.js", "/format.js"]) {
    expect((await get(path)).status).toBe(200);
  }
  expect((await get("/src/main.ts")).status).toBe(404);
});

test("configuration validates Bun and SQLite settings without exposing credentials", () => {
  expect(readConfig({})).toEqual({
    host: "127.0.0.1", port: 3000, bearerToken: "", dbPath: "./data/chat.sqlite", retentionDays: 7, maxEvents: 100000,
  });
  expect(readConfig({ CHAT_LOGGER_HOST: "::1", CHAT_LOGGER_PORT: "8080" }).port).toBe(8080);
  for (const value of ["", "0", "-1", "65536", "3000.5", " 3000", "3000abc"]) {
    expect(() => readConfig({ CHAT_LOGGER_PORT: value })).toThrow("CHAT_LOGGER_PORT");
  }
  for (const name of ["CHAT_LOGGER_MAX_EVENTS", "CHAT_LOGGER_RETENTION_DAYS"]) {
    for (const value of ["0", "-1", "1.5", "9007199254740992"]) {
      expect(() => readConfig({ [name]: value })).toThrow(name);
    }
  }
  expect(() => readConfig({ CHAT_LOGGER_DB_PATH: "\0" })).toThrow("CHAT_LOGGER_DB_PATH");
  expect(() => readConfig({ CHAT_LOGGER_HOST: " " })).toThrow("CHAT_LOGGER_HOST");
  expect(() => readConfig({ CHAT_LOGGER_BEARER_TOKEN: "private\nsecret" }))
    .toThrow("CHAT_LOGGER_BEARER_TOKEN must use HTTP bearer-token characters");
});
