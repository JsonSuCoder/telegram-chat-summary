import cron from "node-cron";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { DEFAULT_SCHEDULE_MINUTES, type PluginConfig } from "./config.js";
import { summarizeChat } from "./summarizer.js";

function minutesToCron(minutes: number): string {
  if (minutes < 1) minutes = 1;
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? "0 * * * *" : `0 */${hours} * * *`;
  }
  return `*/${minutes} * * * *`;
}

export type SchedulerState = {
  stop: () => void;
  isRunning: () => boolean;
  startedAt: Date;
  taskCount: number;
};

export function startScheduler(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
): SchedulerState {
  const abortController = new AbortController();
  const { signal } = abortController;
  const startedAt = new Date();
  let stopped = false;

  const scheduleMinutes = cfg.scheduleMinutes ?? DEFAULT_SCHEDULE_MINUTES;
  const schedule = minutesToCron(scheduleMinutes);
  const taskCount = (cfg.chats ?? []).length;

  api.logger.info(`telegram-chat-summary: scheduling all chats every ${scheduleMinutes}min (${schedule})`);

  const task = cron.schedule(schedule, async () => {
    if (signal.aborted) return;
    for (const chatEntry of cfg.chats ?? []) {
      const label = chatEntry.label ?? String(chatEntry.chatId);
      try {
        await summarizeChat({ api, cfg }, chatEntry, signal);
      } catch (err) {
        api.logger.error(`telegram-chat-summary: task error for '${label}': ${err}`);
      }
    }
  });

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      abortController.abort();
      task.stop();
      api.logger.info("telegram-chat-summary: scheduler stopped");
    },
    isRunning() {
      return !stopped;
    },
    startedAt,
    taskCount,
  };
}
