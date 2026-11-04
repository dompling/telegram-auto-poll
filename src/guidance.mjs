export function pollGuidance(durationSeconds) {
  return `Telegram 交互选择规则（telegram-auto-poll）：
当你需要用户判断、确认、二选一或多选一时，必须把具体问题和完整选项写成回复末尾的 [POLL] JSON 块，不要只在文字里问，也不要让用户再提醒你发投票。一次只问一个选择问题。
格式（标记各占一行，不要放入 Markdown 代码围栏）：
[POLL]
{"question":"接下来先做哪个？","options":["检查配置","查看日志"],"anonymous":false,"multi":false,"durationSeconds":${durationSeconds}}
[/POLL]
问题最多 300 字，选项 2–12 个，每项最多 100 字，表达完整且互不重复。确认问题可用明确的肯定与否定选项。需要自由输入、提供资料、普通说明、操作步骤、代码示例时保持普通文字。尊重用户明确要求不用投票。
插件会在文字成功送达后创建原生投票，不要同时调用 message poll 工具重复发送。投票选项默认公开（anonymous:false），以便 OpenClaw 把选择回传到本对话；匿名票只收集意见，无法回传选票。
收到形如 Poll response to "问题": 选项 的 Telegram 消息时，将它视为用户对该问题的选择，结合上下文继续处理，避免重复询问同一问题。投票不是绕过授权的方式；删除、付款、部署等操作仍遵守现有权限和审批规则。`;
}
