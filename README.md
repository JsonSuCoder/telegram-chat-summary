# telegram-chat-summary

基于 OpenClaw 的 Telegram 聊天摘要插件。

支持列出 Telegram 聊天、配置摘要监听 chat，并可立即对指定聊天执行摘要。TUI 自然语言场景下应优先调用插件 tool，而不是退回到 Telethon / Python 脚本方案。

## 功能概览

- 列出当前账号可访问的 Telegram 聊天、群组、频道与 chat ID（`telegram_summary_list_chats`）
- 按 chat 维度定时摘要（cron）
- 支持 CLI 调度控制（`start` / `stop` / `status`）
- 支持可选工具调度控制（`telegram_summary_scheduler_start` / `telegram_summary_scheduler_stop` / `telegram_summary_scheduler_status`）
- 支持可选工具配置摘要监听 chat（`telegram_configure_chats`）
- 支持可选工具移除摘要监听 chat（`telegram_remove_summary_chats`）
- 支持自定义摘要提示词模板（`summaryPrompt`）
- 支持 `targetChatId` 转发到其他聊天
- 支持 `sendViaBotToken` 通过 Bot API 发送
- 支持 SOCKS 代理连接 MTProto

---

## 目录结构

```text
telegram-chat-summary/
├─ index.ts                # 插件入口：注册 tool/service/cli
├─ openclaw.plugin.json    # 插件元数据与 configSchema
├─ package.json
├─ tsconfig.json
└─ src/
   ├─ config.ts            # 配置 schema、类型与默认值
   ├─ scheduler.ts         # cron 调度与生命周期
   ├─ telegram-client.ts   # Telegram 拉取/发送能力
   ├─ summarizer.ts        # 核心流程（抓取→摘要→发送）
   └─ setup.ts             # QR 登录并生成 sessionString
```

---

## 工作流程

每次触发（定时或手动）执行以下链路：

1. 根据全局上次摘要时间拉取增量消息。
2. 格式化消息为摘要输入文本。
3. 组装 prompt（默认模板或 `summaryPrompt`）。
4. 调用 `api.runtime.agent.runEmbeddedPiAgent(...)` 生成摘要。
5. 发送到 `targetChatId`（缺省为当前 chat）。
6. 记录日志（抓取条数、摘要内容、发送结果）。

---

## 前置条件

- 已安装并可运行 OpenClaw
- 已具备 Telegram `apiId` 与 `apiHash`（来自 https://my.telegram.org ）
- 插件目录已被 OpenClaw 加载（通常位于 `~/.openclaw/extensions/telegram-chat-summary`）

---

## 安装

```bash
npm --prefix ~/.openclaw/extensions/telegram-chat-summary install
```

如在本地开发目录运行：

```bash
npm --prefix /Users/qmk/work/openclaw-skill/telegram-chat-summary install
```

---

## 配置说明

插件配置路径：`plugins.entries.telegram-chat-summary.config`

### 顶层字段

- `apiId` (number, 必填)
- `apiHash` (string, 必填)
- `sessionString` (string, 推荐；可由 setup 生成)
- `schedulerEnabled` (boolean, 可选，默认 `true`；控制后台调度器是否启用，修改后需重启 gateway 生效)
- `proxy` (object, 可选)
  - `host` (string)
  - `port` (number)
  - `socksType` (4 | 5)
  - `username` (string)
  - `password` (string)
- `maxMessagesPerFetch` (number, 默认 500)
- `language` (string, 默认 `zh-CN`)
- `summaryPrompt` (string, 可选，自定义模板)
- `chats` (array, 可选)

### chats[i] 字段

- `chatId` (string | number, 必填)
- `targetChatId` (string | number, 可选，默认等于 `chatId`)
- `schedule` (string, 可选，默认 `0 * * * *`)
- `label` (string, 可选)
- `sendViaBotToken` (string, 可选)

---

## 配置示例（openclaw.json）

```json
{
  "plugins": {
    "entries": {
      "telegram-chat-summary": {
        "config": {
          "apiId": 12345678,
          "apiHash": "0123456789abcdef0123456789abcdef",
          "sessionString": "YOUR_SESSION_STRING",
          "schedulerEnabled": true,
          "maxMessagesPerFetch": 500,
          "language": "zh-CN",
          "chats": [
            {
              "chatId": -1001234567890,
              "label": "项目群",
              "schedule": "0 * * * *"
            },
            {
              "chatId": "@your_channel",
              "targetChatId": -1009988776655,
              "schedule": "*/30 * * * *",
              "sendViaBotToken": "123456:ABC-DEF"
            }
          ]
        }
      }
    }
  },
  "tools": {
    "allow": [
      "telegram_summary_scheduler_start",
      "telegram_summary_scheduler_stop",
      "telegram_summary_scheduler_status",
      "telegram_summary_list_chats",
      "telegram_configure_chats",
      "telegram_remove_summary_chats"
    ]
  }
}
```

---

## 认证与初始化

### 1) 运行 setup 自动写入配置

```bash
openclaw telegram-chat-summary setup --api-id <API_ID> --api-hash <API_HASH>
```

可选代理参数：

```bash
openclaw telegram-chat-summary setup --api-id <API_ID> --api-hash <API_HASH> --proxy-host 127.0.0.1 --proxy-port 1080
```

setup 会完成以下动作：

- 扫码登录并生成 `sessionString`
- 写入 `plugins.entries.telegram-chat-summary.config`
- 自动把以下工具追加到 `tools.allow`（保留已有条目并去重），并确保 `tools.profile = "full"`
  - `telegram_summary_scheduler_start`
  - `telegram_summary_scheduler_stop`
  - `telegram_summary_scheduler_status`
  - `telegram_summary_list_chats`
  - `telegram_configure_chats`
  - `telegram_remove_summary_chats`

### 2) 重启网关

```bash
openclaw gateway restart
```

---

## CLI 命令

### setup

```bash
openclaw telegram-chat-summary setup [--api-id <id>] [--api-hash <hash>] [--proxy-host <host>] [--proxy-port <port>]
```

用途：扫码登录 Telegram，生成 `sessionString`，并自动写入插件配置、`tools.profile = "full"` 与 `tools.allow`。

### start

```bash
openclaw telegram-chat-summary start
```

用途：在配置中启用后台摘要调度器。执行后需运行 `openclaw gateway restart` 才会真正生效。

### stop

```bash
openclaw telegram-chat-summary stop
```

用途：在配置中禁用后台摘要调度器。执行后需运行 `openclaw gateway restart` 才会真正停止后台任务。

### status

```bash
openclaw telegram-chat-summary status
```

用途：查看配置态与当前进程可见的调度器状态。注意：当前进程状态不等于 gateway 进程状态；修改配置后需重启 gateway 才会完全生效。

---

## Tool（可选）

插件注册了以下可选工具：

- `telegram_summary_list_chats`：列出可访问的 Telegram 聊天、群组、频道与 chat ID
- `telegram_configure_chats`：添加或更新摘要监听 chat
- `telegram_remove_summary_chats`：从摘要监听中移除已配置 chat
- `telegram_summary_scheduler_start`：在配置中启用后台摘要调度器（需重启 gateway 生效）
- `telegram_summary_scheduler_stop`：在配置中禁用后台摘要调度器（需重启 gateway 生效）
- `telegram_summary_scheduler_status`：查看配置态与当前进程可见的摘要调度器状态

参数：

### `telegram_summary_list_chats`

无参数。

### `telegram_configure_chats`

- `chats` (array, 必填)
  - `chatId` (string | number, 必填)
  - `label` (string, 可选)

说明：`telegram_configure_chats` 是 add/update 语义，不会删除旧 chat。

### `telegram_remove_summary_chats`

- `chatIds` ((string | number)[], 必填，至少 1 个，必须已存在于 `config.chats`)

### `telegram_summary_scheduler_start`

无参数。

### `telegram_summary_scheduler_stop`

无参数。

### `telegram_summary_scheduler_status`

无参数。

### 自然语言示例

- “帮我看看我有哪些 Telegram 群” → 优先调用 `telegram_summary_list_chats`
- “把第 2 个群加入摘要监听” → 先列聊天并拿到 chatId，再调用 `telegram_configure_chats`
- “把这个群从摘要监听里移除” → 调用 `telegram_remove_summary_chats`
- “开始摘要监听” → 调用 `telegram_summary_scheduler_start`
- “停止摘要监听” → 调用 `telegram_summary_scheduler_stop`
- “摘要监听现在开着吗” → 调用 `telegram_summary_scheduler_status`
- “帮我查一下这个群的 chat id” → 优先调用 `telegram_summary_list_chats`

### 重要说明

当以上 tool 可用时，应优先调用 tool，不要改为建议安装 Telethon、编写 Python 脚本或手动调用 MTProto。

---

## 摘要消息格式

标题格式：

```text
📋 <b>{chatTitle} 摘要</b> · {date} {timeRange}
```

正文为 AI 生成摘要；默认提示词要求：

- 覆盖主要话题
- 提取重要决定与关键信息
- 忽略无意义闲聊与重复内容
- 使用结构化要点输出

---

## 常见问题

### 1) unknown command 'telegram-chat-summary'

原因：插件未加载成功。

排查：

- 插件目录是否存在：`~/.openclaw/extensions/telegram-chat-summary`
- `openclaw.json` 是否有 `plugins.entries.telegram-chat-summary`
- 是否已 `npm install`
- 是否已执行 `openclaw gateway restart`

### 2) Setup 时报 API ID / API Hash 缺失

原因：未通过命令参数传入，也未设置环境变量。

修复：

- 通过 `--api-id --api-hash` 传入
- ��设置 `TELEGRAM_API_ID` / `TELEGRAM_API_HASH`

### 3) Tool 存在但 TUI / agent 看不到

优先排查：

- `~/.openclaw/openclaw.json` 的 `tools.profile` 是否为 `"full"`
- `~/.openclaw/openclaw.json` 的 `tools.allow` 是否包含：
  - `telegram_summary_scheduler_start`
  - `telegram_summary_scheduler_stop`
  - `telegram_summary_scheduler_status`
  - `telegram_summary_list_chats`
  - `telegram_configure_chats`
  - `telegram_remove_summary_chats`
- 是否已重新执行 `openclaw gateway restart`
- 如 setup 自动写入失败，是否已按 fallback JSON 手动合并配置

### 4) stop 了但后台任务还在跑

原因：`start` / `stop` / `status` 现在区分“配置态”和“当前进程态”。CLI 或 tool 运行在独立进程里时，看不到 gateway 进程内存中的 `schedulerState`，所以仅凭当前进程状态不能断言后台已停。

处理：

- 执行 `openclaw telegram-chat-summary stop`
- 再执行 `openclaw gateway restart`
- 用 `status` 查看配置态是否已变为禁用

### 5) 没有收到摘要

排查顺序：

- 时间窗口内是否有消息
- 首次运行时起点就是当前时间
- `schedule` 是否有效 cron
- 目标 chat 是否可发送（权限/ID）
- 是否使用了无效 `sendViaBotToken`

### 4) 定时任务停不下来

处理：

- 直接重启网关：`openclaw gateway restart`
- 或禁用该插件配置后重启

---

## 验证清单

1. 配置校验：缺失 `apiId/apiHash` 时仅注册 CLI 并给出提示。
2. 调度器启动链路：发几条测试消息，执行 `openclaw telegram-chat-summary start`，确认调度器成功启动。
3. 状态链路：执行 `openclaw telegram-chat-summary status`，确认能看到当前进程状态。
4. 停止链路：执行 `openclaw telegram-chat-summary stop`，确认调度器停止且后续不再继续调度。
5. 异常链路：网络错误/无权限/错误 chatId 时服务不中断且日志可诊断。

---

## 验证清单

1. 运行 `openclaw telegram-chat-summary setup` 后，确认 `plugins.entries.telegram-chat-summary.config` 已写入。
2. 确认 `tools.profile` 为 `"full"`，且 `tools.allow` 包含：`telegram_summary_scheduler_start`、`telegram_summary_scheduler_stop`、`telegram_summary_scheduler_status`、`telegram_summary_list_chats`、`telegram_configure_chats`、`telegram_remove_summary_chats`。
3. 预先在 `tools.allow` 中保留其他工具名，重复执行 setup 后确认原条目仍在且没有重复。
4. 执行 `openclaw gateway restart`。
5. 在新会话里测试“帮我看看我有哪些 Telegram 群”，确认命中 `telegram_summary_list_chats`。

---

## 开发与检查

```bash
npm --prefix /Users/qmk/work/openclaw-skill/telegram-chat-summary install
npm --prefix /Users/qmk/work/openclaw-skill/telegram-chat-summary exec -- tsc -p /Users/qmk/work/openclaw-skill/telegram-chat-summary/tsconfig.json
```

---

## 安全与权限建议

- `sessionString`、`apiHash`、`sendViaBotToken` 均属于敏感信息，避免提交到仓库。
- 使用 Bot Token 发送时，确保 Bot 在目标 chat 有发言权限。
- 自定义 `summaryPrompt` 时避免包含敏感原文外发要求。
