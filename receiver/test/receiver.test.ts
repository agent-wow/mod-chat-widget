// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { readConfig } from "../src/config.ts";
import { createReceiver, MAX_BODY_BYTES } from "../src/receiver.ts";
import type { ReceiverOptions } from "../src/receiver.ts";

function sampleBatch() {
  return JSON.parse(readFileSync(new URL("../examples/batch.json", import.meta.url), "utf8"));
}

async function fixture(context: TestContext, options: ReceiverOptions = {}) {
  const lines: string[] = [];
  const diagnostics: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  const server = createReceiver({ output, diagnostic: (message) => diagnostics.push(message), ...options });
  context.after(async () => {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, lines, diagnostics };
}

interface RequestOptions {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  chunks?: Buffer[];
}

function send(server: Server, body = JSON.stringify(sampleBatch()), options: RequestOptions = {}) {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    const client = request({
      hostname: "127.0.0.1",
      port: (server.address() as AddressInfo).port,
      path: options.path ?? "/chat",
      method: options.method ?? "POST",
      agent: false,
      headers: { "Content-Type": "application/json", ...options.headers },
    }, (response) => {
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { responseBody += chunk; });
      response.on("end", () => resolve({
        status: response.statusCode!, headers: response.headers, body: responseBody,
      }));
      response.on("error", reject);
    });
    client.on("error", reject);
    client.setTimeout(5_000, () => client.destroy(new Error("Test request timed out")));
    if (options.chunks) {
      for (const chunk of options.chunks) {
        client.write(chunk);
      }
      client.end();
    } else {
      client.end(body);
    }
  });
}

test("one submission and three recipient copies are preserved as four distinct events", async (context) => {
  const { server, lines, diagnostics } = await fixture(context);
  const batch = sampleBatch();
  batch.events[0].text = "|cffff0000héllo|r\nsecond line";
  for (let i = 0; i < 3; ++i) {
    batch.events.push({
      ...structuredClone(batch.events[0]),
      event_id: `97022b65-0e9a-4a32-bf17-836688338308:${i + 2}`,
      direction: "outgoing",
      observation: "send_attempt",
      opcode: "SMSG_MESSAGECHAT",
      opcode_id: 150,
      session: { account_id: i + 10, character_guid: null, character_name: null, locale: "frFR" },
      extension: { kept: true },
    });
  }
  const response = await send(server, JSON.stringify(batch), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
  assert.equal(response.status, 204);
  assert.equal(response.body, "");
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.split("\n").length, 2);
  assert.deepEqual(JSON.parse(lines[0]!), batch);
  assert.deepEqual(diagnostics, []);
});

test("packet decoding failures, notices, emotes, and null fields are accepted unchanged", async (context) => {
  const { server, lines } = await fixture(context);
  const batch = sampleBatch();
  batch.events = ["ok", "malformed", "unsupported", "trailing_bytes"].map((status, i) => ({
    ...batch.events[0],
    event_id: `process:${i}`,
    event_kind: i % 2 ? "notice" : "text_emote",
    text: null,
    decoding_status: status,
    raw_packet_base64: status === "ok" ? null : "AP8=",
    notice: { lines: ["Welcome", "Bienvenue"], members: [] },
    emote: { emote_id: 1 },
  }));
  assert.equal((await send(server, JSON.stringify(batch))).status, 204);
  assert.deepEqual(JSON.parse(lines[0]!), batch);
});

test("retries are logged again with their original IDs and source", async (context) => {
  const { server, lines } = await fixture(context);
  assert.equal((await send(server)).status, 204);
  assert.equal((await send(server)).status, 204);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], lines[1]);
});

test("configured bearer token is required and never logged", async (context) => {
  const { server, lines, diagnostics } = await fixture(context, { bearerToken: "test-only-token" });
  for (const authorization of ["", "Bearer wrong", "Basic test-only-token"]) {
    const response = await send(server, undefined, { headers: { Authorization: authorization } });
    assert.equal(response.status, 401);
    assert.equal(response.headers["www-authenticate"], "Bearer");
  }
  assert.deepEqual(lines, []);
  assert.equal((await send(server, undefined, {
    headers: { Authorization: "Bearer test-only-token" },
  })).status, 204);
  assert.equal(lines.length, 1);
  assert.ok(!lines.join("").includes("test-only-token"));
  assert.deepEqual(diagnostics, []);
});

test("invalid JSON or any invalid event rejects the entire batch without output", async (context) => {
  const { server, lines } = await fixture(context);
  for (const body of ["", "{broken", "{\"events\":NaN}"]) {
    assert.equal((await send(server, body)).status, 400);
  }
  for (const value of [null, [], {}, { ...sampleBatch(), schema_version: 2 },
    { ...sampleBatch(), source_id: "" }, { ...sampleBatch(), events: [sampleBatch().events[0], {}] }]) {
    assert.equal((await send(server, JSON.stringify(value))).status, 422);
  }
  const batch = sampleBatch();
  batch.events[0].observation = "delivered";
  assert.equal((await send(server, JSON.stringify(batch))).status, 422);
  batch.events[0].event_kind = { toString: "not callable" };
  assert.equal((await send(server, JSON.stringify(batch))).status, 422);
  assert.deepEqual(lines, []);
  // Rejected input does not disable later valid requests.
  assert.equal((await send(server)).status, 204);
});

test("invalid UTF-8 is rejected instead of replacing chat text", async (context) => {
  const { server, lines } = await fixture(context);
  const body = JSON.stringify(sampleBatch()).replace("hello", "PLACEHOLDER");
  const [before, after] = body.split("PLACEHOLDER");
  const response = await send(server, "", {
    chunks: [Buffer.from(before!), Buffer.from([0xff]), Buffer.from(after!)],
  });
  assert.equal(response.status, 400);
  assert.deepEqual(lines, []);
});

test("routing, method, media type, and compressed bodies are rejected", async (context) => {
  const { server, lines } = await fixture(context);
  assert.equal((await send(server, undefined, { path: "/" })).status, 404);
  const wrongMethod = await send(server, "", { method: "GET" });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.allow, "POST");
  assert.equal((await send(server, undefined, { headers: { "Content-Type": "text/plain" } })).status, 415);
  assert.equal((await send(server, undefined, { headers: { "Content-Encoding": "gzip" } })).status, 415);
  assert.deepEqual(lines, []);
});

test("declared and chunked bodies over 8 MiB receive 413 without output", async (context) => {
  const { server, lines } = await fixture(context);
  assert.equal((await send(server, "", {
    headers: { "Content-Length": String(MAX_BODY_BYTES + 1) },
  })).status, 413);
  assert.equal((await send(server, "", {
    chunks: [Buffer.alloc(MAX_BODY_BYTES, " "), Buffer.from(" ")],
  })).status, 413);
  assert.deepEqual(lines, []);
});

test("the largest module batch size is accepted", async (context) => {
  const { server, lines } = await fixture(context);
  const body = JSON.stringify(sampleBatch());
  const padded = body + " ".repeat(MAX_BODY_BYTES - Buffer.byteLength(body));
  assert.equal((await send(server, padded)).status, 204);
  assert.deepEqual(JSON.parse(lines[0]!), sampleBatch());
});

test("204 waits for stdout and excess concurrent requests get a retryable response", async (context) => {
  let completeWrite: ((error?: Error | null) => void) | undefined;
  const firstWrite = Promise.withResolvers<void>();
  const output = new Writable({
    write(_chunk, _encoding, done) {
      completeWrite = done;
      firstWrite.resolve();
    },
  });
  const { server } = await fixture(context, { output });
  let acknowledged = 0;
  const pending = Array.from({ length: 4 }, () => send(server).then((response) => {
    ++acknowledged;
    return response;
  }));
  await firstWrite.promise;
  // Wait until all four complete bodies reach the receiver before sending the fifth.
  while (output.writableLength < 4 * Buffer.byteLength(JSON.stringify(sampleBatch()) + "\n")) {
    await setImmediate();
  }
  assert.equal(acknowledged, 0);
  const busy = await send(server);
  assert.equal(busy.status, 503);
  assert.equal(busy.headers["retry-after"], "1");
  for (let i = 0; i < 4; ++i) {
    completeWrite!();
  }
  assert.ok((await Promise.all(pending)).every((response) => response.status === 204));
});

test("stdout failure never acknowledges a batch and diagnostics omit contents", async (context) => {
  const output = new Writable({
    write(_chunk, _encoding, done) {
      done(new Error("secret chat text must not appear in diagnostics"));
    },
  });
  const { server, diagnostics } = await fixture(context, { output });
  assert.equal((await send(server)).status, 503);
  assert.equal((await send(server)).status, 503);
  assert.equal(diagnostics.length, 1);
  assert.ok(!diagnostics.join("").includes("secret chat text"));
});

test("an interrupted upload does not disable stdout for subsequent requests", async (context) => {
  const { server, diagnostics } = await fixture(context);
  const aborted = Promise.withResolvers<void>();
  server.once("request", (incoming) => {
    incoming.once("aborted", () => aborted.resolve());
  });
  const client = request({
    host: "127.0.0.1", port: (server.address() as AddressInfo).port, path: "/chat", method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": "1000" },
  });
  client.on("error", () => {});
  const received = once(server, "request");
  client.write("{");
  await received;
  client.destroy();
  await aborted.promise;
  assert.equal((await send(server)).status, 204);
  assert.deepEqual(diagnostics, []);
});

test("standalone configuration has local defaults and validates without exposing secrets", () => {
  assert.deepEqual(readConfig({}), { host: "127.0.0.1", port: 3000, bearerToken: "" });
  assert.deepEqual(readConfig({
    CHAT_LOGGER_HOST: "::1", CHAT_LOGGER_PORT: "8080", CHAT_LOGGER_BEARER_TOKEN: "test-only==",
  }), { host: "::1", port: 8080, bearerToken: "test-only==" });
  for (const port of ["", "0", "-1", "65536", "3000.5", " 3000", "3000abc"]) {
    assert.throws(() => readConfig({ CHAT_LOGGER_PORT: port }), /CHAT_LOGGER_PORT/u);
  }
  assert.throws(() => readConfig({ CHAT_LOGGER_HOST: " " }), /CHAT_LOGGER_HOST/u);
  assert.throws(() => readConfig({ CHAT_LOGGER_BEARER_TOKEN: "private\nsecret" }), (error: Error) => {
    assert.ok(!error.message.includes("private"));
    return true;
  });
});
