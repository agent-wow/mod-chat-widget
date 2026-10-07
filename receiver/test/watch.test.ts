// SPDX-License-Identifier: GPL-2.0-or-later
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { ChatStore } from "../src/store.ts";
import { ChatStreams } from "../src/streams.ts";
import { isBatch } from "../src/batch.ts";
import { alice, bob, batch, cleanup, fixture, presence, sessionMessage, temporaryDirectory } from "./helpers.ts";
const target = { guid: bob, name: "Bob" };
const baseTime = "2026-10-06T12:00:00.000Z";
function watched(sequence = 1, watchTarget: typeof target | null = null) {
  return { ...presence(sequence), watch_target: watchTarget };
}
test("watch state respects presence ordering, logout, silence, sessions, and realm isolation", () => {
  let now = Date.parse(baseTime); const store = new ChatStore({ now: () => now }); cleanup(() => store.close());
  store.ingest(batch(watched(1, target)));
  expect(store.watchedGuid("realm-1", alice)).toBe(bob);
  expect(store.watchedGuid("elsewhere", alice)).toBeNull();
  store.ingest(batch(watched(2))); store.ingest(batch(watched(1, target)));
  expect(store.watchedGuid("realm-1", alice)).toBe(alice);
  store.ingest(batch(watched(3, target))); now += 15000;
  expect(store.watchedGuid("realm-1", alice)).toBeNull();
  store.ingest(batch({ ...watched(4, target), presence: "offline" }));
  expect(store.watchedGuid("realm-1", alice)).toBe(alice);
  store.ingest(batch(watched(5, target)));
  expect(store.watchedGuid("realm-1", alice)).toBe(alice);
  store.ingest(batch(presence(1, "online", "22222222-2222-4222-8222-222222222222",
    "2026-10-06T12:00:15.000Z")));
  expect(store.watchedGuid("realm-1", alice)).toBe(alice);
});
test("watch payload validates optional and malformed metadata", () => {
  expect(isBatch(batch(presence()))).toBe(true);
  expect(isBatch(batch(watched(1, target)))).toBe(true);
  for (const invalid of [false, {}, { guid: "", name: "Name" }, { guid: "Bob", name: 4 }]) {
    expect(isBatch(batch({ ...presence(), watch_target: invalid }))).toBe(false);
  }
});
test("version 2 migration and restart preserve history and assignment age", async () => {
  const path = `${await temporaryDirectory()}/migration.sqlite`;
  let now = Date.parse(baseTime);
  let store = new ChatStore({ path, now: () => now });
  store.ingest(batch(presence(), sessionMessage("saved"))); const saved = store.history("realm-1", alice);
  store.close();
  const legacy = new Database(path);
  legacy.run("ALTER TABLE presence DROP COLUMN watch_target"); legacy.run("PRAGMA user_version = 2"); legacy.close();
  store = new ChatStore({ path, now: () => now });
  expect(store.history("realm-1", alice).messages).toEqual(saved.messages);
  expect(store.watchedGuid("realm-1", alice)).toBe(alice);
  store.ingest(batch(watched(2, target))); store.close();
  now += 15000;
  store = new ChatStore({ path, now: () => now }); cleanup(() => store.close());
  expect(store.watchedGuid("realm-1", alice)).toBeNull();
  expect(store.history("realm-1", alice).messages).toEqual(saved.messages);
});
test("follow SSE resets current-login history on retarget/reconnect and clears stale routing", async () => {
  let now = Date.parse(baseTime); const store = new ChatStore({ now: () => now }); cleanup(() => store.close());
  const bobLogin = presence(1, "online", "22222222-2222-4222-8222-222222222222", baseTime, baseTime, bob);
  store.ingest(batch(watched(1, target), bobLogin, sessionMessage("bob", bobLogin), sessionMessage("observer")));
  const streams = new ChatStreams(store, () => {}); cleanup(() => streams.close());
  const response = streams.response(new Request("http://localhost/api/chat/stream?follow=watch&after=invalid"),
    "realm-1", alice, null, true);
  const reader = response.body!.getReader(); const decoder = new TextDecoder();
  const next = async () => {
    const text = decoder.decode((await reader.read()).value);
    return JSON.parse(text.match(/data: (.*)\n/)![1]!);
  };
  try {
    const first = await next(); expect(first.character.guid).toBe(bob); expect(first.reset).toBe(true);
    expect(first.messages).toHaveLength(1);
    store.ingest(batch(watched(2))); streams.publish();
    const second = await next(); expect(second.character.guid).toBe(alice); expect(second.reset).toBe(true);
    expect(second.messages).toHaveLength(1);
    now += 15000; expect(await next()).toBeNull();
  } finally { await reader.cancel(); }
  const latest = { ...watched(3, target), captured_at: new Date(now).toISOString() };
  store.ingest(batch(latest));
  const resumed = streams.response(new Request("http://localhost/api/chat/stream?after=old"),
    "realm-1", alice, null, true);
  const retry = resumed.body!.getReader();
  try { expect(decoder.decode((await retry.read()).value)).toContain('"reset":true'); }
  finally { await retry.cancel(); }
});

test("HTTP watch selection is opt-in, waits on missing state, and rejects invalid modes", async () => {
  const store = new ChatStore({ now: () => Date.parse(baseTime) });
  const { send, get } = fixture({ store });
  const bobLogin = presence(1, "online", "22222222-2222-4222-8222-222222222222", baseTime, baseTime, bob);
  await send(JSON.stringify(batch(watched(1, target), bobLogin, sessionMessage("bob", bobLogin))));
  const route = `/api/chat?source=realm-1&guid=${encodeURIComponent(alice)}`;
  expect((await (await get(route)).json()).character.guid).toBe(alice);
  expect((await (await get(`${route}&follow=watch`)).json()).character.guid).toBe(bob);
  expect(await (await get("/api/chat?source=realm-1&guid=missing&follow=watch")).json()).toBeNull();
  for (const follow of ["follow=bad", "follow=", "follow=watch&follow=watch"]) {
    expect((await get(`${route}&${follow}`)).status).toBe(400);
    expect((await get(`/api/chat/stream?source=realm-1&guid=observer&${follow}`)).status).toBe(400);
  }
});
