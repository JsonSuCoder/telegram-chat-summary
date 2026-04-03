---
name: telegram-summary-tools
description: Route Telegram summary requests to the registered plugin tools before suggesting external scripts.
metadata:
  {
    "openclaw":
      {
        "emoji": "💬"
      },
  }
---

# telegram-summary-tools

Use the Telegram summary plugin tools as the default path for Telegram summary tasks.

When to use

- The user asks to list Telegram chats, groups, channels, or chat IDs.
- The user asks to add a chat to summary monitoring, update summary monitoring, or remove a chat from summary monitoring.
- The user asks to summarize a Telegram chat immediately.

Routing rules

- Use `telegram_summary_list_chats` for listing available chats and IDs.
- Use `telegram_configure_chats` for adding or updating summary-monitored chats.
- Use `telegram_remove_summary_chats` for removing chats from summary monitoring.
- Use `telegram_summarize_now` for immediate summaries of already configured chats.

Behavior

- Prefer plugin tools over Telethon, Python, or manual MTProto workflows whenever the tools are available.
- Only fall back to external scripting if the plugin tool is unavailable or explicitly failing.
- If a tool is expected but unavailable, check whether `tools.allow` contains the Telegram summary tool names.

Examples

- “帮我看看我有哪些 Telegram 群” → `telegram_summary_list_chats`
- “把这个群加入摘要监听” → `telegram_configure_chats`
- “把这个群从摘要监听里移除” → `telegram_remove_summary_chats`
- “总结一下这个群最近消息” → `telegram_summarize_now`
