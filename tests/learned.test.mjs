import test from "node:test";
import assert from "node:assert/strict";
import { createChoiceDetector, detectChoicePoll } from "../src/detect.mjs";
import { presetDocument } from "../src/rules.mjs";

const text = "【甲】检查配置\n保留原始文件。\n【乙】查看日志\n定位失败原因。\n你想挑哪条渠道？我会先备份。";
const rule = {
  id: "tagged-channel-choice", description: "带中文标签的渠道选择",
  question: { phrases: ["挑哪条渠道"] },
  options: { marker: "【{label}】", labelStyle: "custom", labels: ["甲", "乙", "丙"] },
  examples: [
    { text, expected: { question: "你想挑哪条渠道？", options: ["检查配置", "查看日志"] } },
    { text: `教程：\n${text}`, expected: null },
  ],
};
function detector(overrides = {}) {
  return createChoiceDetector({ ...structuredClone(presetDocument), learnedRules: [{ ...structuredClone(rule), ...overrides }] });
}

test("a literal learned template recognizes a new format without changing detector code", () => {
  assert.equal(detectChoicePoll(text), null);
  const parsed = detector()(text, { durationSeconds: 3600 });
  assert.deepEqual(parsed?.poll.options, ["检查配置", "查看日志"]);
  assert.equal(parsed.poll.question, "你想挑哪条渠道？");
  assert.equal(parsed.poll.durationSeconds, 3600);
  assert.equal(parsed.intro, text);
});

test("learned templates handle the question before sections and retain complete labels", () => {
  const input = "你想挑哪条渠道？\n【甲】检查 `production` 配置\n保留原始文件。\n【乙】查看 `staging` 日志\n定位失败原因。";
  assert.deepEqual(detector()(input)?.poll.options, ["检查 production 配置", "查看 staging 日志"]);
});

test("a disabled learned rule cannot produce polls", () => assert.equal(detector({ enabled: false })(text), null));

for (const [name, input] of [
  ["tutorial", `以下是一个教程示例：\n${text}`],
  ["steps", `操作步骤：\n${text}`],
  ["knowledge", text.replace("你想挑哪条渠道？我会先备份。", "你知道为什么要挑哪条渠道吗？")],
  ["free input", `${text}也可以回复其他渠道。`],
  ["withdrawn", `${text}\n不用选了，任务已取消。`],
  ["no poll", `不需要投票。\n${text}`],
  ["fence", `\`\`\`text\n${text}\n\`\`\``],
  ["quote", text.split("\n").map(line => `> ${line}`).join("\n")],
  ["duplicate", text.replace("【乙】", "【甲】")],
  ["missing label", text.replace("【乙】", "【丙】")],
  ["unknown label", text.replace("【乙】", "【丁】")],
  ["duplicate meaning", text.replace("查看日志", "检查配置")],
  ["long option", text.replace("检查配置", "长".repeat(101))],
  ["two decisions", `${text}\n【甲】今天\n说明。\n【乙】明天\n说明。\n你想挑哪条渠道？`],
]) test(`learned templates respect exclusion: ${name}`, () => assert.equal(detector()(input), null));

test("learned marker metacharacters are matched literally", () => {
  const input = "[1].* 检查配置\n说明。\n[2].* 查看日志\n说明。\n你想挑哪条渠道？";
  assert.deepEqual(detector({ options: { marker: "[{label}].* ", labelStyle: "number" } })(input)?.poll.options,
    ["检查配置", "查看日志"]);
  assert.equal(detector({ options: { marker: "[{label}].* ", labelStyle: "number" } })(input.replaceAll(".*", "xx")), null);
});

test("same known choice keeps its behavior when a learned rule also matches", () => {
  const input = "A. 检查配置\nB. 查看日志\n你选哪种方案？";
  const match = detector({ question: { phrases: ["选哪种方案"] }, options: { marker: "{label}. ", labelStyle: "letter" } })(input);
  assert.deepEqual(match?.poll.options, ["检查配置", "查看日志"]);
});

test("compiled preset expressions come from the rule document", () => {
  const document = structuredClone(presetDocument);
  document.patterns.CONFIRMATION.source = "^确认启程$";
  assert.equal(detectChoicePoll("确认启程？"), null);
  assert.deepEqual(createChoiceDetector(document)("确认启程？")?.poll.options, ["是", "否"]);
  assert.equal(detectChoicePoll("确认启程？"), null);
});
