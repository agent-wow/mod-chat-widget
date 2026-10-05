// SPDX-License-Identifier: GPL-2.0-or-later

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

// Validate common metadata, leaving opcode-specific fields and future additions intact.
export function isBatch(value: unknown): value is Batch {
  return isObject(value) && value.schema_version === 1 && isText(value.source_id) &&
    new TextEncoder().encode(value.source_id).byteLength <= 256 && Array.isArray(value.events) &&
    value.events.every((event) => {
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
