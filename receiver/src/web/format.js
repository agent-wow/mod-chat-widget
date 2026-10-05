// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Convert WoW formatting to inert text runs. Never turn packet text into HTML or URLs.
 * @param {string} value
 * @returns {{ text: string, color: string | null }[]}
 */
export function tokenize(value) {
  /** @type {{ text: string, color: string | null }[]} */
  const runs = [];
  /** @type {string | null} */
  let color = null;
  let buffer = "";
  const flush = () => {
    if (buffer) {
      runs.push({ text: buffer, color });
      buffer = "";
    }
  };
  for (let i = 0; i < value.length;) {
    if (value[i] !== "|") {
      buffer += value[i++];
      continue;
    }
    const code = value[i + 1];
    if (code === "|") {
      buffer += "|";
      i += 2;
    } else if (code === "c" && /^[\da-f]{8}$/iu.test(value.slice(i + 2, i + 10))) {
      flush();
      color = `#${value.slice(i + 4, i + 10)}`;
      i += 10;
    } else if (code === "r") {
      flush();
      color = null;
      i += 2;
    } else if (code === "H" || code === "T" || code === "A") {
      const endCode = code === "H" ? "|h" : code === "T" ? "|t" : "|a";
      const end = value.indexOf(endCode, i + 2);
      // Incomplete control sequences must not expose raw link/texture metadata.
      i = end < 0 ? value.length : end + 2;
    } else if (code === "h") {
      i += 2;
    } else if (code === "n") {
      buffer += "\n";
      i += 2;
    } else {
      buffer += value[i++];
    }
  }
  flush();
  return runs;
}
