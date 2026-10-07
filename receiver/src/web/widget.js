// SPDX-License-Identifier: GPL-2.0-or-later
import { resolveObserver, validFollow, SelectionError } from "./follow.js";

import { tokenize } from "./format.js";

const messages = /** @type {HTMLElement} */ (document.getElementById("messages"));
const status = /** @type {HTMLElement} */ (document.getElementById("status"));
const parameters = new URLSearchParams(location.search);
const follow = parameters.get("follow") === "watch";
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
/** @type {ReturnType<typeof setTimeout> | undefined} */
let staleTimer;
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
  if (follow && !guid && !stopped && !suspended) {
    void resolveObserver(source, guid, character, follow).then((resolved) => {
      guid = resolved; connect();
    }).catch((error) => {
      status.textContent = error instanceof Error ? error.message : "Unable to resolve observer";
      if (error instanceof SelectionError && [400, 409].includes(error.status)) { stopped = true; return; }
      if (!stopped && !suspended) retry = setTimeout(connect, 1000);
    });
    return;
  }
  if (stopped || suspended) {
    return;
  }
  const query = new URLSearchParams({ source: source ?? "", session: "current" });
  query.set(guid ? "guid" : "character", guid || character || "");
  if (follow) query.set("follow", "watch");
  if (cursor && !follow) {
    query.set("after", cursor);
  }
  const connection = new EventSource(`/api/chat/stream?${query}`);
  stream = connection;
  connection.addEventListener("chat", (event) => {
    if (stream !== connection || stopped || suspended) return;
    const body = JSON.parse(event.data);
    if (!body) {
      messages.replaceChildren(); displayed.clear(); cursor = undefined;
      clearTimeout(staleTimer); status.textContent = "Waiting for observer or watched character…";
      return;
    }
    const state = /** @type {import('../store.ts').CharacterState} */ (body.state);
    if (body.reset || state.presence === "offline" || state.presence === "unknown") {
      messages.replaceChildren();
      displayed.clear();
    }
    if (!follow) guid = body.character.guid;
    document.title = `${body.character.name} — Chat`;
    for (const message of body.messages) {
      append(message);
    }
    cursor = body.cursor;
    clearTimeout(staleTimer);
    const stale = () => { status.textContent = "Stale · Showing last known chat"; };
    status.textContent = state.presence === "offline" ? "Offline" :
      state.presence === "unknown" ? "Waiting for this character to come online…" :
      state.presence === "unavailable" ? "Unavailable · Character changing maps…" :
      displayed.size ? "" : "Waiting for chat…";
    if (state.stale) {
      stale();
    } else if (["online", "unavailable"].includes(state.presence)) {
      staleTimer = setTimeout(stale, Math.max(0, 15000 - state.age_ms));
    }
    failures = 0;
  });
  connection.addEventListener("status", (event) => {
    if (stream !== connection || stopped || suspended) return;
    const body = JSON.parse(event.data);
    clearTimeout(staleTimer);
    status.textContent = body.error;
    failures = 0;
    if (body.status !== 404) {
      stopped = true;
      connection.close();
    }
  });
  connection.onerror = () => {
    if (stream !== connection || stopped || suspended) return;
    // Recreate the connection with the resolved GUID and last applied cursor, even after HTTP errors.
    connection.close();
    clearTimeout(staleTimer);
    if (!stopped && !suspended) {
      status.textContent = "Reconnecting…";
      retry = setTimeout(connect, Math.min(1000 * 2 ** Math.min(++failures, 5), 30000));
    }
  };
}

window.addEventListener("pagehide", () => {
  suspended = true;
  clearTimeout(retry);
  clearTimeout(staleTimer);
  stream?.close();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    suspended = false;
    connect();
  }
});

if (!validFollow(parameters) || !source || new TextEncoder().encode(source).byteLength > 256 ||
  Boolean(guid) === Boolean(character)) {
  stopped = true;
  status.textContent = "Select a source and one character: /widget?source=realm-1&character=Alice";
} else {
  connect();
}
