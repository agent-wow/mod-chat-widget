// SPDX-License-Identifier: GPL-2.0-or-later

import { readConfig } from "./config.ts";
import { createReceiver } from "./receiver.ts";

function main(): void {
  const config = readConfig(process.env);
  const server = createReceiver({ bearerToken: config.bearerToken });
  server.on("error", (error: NodeJS.ErrnoException) => {
    // Error codes are useful diagnostics without exposing configuration or chat text.
    process.stderr.write(`Chat logger receiver: server error (${error.code ?? "unknown"})\n`);
    process.exitCode = 1;
  });
  server.listen(config.port, config.host, () => {
    process.stderr.write(`Chat logger receiver listening on ${config.host}:${config.port}, POST /chat\n`);
  });

  let stopping = false;
  function shutdown(): void {
    if (stopping) {
      return;
    }
    stopping = true;
    process.stderr.write("Chat logger receiver stopping; allowing up to five seconds to finish writes\n");
    const deadline = setTimeout(() => {
      server.closeAllConnections();
      process.exit(1);
    }, 5_000);
    deadline.unref();
    server.close(() => {
      // Also drain writes belonging to clients that disconnected before receiving their acknowledgement.
      process.stdout.write("", (error) => {
        clearTimeout(deadline);
        if (error) {
          process.exitCode = 1;
        }
      });
    });
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

try {
  main();
} catch (error) {
  process.stderr.write(`Chat logger receiver: ${error instanceof Error ? error.message : "startup failed"}\n`);
  process.exitCode = 1;
}
