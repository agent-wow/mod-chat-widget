// SPDX-License-Identifier: GPL-2.0-or-later
import { isWatchTarget } from "./watch.ts";

export interface Batch {
  schema_version: 1;
  source_id: string;
  events: Record<string, unknown>[];
  [key: string]: unknown;
}

export function isObject(value: unknown): value is Record<string, unknown> {
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

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    Number.isFinite(Date.parse(value));
}

export function hasLogin(session: Record<string, unknown>): session is Record<string, unknown> & {
  login_id: string; started_at: string;
} {
  return typeof session.login_id === "string" && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/u.test(session.login_id) &&
    isTimestamp(session.started_at);
}

// Validate common metadata, leaving opcode-specific fields and future additions intact.
export function isBatch(value: unknown): value is Batch {
  return isObject(value) && value.schema_version === 1 && isText(value.source_id) &&
    new TextEncoder().encode(value.source_id).byteLength <= 256 && Array.isArray(value.events) &&
    value.events.every((event) => {
      if (!isObject(event) || !isObject(event.session)) {
        return false;
      }
      if (!isText(event.event_id) || !isTimestamp(event.captured_at) ||
          !isUnsignedInteger(event.session.account_id) || !isText(event.session.locale) ||
          !isNullableText(event.session.character_guid) || !isNullableText(event.session.character_name)) {
        return false;
      }
      if (event.event_kind === "presence") {
        return isWatchTarget(event.watch_target) && event.direction === "outgoing" &&
          event.observation === "character_presence" &&
          event.opcode === null && event.opcode_id === null && event.decoding_status === "ok" &&
          isText(event.session.character_guid) && isText(event.session.character_name) && hasLogin(event.session) &&
          event.session.started_at <= event.captured_at &&
          typeof event.sequence === "string" && /^[1-9]\d{0,19}$/u.test(event.sequence) &&
          isOneOf(event.presence, ["online", "offline", "unavailable"]);
      }
      const validObservation = (event.direction === "incoming" && event.observation === "client_submission") ||
        (event.direction === "outgoing" && event.observation === "send_attempt");
      return validObservation && isText(event.opcode) && isUnsignedInteger(event.opcode_id) &&
        isOneOf(event.event_kind, ["chat", "text_emote", "notice"]) &&
        isOneOf(event.decoding_status, ["ok", "malformed", "unsupported", "trailing_bytes"]);
    });
}
