// SPDX-License-Identifier: GPL-2.0-or-later

export interface Config {
  host: string;
  port: number;
  bearerToken: string;
  dbPath: string;
  retentionDays: number;
  maxEvents: number;
}

function positiveInteger(value: string, name: string): number {
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return Number(value);
}

export function readConfig(env: Record<string, string | undefined>): Config {
  const host = env.CHAT_LOGGER_HOST ?? "127.0.0.1";
  const port = env.CHAT_LOGGER_PORT ?? "3000";
  const bearerToken = env.CHAT_LOGGER_BEARER_TOKEN ?? "";
  if (!host.trim() || /[\s\x00-\x1f\x7f]/u.test(host)) {
    throw new Error("CHAT_LOGGER_HOST must be a hostname or IP address");
  }
  if (!/^\d+$/u.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error("CHAT_LOGGER_PORT must be an integer from 1 to 65535");
  }
  if (bearerToken && !/^[A-Za-z0-9._~+/-]+=*$/u.test(bearerToken)) {
    throw new Error("CHAT_LOGGER_BEARER_TOKEN must use HTTP bearer-token characters");
  }
  const dbPath = env.CHAT_LOGGER_DB_PATH ?? "./data/chat.sqlite";
  if (!dbPath.trim() || /[\x00-\x1f\x7f]/u.test(dbPath)) {
    throw new Error("CHAT_LOGGER_DB_PATH must be a valid file path");
  }
  const retentionDays = positiveInteger(env.CHAT_LOGGER_RETENTION_DAYS ?? "7", "CHAT_LOGGER_RETENTION_DAYS");
  if (retentionDays > 36500) {
    throw new Error("CHAT_LOGGER_RETENTION_DAYS must not exceed 36500");
  }
  const maxEvents = positiveInteger(env.CHAT_LOGGER_MAX_EVENTS ?? "100000", "CHAT_LOGGER_MAX_EVENTS");
  return { host, port: Number(port), bearerToken, dbPath, retentionDays, maxEvents };
}
