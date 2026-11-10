import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPlugin } from "../index.mjs";

const context = { channelId: "telegram", accountId: "bot" };
const choice = "接下来先做哪个？\nA. 检查配置\nB. 查看日志";
const miss = "确定一个方案？\n方案1：速度\n优先缩短等待时间。\n方案2：质量\n优先保证结果可靠。";

function setup(config = {}) {
  const root = mkdtempSync(join(tmpdir(), "poll-preview-"));
  const hooks = {}, polls = [], logs = [];
  createPlugin({ sendPoll: async payload => polls.push(payload) }).register({
    pluginConfig: { statePath: join(root, "state.json"), previewMode: true, previewSafeChats: [{ chatId: "123", accountId: "bot" }], ...config },
    logger: { info: message => logs.push(message), warn: message => logs.push(message) },
    on: (name, handler) => { hooks[name] = handler; },
    registerTool: () => {},
  });
  const samplesPath = join(root, "telegram-auto-poll", "samples.json");
  return { hooks, polls, logs, statePath: join(root, "state.json"), samples: () => existsSync(samplesPath) ? JSON.parse(readFileSync(samplesPath, "utf8")).records : [],
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("preview mode avoids sending hooks and polls only after confirmed delivery", async () => {
  const s = setup();
  const event = { to: "123", content: choice, messageId: "501", success: true };
  try {
    assert.equal(s.hooks.message_sending, undefined);
    assert.equal(typeof s.hooks.message_sent, "function");
    await s.hooks.message_sent({ ...event, success: false }, context);
    await s.hooks.message_sent({ ...event, messageId: undefined }, context);
    await s.hooks.message_sent(event, { ...context, accountId: "other" });
    assert.equal(s.polls.length, 0);
    await s.hooks.message_sent(event, context);
    await s.hooks.message_sent(event, context);
    assert.equal(s.polls.length, 1);
    assert.deepEqual(s.polls[0].poll.options, ["检查配置", "查看日志"]);
  } finally { s.cleanup(); }
});

test("preview mode skips unconfirmed destinations and retains explicit topic routing", async () => {
  const s = setup({ previewSafeChats: [{ chatId: "123", accountId: "bot" }, { chatId: "-100123", accountId: "bot" }] });
  try {
    await s.hooks.message_sent({ to: "999", content: choice, messageId: "1", success: true }, context);
    await s.hooks.message_sent({ to: "-100123", content: choice, messageId: "2", success: true }, context);
    await s.hooks.message_sent({ to: "-100123", content: choice, messageId: "4", threadId: "42", success: true }, { channelId: "telegram" });
    assert.equal(s.polls.length, 0);
    await s.hooks.message_sent({ to: "-100123", content: choice, messageId: "3", threadId: "42", success: true }, context);
    assert.equal(s.polls.length, 1);
    assert.equal(s.polls[0].threadId, "42");
  } finally { s.cleanup(); }
});

test("preview delivery keeps a pre-upgrade pending poll working", async () => {
  const legacy = setup({ previewMode: false });
  const polls = [], hooks = {};
  try {
    const anchor = legacy.hooks.message_sending({ to: "123", content: choice }, context);
    assert.match(anchor.content, /投票编号/);
    createPlugin({ sendPoll: async data => polls.push(data) }).register({
      pluginConfig: { statePath: legacy.statePath, previewMode: true, previewSafeChats: [{ chatId: "123", accountId: "bot" }] },
      on: (name, handler) => { hooks[name] = handler; },
    });
    await hooks.message_sent({ to: "123", content: anchor.content, success: true }, context);
    assert.equal(polls.length, 1);
    assert.deepEqual(polls[0].poll.options, ["检查配置", "查看日志"]);
  } finally { legacy.cleanup(); }
});

test("preview receipts stay deduplicated during a send and after restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "poll-preview-restart-"));
  const statePath = join(root, "state.json"), event = { to: "123", content: choice, messageId: "501", success: true };
  let count = 0, unblock;
  const waiting = new Promise(resolve => { unblock = resolve; });
  function register(sendPoll) {
    const hooks = {};
    createPlugin({ sendPoll }).register({
      pluginConfig: { statePath, previewMode: true, previewSafeChats: [{ chatId: "123", accountId: "bot" }] },
      on: (name, handler) => { hooks[name] = handler; },
    });
    return hooks;
  }
  try {
    const hooks = register(async () => { count++; await waiting; });
    const first = hooks.message_sent(event, context);
    await hooks.message_sent(event, context);
    assert.equal(count, 1);
    unblock();
    await first;
    await register(async () => { count++; }).message_sent(event, context);
    assert.equal(count, 1);
  } finally { unblock?.(); rmSync(root, { recursive: true, force: true }); }
});

test("preview mode learns only successfully delivered and identifiable misses", async () => {
  const s = setup();
  const event = { to: "123", content: miss, messageId: "501", success: true };
  try {
    await s.hooks.message_sent({ ...event, success: false }, context);
    await s.hooks.message_sent({ ...event, messageId: undefined }, context);
    await s.hooks.message_sent({ ...event, to: "999" }, context);
    assert.deepEqual(s.samples(), []);
    await s.hooks.message_sent(event, context);
    await s.hooks.message_sent(event, context);
    assert.equal(s.samples().length, 1);
    assert.equal(s.samples()[0].content, miss);
  } finally { s.cleanup(); }
});

test("preview mode can create an explicit poll when auto detection is disabled", async () => {
  const s = setup({ autoDetect: false });
  const content = '[POLL]\n{"question":"是否继续？","options":["继续","取消"]}\n[/POLL]';
  try {
    await s.hooks.message_sent({ to: "123", content, messageId: "501", success: true }, context);
    assert.equal(s.polls.length, 1);
    assert.deepEqual(s.polls[0].poll.options, ["继续", "取消"]);
  } finally { s.cleanup(); }
});

test("preview guidance asks for readable choices, while explicit-only mode retains POLL format", () => {
  const normal = setup();
  const explicit = setup({ autoDetect: false });
  const ctx = { channel: "telegram", chatId: "123", accountId: "bot" };
  try {
    const prompt = normal.hooks.before_prompt_build({}, ctx).appendSystemContext;
    assert.doesNotMatch(prompt, /\[POLL\]/);
    assert.match(prompt, /A\./);
    assert.match(prompt, /B\./);
    assert.equal(normal.hooks.before_prompt_build({}, { ...ctx, accountId: "other" }).appendSystemContext, "");
    assert.match(explicit.hooks.before_prompt_build({}, ctx).appendSystemContext, /\[POLL\]/);
  } finally { normal.cleanup(); explicit.cleanup(); }
});
