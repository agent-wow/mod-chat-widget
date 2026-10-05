// SPDX-License-Identifier: GPL-2.0-or-later

import { isObject } from "./batch.ts";

export interface Actor {
  guid: string | null;
  name: string | null;
}

export interface ChatContent {
  type: string;
  text: string;
  sender: Actor;
  channel: string | null;
  tag: number;
}

export function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function actor(value: unknown): Actor {
  return isObject(value) ? { guid: text(value.guid), name: text(value.name) } : { guid: null, name: null };
}

// Only persist fields used by the panel, not raw packets, account IDs, or submitted commands.
export function project(event: Record<string, unknown>): ChatContent | null {
  if (event.direction !== "outgoing" || !["ok", "trailing_bytes"].includes(String(event.decoding_status)) ||
      event.language === -1 || event.language === 4294967295) {
    return null;
  }
  let message = text(event.text);
  let type = event.event_kind === "text_emote" ? "TEXT_EMOTE" : "SYSTEM";
  if (event.event_kind === "chat") {
    if (typeof event.chat_type !== "string" || !/^[A-Z_]+$/u.test(event.chat_type) ||
        ["UNKNOWN", "FILTERED"].includes(event.chat_type)) {
      return null;
    }
    type = event.chat_type;
  } else if (event.opcode === "SMSG_MOTD" && isObject(event.notice) && Array.isArray(event.notice.lines)) {
    message = event.notice.lines.filter((line): line is string => typeof line === "string").join("\n") || null;
  } else if (event.event_kind === "notice" && event.opcode === "SMSG_CHANNEL_NOTIFY" && !message) {
    const channel = text(event.channel);
    // ChatNotify in Channel.h: these two notices need only the supplied channel name, no client lookup.
    if (!channel || !isObject(event.notice) || (event.notice.id !== 2 && event.notice.id !== 3)) {
      return null;
    }
    type = "CHANNEL_NOTICE";
    // Names are literal text; escape pipes before passing the generated line through the WoW text parser.
    message = `${event.notice.id === 2 ? "Joined" : "Left"} Channel: [${channel.replaceAll("|", "||")}]`;
  } else if (event.event_kind !== "notice" && event.event_kind !== "text_emote") {
    return null;
  }
  if (!message) {
    return null;
  }
  return {
    type, text: message, sender: actor(event.sender), channel: text(event.channel),
    tag: typeof event.chat_tag === "number" ? event.chat_tag : 0,
  };
}

const styles: Record<string, { color: string; label?: string }> = {
  SYSTEM: { color: "#ffff00" }, SAY: { color: "#ffffff" }, YELL: { color: "#ff4040" },
  PARTY: { color: "#aaaaff", label: "Party" }, PARTY_LEADER: { color: "#77c8ff", label: "Party Leader" },
  RAID: { color: "#ff7f00", label: "Raid" }, RAID_LEADER: { color: "#ff4809", label: "Raid Leader" },
  RAID_WARNING: { color: "#ff4800", label: "Raid Warning" }, GUILD: { color: "#40ff40", label: "Guild" },
  OFFICER: { color: "#40c040", label: "Officer" }, CHANNEL: { color: "#ffc0c0" },
  CHANNEL_NOTICE: { color: "#ffc0c0" },
  BATTLEGROUND: { color: "#ff7f00", label: "Battleground" },
  BATTLEGROUND_LEADER: { color: "#ff4809", label: "Battleground Leader" },
  WHISPER: { color: "#ff80ff" }, WHISPER_FOREIGN: { color: "#ff80ff" },
  WHISPER_INFORM: { color: "#ff80ff" }, MONSTER_WHISPER: { color: "#ffb5eb" },
  RAID_BOSS_WHISPER: { color: "#ffb5eb" }, AFK: { color: "#ff80ff" }, DND: { color: "#ff80ff" },
  EMOTE: { color: "#ff8040" }, TEXT_EMOTE: { color: "#ff8040" }, MONSTER_EMOTE: { color: "#ff8040" },
  RAID_BOSS_EMOTE: { color: "#ffdd00" }, MONSTER_SAY: { color: "#ffff9f" },
  MONSTER_YELL: { color: "#ff4040" }, MONSTER_PARTY: { color: "#aaaaff", label: "Party" },
};

export interface DisplayMessage {
  id: number;
  capturedAt: string;
  color: string;
  prefix: string;
  text: string;
}

export function format(content: ChatContent, name: string): Omit<DisplayMessage, "id" | "capturedAt"> {
  const style = styles[content.type] ?? styles.SYSTEM!;
  const tag = content.tag & 4 ? "<GM> " : content.tag & 2 ? "<DND> " : content.tag & 1 ? "<AFK> " : "";
  const sender = `${tag}[${name}]`;
  let prefix = "";
  let message = content.text;
  if (style.label) {
    prefix = `[${style.label}] ${sender}: `;
  } else if (["SAY", "MONSTER_SAY"].includes(content.type)) {
    prefix = `${sender} says: `;
  } else if (["YELL", "MONSTER_YELL"].includes(content.type)) {
    prefix = `${sender} yells: `;
  } else if (content.type === "WHISPER_INFORM") {
    // The packet's sender is the other character for this particular chat type.
    prefix = `To ${sender}: `;
  } else if (["WHISPER", "WHISPER_FOREIGN", "MONSTER_WHISPER", "RAID_BOSS_WHISPER"].includes(content.type)) {
    prefix = `${sender} whispers: `;
  } else if (content.type === "CHANNEL") {
    prefix = `[${content.channel ?? "Channel"}] ${sender}: `;
  } else if (content.type === "EMOTE") {
    prefix = `${name} `;
  } else if (["MONSTER_EMOTE", "RAID_BOSS_EMOTE"].includes(content.type)) {
    message = message.replace(/%s/gu, () => name);
  } else if (["AFK", "DND"].includes(content.type)) {
    prefix = `${sender} is ${content.type}: `;
  }
  return { color: style.color, prefix, text: message };
}
