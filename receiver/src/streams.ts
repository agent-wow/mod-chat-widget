// SPDX-License-Identifier: GPL-2.0-or-later

import type { ChatStore } from "./store.ts";

interface Subscriber {
  refresh(): void;
  close(): void;
}

export class ChatStreams {
  private subscribers = new Set<Subscriber>();
  private store: ChatStore;
  private diagnostic: (message: string) => void;

  constructor(store: ChatStore, diagnostic: (message: string) => void) {
    this.store = store;
    this.diagnostic = diagnostic;
  }

  publish(): void {
    for (const subscriber of this.subscribers) {
      subscriber.refresh();
    }
  }

  close(): void {
    for (const subscriber of this.subscribers) {
      subscriber.close();
    }
  }

  response(request: Request, source: string, guid: string | null, name: string | null, follow = false): Response {
    const url = new URL(request.url);
    const currentSession = follow || url.searchParams.get("session") === "current";
    let cursor = follow ? undefined :
      request.headers.get("last-event-id") || url.searchParams.get("after") || undefined;
    let effectiveGuid: string | null | undefined;
    let lastHeartbeat = performance.now();
    let characterName: string | undefined;
    let characterState: string | undefined;
    let waiting = false;
    let dirty = true;
    let heartbeat = false;
    let closed = false;
    let controller: ReadableStreamDefaultController<Uint8Array>;
    let timer: ReturnType<typeof setInterval>;
    const encoder = new TextEncoder();

    const cleanup = () => {
      closed = true;
      clearInterval(timer);
      request.signal.removeEventListener("abort", close);
      this.subscribers.delete(subscriber);
    };
    const close = () => {
      if (!closed) {
        cleanup();
        controller.close();
      }
    };
    const send = (event: string, data: unknown, id?: string) => {
      controller.enqueue(encoder.encode(
        `${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
      ));
    };
    const drain = () => {
      // Read at most one page per pull. Slow viewers retain a cursor, not an unbounded message queue.
      if (closed || controller.desiredSize! <= 0) {
        return;
      }
      try {
        if (dirty) {
          dirty = false;
          if (!guid) {
            const matches = this.store.characters(source, name!);
            if (matches.length > 1) {
              send("status", { status: 409, error: "More than one character has this name; select a GUID" });
              close();
              return;
            }
            if (!matches.length) {
              if (!waiting) {
                waiting = true;
                send("status", { status: 404, error: "Waiting for this character to be observed" });
                return;
              }
            } else {
              guid = matches[0]!.guid;
            }
          }
          if (guid) {
            const selected = follow ? this.store.watchedGuid(source, guid) : guid;
            if (selected === null) {
              if (effectiveGuid !== null) {
                effectiveGuid = null; cursor = undefined; characterName = undefined; characterState = undefined;
                send("chat", null);
                return;
              }
            } else {
              const switched = follow && effectiveGuid !== selected;
              if (switched) cursor = undefined;
              const page = this.store.history(source, selected, cursor, currentSession);
              if (switched) page.reset = true;
              effectiveGuid = selected;
              const state = JSON.stringify(page.state && [page.state.login_id, page.state.presence,
                page.state.updated_at, page.state.stale]);
              dirty = page.hasMore;
              if (page.cursor !== cursor || page.character.name !== characterName ||
                  state !== characterState || page.reset) {
                // Bun can pull again during enqueue, so advance state before handing over this page.
                cursor = page.cursor;
                characterName = page.character.name;
                characterState = state;
                send("chat", page, page.cursor);
                return;
              }
            }
          }
        }
        if (heartbeat) {
          heartbeat = false;
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
        }
      } catch {
        cleanup();
        controller.error(new Error("Chat stream unavailable"));
        this.diagnostic("Chat logger receiver: chat stream failed; viewer will reconnect");
      }
    };
    const subscriber: Subscriber = { refresh() { dirty = true; drain(); }, close };
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
      pull: drain,
      cancel: cleanup,
    });
    this.subscribers.add(subscriber);
    request.signal.addEventListener("abort", close, { once: true });
    timer = setInterval(() => {
      if (performance.now() - lastHeartbeat >= 15000) { heartbeat = true; lastHeartbeat = performance.now(); }
      dirty ||= currentSession; drain();
    }, follow ? 250 : 15000);
    if (request.signal.aborted) {
      close();
    }
    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store",
        "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff",
      },
    });
  }
}
