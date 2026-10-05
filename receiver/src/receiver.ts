// SPDX-License-Identifier: GPL-2.0-or-later

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Writable } from "node:stream";

export const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_ACTIVE_REQUESTS = 4;

export interface Batch {
  schema_version: 1;
  source_id: string;
  events: Record<string, unknown>[];
  [key: string]: unknown;
}

export interface ReceiverOptions {
  bearerToken?: string;
  output?: Writable;
  diagnostic?: (message: string) => void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isUnsignedInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNullableText(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isOneOf(value: unknown, allowed: string[]): boolean {
  return typeof value === "string" && allowed.includes(value);
}

// Validate common metadata, leaving opcode-specific fields and future additions intact.
export function isBatch(value: unknown): value is Batch {
  return isObject(value) && value.schema_version === 1 && isText(value.source_id) &&
    Buffer.byteLength(value.source_id) <= 256 && Array.isArray(value.events) && value.events.every((event) => {
      if (!isObject(event) || !isObject(event.session)) {
        return false;
      }
      const validObservation = (event.direction === "incoming" && event.observation === "client_submission") ||
        (event.direction === "outgoing" && event.observation === "send_attempt");
      return validObservation && isText(event.event_id) && isText(event.captured_at) &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(event.captured_at) &&
        Number.isFinite(Date.parse(event.captured_at)) && isText(event.opcode) && isUnsignedInteger(event.opcode_id) &&
        isOneOf(event.event_kind, ["chat", "text_emote", "notice"]) &&
        isUnsignedInteger(event.session.account_id) && isText(event.session.locale) &&
        isNullableText(event.session.character_guid) && isNullableText(event.session.character_name) &&
        isOneOf(event.decoding_status, ["ok", "malformed", "unsupported", "trailing_bytes"]);
    });
}

class RequestError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = [];
    let bytes = 0;
    let failed = false;
    request.on("data", (chunk: Buffer) => {
      if (failed) {
        return;
      }
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        failed = true;
        chunks = [];
        reject(new RequestError(413, "Request body exceeds 8 MiB"));
      } else {
        chunks.push(chunk);
      }
    });
    request.once("end", () => {
      if (!failed) {
        resolve(Buffer.concat(chunks, bytes));
      }
    });
    request.once("error", () => reject(new RequestError(400, "Request interrupted")));
    request.once("aborted", () => reject(new RequestError(400, "Request aborted")));
  });
}

function rejectRequest(request: IncomingMessage, response: ServerResponse, status: number, message: string): void {
  // Close rejected connections so an unread body cannot keep the connection alive.
  request.resume();
  response.writeHead(status, { "Content-Type": "application/json", "Connection": "close" });
  response.end(JSON.stringify({ error: message }));
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function createReceiver(options: ReceiverOptions = {}) {
  const output: Writable = options.output ?? process.stdout;
  const diagnostic = options.diagnostic ?? ((message: string) => process.stderr.write(`${message}\n`));
  const expectedAuthorization = options.bearerToken ? digest(`Bearer ${options.bearerToken}`) : null;
  let outputFailed = false;
  let activeRequests = 0;
  let closed = false;
  const outputError = () => {
    if (!outputFailed) {
      diagnostic("Chat logger receiver: stdout failed; new batches will receive HTTP 503");
    }
    outputFailed = true;
  };
  output.on("error", outputError);

  const server = createServer({
    maxHeaderSize: 16 * 1024,
    headersTimeout: 10_000,
    requestTimeout: 10_000,
    connectionsCheckingInterval: 1_000,
    keepAliveTimeout: 5_000,
  }, (request, response) => {
    // Rejections can happen before readBody installs its own error listener.
    request.on("error", () => {});
    void handle(request, response);
  });
  server.maxConnections = 32;
  function releaseOutputListener(): void {
    if (closed && activeRequests === 0) {
      output.off("error", outputError);
    }
  }
  server.once("close", () => {
    closed = true;
    releaseOutputListener();
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.url !== "/chat") {
      rejectRequest(request, response, 404, "Use POST /chat");
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      rejectRequest(request, response, 405, "Use POST /chat");
      return;
    }
    if (expectedAuthorization &&
        !timingSafeEqual(expectedAuthorization, digest(request.headers.authorization ?? ""))) {
      response.setHeader("WWW-Authenticate", "Bearer");
      rejectRequest(request, response, 401, "Unauthorized");
      return;
    }
    const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json" ||
        (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity")) {
      rejectRequest(request, response, 415, "An uncompressed application/json body is required");
      return;
    }
    if (Number(request.headers["content-length"]) > MAX_BODY_BYTES) {
      rejectRequest(request, response, 413, "Request body exceeds 8 MiB");
      return;
    }
    if (outputFailed || activeRequests >= MAX_ACTIVE_REQUESTS) {
      response.setHeader("Retry-After", "1");
      rejectRequest(request, response, 503, "Receiver unavailable; retry this batch");
      return;
    }

    ++activeRequests;
    try {
      const body = await readBody(request);
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
      if (outputFailed) {
        throw new RequestError(503, "Receiver unavailable; retry this batch");
      }
      try {
        await new Promise<void>((resolve, reject) => {
          // Wait for the write, including stream backpressure, before acknowledging the batch.
          output.write(line, "utf8", (error) => error ? reject(error) : resolve());
        });
      } catch {
        outputError();
        throw new RequestError(503, "Receiver unavailable; retry this batch");
      }
      response.writeHead(204);
      response.end();
    } catch (error) {
      if (error instanceof RequestError) {
        if (error.status === 503) {
          response.setHeader("Retry-After", "1");
        }
        rejectRequest(request, response, error.status, error.message);
      } else {
        diagnostic("Chat logger receiver: request failed; returning HTTP 503");
        response.setHeader("Retry-After", "1");
        rejectRequest(request, response, 503, "Receiver unavailable; retry this batch");
      }
    } finally {
      --activeRequests;
      releaseOutputListener();
    }
  }

  return server;
}
