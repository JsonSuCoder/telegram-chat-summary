import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { pluginConfigSchema, type PluginConfig, isSchedulerEnabled } from "./src/config.js";
import { startScheduler, type SchedulerState } from "./src/scheduler.js";
import { disconnectClient } from "./src/telegram-client.js";
import { execFileSync } from "node:child_process";

let schedulerState: SchedulerState | null = null;

/** Pull plugin config out of the full openclaw config object */
function resolvePluginConfig(api: { config: unknown }): PluginConfig | null {
  const cfg = api.config as Record<string, unknown> | undefined;
  const entries = (cfg?.plugins as Record<string, unknown> | undefined)
    ?.entries as Record<string, unknown> | undefined;
  return (
    ((entries?.["telegram-chat-summary"] as Record<string, unknown> | undefined)
      ?.config as PluginConfig | undefined) ?? null
  );
}

function requireRunnablePluginConfig(pluginCfg: PluginConfig | null): PluginConfig {
  if (!pluginCfg) {
    throw new Error("telegram-chat-summary not configured.");
  }

  if (!pluginCfg.apiId || !pluginCfg.apiHash || !pluginCfg.sessionString) {
    throw new Error("telegram-chat-summary requires apiId/apiHash/sessionString. Run `openclaw telegram-chat-summary setup`.");
  }

  if (!pluginCfg.chats || pluginCfg.chats.length === 0) {
    throw new Error("No chats configured in telegram-chat-summary config.");
  }

  return pluginCfg;
}

function ensureSchedulerStarted(api: PluginApi, pluginCfg: PluginConfig): SchedulerState {
  if (schedulerState?.isRunning()) {
    return schedulerState;
  }

  schedulerState = startScheduler(api, pluginCfg);
  return schedulerState;
}

async function stopScheduler(): Promise<boolean> {
  if (!schedulerState?.isRunning()) {
    schedulerState = null;
    return false;
  }

  schedulerState.stop();
  schedulerState = null;
  await disconnectClient();
  return true;
}

function setSchedulerEnabled(enabled: boolean): void {
  execFileSync(
    "openclaw",
    [
      "config", "set", "--batch-json",
      JSON.stringify([{
        path: "plugins.entries.telegram-chat-summary.config.schedulerEnabled",
        value: enabled,
        strictJson: true,
      }]),
    ],
    { stdio: "inherit" },
  );
}

function getSchedulerStatus(pluginCfg: PluginConfig | null) {
  return {
    configSchedulerEnabled: pluginCfg ? isSchedulerEnabled(pluginCfg) : null,
    currentProcessRunning: schedulerState?.isRunning() ?? false,
    startedAt: schedulerState?.startedAt.toISOString() ?? null,
    taskCount: schedulerState?.taskCount ?? 0,
    needsGatewayRestart: true,
  };
}

export default definePluginEntry({
  id: "telegram-chat-summary",
  name: "Telegram Chat Summary",
  description:
    "Lists Telegram chats, configures summary monitoring, and runs AI summaries for Telegram conversations.",

  // Wrap TypeBox schema into the shape OpenClaw expects
  configSchema: {
    safeParse: (value: unknown) => {
      try {
        Value.Assert(pluginConfigSchema, value);
        return { success: true, data: value };
      } catch (err) {
        return {
          success: false,
          error: {
            issues: [{ path: [], message: String(err) }],
          },
        };
      }
    },
    jsonSchema: pluginConfigSchema as unknown as Record<string, unknown>,
  },

  register(api) {
    const pluginCfg = resolvePluginConfig(api);

    if (!pluginCfg?.apiId || !pluginCfg?.apiHash) {
      api.logger.warn(
        "telegram-chat-summary: apiId/apiHash not configured. " +
          "Run `openclaw telegram-chat-summary setup` to authenticate.",
      );
      registerCli(api);
      return;
    }

    if (!pluginCfg.sessionString) {
      api.logger.warn(
        "telegram-chat-summary: sessionString not set. " +
          "Run `openclaw telegram-chat-summary setup` to log in.",
      );
      registerCli(api);
      return;
    }

    api.registerTool(
      {
        name: "telegram_summary_scheduler_start",
        label: "Telegram Summary: Start Scheduler",
        description:
          "When the user says start summary monitoring, start the Telegram summary scheduler, or resume scheduled summaries, start the in-process summary scheduler.",
        parameters: Type.Object({}),
        async execute() {
          const runnableCfg = requireRunnablePluginConfig(pluginCfg);
          setSchedulerEnabled(true);
          return {
            content: [{ type: "text" as const, text: isSchedulerEnabled(runnableCfg) ? "Summary scheduler is already enabled in config. Run `openclaw gateway restart` to ensure the background scheduler is running." : "Summary scheduler enabled in config. Run `openclaw gateway restart` to start the background scheduler." }],
            details: {
              status: isSchedulerEnabled(runnableCfg) ? "already_enabled" : "enabled",
              configSchedulerEnabled: true,
              currentProcessRunning: schedulerState?.isRunning() ?? false,
              needsGatewayRestart: true,
            },
          };
        },
      },
      { optional: true },
    );

    api.registerTool(
      {
        name: "telegram_summary_scheduler_stop",
        label: "Telegram Summary: Stop Scheduler",
        description:
          "When the user says stop summary monitoring, stop the Telegram summary scheduler, or pause scheduled summaries, stop the in-process summary scheduler.",
        parameters: Type.Object({}),
        async execute() {
          requireRunnablePluginConfig(pluginCfg);
          setSchedulerEnabled(false);
          return {
            content: [{ type: "text" as const, text: "Summary scheduler disabled in config. Run `openclaw gateway restart` to stop the background scheduler." }],
            details: {
              status: "disabled",
              configSchedulerEnabled: false,
              currentProcessRunning: schedulerState?.isRunning() ?? false,
              needsGatewayRestart: true,
            },
          };
        },
      },
      { optional: true },
    );

    api.registerTool(
      {
        name: "telegram_summary_scheduler_status",
        label: "Telegram Summary: Scheduler Status",
        description:
          "When the user says check summary scheduler status, is summary monitoring running, or show Telegram summary scheduler state, report the in-process summary scheduler status.",
        parameters: Type.Object({}),
        async execute() {
          const status = getSchedulerStatus(pluginCfg);
          return {
            content: [{ type: "text" as const, text: status.configSchedulerEnabled ? "Summary scheduler is enabled in config. Current process state may differ from the gateway process. Run `openclaw gateway restart` after config changes." : "Summary scheduler is disabled in config. Current process state may differ from the gateway process until restart." }],
            details: status,
          };
        },
      },
      { optional: true },
    );

    api.registerTool(
      {
        name: "telegram_remove_summary_chats",
        label: "Telegram Summary: Remove Chats",
        description:
          "When the user says remove this Telegram chat from summary monitoring, stop summarizing a group, or delete chats from scheduled summaries, remove configured chats by chatId.",
        parameters: Type.Object({
          chatIds: Type.Array(
            Type.Union([Type.String(), Type.Number()], {
              description: "Configured Telegram chat ID or @username to remove from summary monitoring",
            }),
            { minItems: 1, description: "Chats to remove from Telegram summaries" },
          ),
        }),
        async execute(_id, params) {
          const existing = (pluginCfg.chats ?? []) as Array<{ chatId: string | number; label?: string }>;
          const removeIds = new Set(params.chatIds.map((chatId: string | number) => String(chatId)));
          const remaining = existing.filter((chat) => !removeIds.has(String(chat.chatId)));
          const removed = existing.filter((chat) => removeIds.has(String(chat.chatId)));
          execFileSync(
            "openclaw",
            [
              "config", "set", "--batch-json",
              JSON.stringify([{
                path: "plugins.entries.telegram-chat-summary.config.chats",
                value: remaining,
                strictJson: true,
              }]),
            ],
            { stdio: "inherit" },
          );
          return {
            content: [{ type: "text" as const, text: `Removed ${removed.length} chat(s). Run \`openclaw gateway restart\` to apply.` }],
            details: { removed, chats: remaining },
          };
        },
      },
      { optional: true },
    );

    api.registerTool(
      {
        name: "telegram_configure_chats",
        label: "Telegram Summary: Configure Chats",
        description:
          "When the user says add this Telegram chat to summary, update summary monitoring, or save chats for scheduled summaries, add or update summary chat configuration by chatId.",
        parameters: Type.Object({
          chats: Type.Array(
            Type.Object({
              chatId: Type.Union([Type.String(), Type.Number()], {
                description: "Telegram chat ID or @username to add to summary monitoring",
              }),
              label: Type.Optional(Type.String({ description: "Human-readable label" })),
            }),
            { description: "Chats to add or update for Telegram summaries" },
          ),
        }),
        async execute(_id, params) {
          const existing = (pluginCfg.chats ?? []) as Array<{ chatId: string | number; label?: string }>;
          const merged = [...existing];
          for (const nc of params.chats) {
            const idx = merged.findIndex((c) => String(c.chatId) === String(nc.chatId));
            if (idx >= 0) {
              merged[idx] = { ...merged[idx], ...nc };
            } else {
              merged.push(nc);
            }
          }
          execFileSync(
            "openclaw",
            [
              "config", "set", "--batch-json",
              JSON.stringify([{
                path: "plugins.entries.telegram-chat-summary.config.chats",
                value: merged,
                strictJson: true,
              }]),
            ],
            { stdio: "inherit" },
          );
          return {
            content: [{ type: "text" as const, text: `Configured ${merged.length} chat(s). Run \`openclaw gateway restart\` to apply.` }],
            details: { chats: merged },
          };
        },
      },
      { optional: true },
    );

    api.registerService({
      id: "telegram-chat-summary",
      start: () => {
        api.logger.info("telegram-chat-summary: service starting");
        if (!isSchedulerEnabled(pluginCfg)) {
          api.logger.info("telegram-chat-summary: scheduler disabled by config; not starting background scheduler");
          schedulerState = null;
          return;
        }
        ensureSchedulerStarted(api, pluginCfg);
      },
      stop: async () => {
        await stopScheduler();
      },
    });

    registerCli(api);
  },
});

type PluginApi = Parameters<Parameters<typeof definePluginEntry>[0]["register"]>[0];

/** Register `openclaw telegram-chat-summary` CLI subcommands */
function registerCli(api: PluginApi) {
  api.registerCli(
    async ({ program }) => {
      const cmd = program
        .command("telegram-chat-summary")
        .description("Telegram Chat Summary plugin management");

      cmd
        .command("setup")
        .description("交互式配置：登录 Telegram 并生成完整插件配置")
        .action(async () => {
          const { setupAll } = await import("./src/setup.js");
          await setupAll();
        });

      cmd
        .command("configure-chats")
        .description("重新配置总结聊天列表（复用已有 session，无需重新登录）")
        .action(async () => {
          const pluginCfg = resolvePluginConfig(api);
          if (!pluginCfg?.apiId || !pluginCfg?.apiHash || !pluginCfg?.sessionString) {
            console.error("缺少 apiId/apiHash/sessionString，请先运行 `openclaw telegram-chat-summary setup`。");
            process.exit(1);
          }
          const { configureChats } = await import("./src/setup.js");
          await configureChats({
            apiId: pluginCfg.apiId,
            apiHash: pluginCfg.apiHash,
            sessionString: pluginCfg.sessionString,
            proxy: pluginCfg.proxy as { host: string; port: number; socksType: 4 | 5 } | undefined,
            existingChats: (pluginCfg.chats ?? []) as object[],
          });
        });

      cmd
        .command("start")
        .description("Enable the summary scheduler in config")
        .action(() => {
          try {
            const runnableCfg = requireRunnablePluginConfig(resolvePluginConfig(api));
            const alreadyEnabled = isSchedulerEnabled(runnableCfg);
            setSchedulerEnabled(true);
            console.log(
              alreadyEnabled
                ? "Summary scheduler is already enabled in config. Run `openclaw gateway restart` to ensure the background scheduler is running."
                : "Summary scheduler enabled in config. Run `openclaw gateway restart` to start the background scheduler.",
            );
            process.exit(0);
          } catch (err) {
            console.error(String(err));
            process.exit(1);
          }
        });

      cmd
        .command("stop")
        .description("Disable the summary scheduler in config")
        .action(() => {
          try {
            requireRunnablePluginConfig(resolvePluginConfig(api));
            setSchedulerEnabled(false);
            console.log("Summary scheduler disabled in config. Run `openclaw gateway restart` to stop the background scheduler.");
            process.exit(0);
          } catch (err) {
            console.error(String(err));
            process.exit(1);
          }
        });

      cmd
        .command("status")
        .description("Show summary scheduler config and current-process status")
        .action(() => {
          const status = getSchedulerStatus(resolvePluginConfig(api));
          console.log(JSON.stringify(status, null, 2));
          console.log("Current process state may differ from the gateway process. Run `openclaw gateway restart` after config changes.");
          process.exit(0);
        });
    },
    {
      descriptors: [
        {
          name: "telegram-chat-summary",
          description: "Telegram Chat Summary plugin management",
          hasSubcommands: true,
        },
      ],
    },
  );
}
