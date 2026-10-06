// SPDX-License-Identifier: GPL-2.0-or-later

import { $ } from "bun";
import { afterEach } from "bun:test";
import { createReceiver } from "../src/receiver.ts";
import type { ReceiverOptions } from "../src/receiver.ts";

const cleanups: (() => void | Promise<unknown>)[] = [];
export function cleanup(action: () => void | Promise<unknown>): void { cleanups.push(action); }
afterEach(async () => {
  for (const action of cleanups.splice(0).reverse()) {
    await action();
  }
});

export const alice = "GUID Full: 0x0000000000000001 Type: Player Low: 1";
export const bob = "GUID Full: 0x0000000000000002 Type: Player Low: 2";
const example = await Bun.file(new URL("../examples/batch.json", import.meta.url)).json();
export function sampleBatch() { return structuredClone(example); }
export function outgoing(id = "out:1", guid = alice, name = "Alice") {
  return {
    ...sampleBatch().events[0], event_id: id, direction: "outgoing", observation: "send_attempt",
    opcode: "SMSG_MESSAGECHAT", opcode_id: 150,
    session: { account_id: 10, character_guid: guid, character_name: name, locale: "enUS" },
    sender: { guid: bob, name: "Bob" },
  };
}
export function batch(...events: Record<string, unknown>[]) {
  return { schema_version: 1 as const, source_id: "realm-1", events };
}

export function presence(sequence = 1, status = "online", loginId = "11111111-1111-4111-8111-111111111111",
  startedAt = "2026-10-06T12:00:00.000Z", capturedAt = startedAt, guid = alice) {
  return {
    ...outgoing(`presence:${loginId}:${sequence}`, guid), event_kind: "presence", observation: "character_presence",
    opcode: null, opcode_id: null, captured_at: capturedAt, sequence: String(sequence), presence: status,
    session: { ...outgoing().session, character_guid: guid, login_id: loginId, started_at: startedAt },
  };
}

export function sessionMessage(id: string, login = presence()) {
  return { ...outgoing(id), session: login.session, captured_at: login.captured_at };
}

export function fixture(options: ReceiverOptions = {}) {
  const lines: string[] = [];
  const diagnostics: string[] = [];
  const receiver = createReceiver({
    port: 0, output: { async write(line) { lines.push(line); } },
    diagnostic: (message) => { diagnostics.push(message); }, ...options,
  });
  cleanup(async () => {
    void receiver.server.stop(true);
    await receiver.stop();
  });
  const send = (body: BodyInit = JSON.stringify(sampleBatch()), init: RequestInit = {}) =>
    fetch(new URL("/chats", receiver.server.url), {
      method: "POST", body, ...init,
      headers: { "Content-Type": "application/json", Connection: "close", ...init.headers },
    });
  const get = (path: string) => fetch(new URL(path, receiver.server.url), { headers: { Connection: "close" } });
  return { receiver, lines, diagnostics, send, get };
}

export async function temporaryDirectory(): Promise<string> {
  const root = Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp";
  const directory = `${root}/chat-receiver-${crypto.randomUUID()}`;
  await $`mkdir -p ${directory}`.quiet();
  cleanup(() => $`rm -rf ${directory}`.quiet());
  return directory;
}

export async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) { throw new Error("Condition timed out"); }
    await Bun.sleep(5);
  }
}

export async function rawRequest(port: number, request: string): Promise<string> {
  const result = Promise.withResolvers<string>();
  let response = "";
  const socket = await Bun.connect({
    hostname: "127.0.0.1", port,
    socket: {
      open(socket) { socket.write(request); },
      data(_socket, data) { response += new TextDecoder().decode(data); },
      close() { result.resolve(response); },
      error(_socket, error) { result.reject(error); },
    },
  });
  const timer = setTimeout(() => {
    socket.terminate();
    result.reject(new Error("Socket timed out"));
  }, 3000);
  try { return await result.promise; } finally { clearTimeout(timer); socket.terminate(); }
}
