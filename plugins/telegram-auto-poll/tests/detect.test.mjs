import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { detectChoicePoll } from "../src/detect.mjs";

test("recognizes numbered and bullet choices with a final or preceding selection question", () => {
  for (const text of [
    "请选择下一步：\n1. 检查配置\n2. 查看日志",
    "- 检查配置\n- 查看日志\n你想先做哪个？",
    "你想先做哪个？\n**A：检查配置**\n**B：查看日志**",
    "你选一个：\n1. 检查配置\n2. 查看日志",
    "你更倾向哪一个？\n1. 检查配置\n2. 查看日志",
  ]) {
    const parsed = detectChoicePoll(text);
    assert.deepEqual(parsed?.poll.options, ["检查配置", "查看日志"], text);
    assert.equal(parsed.intro, text);
    assert.equal(parsed.poll.anonymous, false);
  }
});

test("recognizes explicit inline alternatives without inventing actions", () => {
  const cases = [
    ["你想先检查配置，还是先查看日志？", ["先检查配置", "先查看日志"]],
    ["现在执行还是稍后再做？", ["现在执行", "稍后再做"]],
    ["你选 A：检查配置，还是 B：查看日志？", ["检查配置", "查看日志"]],
    ["Which do you prefer: check config or view logs?", ["check config", "view logs"]],
  ];
  for (const [text, options] of cases) assert.deepEqual(detectChoicePoll(text)?.poll.options, options, text);
});

test("turns direct confirmations into explicit yes/no choices", () => {
  for (const text of ["是否继续？", "需要我帮你检查吗？", "要不要现在执行？", "你想继续吗？", "你希望我现在执行吗？", "你还是要继续吗？", "是否取消部署？", "Do you want me to continue?"]) {
    assert.deepEqual(detectChoicePoll(text)?.poll.options, ["是", "否"], text);
  }
});

test("keeps descriptions, tutorials, quoted questions, examples and open questions as text", () => {
  for (const text of [
    "方案 A 更快，方案 B 更稳。",
    "操作步骤：\n1. 打开设置\n2. 选择账号\n是否成功取决于配置。",
    "请选择正确的配置文件，然后按以下步骤操作：\n1. 打开设置\n2. 重启服务",
    "你觉得怎么样？", "请提供服务器地址。", "为什么需要这么做？",
    "你知道为什么要选择这个方案吗？",
    "教程示例：\n```text\n是否继续？\n```",
    "~~~\n是否继续？\n~~~",
    "> 是否继续？",
    "示例问题：是否继续？",
    "以下是选项示例：\nA. 检查配置\nB. 查看日志",
    "以下是示例：\n请选择：\n1. 检查配置\n2. 查看日志",
    "教程：\n是否继续？",
    "你知道应该选 A 还是 B 吗？",
    "请选择需要的文件，然后依次执行：\n1. 打开文件\n2. 点击保存",
    "你选哪个？\n```text\n1. 检查配置\n2. 查看日志\n```",
    "不需要投票，请直接回复。是否继续？",
    "[POLL]\n{invalid}\n[/POLL]",
  ]) assert.equal(detectChoicePoll(text), null, text);
});

test("retains inline code values that determine the meaning of the choice", () => {
  const parsed = detectChoicePoll("请选择：\n1. 部署到 `production`\n2. 发布到 `staging`");
  assert.deepEqual(parsed?.poll.options, ["部署到 production", "发布到 staging"]);
});

test("refuses lossy, duplicate, excessive or ambiguous option sets", () => {
  for (const text of [
    "请选择：\n1. 相同\n2. 相同",
    `请选择：\n1. ${"长".repeat(101)}\n2. 短`,
    "请选择：\n" + Array.from({ length: 13 }, (_, i) => `${i + 1}. 选项${i}`).join("\n"),
    "请选择：\n1. 检查配置\n2. 查看日志\n\n请选择时间：\n1. 今天\n2. 明天",
    "你想 A 还是 B 还是 C？",
    "请选择：\n1. 检查配置\n2. 查看日志\n或者输入你的自定义方案。",
  ]) assert.equal(detectChoicePoll(text), null, text);
});

test("applies configured automatic poll duration and preserves Unicode", () => {
  const parsed = detectChoicePoll("请选择：\n1. 🚀 部署\n2. 🔎 检查", { durationSeconds: 3600 });
  assert.deepEqual(parsed?.poll.options, ["🚀 部署", "🔎 检查"]);
  assert.equal(parsed.poll.durationSeconds, 3600);
});

test("recognizes the reported Doctor choice after diagnostic lists and parenthetical examples", () => {
  const text = readFileSync(new URL("./fixtures/doctor-choice.txt", import.meta.url), "utf8");
  const parsed = detectChoicePoll(text);
  assert.deepEqual(parsed?.poll.options, [
    "我先查出是哪个进程占着数据库", "你先执行 /restart，再让我重跑 doctor",
  ]);
  assert.equal(parsed.intro, text.trim());
  assert.equal(parsed.poll.anonymous, false);
});

test("unrelated lists do not hide a final binary choice or confirmation", () => {
  for (const prefix of [
    "可能来源：\n- gateway 未退出\n- agent 会话仍在使用数据库",
    "可能来源：\n• gateway 未退出\n• agent 会话（比如另一个 agent）仍在使用数据库",
    "说明里有多个列表。\n- 原因一\n- 原因二\n其他信息：\n1. 状态一\n2. 状态二",
  ]) {
    assert.deepEqual(detectChoicePoll(`${prefix}\n\n你想先排查还是先重启？`)?.poll.options, ["先排查", "先重启"]);
    assert.deepEqual(detectChoicePoll(`${prefix}\n\n是否继续？`)?.poll.options, ["是", "否"]);
  }
});

test("pairs a confirmation and its alternative across question marks and line breaks", () => {
  for (const text of [
    "要我先查进程吗？还是你先执行 `/restart`？",
    "要我先查进程吗？\n还是你先执行 `/restart`？",
  ]) assert.deepEqual(detectChoicePoll(text)?.poll.options, ["我先查进程", "你先执行 /restart"]);
});

test("still leaves illustrative final decisions and missing alternatives alone", () => {
  for (const text of [
    "下面是一个示例：\n要我先查进程吗？还是你先执行 /restart？",
    "教程：\n- 步骤一\n- 步骤二\n是否继续？",
    "> 要我先查进程吗？还是你先执行 /restart？",
    "```text\n要我先查进程吗？\n还是你先执行 /restart？\n```",
    "先查进程。\n还是你先执行 /restart？",
  ]) assert.equal(detectChoicePoll(text), null, text);
});

test("uses inline alternatives rather than borrowing preceding diagnostic bullets", () => {
  const prefix = "可能来源：\n- gateway 未退出\n- agent 会话仍在使用数据库\n";
  for (const question of ["你选 A：先查进程，还是 B：先重启？", "你更喜欢哪个：先查进程还是先重启？"]) {
    assert.deepEqual(detectChoicePoll(prefix + question)?.poll.options, ["先查进程", "先重启"]);
  }
});

test("only joins the last question pair instead of including earlier questions in an option", () => {
  assert.deepEqual(detectChoicePoll("你想查什么？要我先查进程吗？还是你先执行 /restart？")?.poll.options,
    ["我先查进程", "你先执行 /restart"]);
  assert.deepEqual(detectChoicePoll("是否先检查？你想 A 还是 B？")?.poll.options, ["A", "B"]);
});

test("a parenthetical example within a decision is not a tutorial heading", () => {
  assert.deepEqual(detectChoicePoll("要我先查，比如查看进程吗？还是你先执行 /restart？")?.poll.options,
    ["我先查，比如查看进程", "你先执行 /restart"]);
});

test("recognizes the reported installation choice with explanations between section headings", () => {
  const text = readFileSync(new URL("./fixtures/install-choice.txt", import.meta.url), "utf8");
  const parsed = detectChoicePoll(text, { durationSeconds: 3600 });
  assert.deepEqual(parsed?.poll.options, [
    "用 git clone 到 extensions 目录，再 link 进去", "直接替换现有目录内容", "先改 remote 再拉",
  ]);
  assert.equal(parsed.poll.question, "你选哪条路？");
  assert.equal(parsed.intro, text.trim());
  assert.equal(parsed.poll.durationSeconds, 3600);
});

test("recognizes common route and plan selection phrases", () => {
  for (const question of ["你选哪条路？", "你想走哪条路线？", "你选哪一种？", "采用哪一项？", "你想用哪套方案？"]) {
    const text = `A. 检查配置\nB. 查看日志\n${question}`;
    assert.deepEqual(detectChoicePoll(text)?.poll.options, ["检查配置", "查看日志"], text);
  }
});

test("uses the question rather than its trailing explanation for a ballot", () => {
  for (const question of ["你选哪个？", "你选哪条路？"]) {
    const text = `A. 检查配置\nB. 查看日志\n${question}我会先备份配置，再执行。`;
    const parsed = detectChoicePoll(text);
    assert.deepEqual(parsed?.poll.options, ["检查配置", "查看日志"]);
    assert.equal(parsed.poll.question, question);
  }
  assert.equal(detectChoicePoll("是否继续？我会先备份配置。")?.poll.question, "是否继续？");
  assert.deepEqual(detectChoicePoll("先检查配置还是先查看日志？我会保留原始文件。")?.poll.options,
    ["先检查配置", "先查看日志"]);
});

test("uses section titles while preserving explanations, nested steps and code as the introduction", () => {
  for (const [first, second] of [["**A. 部署到 `production`**", "**B. 发布到 `staging`**"],
    ["### A：部署到 `production`", "### B：发布到 `staging`"],
    ["(A) 部署到 `production`", "(B) 发布到 `staging`"]]) {
    for (const placement of ["before", "after"]) {
      const sections = `${first}\n1. 备份配置\n2. 保留日志\n\`\`\`sh\nA. 隐藏示例\nB. 另一个示例\n\`\`\`\n${second}\n保留旧版本，以便回滚。`;
      const text = placement === "before" ? `请选择部署方案：\n${sections}` : `${sections}\n你选哪条路？我会先备份。`;
      const parsed = detectChoicePoll(text);
      assert.deepEqual(parsed?.poll.options, ["部署到 production", "发布到 staging"], text);
      assert.equal(parsed.intro, text);
    }
  }
});

test("does not turn explained sections into polls without an unambiguous user choice", () => {
  const sections = "A. 检查配置\n可以定位环境差异。\nB. 查看日志\n可以找到失败原因。";
  for (const text of [
    sections,
    `${sections}\n你觉得怎么样？`,
    `教程：\n${sections}\n你选哪条路？`,
    `以下是一个示例：\n${sections}\n你选哪条路？我会先备份。`,
    `操作步骤：\n${sections}\n你选哪条路？`,
    `\`\`\`text\n${sections}\n\`\`\`\n你选哪条路？`,
    `> A. 检查配置\n> 可以定位环境差异。\n> B. 查看日志\n你选哪条路？`,
    `${sections}\n你选哪条路？或者输入你的自定义方案。`,
    `不用投票。\n${sections}\n你选哪条路？`,
    `${sections}\n你选哪条路？\nA. 今天\n选择日期。\nB. 明天\n选择日期。\n请选择时间：`,
    "A. 检查配置\n说明。\nC. 查看日志\n说明。\n你选哪条路？",
    "A. 检查配置\n说明。\nB. 查看日志\n说明。\nD. 重启服务\n你选哪条路？",
    "A. 检查配置\n说明。\nB. 查看日志\n说明。\nB. 重启服务\n你选哪条路？",
    "A. 相同\n说明。\nB. 相同\n说明。\n你选哪条路？",
    `A. ${"长".repeat(101)}\n说明。\nB. 短\n说明。\n你选哪条路？`,
  ]) assert.equal(detectChoicePoll(text), null, text);
});

test("nested steps in the last section cannot become a competing ballot", () => {
  const text = "A. 检查配置\n先查看配置内容。\nB. 查看日志\n按下面的方法操作。\n1. 登录服务器\n2. 打开日志\n你选哪条路？";
  assert.deepEqual(detectChoicePoll(text)?.poll.options, ["检查配置", "查看日志"]);
});

test("section association stops at a new choice list instead of borrowing its question", () => {
  const sections = "A. 检查配置\n说明。\nB. 查看日志\n说明。";
  assert.equal(detectChoicePoll(`${sections}\n新的选项如下：\nA. 重启服务\n说明。\n你选哪条路？`), null);
  const text = `${sections}\n请选择执行时间：\n1. 今天\n2. 明天`;
  assert.deepEqual(detectChoicePoll(text)?.poll.options, ["今天", "明天"]);
  assert.equal(detectChoicePoll(text)?.poll.question, "请选择执行时间：");
  const example = `以下是一个示例：\n${sections}\n说明结束。\n接下来需要实际操作。\n请选择操作：\n1. 执行\n2. 取消`;
  assert.deepEqual(detectChoicePoll(example)?.poll.options, ["执行", "取消"]);
});

test("refuses a section list exceeding the option limit rather than dropping its last heading", () => {
  const text = "请选择方案：\n" + Array.from({ length: 13 }, (_, i) => `${String.fromCharCode(65 + i)}. 方案${i + 1}\n说明。`).join("\n");
  assert.equal(detectChoicePoll(text), null);
});

test("descriptive mentions of selection do not split section alternatives", () => {
  const text = "A. 直接安装\n使用哪条命令取决于系统版本。\nB. 使用容器\n说明。\n你选哪条路？";
  assert.deepEqual(detectChoicePoll(text)?.poll.options, ["直接安装", "使用容器"]);
});
