# Telegram Auto Poll for OpenClaw v0.2.2

在 Telegram 和 OpenClaw 对话时，让需要确认或选择的回复自动变成原生投票，减少 Agent 忘记发投票的问题。普通聊天保持原样。

v0.2.2 支持带说明段落、命令和嵌套操作步骤的 A/B/C 方案，以及“方案 A”“选项 A”等标题；识别“你选哪条路”“更倾向哪套方案”和问句后的补充说明。投票只使用完整方案标题，原始说明全部保留。“你选 A、B 还是 C”会关联实际方案；明确只问 A/C 时保留该子集和顺序。解释性问题、教程、自由输入、已撤回的选择保持文字。

v0.2.1 修复了诊断报告前面的原因列表遮住末尾选择问题、列表中的“比如”误触发示例过滤的问题；支持“要我先查进程吗？还是你先执行 `/restart`？”及跨行写法。选项保留操作人和命令，清理末尾疑问语气。

## 新功能

- 每轮通过 `before_prompt_build` 自动加入投票输出规则，不依赖手动提醒或模型记忆。
- 发送前识别明确的选项列表、“A 还是 B”、“是否继续”“需要我检查吗”等问题。保留完整原文，不截短选项。中文及常见英文表达有测试覆盖。
- 合法的末尾 `[POLL]` JSON 块仍然优先；错误格式保留文字并记录警告。
- 默认公开投票（`anonymous:false`），以便支持的宿主将选择送回 AI 对话。可显式开启匿名。
- 保留先前言、后投票的两阶段投递、持久化去重、白名单、限速与不确定失败不自动重试。
- 读取 CLI JSON 结果，在投票已发出但选票不能回传时记录宿主提供的原因。

## 自动识别示例

```text
接下来你想先做哪个？
A. 检查配置
B. 查看日志
```

```text
你想先检查配置，还是先查看日志？
```

```text
是否继续？
```

```text
方案 A：用 Git 保留更新能力
保留 .git，后续可以 git pull。

方案 B：替换现有目录内容
先备份旧文件，再克隆到原位置。

你更倾向哪条路？我会先备份再执行。
```

分节方案要求按 A/B/C 顺序标号，支持加粗、Markdown 标题、项目符号和括号写法。说明段落中的数字步骤不会成为方案选项；标题超过 Telegram 选项长度时保持文字，不截断含义。带说明段落的数字或中文序号方案尚未扩展，建议使用 A/B/C 或显式 `[POLL]`。

教程、代码围栏、引用、普通说明和需要自由输入的问题不自动转换。规则识别不等于完整自然语言理解：特别含糊、没有明确选项、出现多组选项、标号缺失/重复或超出长度限制时保留文字；每轮提示规则用来覆盖更多表达。

## 安装和配置

要求已经可以在 Telegram 和 OpenClaw 正常对话。插件在实际运行 Gateway 的同一用户、同一配置和状态目录下安装，不需要额外 Bot Token。备份配置后执行：

```sh
openclaw plugins install /absolute/path/to/telegram-auto-poll --force
openclaw plugins enable telegram-auto-poll
```

默认复制到 OpenClaw 插件目录；升级时 `--force` 会覆盖同名插件。若已有 `plugins.allow` 白名单，把 `telegram-auto-poll` 追加进去，保留其他项。

将以下片段合并到 `~/.openclaw/openclaw.json`，保留已有配置：

```json
{
  "channels": {
    "telegram": {
      "streaming": { "mode": "off" }
    }
  },
  "plugins": {
    "entries": {
      "telegram-auto-poll": {
        "enabled": true,
        "hooks": {
          "allowConversationAccess": true,
          "allowPromptInjection": true
        },
        "config": {
          "autoDetect": true,
          "promptGuidance": true,
          "defaultDurationSeconds": 3600,
          "cliPath": "openclaw",
          "timeoutMs": 12000,
          "allowedChatIds": [],
          "maxPerChatPerHour": 100
        }
      }
    }
  }
}
```

**本机 OpenClaw 2026.10.5 的默认流式预览/原地编辑会绕过 `message_sending`。因此必须将 Telegram 的 `streaming.mode` 设为 `off`**，等待完整回复后发送；有账号级流式覆盖时也要关闭。这里使用对象配置，不是旧式字符串 `"off"`。

`cliPath` 推荐填写 `command -v openclaw` 的绝对路径，避免后台服务找不到命令。`allowedChatIds:[]` 表示不额外限制目标，仍受宿主渠道权限控制；可填写指定私聊或群 ID。代码默认时长 300 秒、每小时 10 次，示例改成 1 小时和 100 次；超额退回文字。提示注入需要上述两个 Hook 权限。

应用配置后热加载并检查：

```sh
openclaw plugins reload telegram-auto-poll --json
openclaw plugins inspect telegram-auto-poll --runtime --json
openclaw plugins doctor --json
```

应看到 `status:"loaded"` 和三个 `typedHooks`：`before_prompt_build`、`message_sending`、`message_sent`。本机验证版本 OpenClaw **2026.10.5**、Node.js **24**；代码要求 Node.js >=20，其他宿主版本需实际验证。

`plugins validate` 在本机版本校验工具/功能插件的 authoring metadata，不适合用来判断此 Hook 插件是否可运行。`hook-only` 是受支持兼容路径的信息提示。旧 README 的 `plugins lint` 也不是本机 CLI 支持的命令。

## 投票后继续对话

本机宿主会记录公开投票，将 `poll_answer` 按正常 Telegram 入站路由送回该聊天/话题的 Agent，形式类似：

```text
Poll response to "接下来先做哪个？": 查看日志
```

插件每轮指令会告诉 Agent 结合上下文继续，不要重复问同一问题。无需独立 `getUpdates` 或另一套 webhook。

- 私聊：公开投票，用户满足已有 pairing/allowlist 权限。
- 群组：机器人需要管理员身份，以便宿主核实投票者的成员资格；原有群/话题权限仍须允许入站。
- 匿名投票：无法回传个人选择。频道投票：本机宿主不支持将答案交回 Agent。
- 定时任务：回到该 Telegram 目标/话题正常路由的对话，不保证回到隔离 cron 会话。
- 投票是用户选择输入，不绕过删除、付款、部署等操作原有的授权规则。

## 显式格式

插件自动加入每轮指令，`AGENT_INSTRUCTIONS.md` 仅供额外定制。回复末尾可输出（实际发送不要包在代码围栏里）：

```text
请选择下一步。
[POLL]
{"question":"接下来先做哪个？","options":["检查配置","查看日志"],"anonymous":false,"multi":false,"silent":false,"durationSeconds":3600}
[/POLL]
```

问题 1–300 字，选项 2–12 个且不重复，每项 1–100 字；默认单选。显式块省略时长时为 300 秒，自动识别和每轮指令使用 `defaultDurationSeconds`。

## 排查与限制

- 没有编号：检查加载、白名单、提示权限、限速、选择表达是否明确，以及 Telegram 流式配置。
- 有编号没有投票：看 Gateway 的 `telegram-auto-poll` 日志和 `~/.openclaw/telegram-auto-poll-state.json`。CLI 超时/非零退出记为 `uncertain`；先看 TG 是否送达，不自动重发。
- 点击后 AI 没继续：检查匿名、群管理员身份、入站权限和日志中的答案路由警告。
- 两阶段投递可能只发出前言，不能保证前言和投票同时成功。长消息拆分及其他 Hook 改写仍需真实消息路径验证。
- 状态文件包含问题、选项和聊天 ID，保留窗口为 7 天，在后续写入时清理。应存放在受保护的可写持久目录；仅支持单 Gateway，不支持多进程共用文件并发写入。
- “不用投票”出现在发送文本中时不会自动转换；用户要求不用投票也会写进模型本轮上下文，但模型不遵守时仍可能被兜底规则识别。

## 验证

```sh
npm test
node --check index.mjs
npm run check:host
```

`check:host` 用临时配置和状态目录调用真实 OpenClaw 加载器，验证三个 Hook，不改生产配置、不向 Telegram 发消息。单元测试和加载检查不能替代在 TG 中提问并点击选项的完整联调。

参考：[Telegram 消息](https://docs.openclaw.ai/channels/telegram/messaging)、[提示 Hook](https://docs.openclaw.ai/plugins/hooks/prompt-and-session)、[消息 Hook](https://docs.openclaw.ai/plugins/hooks/messages)。
