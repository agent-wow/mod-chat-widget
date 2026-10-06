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
/** @type {EventSource | undefined} */
let stream;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let retry;
let stopped = false;
let suspended = false;
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

function connect() {
  if (stopped || suspended) {
    return;
  }
  const query = new URLSearchParams({ source: source ?? "" });
  query.set(guid ? "guid" : "character", guid || character || "");
  if (cursor) {
    query.set("after", cursor);
  }
  const connection = new EventSource(`/api/chat/stream?${query}`);
  stream = connection;
  connection.addEventListener("chat", (event) => {
    const body = JSON.parse(event.data);
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
  });
  connection.addEventListener("status", (event) => {
    const body = JSON.parse(event.data);
    status.textContent = body.error;
    failures = 0;
    if (body.status !== 404) {
      stopped = true;
      connection.close();
    }
  });
  connection.onerror = () => {
    // Recreate the connection with the resolved GUID and last applied cursor, even after HTTP errors.
    connection.close();
    if (!stopped && !suspended) {
      status.textContent = "Reconnecting…";
      retry = setTimeout(connect, Math.min(1000 * 2 ** Math.min(++failures, 5), 30000));
    }
  };
}

window.addEventListener("pagehide", () => {
  suspended = true;
  clearTimeout(retry);
  stream?.close();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    suspended = false;
    connect();
  }
});

if (!source || new TextEncoder().encode(source).byteLength > 256 || Boolean(guid) === Boolean(character)) {
  stopped = true;
  status.textContent = "Select a source and one character: /widget?source=realm-1&character=Alice";
} else {
  connect();
}
