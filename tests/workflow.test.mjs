import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPlugin } from "../index.mjs";

const miss = "确定一个方案？\n方案1：速度\n优先缩短等待时间。\n方案2：质量\n优先保证结果可靠。";
const expected = { question: "确定一个方案？", options: ["速度", "质量"] };
const rule = {
  id: "decide-a-plan", description: "确定一个方案的数字分节",
  question: { phrases: ["确定一个方案"] }, options: { marker: "方案{label}：", labelStyle: "number" },
  examples: [{ text: miss, expected }, { text: `这是教程示例：\n${miss}`, expected: null }],
};
const messageContext = { channelId: "telegram", accountId: "bot" };
const agentContext = { channel: "telegram", chatId: "123", accountId: "bot" };
const toolContext = { messageChannel: "telegram", nativeChannelId: "123", agentAccountId: "bot" };

function setup(config = {}) {
  const root = mkdtempSync(join(tmpdir(), "poll-workflow-"));
  const hooks = {}, factories = [], polls = [], logs = [];
  createPlugin({ sendPoll: async params => { polls.push(params); } }).register({
    pluginConfig: { statePath: join(root, "state.json"), ...config },
    logger: { info: line => logs.push(line), warn: line => logs.push(line) },
    on: (name, handler) => { hooks[name] = handler; },
    registerTool: factory => { factories.push(factory); },
  });
  return { hooks, factories, polls, logs, root,
    rulesPath: join(root, "telegram-auto-poll", "rules.json"),
    samplesPath: join(root, "telegram-auto-poll", "samples.json"),
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
function outgoing(content = miss, to = "123") { return { content, to }; }
async function delivered(s, content = miss, context = messageContext, success = true, to = "123") {
  const result = s.hooks.message_sending(outgoing(content, to), context);
  await s.hooks.message_sent({ content: result?.content ?? content, to, success }, context);
  return result;
}
function samples(s) { return existsSync(s.samplesPath) ? JSON.parse(readFileSync(s.samplesPath, "utf8")).records : []; }

test("manifest declares every registered agent tool and learning settings", () => {
  const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
  const s = setup();
  try {
    const toolNames = s.factories.map(factory => factory(toolContext)?.name).filter(Boolean);
    assert.deepEqual(manifest.contracts?.tools, toolNames);
    assert.equal(manifest.configSchema.properties.learningEnabled.type, "boolean");
    assert.equal(manifest.configSchema.properties.rulesPath.type, "string");
  } finally { s.cleanup(); }
});

test("plugin seeds the shipped rules into its writable state directory", () => {
  const s = setup();
  try {
    assert.ok(existsSync(s.rulesPath));
    const document = JSON.parse(readFileSync(s.rulesPath, "utf8"));
    assert.equal(document.version, 1);
    assert.ok(Object.keys(document.patterns).length > 0);
    assert.deepEqual(document.learnedRules, []);
  } finally { s.cleanup(); }
});

test("only a matching successful delivery turns a staged miss into a pending sample", async () => {
  const s = setup();
  try {
    assert.equal(s.hooks.message_sending(outgoing(), messageContext), undefined);
    assert.deepEqual(samples(s), []);
    await s.hooks.message_sent({ ...outgoing(), success: true }, messageContext);
    assert.equal(samples(s).length, 1);
    assert.equal(samples(s)[0].content, miss);
    assert.equal(s.polls.length, 0);
    const prompt = s.hooks.before_prompt_build({}, agentContext);
    assert.match(prompt?.appendSystemContext ?? "", /telegram_auto_poll_learn/);
    assert.ok((prompt.appendContext ?? "").includes(samples(s)[0].id));
    assert.ok((prompt.appendContext ?? "").includes("确定一个方案"));
  } finally { s.cleanup(); }
});

test("failed, unseen or rewritten delivery receipts cannot enroll samples", async () => {
  const s = setup();
  try {
    await s.hooks.message_sent({ ...outgoing(), success: true }, messageContext);
    assert.deepEqual(samples(s), []);
    await delivered(s, miss, messageContext, false);
    await s.hooks.message_sent({ ...outgoing(), success: true }, messageContext);
    assert.deepEqual(samples(s), []);
    s.hooks.message_sending(outgoing(), messageContext);
    await s.hooks.message_sent({ ...outgoing(`${miss}\n已改写`), success: true }, messageContext);
    assert.deepEqual(samples(s), []);
  } finally { s.cleanup(); }
});

test("learning a captured miss activates a rule used by the next message without restart", async () => {
  const s = setup();
  try {
    await delivered(s);
    const sample = samples(s)[0];
    assert.ok(sample);
    assert.equal(s.factories.length, 1);
    const tool = s.factories[0](toolContext);
    assert.equal(tool?.name, "telegram_auto_poll_learn");
    const result = await tool.execute("call-learn", { action: "learn", sampleId: sample.id, rule, expected });
    assert.ok(!result.isError, JSON.stringify(result));
    assert.equal(samples(s)[0].status, "learned");
    assert.equal(JSON.parse(readFileSync(s.rulesPath, "utf8")).learnedRules.length, 1);
    const anchor = await delivered(s);
    assert.match(anchor?.content ?? "", /投票编号/);
    assert.equal(s.polls.length, 1);
    assert.equal(s.polls[0].poll.question, expected.question);
    assert.deepEqual(s.polls[0].poll.options, expected.options);
  } finally { s.cleanup(); }
});

test("rule file edits reload, and corrupt edits keep the last working detector", async () => {
  const s = setup();
  try {
    assert.ok(existsSync(s.rulesPath));
    const document = JSON.parse(readFileSync(s.rulesPath, "utf8"));
    document.learnedRules.push(rule);
    writeFileSync(s.rulesPath, JSON.stringify(document));
    assert.match((await delivered(s))?.content ?? "", /投票编号/);
    writeFileSync(s.rulesPath, "{broken");
    assert.match((await delivered(s))?.content ?? "", /投票编号/);
    assert.equal(s.polls.length, 2);
    assert.ok(s.logs.some(line => line.includes("last valid")));
  } finally { s.cleanup(); }
});

test("tool and prompt samples remain scoped to the trusted chat and bot account", async () => {
  const s = setup();
  try {
    await delivered(s);
    assert.equal(s.factories.length, 1);
    assert.equal(s.factories[0]({ ...toolContext, messageChannel: "discord" }), null);
    assert.equal(s.factories[0]({}), null);
    const wrongPrompt = s.hooks.before_prompt_build({}, { ...agentContext, chatId: "456" });
    assert.ok(!(wrongPrompt?.appendContext ?? "").includes(miss));
    const wrongAccount = s.hooks.before_prompt_build({}, { ...agentContext, accountId: "other" });
    assert.ok(!(wrongAccount?.appendContext ?? "").includes(miss));
    const tool = s.factories[0]({ ...toolContext, nativeChannelId: "456" });
    await assert.rejects(tool.execute("wrong-chat", { action: "dismiss", sampleId: samples(s)[0].id }));
    assert.equal(samples(s)[0].status, "pending");
  } finally { s.cleanup(); }
});

test("disabled learning keeps detection working without recording or offering a learning tool", async () => {
  const s = setup({ learningEnabled: false });
  try {
    await delivered(s);
    assert.deepEqual(samples(s), []);
    assert.equal(s.factories.length, 0);
    assert.match((await delivered(s, "是否继续？"))?.content ?? "", /投票编号/);
    assert.equal(s.polls.length, 1);
  } finally { s.cleanup(); }
});

test("chat allowlist prevents candidate collection and learning tool exposure", async () => {
  const s = setup({ allowedChatIds: ["456"] });
  try {
    await delivered(s);
    assert.deepEqual(samples(s), []);
    assert.equal(s.factories.length, 1);
    assert.equal(s.factories[0](toolContext), null);
  } finally { s.cleanup(); }
});

test("disabling prompt guidance does not disable pending-sample learning", async () => {
  const s = setup({ promptGuidance: false });
  try {
    await delivered(s);
    const prompt = s.hooks.before_prompt_build?.({}, agentContext);
    assert.match(prompt?.appendSystemContext ?? "", /telegram_auto_poll_learn/);
    assert.ok((prompt.appendContext ?? "").includes("确定一个方案"));
  } finally { s.cleanup(); }
});
