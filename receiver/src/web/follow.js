// SPDX-License-Identifier: GPL-2.0-or-later
export class SelectionError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) { super(message); this.status = status; }
}
/** @param {URLSearchParams} params */
export function validFollow(params) {
  return !params.has("follow") || (params.getAll("follow").length === 1 && params.get("follow") === "watch");
}
/** Resolve the observer once; displayed targets must never replace this GUID.
 * @param {string | null} source @param {string | null} guid
 * @param {string | null} character @param {boolean} follow
 */
export async function resolveObserver(source, guid, character, follow) {
  if (!follow || guid) return guid;
  const query = new URLSearchParams({ source: source ?? "", character: character ?? "" });
  const response = await fetch(`/api/characters?${query}`, { cache: "no-store", signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new SelectionError(response.status, "Unable to resolve observer");
  const matches = (await response.json()).characters;
  if (!matches.length) throw new SelectionError(404, "Waiting for this observer to be observed…");
  if (matches.length !== 1) throw new SelectionError(409, "Ambiguous observer name; select a GUID");
  return /** @type {string} */ (matches[0].guid);
}
