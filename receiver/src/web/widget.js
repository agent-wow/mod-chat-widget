// SPDX-License-Identifier: GPL-2.0-or-later

import { tokenize } from "./format.js";

const messages = /** @type {HTMLElement} */ (document.getElementById("messages"));
const status = /** @type {HTMLElement} */ (document.getElementById("status"));
const parameters = new URLSearchParams(location.search);
const source = parameters.get("source");
let guid = parameters.get("guid");
const character = parameters.get("character");
/** @type {string | undefined} */
let cursor;
let failures = 0;
const displayed = new Set();

/** @param {{id: number, color: string, prefix: string, text: string}} message */
function append(message) {
  if (displayed.has(message.id)) {
    return;
  }
  displayed.add(message.id);
  const line = document.createElement("p");
  line.className = "message";
  line.dataset.id = String(message.id);
  line.style.color = message.color;
  // Actor and channel names are plain text, even if they contain WoW control characters.
  line.append(document.createTextNode(message.prefix));
  for (const run of tokenize(message.text)) {
    const span = document.createElement("span");
    span.textContent = run.text;
    if (run.color) {
      span.style.color = run.color;
    }
    line.append(span);
  }
  messages.append(line);
  while (messages.children.length > 100) {
    const first = /** @type {HTMLElement} */ (messages.firstElementChild);
    displayed.delete(Number(first.dataset.id));
    first.remove();
  }
}

async function poll() {
  let delay = 1000;
  try {
    const query = new URLSearchParams({ source: source ?? "" });
    query.set(guid ? "guid" : "character", guid || character || "");
    if (cursor) {
      query.set("after", cursor);
    }
    const response = await fetch(`/api/chat?${query}`, { cache: "no-store", signal: AbortSignal.timeout(10000) });
    if ([400, 404, 409].includes(response.status)) {
      const body = await response.json();
      status.textContent = body.error;
      failures = 0;
      delay = 3000;
    } else {
      if (!response.ok) {
        throw new Error("Unavailable");
      }
      const body = await response.json();
      if (body.reset) {
        messages.replaceChildren();
        displayed.clear();
      }
      guid = body.character.guid;
      document.title = `${body.character.name} — Chat`;
      for (const message of body.messages) {
        append(message);
      }
      cursor = body.cursor;
      status.textContent = displayed.size ? "" : "Waiting for chat…";
      failures = 0;
      if (body.hasMore) {
        delay = 0;
      }
    }
  } catch {
    status.textContent = "Reconnecting…";
    delay = Math.min(1000 * 2 ** Math.min(++failures, 5), 30000);
  }
  // Schedule after completion so slow requests never overlap or move the cursor backwards.
  setTimeout(poll, delay);
}

if (!source || Boolean(guid) === Boolean(character)) {
  status.textContent = "Select a source and one character: /widget?source=realm-1&character=Alice";
} else {
  void poll();
}
