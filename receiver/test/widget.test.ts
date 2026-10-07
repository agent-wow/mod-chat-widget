// SPDX-License-Identifier: GPL-2.0-or-later

import { runInNewContext } from "node:vm";
import { expect, test } from "bun:test";
import { tokenize } from "../src/web/format.js";
import { resolveObserver, validFollow, SelectionError } from "../src/web/follow.js";

const widget = (await Bun.file(new URL("../src/web/widget.js", import.meta.url)).text())
  .replace('import { tokenize } from "./format.js";', "")
  .replace('import { resolveObserver, validFollow, SelectionError } from "./follow.js";', "");

class Element {
  children: Element[] = [];
  parent?: Element;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  textContent = "";
  className = "";
  get firstElementChild() { return this.children[0]; }
  append(child: Element) { child.parent = this; this.children.push(child); }
  replaceChildren() { this.children = []; }
  remove() { this.parent!.children = this.parent!.children.filter((child) => child !== this); }
}

function loadWidget(search = "?source=realm-1&character=Alice") {
  const connections: Connection[] = [];
  class Connection extends EventTarget {
    url: URL;
    closed = false;
    onerror?: () => void;
    constructor(url: string) {
      super();
      this.url = new URL(url, "http://localhost");
      connections.push(this);
    }
    close() { this.closed = true; }
    emit(type: string, body: unknown) { this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(body) })); }
    fail() { this.onerror?.(); }
  }
  const messages = new Element();
  const status = new Element();
  const document = {
    title: "", getElementById: (id: string) => id === "messages" ? messages : status,
    createElement: () => new Element(),
    createTextNode: (text: string) => Object.assign(new Element(), { textContent: text }),
  };
  const window = new EventTarget();
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let sequence = 0;
  runInNewContext(widget, {
    document, window, location: { search }, URLSearchParams, TextEncoder, EventSource: Connection, tokenize,
    resolveObserver, validFollow, SelectionError,
    fetch() { throw new Error("The widget must not poll"); },
    setTimeout(callback: () => void, delay: number) { timers.set(++sequence, { callback, delay }); return sequence; },
    clearTimeout(id: number) { timers.delete(id); },
  });
  function retry() {
    expect(timers.size).toBe(1);
    const [id, timer] = [...timers][0]!;
    timers.delete(id);
    timer.callback();
  }
  return { connections, messages, status, document, timers, window, retry };
}

function page(ids: number[], cursor = "cursor:1", reset = false) {
  return {
    character: { guid: "alice-guid", name: "Alice" }, cursor, reset, hasMore: false,
    state: { login_id: "login-1", presence: "online", age_ms: 0, stale: false, updated_at: "now" },
    messages: ids.map((id) => ({ id, text: `Message ${id}`, color: "#ffffff", prefix: "[Guild] Bob: " })),
  };
}

test("widget renders SSE and reconnects by GUID and cursor while retaining its messages", () => {
  const widget = loadWidget();
  expect(widget.connections).toHaveLength(1);
  const first = widget.connections[0]!;
  expect(first.url.pathname).toBe("/api/chat/stream");
  expect(first.url.searchParams.get("session")).toBe("current");
  first.emit("chat", page([1]));
  expect(widget.document.title).toBe("Alice — Chat");
  expect(widget.messages.children).toHaveLength(1);
  expect(widget.timers.size).toBe(1); // Freshness deadline, not a history poll.
  first.fail();
  expect(first.closed).toBe(true);
  expect(widget.status.textContent).toBe("Reconnecting…");
  expect(widget.messages.children).toHaveLength(1);
  widget.retry();
  const second = widget.connections[1]!;
  expect(second.url.searchParams.get("guid")).toBe("alice-guid");
  expect(second.url.searchParams.has("character")).toBe(false);
  expect(second.url.searchParams.get("after")).toBe("cursor:1");
  second.emit("chat", page([1, 2], "cursor:2"));
  expect(widget.messages.children).toHaveLength(2);
  expect(widget.status.textContent).toBe("");
  second.emit("chat", page([2], "reset:2", true));
  expect(widget.messages.children).toHaveLength(1);
  expect(widget.messages.children[0]!.dataset.id).toBe("2");
});

test("widget follows character status, expires silent presence, and replaces chat on a new login", () => {
  const widget = loadWidget();
  const connection = widget.connections[0]!;
  connection.emit("chat", page([1]));
  const transfer = page([]);
  transfer.state.presence = "unavailable";
  connection.emit("chat", transfer);
  expect(widget.messages.children).toHaveLength(1);
  expect(widget.status.textContent).toContain("Character changing maps");
  widget.retry(); // Expire presence without receiving another SSE event.
  expect(widget.status.textContent).toBe("Stale · Showing last known chat");
  const offline = page([], "offline", true);
  offline.state.presence = "offline";
  connection.emit("chat", offline);
  expect(widget.messages.children).toEqual([]);
  expect(widget.status.textContent).toBe("Offline");
  expect(widget.timers.size).toBe(0);
  connection.emit("chat", page([2], "login-2", true));
  expect(widget.messages.children.map((line) => line.dataset.id)).toEqual(["2"]);
  const waiting = page([], "waiting", true);
  waiting.state.presence = "unknown";
  connection.emit("chat", waiting);
  expect(widget.status.textContent).toContain("come online");
  expect(widget.messages.children).toEqual([]);
});

test("widget caps displayed messages and resumes after empty cursor updates", () => {
  const widget = loadWidget("?source=realm-1&guid=alice-guid");
  const connection = widget.connections[0]!;
  connection.emit("chat", page(Array.from({ length: 105 }, (_, i) => i + 1)));
  expect(widget.messages.children).toHaveLength(100);
  expect(widget.messages.children[0]!.dataset.id).toBe("6");
  connection.emit("chat", page([], "cursor:empty"));
  connection.fail();
  widget.retry();
  expect(widget.connections[1]!.url.searchParams.get("after")).toBe("cursor:empty");
});

test("widget waits for unknown names on its connection and stops on ambiguity", () => {
  const widget = loadWidget();
  const connection = widget.connections[0]!;
  connection.emit("status", { status: 404, error: "Waiting for this character to be observed" });
  expect(widget.status.textContent).toContain("Waiting");
  expect(connection.closed).toBe(false);
  expect(widget.timers.size).toBe(0);
  connection.emit("status", { status: 409, error: "Select a GUID" });
  expect(connection.closed).toBe(true);
  expect(widget.status.textContent).toBe("Select a GUID");
  connection.fail();
  expect(widget.timers.size).toBe(0);
});

test("widget backs off failed connections and cleans up and resumes across page navigation", () => {
  const widget = loadWidget();
  for (let i = 0; i < 6; ++i) {
    widget.connections.at(-1)!.fail();
    expect([...widget.timers.values()][0]!.delay).toBe(Math.min(1000 * 2 ** (i + 1), 30000));
    widget.retry();
  }
  widget.connections.at(-1)!.emit("chat", page([]));
  widget.connections.at(-1)!.fail();
  expect([...widget.timers.values()][0]!.delay).toBe(2000);
  widget.window.dispatchEvent(new Event("pagehide"));
  expect(widget.timers.size).toBe(0);
  expect(widget.connections.at(-1)!.closed).toBe(true);
  widget.window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
  expect(widget.connections.at(-1)!.closed).toBe(false);
  expect(widget.connections.at(-1)!.url.searchParams.get("guid")).toBe("alice-guid");
});

test("invalid widget selections never open a stream", () => {
  for (const search of ["", "?source=realm-1", "?source=realm-1&character=Alice&guid=alice-guid",
    `?source=${"a".repeat(257)}&character=Alice`]) {
    const widget = loadWidget(search);
    expect(widget.connections).toEqual([]);
    expect(widget.status.textContent).toContain("Select a source");
  }
});

test("watch following keeps observer selector, replaces messages, and reconnects without a target cursor", () => {
  const widget = loadWidget("?source=realm-1&guid=observer-guid&follow=watch");
  const first = widget.connections[0]!;
  expect(first.url.searchParams.get("follow")).toBe("watch");
  first.emit("chat", page([1], "alice:1", true));
  first.emit("chat", { ...page([2], "bob:1", true), character: { guid: "bob-guid", name: "Bob" } });
  expect(widget.messages.children).toHaveLength(1);
  expect(widget.messages.children[0]!.dataset.id).toBe("2");
  first.emit("chat", null); expect(widget.messages.children).toHaveLength(0);
  first.fail(); widget.retry();
  const second = widget.connections[1]!;
  expect(second.url.searchParams.get("guid")).toBe("observer-guid");
  expect(second.url.searchParams.has("after")).toBe(false);
  first.emit("chat", page([3])); expect(widget.messages.children).toHaveLength(0);
});

test("invalid and repeated follow modes never open a connection", () => {
  for (const follow of ["follow=bad", "follow=", "follow=watch&follow=watch"]) {
    expect(loadWidget(`?source=realm-1&guid=observer&${follow}`).connections).toHaveLength(0);
  }
});
