// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("a copied receiver starts independently, writes only batches to stdout, and stops on SIGTERM", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "chat-logger-receiver-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  // Copy only runtime files, with no dependencies or connection to the AzerothCore tree.
  await cp(new URL("../src/", import.meta.url), join(directory, "src"), { recursive: true });
  await cp(new URL("../package.json", import.meta.url), join(directory, "package.json"));
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const child = spawn(process.execPath, ["src/main.ts"], {
    cwd: directory,
    env: {
      ...process.env,
      CHAT_LOGGER_HOST: "127.0.0.1",
      CHAT_LOGGER_PORT: String(port),
      CHAT_LOGGER_BEARER_TOKEN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
  });
  let stdout = "";
  let stderr = "";
  const ready = Promise.withResolvers<void>();
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
    if (stderr.includes("receiver listening")) {
      ready.resolve();
    }
  });
  await Promise.race([ready.promise, exited.then(() => { throw new Error("Receiver exited before listening"); })]);
  const body = await readFile(new URL("../examples/batch.json", import.meta.url), "utf8");
  const response = await fetch(`http://127.0.0.1:${port}/chat`, {
    method: "POST", headers: { "Content-Type": "application/json", "Connection": "close" }, body,
  });
  assert.equal(response.status, 204);
  child.kill("SIGTERM");
  assert.deepEqual(await exited, [0, null]);
  assert.equal(stdout.split("\n").length, 2);
  assert.deepEqual(JSON.parse(stdout), JSON.parse(body));
  assert.match(stderr, /receiver stopping/u);
  assert.ok(!stderr.includes("hello"));
});

test("bad configuration exits unsuccessfully without logging a token or writing stdout", async () => {
  const child = spawn(process.execPath, [new URL("../src/main.ts", import.meta.url).pathname], {
    env: { ...process.env, CHAT_LOGGER_BEARER_TOKEN: "private\nsecret" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  assert.deepEqual(await once(child, "exit"), [1, null]);
  assert.equal(stdout, "");
  assert.match(stderr, /CHAT_LOGGER_BEARER_TOKEN/u);
  assert.ok(!stderr.includes("private"));
});
