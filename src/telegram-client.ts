/**
 * GramJS (MTProto) client wrapper.
 * Connects as a real Telegram user account — can read any chat the user is in.
 */

import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import type { TelegramClientParams } from "telegram/client/telegramBaseClient.js";
import type { PluginConfig } from "./config.js";

export type FetchedMessage = {
  id: number;
  sender: string;
  text: string;
  date: Date;
};

let _client: TelegramClient | null = null;

function buildClient(cfg: PluginConfig): TelegramClient {
  const session = new StringSession(cfg.sessionString ?? "");

  const clientParams: TelegramClientParams = {
    connectionRetries: 5,
    appVersion: "1.0.0",
    deviceModel: "OpenClaw Plugin",
    systemVersion: "Node.js",
    langCode: "zh",
  };

  if (cfg.proxy) {
    clientParams.proxy = {
      ip: cfg.proxy.host,
      port: cfg.proxy.port,
      socksType: (cfg.proxy.socksType ?? 5) as 4 | 5,
      username: cfg.proxy.username,
      password: cfg.proxy.password,
    };
  }

  return new TelegramClient(session, cfg.apiId, cfg.apiHash, clientParams);
}

/** Get or create the shared client (connects lazily) */
export async function getClient(cfg: PluginConfig): Promise<TelegramClient> {
  if (!_client) {
    _client = buildClient(cfg);
  }
  if (!_client.connected) {
    await _client.connect();
  }
  return _client;
}

/** Disconnect and clear the shared client */
export async function disconnectClient(): Promise<void> {
  if (_client) {
    await _client.disconnect();
    _client = null;
  }
}

/**
 * Fetch messages from a chat sent after `since`.
 * Returns messages in chronological order (oldest first).
 */
export async function fetchMessages(
  cfg: PluginConfig,
  chatId: string | number,
  since: Date,
  maxMessages: number,
): Promise<FetchedMessage[]> {
  const client = await getClient(cfg);
  const sinceUnix = Math.floor(since.getTime() / 1000);
  const results: FetchedMessage[] = [];

  // iterMessages returns an async iterator of CustomMessage; cast to avoid index-sig error
  const iter = client.iterMessages(chatId, { limit: maxMessages }) as AsyncIterable<{
    id: number;
    date?: number;
    message?: string;
    getSender: () => Promise<unknown>;
  }>;

  for await (const msg of iter) {
    if (!msg.date) continue;
    if (msg.date < sinceUnix) break;
    const text = msg.message ?? "";
    if (!text.trim()) continue;

    const senderName = await resolveSenderName(msg);
    results.push({
      id: msg.id,
      sender: senderName,
      text,
      date: new Date(msg.date * 1000),
    });
  }

  // Reverse to chronological order (oldest first)
  return results.reverse();
}

/** Resolve a display name for the message sender */
async function resolveSenderName(
  msg: { getSender: () => Promise<unknown> },
): Promise<string> {
  try {
    const sender = await msg.getSender();
    if (!sender || typeof sender !== "object") return "unknown";
    const s = sender as Record<string, unknown>;
    if ("firstName" in s) {
      const first = (s.firstName as string | undefined) ?? "";
      const last = (s.lastName as string | undefined) ?? "";
      const username = (s.username as string | undefined) ?? "";
      return [first, last].filter(Boolean).join(" ") || username || "unknown";
    }
    if ("title" in s) {
      return (s.title as string | undefined) || "unknown";
    }
  } catch {
    // ignore
  }
  return "unknown";
}

/** Resolve a chat's title for display in summary headers */
export async function resolveChatTitle(
  cfg: PluginConfig,
  chatId: string | number,
): Promise<string> {
  try {
    const client = await getClient(cfg);
    const entity = await client.getEntity(chatId);
    if ("title" in entity && entity.title) return entity.title;
    if ("firstName" in entity) {
      const first = (entity as { firstName?: string }).firstName ?? "";
      const last = (entity as { lastName?: string }).lastName ?? "";
      return [first, last].filter(Boolean).join(" ") || String(chatId);
    }
  } catch {
    // ignore
  }
  return String(chatId);
}

export type ChatListEntry = {
  chatId: string | number;
  title: string;
};

/** List all dialogs (chats/groups/channels) the user is in */
export async function listChats(cfg: PluginConfig): Promise<ChatListEntry[]> {
  const client = await getClient(cfg);
  const dialogs = await client.getDialogs({ limit: 200 });

  const result: ChatListEntry[] = [];
  const seen = new Set<string>();

  for (const dialog of dialogs as unknown as Array<Record<string, unknown>>) {
    const entity = (dialog.entity as Record<string, unknown> | undefined) ?? dialog;
    const username =
      typeof entity.username === "string" && entity.username.trim()
        ? `@${entity.username}`
        : null;

    const rawId = (dialog as { id?: unknown }).id ?? (entity as { id?: unknown }).id;
    let numericId: string | number | null = null;
    if (typeof rawId === "string" && rawId.trim()) numericId = rawId;
    else if (typeof rawId === "number" && Number.isFinite(rawId)) numericId = rawId;
    else if (typeof rawId === "bigint") numericId = rawId.toString();
    else if (rawId != null) {
      const str = String(rawId);
      if (/^-?\d+$/.test(str)) numericId = str;
    }

    const chatId = username ?? numericId;
    if (!chatId) continue;
    const key = String(chatId);
    if (seen.has(key)) continue;
    seen.add(key);

    const first = typeof entity.firstName === "string" ? entity.firstName.trim() : "";
    const last = typeof entity.lastName === "string" ? entity.lastName.trim() : "";
    const title =
      (typeof entity.title === "string" && entity.title.trim()) ||
      [first, last].filter(Boolean).join(" ") ||
      (typeof entity.username === "string" && entity.username ? `@${entity.username}` : "") ||
      key;

    result.push({ chatId, title });
  }

  return result;
}

/** Send a text message — via bot token if provided, otherwise via user account */
export async function sendMessageAsUser(
  cfg: PluginConfig,
  chatId: string | number,
  text: string,
  botToken?: string,
): Promise<void> {
  if (botToken) {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Bot API sendMessage failed (${res.status}): ${body}`);
    }
    return;
  }

  // Send via user account (MTProto)
  const client = await getClient(cfg);
  await client.sendMessage(chatId, { message: text, parseMode: "html" });
}
