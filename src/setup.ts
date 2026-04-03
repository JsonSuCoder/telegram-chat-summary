import qrcode from "qrcode-terminal";
import { TelegramClient } from "telegram";
import { LogLevel, Logger } from "telegram/extensions/Logger.js";
import { StringSession } from "telegram/sessions/index.js";
import type { TelegramClientParams } from "telegram/client/telegramBaseClient.js";
import readline from "node:readline/promises";
import { writePluginConfigWithAllowedTools } from "./openclaw-config.js";

let timeoutGuardInstalled = false;

const SUMMARY_TOOL_NAMES = [
  "telegram_summary_scheduler_start",
  "telegram_summary_scheduler_stop",
  "telegram_summary_scheduler_status",
  "telegram_summary_list_chats",
  "telegram_configure_chats",
  "telegram_remove_summary_chats",
] as const;


function isTelegramUpdateTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.message === "TIMEOUT" &&
    (err.stack?.includes("/telegram/client/updates.js") ?? false)
  );
}

function installTelegramTimeoutGuard(): void {
  if (timeoutGuardInstalled) return;
  timeoutGuardInstalled = true;
  process.on("unhandledRejection", (reason) => {
    if (isTelegramUpdateTimeoutError(reason)) return;
    console.error("Unhandled rejection:", reason);
  });
  process.on("uncaughtException", (err) => {
    if (isTelegramUpdateTimeoutError(err)) return;
    console.error("Uncaught exception:", err);
    process.exit(1);
  });
}

type AvailableChat = { chatId: string | number; title: string };

function createRl() {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

async function ask(rl: readline.Interface, question: string, defaultValue?: string): Promise<string> {
  const hint = defaultValue !== undefined ? ` (default: ${defaultValue})` : "";
  const answer = (await rl.question(`${question}${hint}: `)).trim();
  return answer || defaultValue || "";
}

function parseProxyUrl(raw: string): { host: string; port: number; socksType: 4 | 5 } | null {
  try {
    const url = new URL(raw);
    const host = url.hostname;
    const port = Number(url.port);
    if (!host || !port) return null;
    return { host, port, socksType: url.protocol === "socks4:" ? 4 : 5 };
  } catch {
    return null;
  }
}

function detectEnvProxy(): { host: string; port: number; socksType: 4 | 5 } | null {
  for (const raw of [process.env.ALL_PROXY, process.env.all_proxy, process.env.SOCKS_PROXY, process.env.socks_proxy]) {
    if (!raw) continue;
    const parsed = parseProxyUrl(raw);
    if (parsed) return parsed;
  }
  return null;
}

async function askYN(rl: readline.Interface, question: string, defaultYes = false): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = (await rl.question(`${question} ${hint}: `)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}

function parseSelection(input: string, max: number): number[] {
  const set = new Set<number>();
  for (const part of input.split(",").map((s) => s.trim()).filter(Boolean)) {
    const idx = Number(part);
    if (!Number.isInteger(idx) || idx < 1 || idx > max) continue;
    set.add(idx - 1);
  }
  return Array.from(set.values());
}

function toChatId(raw: unknown): string | number | null {
  if (typeof raw === "string" && raw.trim()) return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "bigint") return raw.toString();
  if (typeof raw === "object" && raw !== null) {
    const str = String(raw);
    if (/^-?\d+$/.test(str)) return str;
  }
  return null;
}

function toTitle(raw: { title?: unknown; firstName?: unknown; lastName?: unknown; username?: unknown }, fallback: string): string {
  if (typeof raw.title === "string" && raw.title.trim()) return raw.title;
  const first = typeof raw.firstName === "string" ? raw.firstName.trim() : "";
  const last = typeof raw.lastName === "string" ? raw.lastName.trim() : "";
  const full = [first, last].filter(Boolean).join(" ");
  if (full) return full;
  if (typeof raw.username === "string" && raw.username.trim()) return `@${raw.username}`;
  return fallback;
}

async function listAvailableChats(client: TelegramClient): Promise<AvailableChat[]> {
  const dialogs = await client.getDialogs({ limit: 200 });
  console.log(`Found ${dialogs.length} dialogs.`);
  const result: AvailableChat[] = [];
  const seen = new Set<string>();
  for (const dialog of dialogs as unknown as Array<Record<string, unknown>>) {
    const entity = (dialog.entity as Record<string, unknown> | undefined) ?? dialog;
    const username = typeof entity.username === "string" && entity.username.trim() ? `@${entity.username}` : null;
    const numericId = toChatId((dialog as { id?: unknown }).id ?? (entity as { id?: unknown }).id);
    const chatId = username ?? numericId;
    if (!chatId) continue;
    const key = String(chatId);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ chatId, title: toTitle({ title: entity.title, firstName: entity.firstName, lastName: entity.lastName, username: entity.username }, key) });
  }
  return result;
}

async function selectChatsFromList(
  rl: readline.Interface,
  availableChats: AvailableChat[],
  existingChats: Record<string, unknown>[] = [],
): Promise<object[]> {
  if (availableChats.length === 0) throw new Error("No available chats were fetched.");
  const existingMap = new Map(existingChats.map((c) => [String(c.chatId), c]));

  console.log("\n--- Available chats ---");
  availableChats.forEach((chat, idx) => {
    const tag = existingMap.has(String(chat.chatId)) ? " [configured]" : "";
    console.log(`${idx + 1}. ${chat.title} (${String(chat.chatId)})${tag}`);
  });

  let selectedIndexes: number[] = [];
  while (selectedIndexes.length === 0) {
    const raw = await ask(rl, "\nSelect chats to summarize (comma-separated, e.g. 1,3,5)");
    selectedIndexes = parseSelection(raw, availableChats.length);
    if (selectedIndexes.length === 0) console.log("Invalid input. Please try again.");
  }

  const chats: object[] = [];
  for (const idx of selectedIndexes) {
    const selected = availableChats[idx];
    const existing = existingMap.get(String(selected.chatId));
    chats.push({ chatId: selected.chatId, label: (existing?.label as string | undefined) ?? selected.title });
  }
  return chats;
}

async function doQrLogin(
  apiId: number,
  apiHash: string,
  proxy?: { host: string; port: number; socksType: 4 | 5 },
): Promise<{ client: TelegramClient; sessionString: string }> {
  const clientParams: TelegramClientParams = {
    connectionRetries: 5,
    appVersion: "1.0.0",
    deviceModel: "OpenClaw Plugin",
    systemVersion: "Node.js",
    baseLogger: new Logger(LogLevel.NONE),
  };
  if (proxy) clientParams.proxy = { ip: proxy.host, port: proxy.port, socksType: proxy.socksType };

  const session = new StringSession("");
  const client = new TelegramClient(session, apiId, apiHash, clientParams);

  console.log("\nConnecting to Telegram...");
  await client.connect();
  console.log("Generating login QR code...\n");

  await client.signInUserWithQrCode(
    { apiId, apiHash },
    {
      onError: (err) => { throw err; },
      qrCode: async (code) => {
        const tokenBuf = code.token instanceof Buffer ? code.token : Buffer.from(code.token);
        qrcode.generate(`tg://login?token=${tokenBuf.toString("base64url")}`, { small: true });
        console.log("\nOpen Telegram → Settings → Devices → Link Desktop Device, then scan the QR code above...\n");
      },
      password: async (hint) => {
        const rl = createRl();
        try { return (await rl.question(`Two-step verification password required (hint: ${hint || "none"}): `)).trim(); }
        finally { rl.close(); }
      },
    },
  );

  const sessionString = client.session.save() as unknown as string;
  return { client, sessionString };
}

export async function setupAll(): Promise<void> {
  installTelegramTimeoutGuard();
  const rl = createRl();
  try {
    console.log("=== Telegram Chat Summary Setup ===\n");
    console.log("--- Telegram API credentials (from https://my.telegram.org) ---");
    const apiIdRaw = await ask(rl, "API ID");
    const apiId = Number(apiIdRaw);
    if (!apiId || apiId <= 0) { console.error("Invalid API ID. Exiting."); process.exit(1); }
    const apiHash = await ask(rl, "API Hash");
    if (!apiHash) { console.error("API Hash cannot be empty. Exiting."); process.exit(1); }

    const envProxy = detectEnvProxy();
    let proxy: { host: string; port: number; socksType: 4 | 5 } | undefined;
    if (envProxy) {
      console.log(`\nDetected proxy from environment: SOCKS${envProxy.socksType} ${envProxy.host}:${envProxy.port}`);
      if (await askYN(rl, "Use this proxy?", true)) proxy = envProxy;
    }
    if (!proxy && await askYN(rl, "\nConfigure a SOCKS proxy?", false)) {
      const host = await ask(rl, "  Proxy host");
      const port = Number(await ask(rl, "  Proxy port"));
      const socksTypeRaw = await ask(rl, "  SOCKS type (4 or 5)", "5");
      if (host && port) proxy = { host, port, socksType: (socksTypeRaw === "4" ? 4 : 5) as 4 | 5 };
    }

    console.log("\n--- Global configuration ---");
    const language = await ask(rl, "Summary language", "zh-CN");
    const scheduleMinutes = Number(await ask(rl, "Summary interval (minutes)", "60")) || 60;
    const maxMessagesRaw = await ask(rl, "Max messages to fetch per run", "500");
    const maxMessagesPerFetch = Number(maxMessagesRaw) || 500;
    const botToken = await ask(rl, "Bot token for sending summaries (optional)");
    rl.close();

    console.log("\n--- Telegram login ---");
    const { client, sessionString } = await doQrLogin(apiId, apiHash, proxy);
    console.log("\n✅ Login successful. Fetching account info...");

    let selfId: number | undefined;
    let availableChats: AvailableChat[] = [];
    try {
      const me = await client.getMe() as { id?: unknown };
      if (me?.id != null) {
        const raw = me.id;
        selfId = typeof raw === "bigint" ? Number(raw) : typeof raw === "number" ? raw : Number(String(raw));
      }
      console.log(`Account ID: ${selfId ?? "unknown"}. Fetching chat list...`);
      availableChats = await listAvailableChats(client);
    } finally {
      try { await client.disconnect(); } catch { /* ignore */ }
      await new Promise((resolve) => setTimeout(resolve, 800));
    }

    const chatRl = createRl();
    let chats: object[];
    try { chats = await selectChatsFromList(chatRl, availableChats); }
    finally { chatRl.close(); }

    const config: Record<string, unknown> = {
      apiId, apiHash, sessionString,
      schedulerEnabled: true,
      ...(proxy ? { proxy } : {}),
      ...(language !== "zh-CN" ? { language } : {}),
      ...(scheduleMinutes !== 60 ? { scheduleMinutes } : {}),
      ...(maxMessagesPerFetch !== 500 ? { maxMessagesPerFetch } : {}),
      ...(botToken ? { botToken } : {}),
      ...(botToken && selfId ? { alertChatId: selfId } : {}),
      ...(chats.length > 0 ? { chats } : {}),
    };

    writePluginConfigWithAllowedTools({
      pluginId: "telegram-chat-summary",
      config,
      toolNames: [...SUMMARY_TOOL_NAMES],
    });
  } catch (err) {
    rl.close();
    console.error("\nSetup failed:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

export async function configureChats(opts: {
  apiId: number;
  apiHash: string;
  sessionString: string;
  proxy?: { host: string; port: number; socksType: 4 | 5 };
  existingChats?: object[];
}): Promise<void> {
  installTelegramTimeoutGuard();

  const clientParams: TelegramClientParams = {
    connectionRetries: 5,
    appVersion: "1.0.0",
    deviceModel: "OpenClaw Plugin",
    systemVersion: "Node.js",
    baseLogger: new Logger(LogLevel.NONE),
  };
  if (opts.proxy) clientParams.proxy = { ip: opts.proxy.host, port: opts.proxy.port, socksType: opts.proxy.socksType };

  const session = new StringSession(opts.sessionString);
  const client = new TelegramClient(session, opts.apiId, opts.apiHash, clientParams);

  console.log("Connecting to Telegram...");
  await client.connect();
  console.log("Fetching chat list...");

  let availableChats: AvailableChat[] = [];
  try {
    availableChats = await listAvailableChats(client);
  } finally {
    try { await client.disconnect(); } catch { /* ignore */ }
    await new Promise((resolve) => setTimeout(resolve, 800));
  }

  const rl = createRl();
  let newChats: object[];
  try { newChats = await selectChatsFromList(rl, availableChats, (opts.existingChats ?? []) as Record<string, unknown>[]); }
  finally { rl.close(); }

  const merged = [...(opts.existingChats ?? [])] as Record<string, unknown>[];
  for (const nc of newChats as Record<string, unknown>[]) {
    const idx = merged.findIndex((c) => String(c.chatId) === String(nc.chatId));
    if (idx >= 0) merged[idx] = nc; else merged.push(nc);
  }

  writePluginConfigWithAllowedTools({
    pluginId: "telegram-chat-summary",
    config: { chats: merged },
    toolNames: [...SUMMARY_TOOL_NAMES],
  });
}
