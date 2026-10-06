// SPDX-License-Identifier: GPL-2.0-or-later

import { isBatch } from "./batch.ts";
import { ChatStore } from "./store.ts";

export { isBatch } from "./batch.ts";
export type { Batch } from "./batch.ts";
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_ACTIVE_REQUESTS = 4;

export interface BatchOutput {
  write(line: string): Promise<void>;
  close?(): Promise<void>;
}

export interface ReceiverOptions {
  host?: string;
  port?: number;
  bearerToken?: string;
  output?: BatchOutput;
  diagnostic?: (message: string) => void;
  store?: ChatStore;
  bodyTimeoutMs?: number;
}

export function stdoutOutput(): BatchOutput {
  const writer = Bun.stdout.writer();
  return {
    async write(line) {
      writer.write(line);
      await writer.flush();
    },
    async close() { await writer.end(); },
  };
}

class RequestError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function failure(status: number, message: string, headers: Record<string, string> = {}): Response {
  return Response.json({ error: message }, {
    status, headers: {
      "Cache-Control": "no-store", "Connection": "close", ...headers,
      ...(status === 503 ? { "Retry-After": "1" } : {}),
    },
  });
}

async function readBody(request: Request, timeoutMs: number): Promise<Uint8Array> {
  if (!request.body) {
    return new Uint8Array();
  }
  const reader = request.body.getReader();
  const interrupted = Promise.withResolvers<never>();
  // A deadline covers the whole upload, including clients that keep sending single bytes.
  const timer = setTimeout(() => interrupted.reject(new RequestError(408, "Request body timed out")), timeoutMs);
  const aborted = () => interrupted.reject(new RequestError(400, "Request interrupted"));
  request.signal.addEventListener("abort", aborted, { once: true });
  try {
    if (request.signal.aborted) {
      throw new RequestError(400, "Request interrupted");
    }
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const { value, done } = await Promise.race([reader.read(), interrupted.promise]);
      if (done) {
        break;
      }
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        throw new RequestError(413, "Request body exceeds 8 MiB");
      }
      chunks.push(value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof RequestError) {
      throw error;
    }
    throw new RequestError(400, "Request interrupted");
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", aborted);
  }
}

const assets = new Map<string, readonly [string, string]>([
  ["/widget", ["widget.html", "text/html; charset=utf-8"]],
  ["/widget.css", ["widget.css", "text/css; charset=utf-8"]],
  ["/widget.js", ["widget.js", "text/javascript; charset=utf-8"]],
  ["/format.js", ["format.js", "text/javascript; charset=utf-8"]],
]);

export function createReceiver(options: ReceiverOptions = {}) {
  const output = options.output ?? stdoutOutput();
  const store = options.store ?? new ChatStore();
  const diagnostic = options.diagnostic ?? ((message) => console.error(message));
  const digest = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest();
  const expected = options.bearerToken ? digest(`Bearer ${options.bearerToken}`) : null;
  let outputFailed = false;
  let activeRequests = 0;
  let stopping = false;
  let writeQueue: Promise<void> = Promise.resolve();
  const pending = new Set<Promise<Response>>();
  let stopPromise: Promise<void> | undefined;

  async function ingest(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return failure(405, "Use POST /chats", { Allow: "POST" });
    }
    if (expected && !crypto.timingSafeEqual(expected, digest(request.headers.get("authorization") ?? ""))) {
      return failure(401, "Unauthorized", { "WWW-Authenticate": "Bearer" });
    }
    const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    const encoding = request.headers.get("content-encoding");
    if (contentType !== "application/json" || (encoding && encoding !== "identity")) {
      return failure(415, "An uncompressed application/json body is required");
    }
    if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) {
      return failure(413, "Request body exceeds 8 MiB");
    }
    if (stopping || outputFailed || activeRequests >= MAX_ACTIVE_REQUESTS) {
      return failure(503, "Receiver unavailable; retry this batch");
    }
    ++activeRequests;
    try {
      const body = await readBody(request, options.bodyTimeoutMs ?? 10000);
      let batch: unknown;
      try {
        batch = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
      } catch {
        throw new RequestError(400, "Invalid UTF-8 JSON");
      }
      if (!isBatch(batch)) {
        throw new RequestError(422, "Expected a schema_version 1 chat logger batch with valid event metadata");
      }
      let line: string;
      try {
        line = `${JSON.stringify(batch)}\n`;
      } catch {
        throw new RequestError(400, "JSON nesting exceeds receiver limits");
      }
      // Serialize writes and commits even while stdout applies backpressure.
      const accepted = batch;
      const write = writeQueue.then(async () => {
        if (outputFailed) {
          throw new RequestError(503, "Receiver unavailable; retry this batch");
        }
        try {
          await output.write(line);
        } catch {
          outputFailed = true;
          diagnostic("Chat logger receiver: stdout failed; new batches will receive HTTP 503");
          throw new RequestError(503, "Receiver unavailable; retry this batch");
        }
        store.ingest(accepted);
      });
      writeQueue = write.catch(() => {});
      await write;
      return new Response(null, { status: 204 });
    } finally {
      --activeRequests;
    }
  }

  async function route(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/chats") {
        return await ingest(request);
      }
      const asset = assets.get(url.pathname);
      if (asset) {
        if (request.method !== "GET") {
          return failure(405, "Use GET", { Allow: "GET" });
        }
        return new Response(Bun.file(new URL(`./web/${asset[0]}`, import.meta.url)), {
          headers: {
            "Content-Type": asset[1], "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
            "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; " +
              "style-src-attr 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
          },
        });
      }
      if (url.pathname !== "/api/characters" && url.pathname !== "/api/chat") {
        return failure(404, "Not found");
      }
      if (request.method !== "GET") {
        return failure(405, "Use GET", { Allow: "GET" });
      }
      const source = url.searchParams.get("source");
      if (!source || new TextEncoder().encode(source).byteLength > 256) {
        return failure(400, "A source ID is required");
      }
      if (url.pathname === "/api/characters") {
        const character = url.searchParams.get("character") ?? undefined;
        return Response.json({ characters: store.characters(source, character) }, {
          headers: { "Cache-Control": "no-store" },
        });
      }
      let guid = url.searchParams.get("guid");
      const name = url.searchParams.get("character");
      if (Boolean(guid) === Boolean(name)) {
        return failure(400, "Select exactly one character name or GUID");
      }
      if (name) {
        const matches = store.characters(source, name);
        if (!matches.length) {
          return failure(404, "Waiting for this character to be observed");
        }
        if (matches.length > 1) {
          return failure(409, "More than one character has this name; select a GUID");
        }
        guid = matches[0]!.guid;
      }
      return Response.json(store.history(source, guid!, url.searchParams.get("after") ?? undefined), {
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      if (error instanceof RequestError) {
        return failure(error.status, error.message);
      }
      diagnostic("Chat logger receiver: request failed; returning HTTP 503");
      return failure(503, "Receiver unavailable; retry this request");
    }
  }

  let server: Bun.Server<undefined>;
  try {
    server = Bun.serve({
      hostname: options.host ?? "127.0.0.1", port: options.port ?? 3000, development: false,
      maxRequestBodySize: MAX_BODY_BYTES,
      fetch(request, nativeServer) {
        // Enforce the body deadline ourselves; stdout may take longer to drain.
        if (new URL(request.url).pathname === "/chats") {
          nativeServer.timeout(request, 0);
        }
        if (stopping) {
          return failure(503, "Receiver stopping");
        }
        const result = route(request);
        pending.add(result);
        void result.finally(() => pending.delete(result));
        return result;
      },
      error() { return failure(503, "Receiver unavailable; retry this request"); },
    });
  } catch (error) {
    void output.close?.().catch(() => {});
    if (!options.store) {
      store.close();
    }
    throw error;
  }

  return {
    server,
    get activeRequests() { return activeRequests; },
    stop() {
      stopPromise ??= (async () => {
        stopping = true;
        const closed = server.stop();
        await Promise.allSettled([...pending]);
        await writeQueue;
        try {
          await output.close?.();
        } finally {
          store.close();
          await closed;
        }
      })();
      return stopPromise;
    },
  };
}
