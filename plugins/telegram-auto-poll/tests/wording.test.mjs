import test from "node:test";
import assert from "node:assert/strict";
import { detectChoicePoll } from "../src/detect.mjs";

const options = ["用 Git 保留更新能力", "替换当前插件目录", "在原目录关联远程仓库"];
const sections = `A. 用 Git 保留更新能力
保留 .git，后续可以 git pull。
B. 替换当前插件目录
先备份旧文件，再克隆到原位置。
C. 在原目录关联远程仓库
需要处理已有文件，避免覆盖冲突。`;

const choices = [
  ["route with a backup promise", "你选哪条路？我会先备份旧目录。", "你选哪条路？"],
  ["preferred route", "你更倾向哪条路线？我会先备份旧目录。", "你更倾向哪条路线？"],
  ["preferred plan", "你更倾向于哪一套方案？", "你更倾向于哪一套方案？"],
  ["preferred method", "你更喜欢哪一种方式？", "你更喜欢哪一种方式？"],
  ["desired approach", "你希望采用哪一种方式？我会按你选择的方案执行。", "你希望采用哪一种方式？"],
  ["want a plan", "你要哪个方案？", "你要哪个方案？"],
  ["explicit selection", "请选择安装方式：", "请选择安装方式："],
  ["one route", "选哪一条比较合适？我建议 A，但由你决定。", "选哪一条比较合适？"],
  ["separate backup paragraph", "你想选哪一个方案？\n我会先备份，确认后开始。", "你想选哪一个方案？"],
  ["question referring to all three letters", "你选 A、B 还是 C？我会先备份。", "你选 A、B 还是 C？"],
  ["two letter references", "你选 A 还是 B？", "你选 A 还是 B？"],
  ["English preference", "Which approach would you prefer? I'll back up the directory first.", "Which approach would you prefer?"],
  ["English pronoun is not a section reference", "Which option should I choose?", "Which option should I choose?"],
  ["English article is not a section reference", "Please choose a route:", "Please choose a route:"],
  ["backup completed before the pending choice", "你选哪条路？我已经完成旧目录备份，选好后再安装。", "你选哪条路？"],
  ["backup is ready", "你选哪条路？备份已经完成，随时可以开始。", "你选哪条路？"],
];

for (const [name, ending, question] of choices) {
  test(`wording: ${name}`, () => {
    const text = `${sections}\n${ending}`;
    const parsed = detectChoicePoll(text);
    // An explicit A/B reference is a subset of the defined A/B/C sections.
    const expected = name === "two letter references" ? ["用 Git 保留更新能力", "替换当前插件目录"] : options;
    assert.deepEqual(parsed?.poll.options, expected, text);
    assert.equal(parsed.poll.question, question);
    assert.equal(parsed.intro, text);
    assert.equal(parsed.poll.anonymous, false);
  });
}

for (const [name, text] of [
  ["plan-prefixed headings", "方案 A：用 Git 保留更新能力\n保留 .git。\n方案 B：替换当前插件目录\n先备份。\n你选哪种方案？"],
  ["option-prefixed headings", "选项 A：用 Git 保留更新能力\n保留 .git。\n选项 B：替换当前插件目录\n先备份。\n你选哪种方案？"],
  ["bulleted bold letter headings", "- **A. 用 Git 保留更新能力**\n保留 .git。\n- **B. 替换当前插件目录**\n先备份。\n你选哪种方案？"],
  ["parenthesized letters", "（A）用 Git 保留更新能力\n保留 .git。\n（B）替换当前插件目录\n先备份。\n你选哪种方案？"],
  ["case-insensitive letters", "a. 用 Git 保留更新能力\n保留 .git。\nb. 替换当前插件目录\n先备份。\n你选哪种方案？"],
]) {
  test(`wording: ${name}`, () => {
    const parsed = detectChoicePoll(text);
    assert.deepEqual(parsed?.poll.options, ["用 Git 保留更新能力", "替换当前插件目录"], text);
    assert.equal(parsed.intro, text);
  });
}

for (const [name, ending] of [
  ["asks why to choose", "你知道为什么要选 A 吗？"],
  ["asks which is safer", "你知道选哪个更安全吗？"],
  ["diagnostic question", "你为什么选哪个方案都报错？"],
  ["open opinion", "你觉得这样安排怎么样？"],
  ["already selected", "我建议选择 A，已经按 A 执行完了。"],
  ["no decision needed", "上述仅是安装方式说明，不需要你选择。"],
  ["quoted documentation question", "文档里写着“你选哪条路？”，这是交互示例，不是现在让你选择。"],
  ["other approaches by reply", "你选哪条路？也可以回复其他安装方式。"],
  ["own installation method", "请选择一种，或者告诉我你自己的安装方法。"],
  ["other ideas by reply", "你选哪个？有其他想法也可以直接说。"],
  ["English free input", "Which approach would you prefer? Or suggest another approach."],
  ["explicit custom plan", "你选哪个？也可以输入你的自定义方案。"],
  ["explicit no poll", "不用发起投票，直接在聊天里回复。你选哪个？"],
]) {
  test(`wording stays text: ${name}`, () => {
    const text = `${sections}\n${ending}`;
    assert.equal(detectChoicePoll(text), null, text);
  });
}

for (const [name, text] of [
  ["tutorial dialogue", `这是教程中的对话示例：\n${sections}\n你选哪条路？`],
  ["generated string template", `这段配置的作用是生成以下问题：\n${sections}\n请选择安装方式：\n以上只是字符串模板。`],
  ["fenced dialogue", `\`\`\`text\n${sections}\n你选哪条路？\n\`\`\``],
  ["quoted dialogue", "> A. 查看配置\n> 配置说明。\n> B. 查看日志\n> 日志说明。\n> 你选哪条路？"],
  ["canceled confirmation", "是否继续？不用了，任务已取消。"],
  ["answered confirmation", "是否继续？已经执行完成，无需再确认。"],
  ["withdrawn selection", `${sections}\n你选哪条路？不用选了，我已经取消安装。`],
  ["selection withdrawn on the next line", `${sections}\n你选哪个？\n不用选了，任务已取消。`],
  ["instruction withdrawn on the next line", `${sections}\n请选择安装方式：\n不用了，任务已取消。`],
  ["two separate decisions", `请选择安装方案：\n${sections}\n请选择时间：\n1. 今天\n2. 明天`],
  ["missing middle label", "A. 直接安装\n说明。\nC. 使用容器\n说明。\n你选哪条路？"],
  ["incomplete latest choice", `${sections}\n新的选项如下：\nA. 重启服务\n说明。\n你选哪条路？`],
]) {
  test(`wording stays text: ${name}`, () => assert.equal(detectChoicePoll(text), null, text));
}

test("wording: unrelated diagnostic lists do not replace a section decision", () => {
  const text = `当前状态：\n1. 插件已加载\n2. 配置已备份\n${sections}\n你选哪条路？`;
  assert.deepEqual(detectChoicePoll(text)?.poll.options, options);
});

test("wording: explicit nonadjacent references preserve the requested subset and order", () => {
  const parsed = detectChoicePoll(`${sections}\n你选方案 C 还是方案 A？`);
  assert.deepEqual(parsed?.poll.options, ["在原目录关联远程仓库", "用 Git 保留更新能力"]);
});

for (const question of ["你选 A 还是 D？", "你选 A 还是 A？"]) {
  test(`wording stays text: invalid section reference ${question}`, () => {
    assert.equal(detectChoicePoll(`${sections}\n${question}`), null);
  });
}

test("wording: confirming one named section asks yes or no rather than offering every section", () => {
  const parsed = detectChoicePoll(`${sections}\n你选 A 吗？我会先备份。`);
  assert.deepEqual(parsed?.poll.options, ["是", "否"]);
});
