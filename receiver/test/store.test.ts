// SPDX-License-Identifier: GPL-2.0-or-later

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { ChatStore } from "../src/store.ts";
import { format, project } from "../src/projection.ts";
import { tokenize } from "../src/web/format.js";
import { alice, bob, batch, cleanup, outgoing, sampleBatch, temporaryDirectory } from "./helpers.ts";

function store(options: ConstructorParameters<typeof ChatStore>[0] = {}) {
  const result = new ChatStore(options);
  cleanup(() => result.close());
  return result;
}

test("recipient and source boundaries exclude submissions, other recipients, and unidentified sessions", () => {
  const db = store();
  db.ingest(batch(sampleBatch().events[0], outgoing("a"), outgoing("b", bob, "Bob"), {
    ...outgoing("c"), session: { account_id: 3, character_guid: null, character_name: null, locale: "enUS" },
  }));
  db.ingest({ ...batch({ ...outgoing("a"), text: "other realm" }), source_id: "realm-2" });
  expect(db.history("realm-1", alice).messages.map((line) => line.text)).toEqual(["hello"]);
  expect(db.history("realm-1", bob).messages).toHaveLength(1);
  expect(db.history("realm-2", alice).messages.map((line) => line.text)).toEqual(["other realm"]);
  expect(db.history("missing", alice).messages).toEqual([]);
});

test("names are learned across batches, scoped to source, and not overwritten by older captures", () => {
  const db = store();
  db.ingest(batch({ ...outgoing(), sender: { guid: bob, name: null } }));
  expect(db.history("realm-1", alice).messages[0]!.prefix).toContain("Unknown player");
  db.ingest({ ...batch({ ...outgoing("b", bob, "Elsewhere"), sender: null }), source_id: "realm-2" });
  expect(db.history("realm-1", alice).messages[0]!.prefix).toContain("Unknown player");
  db.ingest(batch({ ...sampleBatch().events[0], captured_at: "2026-10-06T10:00:00.000Z",
    session: { account_id: 2, character_guid: bob, character_name: "Bób", locale: "enUS" }, sender: null }));
  expect(db.history("realm-1", alice).messages[0]!.prefix).toContain("Bób");
  db.ingest(batch({ ...outgoing("older", bob, "Oldname"), sender: null }));
  expect(db.characters("realm-1", "BÓB")).toEqual([{ guid: bob, name: "Bób" }]);
});

test("incoming and outgoing whispers identify the other character correctly", () => {
  const db = store();
  db.ingest(batch({ ...outgoing("in"), chat_type: "WHISPER" },
    { ...outgoing("out"), chat_type: "WHISPER_INFORM" }));
  expect(db.history("realm-1", alice).messages.map((line) => line.prefix))
    .toEqual(["[Bob] whispers: ", "To [Bob]: "]);
});

test("history returns the latest 100 and cursors page forward without dropping bursts", () => {
  const db = store();
  db.ingest(batch(...Array.from({ length: 110 }, (_, i) => ({ ...outgoing(`start:${i}`), text: String(i) }))));
  const initial = db.history("realm-1", alice);
  expect(initial.messages).toHaveLength(100);
  expect(initial.messages[0]!.text).toBe("10");
  const empty = db.history("realm-1", alice, initial.cursor);
  expect(empty.messages).toEqual([]);
  db.ingest(batch(...Array.from({ length: 150 }, (_, i) => ({ ...outgoing(`next:${i}`), text: String(i + 110) }))));
  const first = db.history("realm-1", alice, empty.cursor);
  const second = db.history("realm-1", alice, first.cursor);
  expect(first.hasMore).toBe(true);
  expect(second.hasMore).toBe(false);
  expect([...first.messages, ...second.messages].map((line) => line.text))
    .toEqual(Array.from({ length: 150 }, (_, i) => String(i + 110)));
  expect(db.history("realm-1", alice, second.cursor).messages).toEqual([]);
});

test("count retention and time retention invalidate old cursors, including during silence", () => {
  let now = Date.now();
  const db = store({ maxEvents: 2, retentionDays: 1, now: () => now });
  const empty = db.history("realm-1", alice);
  db.ingest(batch(outgoing("1"), outgoing("2"), outgoing("3")));
  const countReset = db.history("realm-1", alice, empty.cursor);
  expect(countReset.reset).toBe(true);
  expect(countReset.messages).toHaveLength(2);
  now += 86400001;
  const aged = db.history("realm-1", alice, countReset.cursor);
  expect(aged.reset).toBe(true);
  expect(aged.messages).toEqual([]);
  expect(db.characters("realm-1")).toEqual([]);
  expect(db.history("realm-1", alice, "invalid").reset).toBe(true);
});

test("database restart retains history, deduplication, names, and valid cursors", async () => {
  const path = `${await temporaryDirectory()}/chat.sqlite`;
  const first = new ChatStore({ path });
  first.ingest(batch(outgoing()));
  const saved = first.history("realm-1", alice);
  first.close();
  const second = store({ path });
  second.ingest(batch(outgoing()));
  expect(second.history("realm-1", alice).messages).toEqual(saved.messages);
  expect(second.history("realm-1", alice, saved.cursor).messages).toEqual([]);
  expect(second.history("realm-1", alice, saved.cursor).reset).toBe(false);
  const replacement = store();
  expect(replacement.history("realm-1", alice, saved.cursor).reset).toBe(true);
});

test("a SQLite failure halfway through a batch rolls back both events and identities", async () => {
  const path = `${await temporaryDirectory()}/chat.sqlite`;
  const db = store({ path });
  const connection = new Database(path);
  try {
    connection.run(`CREATE TRIGGER reject_event BEFORE INSERT ON events WHEN NEW.event_id = 'fail'
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    expect(() => db.ingest(batch(outgoing("first"), outgoing("fail", bob, "Bob")))).toThrow();
    expect(db.history("realm-1", alice).messages).toEqual([]);
    expect(db.characters("realm-1")).toEqual([]);
    connection.run("DROP TRIGGER reject_event");
    db.ingest(batch(outgoing("first"), outgoing("fail", bob, "Bob")));
    expect(db.history("realm-1", alice).messages).toHaveLength(1);
    expect(db.history("realm-1", bob).messages).toHaveLength(1);
  } finally { connection.close(); }
});

test("malformed optional fields cannot poison storage or invent client-localized messages", () => {
  const db = store();
  db.ingest(batch(
    { ...outgoing("bad"), decoding_status: "malformed" },
    { ...outgoing("unknown"), decoding_status: "unsupported" },
    { ...outgoing("emote"), event_kind: "text_emote", opcode: "SMSG_TEXT_EMOTE", text: null, emote: { id: 1 } },
    { ...outgoing("addon"), language: 4294967295 },
    { ...outgoing("optional"), sender: 10, channel: {}, chat_tag: [], text: "safe" },
    { ...outgoing("motd"), event_kind: "notice", opcode: "SMSG_MOTD", notice: { lines: ["Welcome", {}, "旅人"] } },
  ));
  expect(db.history("realm-1", alice).messages.map((line) => line.text)).toEqual(["safe", "Welcome\n旅人"]);
  const emote = project({ ...outgoing(), chat_type: "EMOTE", text: "waves." })!;
  expect(format(emote, "Bob").prefix).toBe("Bob ");
});

test("WoW colors, pipes, and item links become inert text runs", () => {
  expect(tokenize("héllo || |cffa335ee|Hitem:123:0|h[Shiny sword]|h|r!"))
    .toEqual([
      { text: "héllo | ", color: null }, { text: "[Shiny sword]", color: "#a335ee" }, { text: "!", color: null },
    ]);
  expect(tokenize("x|TInterface\\Icons\\foo:16|ty|Aatlas:16|az")).toEqual([{ text: "xyz", color: null }]);
  expect(tokenize("x|Hsecret-data")).toEqual([{ text: "x", color: null }]);
  expect(tokenize('<img src=x onerror="alert(1)">|Hjavascript:evil|h<script>evil</script>|h'))
    .toEqual([{ text: '<img src=x onerror="alert(1)"><script>evil</script>', color: null }]);
  expect(tokenize("|cbad|rtext").map((run) => run.text).join("")).toBe("|cbadtext");
});

test("channel confirmations require decoded outgoing notices and keep channel names literal", () => {
  const notice = {
    ...outgoing(), event_kind: "notice", opcode: "SMSG_CHANNEL_NOTIFY", text: null,
    channel: "General", notice: { id: 2 },
  };
  for (const invalid of [
    { notice: { id: "2" } }, { notice: { id: 0 } }, { notice: { id: 255 } }, { notice: null },
    { channel: null }, { channel: {} }, { channel: "" }, { direction: "incoming" },
    { decoding_status: "malformed" }, { decoding_status: "unsupported" }, { event_kind: "text_emote" },
  ]) {
    expect(project({ ...notice, ...invalid })).toBeNull();
  }
  const channel = '<script>alert(1)</script> |cff00ff00旅人|r |Hhidden|h[label]|h';
  const content = project({ ...notice, channel, decoding_status: "trailing_bytes" })!;
  const display = format(content, "Unknown player");
  expect(display.prefix).toBe("");
  expect(tokenize(display.text)).toEqual([{ text: `Joined Channel: [${channel}]`, color: null }]);
});
