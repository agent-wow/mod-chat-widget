// SPDX-License-Identifier: GPL-2.0-or-later

import { $ } from "bun";
import { readConfig } from "./config.ts";
import { createReceiver } from "./receiver.ts";
import { ChatStore } from "./store.ts";

async function main(): Promise<void> {
  const config = readConfig(Bun.env);
  if (config.dbPath !== ":memory:") {
    const path = Bun.pathToFileURL(config.dbPath);
    await $`mkdir -p ${Bun.fileURLToPath(new URL(".", path))}`.quiet();
  }
  let store: ChatStore;
  try {
    store = new ChatStore({ path: config.dbPath, retentionDays: config.retentionDays, maxEvents: config.maxEvents });
  } catch {
    throw new Error("Could not open chat history database");
  }
  let receiver: ReturnType<typeof createReceiver>;
  try {
    receiver = createReceiver({ host: config.host, port: config.port, bearerToken: config.bearerToken, store });
  } catch {
    store.close();
    throw new Error("Could not start chat receiver listener");
  }
  console.error(`Chat logger receiver listening on ${config.host}:${receiver.server.port}, POST /chats, GET /widget`);
  let stopping = false;
  function shutdown(): void {
    if (stopping) {
      return;
    }
    stopping = true;
    console.error("Chat logger receiver stopping; allowing up to five seconds to finish writes");
    const deadline = setTimeout(() => {
      void receiver.server.stop(true);
      process.exit(1);
    }, 5000);
    void receiver.stop().then(() => {
      clearTimeout(deadline);
    }, () => {
      clearTimeout(deadline);
      console.error("Chat logger receiver: shutdown failed");
      process.exit(1);
    });
  }
  // Bun's documented signal API is the process global.
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

try {
  await main();
} catch (error) {
  console.error(`Chat logger receiver: ${error instanceof Error ? error.message : "startup failed"}`);
  process.exitCode = 1;
}
