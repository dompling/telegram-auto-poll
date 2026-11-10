import test from "node:test";
import assert from "node:assert/strict";
import { detectChoicePoll } from "../src/detect.mjs";

const options = ["检查配置", "查看日志", "重启服务"];
const sections = "1. 检查配置\n先查看配置文件。\n2. 查看日志\n定位失败原因。\n3. 重启服务\n先备份，再重启。";

for (const [style, headings] of [
  ["period", ["1. 检查配置", "2. 查看日志", "3. 重启服务"]],
  ["dunhao", ["1、检查配置", "2、查看日志", "3、重启服务"]],
  ["closing parenthesis", ["1）检查配置", "2）查看日志", "3）重启服务"]],
  ["parenthesized numbers", ["（1）检查配置", "（2）查看日志", "（3）重启服务"]],
  ["plan prefixes", ["方案 1：检查配置", "方案 2：查看日志", "方案 3：重启服务"]],
  ["option prefixes", ["选项 1：检查配置", "选项 2：查看日志", "选项 3：重启服务"]],
  ["bold bullet headings", ["- **1. 检查配置**", "- **2. 查看日志**", "- **3. 重启服务**"]],
  ["Markdown headings", ["### 1. 检查配置", "### 2. 查看日志", "### 3. 重启服务"]],
]) {
  for (const explained of [false, true]) {
    for (const placement of ["before", "after"]) {
      test(`numbered ${style}, ${explained ? "explained" : "continuous"}, prompt ${placement}`, () => {
        const body = headings.map(heading => explained ? `${heading}\n保留原始文件，便于核对。` : heading).join("\n");
        const text = placement === "before" ? `请选择下一步：\n${body}` : `${body}\n你选哪种方案？我会先备份。`;
        const parsed = detectChoicePoll(text, { durationSeconds: 3600 });
        assert.deepEqual(parsed?.poll.options, options, text);
        assert.equal(parsed.poll.question, placement === "before" ? "请选择下一步：" : "你选哪种方案？");
        assert.equal(parsed.intro, text);
        assert.equal(parsed.poll.durationSeconds, 3600);
      });
    }
  }
}

for (const [question, expected] of [
  ["你选 1、2 还是 3？", ["检查配置", "查看日志", "重启服务"]],
  ["你选方案 3 还是方案 1？", ["重启服务", "检查配置"]],
  ["你选 1 还是 2？我会先备份。", ["检查配置", "查看日志"]],
  ["你选 1 吗？我会先备份。", ["是", "否"]],
]) {
  test(`numbered references: ${question}`, () => {
    assert.deepEqual(detectChoicePoll(`${sections}\n${question}`)?.poll.options, expected);
  });
}

for (const [name, text] of [
  ["plain diagnostic list", sections],
  ["open opinion", `${sections}\n你觉得怎么样？`],
  ["knowledge question", `${sections}\n你知道为什么选 1 吗？`],
  ["tutorial sections", `以下是一个教程示例：\n${sections}\n你选哪种方案？`],
  ["procedural instructions", `操作步骤：\n${sections}\n你选哪种方案？`],
  ["fenced sections", `\`\`\`text\n${sections}\n\`\`\`\n你选哪种方案？`],
  ["quoted sections", "> 1. 检查配置\n> 配置说明。\n> 2. 查看日志\n> 日志说明。\n你选哪种方案？"],
  ["free input", `${sections}\n你选哪种方案？也可以回复其他方法。`],
  ["withdrawn choice", `${sections}\n你选哪种方案？\n不用选了，任务已取消。`],
  ["missing middle number", "1. 检查配置\n说明。\n3. 重启服务\n说明。\n你选哪种方案？"],
  ["duplicate number", "1. 检查配置\n说明。\n2. 查看日志\n说明。\n2. 重启服务\n说明。\n你选哪种方案？"],
  ["missing final number", "1. 检查配置\n说明。\n2. 查看日志\n说明。\n4. 重启服务\n说明。\n你选哪种方案？"],
  ["incomplete newer group", `${sections}\n新的选项如下：\n1. 部署更新\n保留日志。\n你选哪种方案？`],
  ["two decisions", `请选择操作：\n${sections}\n请选择时间：\n1. 今天\n说明。\n2. 明天\n说明。`],
  ["unknown reference", `${sections}\n你选 1 还是 4？`],
  ["repeated reference", `${sections}\n你选 1 还是 1？`],
  ["too many options", "请选择操作：\n" + Array.from({ length: 13 }, (_, i) => `${i + 1}. 操作${i + 1}\n说明。`).join("\n")],
]) {
  test(`numbered stays text: ${name}`, () => assert.equal(detectChoicePoll(text), null, text));
}

test("numbered sections own nested bullet steps and fenced command examples", () => {
  const text = "1. 检查配置\n- 备份文件\n- 核对权限\n```text\n1. 隐藏示例\n2. 另一个示例\n```\n2. 查看日志\n- 登录服务器\n- 打开日志\n你选哪条路？";
  assert.deepEqual(detectChoicePoll(text)?.poll.options, ["检查配置", "查看日志"]);
});

test("numbered choices own lettered substeps rather than publishing the substeps", () => {
  for (const text of [
    "1. 手工安装\n准备过程：\na. 下载压缩包\nb. 校验文件\n2. 容器安装\n使用镜像运行。\n你选 1 还是 2？",
    "1. 手工安装\n准备过程：\na. 下载压缩包\nb. 校验文件\n2. 容器安装\n使用镜像运行。\n你选哪种方案？",
    "请选择安装方案：\n1. 手工安装\n子步骤：\nA. 备份文件\nB. 核对权限\n2. 容器安装\n子步骤：\nA. 下载镜像\nB. 启动容器\n你选哪种方案？",
  ]) assert.deepEqual(detectChoicePoll(text)?.poll.options, ["手工安装", "容器安装"], text);
});

test("diagnostic numbers do not borrow the prompt introducing a newer numbered decision", () => {
  const text = "检查结果：\n1. 配置已经备份\n备份文件可用。\n2. 服务尚未启动\n等待选择。\n请选择执行时间：\n1. 今天\n尽快处理。\n2. 明天\n安排窗口。";
  const parsed = detectChoicePoll(text);
  assert.deepEqual(parsed?.poll.options, ["今天", "明天"]);
  assert.equal(parsed.poll.question, "请选择执行时间：");
});

for (const [question, expected] of [
  ["你希望运行 1 还是 2 个实例？", ["运行 1", "2 个实例"]],
  ["你选1.5还是2.5？", ["1.5", "2.5"]],
  ["你选1/2小时还是3小时？", ["1/2小时", "3小时"]],
]) {
  test(`numeric values are not section references: ${question}`, () => {
    assert.deepEqual(detectChoicePoll(`${sections}\n${question}`)?.poll.options, expected);
  });
}

test("numeric references outside the label range cannot fall back to a literal-number poll", () => {
  assert.equal(detectChoicePoll(`${sections}\n你选 1 还是 100？`), null);
});
