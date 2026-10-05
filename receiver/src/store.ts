// SPDX-License-Identifier: GPL-2.0-or-later

import { Database } from "bun:sqlite";
import { isObject } from "./batch.ts";
import type { Batch } from "./batch.ts";
import { actor, format, project, text } from "./projection.ts";
import type { ChatContent, DisplayMessage } from "./projection.ts";

export interface StoreOptions {
  path?: string;
  retentionDays?: number;
  maxEvents?: number;
  now?: () => number;
}

export interface Character {
  guid: string;
  name: string;
}

interface EventRow {
  sequence: number;
  captured_at: string;
  content: string;
}

interface Metadata {
  epoch: string;
  high_water: number;
  pruned: number;
}

export class ChatStore {
  private db: Database;
  private now: () => number;
  private retentionMs: number;
  private maxEvents: number;
  private lastPrune = -Infinity;

  constructor(options: StoreOptions = {}) {
    this.db = new Database(options.path ?? ":memory:", { create: true, strict: true });
    this.now = options.now ?? Date.now;
    this.retentionMs = (options.retentionDays ?? 7) * 86400000;
    this.maxEvents = options.maxEvents ?? 100000;
    try {
      this.db.run("PRAGMA journal_mode = WAL");
      this.db.run("PRAGMA busy_timeout = 1000");
      const version = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
      if (version !== 0 && version !== 1) {
        throw new Error("Unsupported chat database version");
      }
      this.db.transaction(() => {
        this.db.run(`
          CREATE TABLE IF NOT EXISTS metadata (
            id INTEGER PRIMARY KEY CHECK (id = 1), epoch TEXT NOT NULL,
            high_water INTEGER NOT NULL DEFAULT 0, pruned INTEGER NOT NULL DEFAULT 0
          );
          CREATE TABLE IF NOT EXISTS identities (
            source TEXT NOT NULL, guid TEXT NOT NULL, name TEXT NOT NULL, name_key TEXT NOT NULL,
            is_character INTEGER NOT NULL, named_at TEXT NOT NULL, seen_at INTEGER NOT NULL,
            PRIMARY KEY (source, guid)
          );
          CREATE INDEX IF NOT EXISTS identity_names ON identities(source, name_key, is_character);
          CREATE INDEX IF NOT EXISTS identity_age ON identities(seen_at);
          CREATE TABLE IF NOT EXISTS events (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, event_id TEXT NOT NULL,
            recipient TEXT NOT NULL, captured_at TEXT NOT NULL, received_at INTEGER NOT NULL, content TEXT NOT NULL,
            UNIQUE (source, event_id)
          );
          CREATE INDEX IF NOT EXISTS recipient_history ON events(source, recipient, sequence);
          CREATE INDEX IF NOT EXISTS event_age ON events(received_at);
          PRAGMA user_version = 1;
        `);
        this.db.query("INSERT OR IGNORE INTO metadata (id, epoch) VALUES (1, ?)").run(crypto.randomUUID());
      })();
      this.prune(true);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  ingest(batch: Batch): void {
    const now = this.now();
    this.db.transaction(() => {
      const identity = this.db.query(`
        INSERT INTO identities (source, guid, name, name_key, is_character, named_at, seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (source, guid) DO UPDATE SET
          name = CASE WHEN excluded.is_character >= is_character AND excluded.named_at >= named_at
            THEN excluded.name ELSE name END,
          name_key = CASE WHEN excluded.is_character >= is_character AND excluded.named_at >= named_at
            THEN excluded.name_key ELSE name_key END,
          named_at = CASE WHEN excluded.is_character >= is_character
            THEN MAX(named_at, excluded.named_at) ELSE named_at END, seen_at = excluded.seen_at,
          is_character = MAX(is_character, excluded.is_character)
      `);
      const insert = this.db.query(`
        INSERT OR IGNORE INTO events (source, event_id, recipient, captured_at, received_at, content)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const event of batch.events) {
        const session = isObject(event.session) ? event.session : {};
        const actors = [
          { guid: text(session.character_guid), name: text(session.character_name), character: 1 },
          { ...actor(event.sender), character: 0 }, { ...actor(event.target), character: 0 },
        ];
        for (const entry of actors) {
          if (entry.guid && entry.name) {
            identity.run(batch.source_id, entry.guid, entry.name, entry.name.toLowerCase(), entry.character,
              String(event.captured_at), now);
          }
        }
        const content = project(event);
        const recipient = text(session.character_guid);
        if (recipient && content) {
          insert.run(batch.source_id, String(event.event_id), recipient, String(event.captured_at), now,
            JSON.stringify(content));
        }
      }
      this.db.run("UPDATE metadata SET high_water = MAX(high_water, COALESCE((SELECT MAX(sequence) FROM events), 0))");
      this.prune(true);
    })();
  }

  private prune(force = false): void {
    const now = this.now();
    if (!force && now - this.lastPrune < 60000) {
      return;
    }
    this.db.transaction(() => {
      const cutoff = now - this.retentionMs;
      const overflow = this.db.query<{ sequence: number }, [number]>(
        "SELECT sequence FROM events ORDER BY sequence DESC LIMIT 1 OFFSET ?",
      ).get(this.maxEvents)?.sequence ?? 0;
      const expired = this.db.query<{ sequence: number | null }, [number]>(
        "SELECT MAX(sequence) AS sequence FROM events WHERE received_at < ?",
      ).get(cutoff)?.sequence ?? 0;
      this.db.query("UPDATE metadata SET pruned = MAX(pruned, ?, ?)").run(overflow, expired);
      this.db.query("DELETE FROM events WHERE sequence <= ? OR received_at < ?").run(overflow, cutoff);
      this.db.query("DELETE FROM identities WHERE seen_at < ?").run(cutoff);
      this.db.query(`DELETE FROM identities WHERE rowid IN (
        SELECT rowid FROM identities ORDER BY seen_at DESC, rowid DESC LIMIT -1 OFFSET ?
      )`).run(this.maxEvents);
    })();
    this.lastPrune = now;
  }

  characters(source: string, name?: string): Character[] {
    this.prune();
    if (name !== undefined) {
      return this.db.query<Character, [string, string]>(
        "SELECT guid, name FROM identities WHERE source = ? AND name_key = ? AND is_character = 1 LIMIT 2",
      ).all(source, name.toLowerCase());
    }
    return this.db.query<Character, [string]>(
      "SELECT guid, name FROM identities WHERE source = ? AND is_character = 1 ORDER BY name_key, guid",
    ).all(source);
  }

  history(source: string, guid: string, cursor?: string): {
    character: Character; messages: DisplayMessage[]; cursor: string; reset: boolean; hasMore: boolean;
  } {
    this.prune();
    const meta = this.db.query<Metadata, []>("SELECT epoch, high_water, pruned FROM metadata").get()!;
    const match = cursor?.match(/^([\da-f-]{36}):(\d+):(\d+)$/u);
    const after = match ? Number(match[2]) : -1;
    const reset = cursor !== undefined && (!match || match[1] !== meta.epoch ||
      !Number.isSafeInteger(after) || after < meta.pruned || after > meta.high_water ||
      Number(match[3]) !== meta.pruned);
    const snapshot = cursor === undefined || reset;
    let rows: EventRow[];
    if (snapshot) {
      rows = this.db.query<EventRow, [string, string]>(
        `SELECT sequence, captured_at, content FROM events
         WHERE source = ? AND recipient = ? ORDER BY sequence DESC LIMIT 100`,
      ).all(source, guid).reverse();
    } else {
      rows = this.db.query<EventRow, [string, string, number]>(
        `SELECT sequence, captured_at, content FROM events
         WHERE source = ? AND recipient = ? AND sequence > ? ORDER BY sequence LIMIT 101`,
      ).all(source, guid, after);
    }
    const hasMore = rows.length > 100;
    rows = rows.slice(0, 100);
    const resolveName = this.db.query<{ name: string }, [string, string]>(
      "SELECT name FROM identities WHERE source = ? AND guid = ?",
    );
    return {
      character: { guid, name: resolveName.get(source, guid)?.name ?? "Unknown player" },
      messages: rows.map((row) => {
        const content = JSON.parse(row.content) as ChatContent;
        const name = content.sender.name ?? (content.sender.guid ?
          resolveName.get(source, content.sender.guid)?.name : null) ?? "Unknown player";
        return { id: row.sequence, capturedAt: row.captured_at, ...format(content, name) };
      }),
      cursor: `${meta.epoch}:${hasMore ? rows.at(-1)!.sequence : meta.high_water}:${meta.pruned}`, reset, hasMore,
    };
  }

  close(): void {
    this.db.close(true);
  }
}
