// SPDX-License-Identifier: GPL-2.0-or-later

import { expect, test } from "bun:test";
import { ChatStore } from "../src/store.ts";
import { ChatStreams } from "../src/streams.ts";
import { alice, bob, batch, cleanup, fixture, outgoing, until } from "./helpers.ts";

type Page = ReturnType<ChatStore["history"]>;

async function openStream(url: URL, headers: Record<string, string> = {}) {
  const abort = new AbortController();
  cleanup(() => abort.abort());
  const response = await fetch(url, { headers, signal: abort.signal });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-accel-buffering")).toBe("no");
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  async function next(includeHeartbeat = false, timeoutMs = 3000) {
    const deadline = setTimeout(() => abort.abort(), timeoutMs);
    try {
      while (true) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (frame.startsWith(":")) {
            if (includeHeartbeat) { return { event: "heartbeat", id: undefined, data: frame }; }
            continue;
          }
          const fields = Object.fromEntries(frame.split("\n").map((line) => {
            const colon = line.indexOf(":");
            return [line.slice(0, colon), line.slice(colon + 1).trimStart()];
          }));
          return { event: fields.event, id: fields.id, data: JSON.parse(fields.data!) };
        }
        const { value, done } = await reader.read();
        if (done) { return null; }
        buffer += value;
      }
    } finally {
      clearTimeout(deadline);
    }
  }
  return { next, close: () => abort.abort() };
}

function streamURL(receiver: ReturnType<typeof fixture>["receiver"], selection = `guid=${encodeURIComponent(alice)}`) {
  return new URL(`/api/chat/stream?source=realm-1&${selection}`, receiver.server.url);
}

test("SSE sends recent history, all catch-up pages, and committed live messages without duplicates", async () => {
  const { receiver, send } = fixture();
  await send(JSON.stringify(batch(...Array.from({ length: 105 }, (_, i) => outgoing(`initial:${i}`)))));
  const stream = await openStream(streamURL(receiver));
  const initial = (await stream.next())!;
  expect(initial.event).toBe("chat");
  expect(initial.id).toBe(initial.data.cursor);
  expect(initial.data.messages).toHaveLength(100);
  expect(initial.data.messages[0].id).toBe(6);
  const events = batch(...Array.from({ length: 251 }, (_, i) => ({ ...outgoing(`live:${i}`), text: `line ${i}` })));
  expect((await send(JSON.stringify(events))).status).toBe(204);
  const pages: Page[] = [];
  for (let i = 0; i < 3; ++i) { pages.push((await stream.next())!.data); }
  expect(pages.map((page) => page.messages.length)).toEqual([100, 100, 51]);
  expect(pages.map((page) => page.hasMore)).toEqual([true, true, false]);
  expect(pages.flatMap((page) => page.messages.map((message) => message.text)))
    .toEqual(Array.from({ length: 251 }, (_, i) => `line ${i}`));
  expect((await send(JSON.stringify(events))).status).toBe(204);
  await send(JSON.stringify(batch({ ...outgoing("final"), text: "héllo\nworld" })));
  expect((await stream.next())!.data.messages.map((message: { text: string }) => message.text))
    .toEqual(["héllo\nworld"]);
});

test("SSE isolates source and recipient, remains readable without an ingestion token, and advances empty cursors",
  async () => {
    const { receiver, send } = fixture({ bearerToken: "test-token" });
    const stream = await openStream(streamURL(receiver));
    const initial = (await stream.next())!.data;
    expect(initial.messages).toEqual([]);
    const auth = { headers: { Authorization: "Bearer test-token" } };
    await send(JSON.stringify({ ...batch(outgoing()), source_id: "other-realm" }), auth);
    const other = (await stream.next())!.data;
    expect(other.messages).toEqual([]);
    expect(other.cursor).not.toBe(initial.cursor);
    await send(JSON.stringify(batch(outgoing("bob:1", bob, "Bob"), outgoing("alice:1"))), auth);
    expect((await stream.next())!.data.messages).toHaveLength(1);
  });

test("unknown names wait on the stream, resolve on ingestion, and stay pinned to the resolved GUID", async () => {
  const { receiver, send } = fixture();
  const stream = await openStream(streamURL(receiver, "character=alice"));
  expect((await stream.next())!.data).toEqual({ status: 404, error: "Waiting for this character to be observed" });
  // Incoming observations can identify the recipient without creating displayable messages.
  await send(JSON.stringify(batch({ ...outgoing(), direction: "incoming", observation: "client_submission" })));
  const identified = (await stream.next())!.data;
  expect(identified.character.guid).toBe(alice);
  expect(identified.messages).toEqual([]);
  await send(JSON.stringify(batch(outgoing("namesake", bob, "Alice"), outgoing("renamed", alice, "Newname"))));
  const live = (await stream.next())!.data;
  expect(live.character).toEqual({ guid: alice, name: "Newname" });
  expect(live.messages).toHaveLength(1);
  // Restore the original name so two sessions have it.
  await send(JSON.stringify(batch(outgoing("oldname", alice, "Alice"))));
  const fresh = await openStream(streamURL(receiver, "character=Alice"));
  expect((await fresh.next())!.data.status).toBe(409);
  expect(await fresh.next()).toBeNull();
});

test("reconnects resume with after or Last-Event-ID and reset expired or foreign cursors", async () => {
  const store = new ChatStore({ maxEvents: 3 });
  const { receiver, send } = fixture({ store });
  await send(JSON.stringify(batch(outgoing("one"))));
  const first = await openStream(streamURL(receiver));
  const cursor = (await first.next())!.id!;
  first.close();
  await send(JSON.stringify(batch(outgoing("two"))));
  const resumed = await openStream(streamURL(receiver, `guid=${encodeURIComponent(alice)}&after=${cursor}`));
  const update = (await resumed.next())!.data;
  expect(update.reset).toBe(false);
  expect(update.messages).toHaveLength(1);
  resumed.close();
  const header = await openStream(streamURL(receiver, `guid=${encodeURIComponent(alice)}&after=invalid`), {
    "Last-Event-ID": update.cursor,
  });
  expect((await header.next())!.data.messages).toEqual([]);
  header.close();
  await send(JSON.stringify(batch(outgoing("three"), outgoing("four"))));
  for (const after of [cursor, `${crypto.randomUUID()}:0:0`]) {
    const reset = await openStream(streamURL(receiver, `guid=${encodeURIComponent(alice)}&after=${after}`));
    const page = (await reset.next())!.data;
    expect(page.reset).toBe(true);
    expect(page.messages).toHaveLength(3);
    reset.close();
  }
});

test("SSE validates method, source, and selection before subscribing", async () => {
  const { receiver, get } = fixture();
  for (const path of ["/api/chat/stream", "/api/chat/stream?source=realm-1",
    "/api/chat/stream?source=realm-1&guid=a&character=A"]) {
    expect((await get(path)).status).toBe(400);
  }
  const response = await fetch(streamURL(receiver), { method: "POST" });
  expect(response.status).toBe(405);
  expect(response.headers.get("allow")).toBe("GET");
});

test("SSE heartbeats survive Bun's idle timeout without reading history", async () => {
  const store = new ChatStore();
  let reads = 0;
  const history = store.history.bind(store);
  store.history = (...args) => { ++reads; return history(...args); };
  const { receiver, send } = fixture({ store });
  const stream = await openStream(streamURL(receiver));
  await stream.next();
  expect((await stream.next(true, 18000))!.event).toBe("heartbeat");
  expect(reads).toBe(1);
  await send(JSON.stringify(batch(outgoing())));
  expect((await stream.next())!.data.messages).toHaveLength(1);
}, 20000);

test("SSE waits for stdout and storage, and open streams do not prevent graceful shutdown", async () => {
  const gate = Promise.withResolvers<void>();
  let writing = false;
  const { receiver, send } = fixture({ output: { async write() { writing = true; await gate.promise; } } });
  cleanup(() => gate.resolve());
  const stream = await openStream(streamURL(receiver));
  await stream.next();
  let delivered = false;
  const next = stream.next().then((event) => { delivered = true; return event; });
  const pending = send(JSON.stringify(batch(outgoing())));
  await until(() => writing);
  expect(delivered).toBe(false);
  gate.resolve();
  expect((await pending).status).toBe(204);
  expect((await next)!.data.messages).toHaveLength(1);
  const stopped = receiver.stop();
  expect(await stream.next()).toBeNull();
  await stopped;
});

test("slow streams coalesce notifications and release subscriptions when cancelled or aborted", async () => {
  const store = new ChatStore();
  cleanup(() => store.close());
  const streams = new ChatStreams(store, () => {});
  cleanup(() => streams.close());
  let reads = 0;
  const history = store.history.bind(store);
  store.history = (...args) => { ++reads; return history(...args); };
  const abort = new AbortController();
  const response = streams.response(new Request("http://localhost/", { signal: abort.signal }), "realm-1", alice, null);
  await until(() => reads === 1);
  for (let i = 0; i < 20; ++i) {
    store.ingest(batch(outgoing(`slow:${i}`)));
    streams.publish();
  }
  expect(reads).toBe(1);
  const reader = response.body!.getReader();
  await reader.read(); // Initial empty snapshot.
  const frame = new TextDecoder().decode((await reader.read()).value);
  expect(JSON.parse(frame.split("data: ")[1]!).messages).toHaveLength(20);
  await reader.cancel();
  const cancelledReads = reads;
  streams.publish();
  expect(reads).toBe(cancelledReads);
  const other = streams.response(new Request("http://localhost/", { signal: abort.signal }), "realm-1", alice, null);
  const otherReader = other.body!.getReader();
  await otherReader.read();
  abort.abort();
  expect((await otherReader.read()).done).toBe(true);
  const abortedReads = reads;
  streams.publish();
  expect(reads).toBe(abortedReads);
});
