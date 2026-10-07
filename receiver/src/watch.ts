// SPDX-License-Identifier: GPL-2.0-or-later
export interface WatchTarget { guid: string; name: string }

// Absent metadata is compatible with publishers predating watch integration.
export function isWatchTarget(value: unknown): value is WatchTarget | null | undefined {
  if (value === null || value === undefined) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const target = value as Record<string, unknown>;
  return typeof target.guid === "string" && target.guid.length > 0 &&
    new TextEncoder().encode(target.guid).length <= 256 &&
    typeof target.name === "string" && target.name.length > 0 &&
    new TextEncoder().encode(target.name).length <= 512;
}

export function validFollow(params: URLSearchParams): boolean {
  return !params.has("follow") || (params.getAll("follow").length === 1 && params.get("follow") === "watch");
}
