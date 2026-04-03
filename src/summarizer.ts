import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  DEFAULT_LANGUAGE,
  DEFAULT_SUMMARY_PROMPT,
  type PluginConfig,
  type ChatEntry,
} from "./config.js";
import { fetchMessages, resolveChatTitle, sendMessageAsUser } from "./telegram-client.js";

export type SummarizerDeps = {
  api: OpenClawPluginApi;
  cfg: PluginConfig;
};

let lastSummaryAt: Date | null = null;

function getCheckpoint(): Date {
  return lastSummaryAt ?? new Date();
}

function markCheckpoint(at: Date): void {
  lastSummaryAt = at;
}

function buildPrompt(
  messages: string,
  chatTitle: string,
  timeRange: string,
  language: string,
  customPrompt?: string,
): string {
  const template = customPrompt ?? DEFAULT_SUMMARY_PROMPT;
  return template
    .replace("{language}", language)
    .replace("{messages}", messages)
    .replace("{chatTitle}", chatTitle)
    .replace("{timeRange}", timeRange);
}

function formatMessages(
  msgs: Awaited<ReturnType<typeof fetchMessages>>,
): string {
  if (msgs.length === 0) return "(该时段无消息)";
  return msgs
    .map((m) => {
      const t = m.date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
      return `[${t}] ${m.sender}: ${m.text}`;
    })
    .join("\n");
}

function notifyLocal(title: string, message: string): void {
  if (process.platform !== "darwin") return;

  const safeTitle = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const safeMessage = message
    .replace(/\n/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .slice(0, 240);

  try {
    execFileSync("osascript", ["-e", `display notification \"${safeMessage}\" with title \"${safeTitle}\"`], {
      stdio: "ignore",
      timeout: 2000,
    });
  } catch {
    // ignore local notification errors
  }
}

export async function summarizeChat(
  deps: SummarizerDeps,
  chatEntry: ChatEntry,
  signal?: AbortSignal,
): Promise<void> {
  const { api, cfg } = deps;
  const language = cfg.language ?? DEFAULT_LANGUAGE;
  const maxMessages = cfg.maxMessagesPerFetch ?? 500;
  const targetChatId = cfg.botToken
    ? (cfg.alertChatId ?? chatEntry.chatId)
    : chatEntry.chatId;
  const label = chatEntry.label ?? String(chatEntry.chatId);

  const since = getCheckpoint();
  const startedAt = new Date();

  api.logger.info(
    `telegram-chat-summary: fetching messages for '${label}' (since ${since.toISOString()})`,
  );

  let msgs: Awaited<ReturnType<typeof fetchMessages>>;
  try {
    msgs = await fetchMessages(cfg, chatEntry.chatId, since, maxMessages);
  } catch (err) {
    api.logger.error(`telegram-chat-summary: fetch failed for '${label}': ${err}`);
    return;
  }

  markCheckpoint(startedAt);

  if (msgs.length === 0) {
    api.logger.info(`telegram-chat-summary: no messages in '${label}', skipping`);
    return;
  }

  api.logger.info(
    `telegram-chat-summary: ${msgs.length} messages fetched for '${label}', summarizing`,
  );

  const chatTitle = await resolveChatTitle(cfg, chatEntry.chatId).catch(() => label);
  const now = new Date();
  const timeRange = `${since.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} – ${now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;

  const prompt = buildPrompt(
    formatMessages(msgs),
    chatTitle,
    timeRange,
    language,
    cfg.summaryPrompt,
  );

  let summaryText: string;
  try {
    const { resolveAgentDir, resolveAgentWorkspaceDir, resolveTimeoutSeconds } = await import(
      "openclaw/plugin-sdk/agent-runtime"
    );
    const agentId = "main";
    const agentDir = resolveAgentDir(api.config, agentId);
    const workspaceDir = resolveAgentWorkspaceDir(api.config, agentId);
    const timeoutMs = resolveTimeoutSeconds(
      api.config?.agents?.defaults?.timeoutSeconds,
      48 * 60 * 60,
    ) * 1000;

    const safeId = String(chatEntry.chatId).replace(/[^a-z0-9_-]/gi, "_");
    const sessionFile = path.join(agentDir, "sessions", `tg-summary-${safeId}.jsonl`);

    // Use the primary model from user's config
    const primaryModel = (api.config as any)?.agents?.defaults?.model?.primary;
    let provider: string | undefined;
    let model: string | undefined;

    if (primaryModel && typeof primaryModel === "string") {
      const parts = primaryModel.split("/");
      if (parts.length === 2) {
        provider = parts[0];
        model = parts[1];
      } else {
        model = primaryModel;
      }
    }

    const result = await api.runtime.agent.runEmbeddedPiAgent({
      sessionId: `telegram-chat-summary:${safeId}:${Date.now()}`,
      runId: randomUUID(),
      sessionFile,
      workspaceDir,
      agentDir,
      config: api.config,
      prompt,
      timeoutMs,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
    });

    // Extract text from payloads array
    summaryText =
      result.payloads
        ?.filter((p) => p.text && !p.isReasoning && !p.isError)
        .map((p) => p.text)
        .join("\n")
        .trim() ?? "";
  } catch (err) {
    if (signal?.aborted) return;
    api.logger.error(`telegram-chat-summary: AI summarization failed for '${label}': ${err}`);
    return;
  }

  if (!summaryText) {
    api.logger.warn(`telegram-chat-summary: empty summary for '${label}'`);
    return;
  }

  const header = `📋 <b>${chatTitle} 摘要</b> · ${now.toLocaleDateString("zh-CN")} ${timeRange}`;
  const fullMessage = `${header}\n\n${summaryText}`;

  api.logger.info(`telegram-chat-summary: summary content for '${label}':\n${fullMessage}`);
  console.log(`[telegram-chat-summary][${label}]\n${fullMessage}`);

  try {
    await sendMessageAsUser(
      cfg,
      targetChatId,
      fullMessage,
      cfg.botToken,
    );
    api.logger.info(`telegram-chat-summary: summary sent to '${label}' → ${targetChatId}`);
    notifyLocal("Telegram Chat Summary", fullMessage);
  } catch (err) {
    api.logger.error(`telegram-chat-summary: send failed for '${label}': ${err}`);
    notifyLocal("Telegram Chat Summary", `${chatTitle} 摘要发送失败：${String(err)}`);
  }
}
