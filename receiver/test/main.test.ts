// SPDX-License-Identifier: GPL-2.0-or-later

import { $ } from "bun";
import { expect, test } from "bun:test";
import { batch, cleanup, outgoing, temporaryDirectory } from "./helpers.ts";

const executable = Bun.which("bun") ?? `${Bun.env.HOME}/.bun/bin/bun`;

test("a copied receiver starts with Bun alone, persists chat, serves assets, and stops on SIGTERM", async () => {
  const directory = await temporaryDirectory();
  await $`cp -R ${Bun.fileURLToPath(new URL("../src", import.meta.url))} ${directory}/src`.quiet();
  await Bun.write(`${directory}/package.json`, Bun.file(new URL("../package.json", import.meta.url)));
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port!;
  await probe.stop(true);
  async function launch() {
    const child = Bun.spawn([executable, "src/main.ts"], {
      cwd: directory,
      env: { ...Bun.env, CHAT_LOGGER_HOST: "127.0.0.1", CHAT_LOGGER_PORT: String(port),
        CHAT_LOGGER_BEARER_TOKEN: "", CHAT_LOGGER_DB_PATH: "./data/chat.sqlite" },
      stdout: "pipe", stderr: "pipe",
    });
    cleanup(async () => { if (child.exitCode === null) { child.kill("SIGKILL"); } await child.exited; });
    const ready = Promise.withResolvers<void>();
    let stderr = "";
    const errors = (async () => {
      for await (const chunk of child.stderr) {
        stderr += new TextDecoder().decode(chunk);
        if (stderr.includes("receiver listening")) { ready.resolve(); }
      }
    })();
    const stdout = new Response(child.stdout).text();
    await Promise.race([ready.promise, child.exited.then(() => { throw new Error(`Startup failed: ${stderr}`); })]);
    return { child, stdout, errors, stderr: () => stderr };
  }
  const first = await launch();
  const value = batch(outgoing());
  expect((await fetch(`http://127.0.0.1:${port}/chat`, {
    method: "POST", headers: { "Content-Type": "application/json", Connection: "close" }, body: JSON.stringify(value),
  })).status).toBe(204);
  expect((await fetch(`http://127.0.0.1:${port}/widget.js`)).status).toBe(200);
  first.child.kill("SIGTERM");
  expect(await first.child.exited).toBe(0);
  await first.errors;
  expect(JSON.parse(await first.stdout)).toEqual(value);
  expect(first.stderr()).toContain("receiver stopping");
  expect(first.stderr()).not.toContain("hello");
  const second = await launch();
  const history = await fetch(`http://127.0.0.1:${port}/api/chat?source=realm-1&character=Alice`);
  expect((await history.json()).messages).toHaveLength(1);
  second.child.kill("SIGTERM");
  expect(await second.child.exited).toBe(0);
  expect(await second.stdout).toBe("");
  await second.errors;
});

test("invalid configuration exits unsuccessfully without exposing a token", async () => {
  const child = Bun.spawn([executable, Bun.fileURLToPath(new URL("../src/main.ts", import.meta.url))], {
    env: { ...Bun.env, CHAT_LOGGER_BEARER_TOKEN: "private\nsecret" }, stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect(code).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toContain("CHAT_LOGGER_BEARER_TOKEN");
  expect(stderr).not.toContain("private");
});

test("a listener startup failure closes the output writer and exits", async () => {
  const occupied = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  cleanup(() => occupied.stop(true));
  const child = Bun.spawn([executable, Bun.fileURLToPath(new URL("../src/main.ts", import.meta.url))], {
    env: { ...Bun.env, CHAT_LOGGER_HOST: "127.0.0.1", CHAT_LOGGER_PORT: String(occupied.port),
      CHAT_LOGGER_BEARER_TOKEN: "", CHAT_LOGGER_DB_PATH: ":memory:" }, stdout: "pipe", stderr: "pipe",
    timeout: 3000,
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect(code).toBe(1);
  expect(child.signalCode).toBeNull();
  expect(stdout).toBe("");
  expect(stderr).toContain("Could not start chat receiver listener");
});
