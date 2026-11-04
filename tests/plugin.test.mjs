import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePollText, fallbackText } from "../src/parse.mjs";
import { pollArguments, messageArguments, runCli, DefiniteDeliveryError, UncertainDeliveryError } from "../src/send.mjs";
import { createPlugin } from "../index.mjs";

const pollText = `[POLL]\n{\n  "question": "是否部署？",\n  "options": ["立即部署", "先测试", "取消"],\n  "anonymous": false,\n  "durationSeconds": 300\n}\n[/POLL]`;
const demoContext = { channelId: "telegram", accountId: "my-bot", runId: "run-1" };

function setup({ sendPoll = async () => {}, sendText = async () => {}, config = {}, statePath } = {}) {
  const tmp = statePath ? null : mkdtempSync(join(tmpdir(), "telegram-auto-poll-"));
  const path = statePath ?? join(tmp, "journal.json");
  const hooks = {};
  const logs = [];
  createPlugin({ sendPoll, sendText }).register({
    pluginConfig: { ...config, statePath: path },
    logger: { info: x => logs.push(x), warn: x => logs.push(x) },
    on: (name, handler) => { hooks[name] = handler; },
  });
  return { hooks, logs, path, cleanup: () => { if (tmp) rmSync(tmp, { recursive: true, force: true }); } };
}
function getRecord(path) { return JSON.parse(readFileSync(path, "utf8")).records.at(-1); }
function outgoing(to = "12345", content = pollText) { return { to, content }; }
function confirmed(anchor, to = "12345") { return { to, content: anchor.content, success: true, channelId: "telegram" }; }

test("parses explicit structured block and keeps introduction", () => {
  const parsed = parsePollText(`选择一个：\n${pollText}`);
  assert.equal(parsed.intro, "选择一个：");
  assert.equal(parsed.poll.anonymous, false);
  assert.equal(parsed.poll.options.length, 3);
});

test("does not parse ordinary text or fenced blocks", () => {
  assert.equal(parsePollText("方案 A 或 B，你觉得呢？"), null);
  assert.equal(parsePollText(`\`\`\`text\n${pollText}\n\`\`\``), null);
});

test("rejects invalid options, duplicate choices and invalid durations", () => {
  assert.throws(() => parsePollText(`[POLL]\n{"question":"Q","options":["one"]}\n[/POLL]`));
  assert.throws(() => parsePollText(`[POLL]\n{"question":"Q","options":["a","a"]}\n[/POLL]`));
  assert.throws(() => parsePollText(`[POLL]\n{"question":"Q","options":["a","b"],"durationSeconds":1}\n[/POLL]`));
});

test("CLI arguments route topic, account and Telegram privacy options", () => {
  const details = { to: "-10012345", accountId: "bot-2", threadId: "67", poll: parsePollText(pollText).poll };
  const args = pollArguments(details);
  assert.deepEqual(args.slice(0, 6), ["message", "poll", "--channel", "telegram", "--target", "-10012345"]);
  assert.ok(args.includes("--poll-public"));
  assert.equal(args.filter(a => a === "--poll-option").length, 3);
  assert.ok(args.includes("--thread-id"));
  assert.ok(args.includes("--account"));
  assert.deepEqual(messageArguments({ ...details, message: "fallback" }).slice(-2), ["--message", "fallback"]);
});

test("creates an anchor, then sends poll only after successful message_sent (correct order)", async () => {
  const timeline = [];
  const session = setup({ sendPoll: async params => { timeline.push("poll"); assert.equal(params.to, "12345"); } });
  try {
    const anchor = session.hooks.message_sending(outgoing("12345", `前言\n${pollText}`), demoContext);
    assert.ok(anchor.content.startsWith("前言\n\n"));
    assert.match(anchor.content, /\[投票编号:[a-f0-9]{16}\]/);
    assert.deepEqual(timeline, []);
    timeline.push("anchor-delivered");
    await session.hooks.message_sent(confirmed(anchor), demoContext);
    assert.deepEqual(timeline, ["anchor-delivered", "poll"]);
    assert.equal(getRecord(session.path).status, "sent");
  } finally { session.cleanup(); }
});

test("poll without intro has a minimal, meaningful anchor", async () => {
  let count = 0;
  const s = setup({ sendPoll: async () => { count++; } });
  try {
    const a = s.hooks.message_sending(outgoing(), demoContext);
    assert.match(a.content, /请查看接下来的投票/);
    await s.hooks.message_sent(confirmed(a), demoContext);
    assert.equal(count, 1);
  } finally { s.cleanup(); }
});

test("other channels and ordinary messages are unchanged", async () => {
  const s = setup();
  try {
    assert.equal(s.hooks.message_sending(outgoing(), { channelId: "discord" }), undefined);
    assert.equal(s.hooks.message_sending(outgoing("12345", "无投票的回复"), demoContext), undefined);
  } finally { s.cleanup(); }
});

test("canceled or failed original delivery NEVER triggers a poll", async () => {
  let count = 0;
  const s = setup({ sendPoll: async () => { count++; } });
  try {
    const a = s.hooks.message_sending(outgoing(), demoContext);
    // A following hook cancels delivery. There should be no message_sent.
    assert.equal(count, 0);
    await s.hooks.message_sent({ ...confirmed(a), success: false }, demoContext);
    assert.equal(count, 0);
    assert.equal(getRecord(s.path).status, "anchor_failed");
  } finally { s.cleanup(); }
});

test("rejects a forged receipt for a different chat or account", async () => {
  let count = 0;
  const s = setup({ sendPoll: async () => { count++; } });
  try {
    const a = s.hooks.message_sending(outgoing(), demoContext);
    await s.hooks.message_sent(confirmed(a, "9999"), demoContext);
    await s.hooks.message_sent(confirmed(a), { channelId: "telegram", accountId: "other-bot" });
    assert.equal(count, 0);
    await s.hooks.message_sent(confirmed(a), demoContext);
    assert.equal(count, 1);
  } finally { s.cleanup(); }
});

test("duplicate message_sent receipts or in-flight sends cannot send twice", async () => {
  let count = 0;
  let unblock;
  const delayed = new Promise(resolve => { unblock = resolve; });
  const s = setup({ sendPoll: async () => { count++; await delayed; } });
  try {
    const a = s.hooks.message_sending(outgoing(), demoContext);
    const first = s.hooks.message_sent(confirmed(a), demoContext);
    await s.hooks.message_sent(confirmed(a), demoContext);
    assert.equal(count, 1);
    unblock();
    await first;
    await s.hooks.message_sent(confirmed(a), demoContext);
    assert.equal(count, 1);
  } finally { s.cleanup(); }
});

test("stable origin is downgraded to readable text across Gateway restarts", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "telegram-auto-poll-restart-"));
  const statePath = join(tmp, "state.json");
  try {
    const first = setup({ statePath });
    const a = first.hooks.message_sending(outgoing(), demoContext);
    assert.ok(a.content);
    const next = setup({ statePath });
    const repeated = next.hooks.message_sending(outgoing(), demoContext);
    assert.equal(repeated.cancel, undefined);
    assert.match(repeated.content, /投票文字模式/);
    assert.match(repeated.content, /立即部署/);
    assert.equal(next.hooks.message_sending(outgoing("12345", repeated.content), demoContext), undefined);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("different outgoing text in the same run is never swallowed as a duplicate", async () => {
  const polls = [];
  const s = setup({ sendPoll: async data => { polls.push(data); } });
  try {
    const first = s.hooks.message_sending(outgoing("12345", `第一段说明\n${pollText}`), demoContext);
    const second = s.hooks.message_sending(outgoing("12345", `第二段不同说明\n${pollText}`), demoContext);
    assert.match(first.content, /^第一段说明/);
    assert.match(second.content, /^第二段不同说明/);
    assert.notEqual(first.content, second.content);
    assert.equal(first.cancel, undefined);
    assert.equal(second.cancel, undefined);
    await s.hooks.message_sent(confirmed(first), demoContext);
    await s.hooks.message_sent(confirmed(second), demoContext);
    assert.equal(polls.length, 2);
  } finally { s.cleanup(); }
});

test("anchors include readable options and do not re-enter poll detection", async () => {
  let count = 0;
  const s = setup({ sendPoll: async () => { count++; } });
  try {
    const anchor = s.hooks.message_sending(outgoing(), demoContext);
    assert.match(anchor.content, /是否部署？/);
    assert.match(anchor.content, /立即部署/);
    assert.match(anchor.content, /先测试/);
    assert.match(anchor.content, /取消/);
    assert.equal(s.hooks.message_sending(outgoing("12345", anchor.content), demoContext), undefined);
    await s.hooks.message_sent(confirmed(anchor), demoContext);
    await s.hooks.message_sent(confirmed(anchor), demoContext);
    assert.equal(count, 1);
  } finally { s.cleanup(); }
});

test("a text fallback re-entering message hooks cannot trigger another poll", async () => {
  let count = 0;
  let fallbackTextSent;
  const s = setup({
    sendPoll: async () => { count++; throw new DefiniteDeliveryError("CLI unavailable"); },
    sendText: async details => { fallbackTextSent = details.message; },
  });
  try {
    const anchor = s.hooks.message_sending(outgoing(), demoContext);
    await s.hooks.message_sent(confirmed(anchor), demoContext);
    assert.equal(count, 1);
    assert.match(fallbackTextSent, /投票文字模式/);
    assert.match(fallbackTextSent, /立即部署/);
    assert.equal(s.hooks.message_sending(outgoing("12345", fallbackTextSent), demoContext), undefined);
    await s.hooks.message_sent({ to: "12345", content: fallbackTextSent, success: true }, demoContext);
    assert.equal(count, 1);
    assert.equal(getRecord(s.path).status, "failed");
  } finally { s.cleanup(); }
});

test("unknown poll delivery still leaves original options readable in the anchor", async () => {
  const s = setup({ sendPoll: async () => { throw new UncertainDeliveryError("timeout"); },
    sendText: async () => { assert.fail("uncertain delivery must not retry"); } });
  try {
    const anchor = s.hooks.message_sending(outgoing(), demoContext);
    assert.match(anchor.content, /1\. 立即部署/);
    assert.match(anchor.content, /2\. 先测试/);
    await s.hooks.message_sent(confirmed(anchor), demoContext);
    assert.equal(getRecord(s.path).status, "uncertain");
  } finally { s.cleanup(); }
});

test("old-version anchor receipts still work after updating the plugin", async () => {
  let count = 0;
  const s = setup({ sendPoll: async () => { count++; } });
  try {
    const anchor = s.hooks.message_sending(outgoing(), demoContext);
    const token = getRecord(s.path).token;
    const oldAnchor = `📊 请查看接下来的投票。\n[投票编号:${token}]`;
    assert.notEqual(anchor.content, oldAnchor);
    assert.equal(s.hooks.message_sending(outgoing("12345", oldAnchor), demoContext), undefined);
    await s.hooks.message_sent({ to: "12345", content: oldAnchor, success: true }, demoContext);
    assert.equal(count, 1);
  } finally { s.cleanup(); }
});

test("text fallback is still ignored after the plugin restarts", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "telegram-auto-poll-fallback-restart-"));
  const statePath = join(tmp, "state.json");
  try {
    const first = setup({ statePath });
    first.hooks.message_sending(outgoing(), demoContext);
    const repeated = first.hooks.message_sending(outgoing(), demoContext);
    assert.match(repeated.content, /投票文字模式/);
    let sent = 0;
    const restarted = setup({ statePath, sendPoll: async () => { sent++; } });
    assert.equal(restarted.hooks.message_sending(outgoing("12345", repeated.content), demoContext), undefined);
    await restarted.hooks.message_sent({ to: "12345", content: repeated.content, success: true }, demoContext);
    assert.equal(sent, 0);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("hourly limit and chat allowlist degrade to readable choices", () => {
  const s = setup({ config: { maxPerChatPerHour: 1, allowedChatIds: ["12345"] } });
  try {
    assert.ok(s.hooks.message_sending(outgoing("9999"), demoContext).content.endsWith(fallbackText(parsePollText(pollText))));
    const first = s.hooks.message_sending(outgoing(), demoContext);
    assert.match(first.content, /投票编号/);
    const second = s.hooks.message_sending(outgoing(), { ...demoContext, runId: "run-2" });
    assert.ok(second.content.endsWith(fallbackText(parsePollText(pollText))));
    assert.equal(s.hooks.message_sending(outgoing("12345", second.content), demoContext), undefined);
  } finally { s.cleanup(); }
});

test("definitively failed spawn sends readable fallback, unknown failure does not auto retry", async () => {
  let fallback = 0;
  const definite = setup({
    sendPoll: async () => { throw new DefiniteDeliveryError("ENOENT"); },
    sendText: async p => { fallback++; assert.match(p.message, /立即部署/); },
  });
  try {
    const a = definite.hooks.message_sending(outgoing(), demoContext);
    await definite.hooks.message_sent(confirmed(a), demoContext);
    assert.equal(fallback, 1);
    assert.equal(getRecord(definite.path).status, "failed");
  } finally { definite.cleanup(); }
  const unknown = setup({
    sendPoll: async () => { throw new UncertainDeliveryError("timeout"); },
    sendText: async () => { fallback++; },
  });
  try {
    const a = unknown.hooks.message_sending(outgoing(), demoContext);
    await unknown.hooks.message_sent(confirmed(a), demoContext);
    await unknown.hooks.message_sent(confirmed(a), demoContext);
    assert.equal(getRecord(unknown.path).status, "uncertain");
    assert.equal(fallback, 1);
  } finally { unknown.cleanup(); }
});

test("a real nonexistent CLI path has definite spawn failure", async () => {
  await assert.rejects(runCli("/definitely/not/an/openclaw-executable", ["message"], 500), DefiniteDeliveryError);
});

test("CLI nonzero exit and timeout are UNKNOWN (no automatic retries)", async () => {
  await assert.rejects(runCli(process.execPath, ["-e", "process.exit(17)"], 2000), UncertainDeliveryError);
  await assert.rejects(runCli(process.execPath, ["-e", "setInterval(()=>{},1000)"], 100), UncertainDeliveryError);
});

test("journal on disk is JSON and does not contain Telegram bot credentials", () => {
  const s = setup();
  try {
    s.hooks.message_sending(outgoing(), demoContext);
    const raw = readFileSync(s.path, "utf8");
    assert.doesNotMatch(raw, /botToken|apiKey|hskey-auth/);
    assert.equal(JSON.parse(raw).version, 1);
  } finally { s.cleanup(); }
});

test("a rewritten or forged delivery marker cannot launch poll", async () => {
  let polls = 0;
  const s = setup({ sendPoll: async () => { polls++; } });
  try {
    const anchor = s.hooks.message_sending(outgoing(), demoContext);
    await s.hooks.message_sent({ ...confirmed(anchor), content: `changed!\n${anchor.content}` }, demoContext);
    assert.equal(polls, 0);
    await s.hooks.message_sent(confirmed(anchor), demoContext);
    assert.equal(polls, 1);
  } finally { s.cleanup(); }
});

test("forgotten POLL markers still turn explicit choices into a native poll after delivery", async () => {
  const sent = [];
  const s = setup({ sendPoll: async params => { sent.push(params); } });
  try {
    const text = "我可以先帮你排查。\n接下来你想先做哪个？\nA. 检查配置\nB. 查看日志";
    const anchor = s.hooks.message_sending(outgoing("12345", text), demoContext);
    assert.match(anchor?.content ?? "", /投票编号/);
    assert.ok(anchor.content.startsWith(text));
    assert.equal(sent.length, 0);
    await s.hooks.message_sent(confirmed(anchor), demoContext);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].poll.question, "接下来你想先做哪个？");
    assert.deepEqual(sent[0].poll.options, ["检查配置", "查看日志"]);
    assert.equal(sent[0].poll.anonymous, false);
  } finally { s.cleanup(); }
});

test("automatic choices can be disabled and obey chat allowlists", () => {
  const disabled = setup({ config: { autoDetect: false } });
  const restricted = setup({ config: { allowedChatIds: ["9999"] } });
  try {
    assert.equal(disabled.hooks.message_sending(outgoing("12345", "是否继续？"), demoContext), undefined);
    const result = restricted.hooks.message_sending(outgoing("12345", "是否继续？"), demoContext);
    assert.doesNotMatch(result?.content ?? "", /投票编号/);
    assert.match(result?.content ?? "", /是否继续/);
  } finally { disabled.cleanup(); restricted.cleanup(); }
});

test("per-turn guidance uses Telegram agent channel context rather than treating chat ID as channel name", () => {
  const s = setup();
  try {
    const guide = s.hooks.before_prompt_build?.({ prompt: "hello", messages: [] },
      { channel: "telegram", channelId: "12345", chatId: "12345" });
    assert.match(guide?.appendSystemContext ?? "", /\[POLL\]/);
    assert.match(guide.appendSystemContext, /anonymous/);
    assert.equal(s.hooks.before_prompt_build({}, { channel: "discord", channelId: "12345" }), undefined);
    assert.equal(s.hooks.before_prompt_build({}, { sessionKey: "agent:main:main" }), undefined);
  } finally { s.cleanup(); }
});

test("successful polls with unavailable answer routing produce a useful diagnostic", async () => {
  const s = setup({ sendPoll: async () => ({ payload: {
    pollAnswerRouting: "unavailable", warning: "Bot must be an administrator for group votes",
  } }) });
  try {
    const anchor = s.hooks.message_sending(outgoing(), demoContext);
    await s.hooks.message_sent(confirmed(anchor), demoContext);
    assert.equal(getRecord(s.path).status, "sent");
    assert.ok(s.logs.some(line => line.includes("administrator")));
  } finally { s.cleanup(); }
});

test("the real Doctor response reaches the native poll sender after successful text delivery", async () => {
  const text = readFileSync(new URL("./fixtures/doctor-choice.txt", import.meta.url), "utf8");
  const polls = [];
  const s = setup({ sendPoll: async params => { polls.push(params); } });
  try {
    const anchor = s.hooks.message_sending(outgoing("12345", text), demoContext);
    assert.match(anchor?.content ?? "", /投票编号/);
    assert.equal(polls.length, 0);
    await s.hooks.message_sent(confirmed(anchor), demoContext);
    assert.equal(polls.length, 1);
    assert.deepEqual(polls[0].poll.options, ["我先查出是哪个进程占着数据库", "你先执行 /restart，再让我重跑 doctor"]);
    assert.equal(getRecord(s.path).status, "sent");
  } finally { s.cleanup(); }
});

test("the real installation decision sends its section titles only after the complete explanation is delivered", async () => {
  const text = readFileSync(new URL("./fixtures/install-choice.txt", import.meta.url), "utf8");
  const polls = [];
  const s = setup({ sendPoll: async params => { polls.push(params); } });
  try {
    const anchor = s.hooks.message_sending(outgoing("12345", text), demoContext);
    assert.ok(anchor?.content.startsWith(text.trim()));
    assert.match(anchor.content, /投票编号/);
    assert.equal(polls.length, 0);
    await s.hooks.message_sent(confirmed(anchor), demoContext);
    await s.hooks.message_sent(confirmed(anchor), demoContext);
    assert.equal(polls.length, 1);
    assert.equal(polls[0].poll.question, "你选哪条路？");
    assert.deepEqual(polls[0].poll.options, [
      "用 git clone 到 extensions 目录，再 link 进去", "直接替换现有目录内容", "先改 remote 再拉",
    ]);
    assert.equal(getRecord(s.path).status, "sent");
  } finally { s.cleanup(); }
});

test("numbered installation sections reach the sender without explanatory commands becoming choices", async () => {
  const text = readFileSync(new URL("./fixtures/install-choice.txt", import.meta.url), "utf8")
    .replace("**A.", "**1.").replace("**B.", "**2.").replace("**C.", "**3.");
  const polls = [];
  const s = setup({ sendPoll: async params => { polls.push(params); } });
  try {
    const anchor = s.hooks.message_sending(outgoing("12345", text), demoContext);
    assert.ok(anchor?.content.startsWith(text.trim()));
    assert.equal(polls.length, 0);
    await s.hooks.message_sent(confirmed(anchor), demoContext);
    assert.equal(polls.length, 1);
    assert.deepEqual(polls[0].poll.options, [
      "用 git clone 到 extensions 目录，再 link 进去", "直接替换现有目录内容", "先改 remote 再拉",
    ]);
    assert.equal(getRecord(s.path).status, "sent");
  } finally { s.cleanup(); }
});
