// SPDX-License-Identifier: GPL-2.0-or-later

export interface Config {
  host: string;
  port: number;
  bearerToken: string;
}

export function readConfig(env: NodeJS.ProcessEnv): Config {
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
  return { host, port: Number(port), bearerToken };
}
