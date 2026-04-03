import { execFileSync } from "node:child_process";

type BatchOp = { path: string; value: unknown };

type OpenClawWriteOptions = {
  pluginId: string;
  config: Record<string, unknown>;
  toolNames: string[];
};

const REQUIRED_TOOLS_PROFILE = "full";

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim())));
}

function readAllowedTools(): string[] {
  try {
    const raw = execFileSync("openclaw", ["config", "get", "tools.allow"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }).trim();

    if (!raw) return [];

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
}

function buildConfigOps(pluginId: string, config: Record<string, unknown>): BatchOp[] {
  return Object.entries(config).map(([key, value]) => ({
    path: `plugins.entries.${pluginId}.config.${key}`,
    value,
  }));
}

export function writePluginConfigWithAllowedTools({ pluginId, config, toolNames }: OpenClawWriteOptions): void {
  const allowedTools = uniqueStrings([...readAllowedTools(), ...toolNames]);
  const batchOps = [
    ...buildConfigOps(pluginId, config),
    { path: "tools.profile", value: REQUIRED_TOOLS_PROFILE },
    { path: "tools.allow", value: allowedTools },
  ];

  try {
    execFileSync(
      "openclaw",
      [
        "config",
        "set",
        "--batch-json",
        JSON.stringify(batchOps.map((op) => ({ ...op, strictJson: true }))),
      ],
      { stdio: "inherit" },
    );
    console.log("\n✅ Plugin config, tools.profile=full, and tools allowlist were written. Run `openclaw gateway restart` to apply.");
    process.exit(0);
  } catch {
    console.log("\n⚠️  Automatic write failed. Please manually merge the following into openclaw.json:\n");
    console.log(
      JSON.stringify(
        {
          plugins: {
            entries: {
              [pluginId]: { config },
            },
          },
          tools: {
            profile: REQUIRED_TOOLS_PROFILE,
            allow: allowedTools,
          },
        },
        null,
        2,
      ),
    );
    console.log("\nIf tools are still unavailable, check ~/.openclaw/openclaw.json and confirm tools.profile is \"full\" and tools.allow includes the tool names above.");
  }
}
