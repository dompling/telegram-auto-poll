import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, statSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { presetDocument, RuleStore, validateLearnedRule, validateRuleDocument } from "../src/rules.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "poll-rules-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, file: join(directory, "private", "rules.json") };
}
function rule(overrides = {}) {
  return {
    id: "execution-plan", description: "Literal plan heading choices",
    question: { phrases: ["确定一个方案"] }, options: { marker: "方案{label}：", labelStyle: "number" },
    examples: [
      { text: "确定一个方案？\n方案1：速度\n方案2：质量", expected: { question: "确定一个方案？", options: ["速度", "质量"] } },
      { text: "这是方案说明，不需要选择。", expected: null },
    ], ...overrides,
  };
}
const copy = value => JSON.parse(JSON.stringify(value));

// These store tests deliberately avoid importing the detector: extraction is
// verified by the detector's separate positive and negative corpus.
test("shipped presets contain every matching family and compile", () => {
  assert.equal(presetDocument.version, 1);
  assert.deepEqual(presetDocument.learnedRules, []);
  assert.equal(Object.keys(presetDocument.patterns).length, 45);
  for (const pattern of Object.values(presetDocument.patterns)) assert.doesNotThrow(() => new RegExp(pattern.source, pattern.flags));
  assert.match("please choose", new RegExp(presetDocument.patterns.SELECTION.source, "i"));
  assert.match("你愿意继续吗", new RegExp(presetDocument.patterns.CONFIRMATION.source, "i"));
  assert.match("不要发送投票", new RegExp(presetDocument.patterns.POLL_EXCLUSION.source, "i"));
  assert(Object.isFrozen(presetDocument.patterns.SELECTION));
});

test("constructor atomically seeds private directories and files; unchanged loads keep identity", t => {
  const { file } = fixture(t);
  const store = new RuleStore(file);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(file, "..")).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), presetDocument);
  const first = store.load();
  assert.strictEqual(store.load(), first);
  assert(Object.isFrozen(first.learnedRules));
  assert.deepEqual(readdirSync(join(file, "..")), ["rules.json"]);
});

test("valid edits reload immediately even when the file has the same size", t => {
  const { file } = fixture(t);
  const store = new RuleStore(file);
  const first = store.load();
  const document = copy(first);
  document.families[0].description = document.families[0].description.replace("Explicit", "Specific");
  writeFileSync(file, JSON.stringify(document));
  const second = store.load();
  assert.notStrictEqual(second, first);
  assert.equal(second.families[0].description, document.families[0].description);
  assert.strictEqual(store.load(), second);
});

test("corrupt initial content remains intact and uses shipped rules", t => {
  const { file } = fixture(t);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, "{broken");
  const warnings = [];
  const store = new RuleStore(file, { logger: { warn: message => warnings.push(message) } });
  assert.strictEqual(store.load(), presetDocument);
  assert.equal(readFileSync(file, "utf8"), "{broken");
  assert.equal(warnings.length, 1);
  assert.strictEqual(store.load(), presetDocument);
  assert.equal(warnings.length, 1);
});

test("invalid schema, syntax and oversized reloads keep last valid identity then recover", t => {
  const { file } = fixture(t);
  const warnings = [];
  const store = new RuleStore(file, { logger: { warn: text => warnings.push(text) } });
  const good = store.load();
  const invalid = copy(good);
  invalid.patterns.OPTION.source = "[";
  for (const contents of ["{bad", JSON.stringify(invalid), " ".repeat(256 * 1024 + 1)]) {
    writeFileSync(file, contents);
    assert.strictEqual(store.load(), good);
  }
  assert.equal(warnings.length, 3);
  writeFileSync(file, JSON.stringify({ ...good, learnedRules: [rule()] }));
  assert.equal(store.load().learnedRules[0].id, "execution-plan");
});

test("append validates a frozen candidate before publishing and records metadata only", t => {
  const { file } = fixture(t);
  const store = new RuleStore(file);
  const before = readFileSync(file, "utf8");
  let calls = 0;
  assert.deepEqual(store.append(rule(), candidate => {
    calls++;
    assert.equal(readFileSync(file, "utf8"), before);
    assert.equal(candidate.learnedRules.length, 1);
    assert.equal(candidate.learnedRules[0].enabled, true);
    assert.equal(candidate.learnedRules[0].question.allowStatement, false);
    assert.throws(() => { candidate.patterns.OPTION.source = ".*"; }, TypeError);
    return true;
  }), { added: true, ruleId: "execution-plan" });
  assert.equal(calls, 1);
  assert.equal(store.load().learnedRules.length, 1);
  const history = JSON.parse(readFileSync(join(file, "..", "history.jsonl"), "utf8"));
  assert.deepEqual(Object.keys(history).sort(), ["action", "ruleId", "timestamp"]);
  assert.equal(history.ruleId, "execution-plan");
  assert.equal(statSync(join(file, "..", "history.jsonl")).mode & 0o777, 0o600);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("failed or asynchronous candidate validation never publishes", t => {
  const { file } = fixture(t);
  const store = new RuleStore(file);
  const before = readFileSync(file, "utf8");
  const identity = store.load();
  for (const validate of [() => false, () => { throw new Error("negative corpus mismatch"); }, () => Promise.resolve(true)]) {
    assert.throws(() => store.append(rule(), validate));
    assert.equal(readFileSync(file, "utf8"), before);
    assert.strictEqual(store.load(), identity);
    assert.deepEqual(readdirSync(join(file, "..")), ["rules.json"]);
  }
});

test("append reloads disk edits and semantic duplicates do not rewrite or create history", t => {
  const { file } = fixture(t);
  const store = new RuleStore(file);
  const edited = copy(store.load());
  edited.families[0].description = "Locally maintained selection family";
  writeFileSync(file, JSON.stringify(edited));
  store.append(rule());
  assert.equal(store.load().families[0].description, edited.families[0].description);
  const before = readFileSync(file, "utf8");
  const history = readFileSync(join(file, "..", "history.jsonl"), "utf8");
  assert.deepEqual(store.append(rule({ id: "same-template", question: { phrases: [" 确定一个方案 "] } }), () => { throw Error("must not run"); }), {
    added: false, ruleId: "execution-plan",
  });
  assert.equal(readFileSync(file, "utf8"), before);
  assert.equal(readFileSync(join(file, "..", "history.jsonl"), "utf8"), history);
  assert.throws(() => store.append(rule({ options: { marker: "【{label}】", labelStyle: "number" } })), /already exists/);
});

test("history failure is warned after successful activation", t => {
  const { file } = fixture(t);
  const warnings = [];
  const store = new RuleStore(file, { logger: { warn: value => warnings.push(value) } });
  mkdirSync(join(file, "..", "history.jsonl"));
  assert.deepEqual(store.append(rule()), { added: true, ruleId: "execution-plan" });
  assert.equal(new RuleStore(file).load().learnedRules.length, 1);
  assert.match(warnings[0], /activated but history/);
});

test("document validation requires exact known regex keys and globally unique IDs", () => {
  for (const mutate of [
    document => { document.version = 2; },
    document => { delete document.patterns.OPTION; },
    document => { document.patterns.UNREVIEWED = { source: ".*", flags: "" }; },
    document => { document.patterns.OPTION.flags = "ii"; },
    document => { document.patterns.OPTION.code = "eval()"; },
    document => { document.families.push(document.families[0]); },
    document => { document.learnedRules = [rule(), rule()]; },
    document => { document.learnedRules = [rule({ id: document.families[0].id })]; },
    document => { document.extra = true; },
  ]) {
    const document = copy(presetDocument);
    mutate(document);
    assert.throws(() => validateRuleDocument(document));
  }
});

test("learned schema rejects code, regex, unsupported fields and invalid template markers", () => {
  for (const mutate of [
    value => { value.source = ".*"; },
    value => { value.flags = "i"; },
    value => { value.question.regex = ".*"; },
    value => { value.options.code = "return true"; },
    value => { value.options.marker = "方案#："; },
    value => { value.options.marker = "{label}{label}："; },
    value => { value.options.marker = "方案{label}"; },
    value => { value.options.marker = "{unknown}{label}："; },
    value => { value.options.labelStyle = "regex"; },
    value => { value.options.labels = ["甲", "乙"]; },
    value => { value.enabled = "yes"; },
    value => { value.question.allowStatement = "yes"; },
    value => { value.examples[0].expected.code = "execute()"; },
    value => { value.examples[1].extra = true; },
  ]) {
    const input = rule(); mutate(input);
    assert.throws(() => validateLearnedRule(input));
  }
  assert.equal(validateLearnedRule(rule({ options: { marker: "{label}. ", labelStyle: "letter" } })).options.marker, "{label}. ");
  assert.deepEqual(validateLearnedRule(rule({ options: { marker: "【{label}】", labelStyle: "custom", labels: ["甲", "乙"] } })).options.labels, ["甲", "乙"]);
});

test("learned schema enforces example balance, uniqueness and string/array bounds", () => {
  for (const mutate of [
    value => { value.question.phrases = []; },
    value => { value.question.phrases = Array(13).fill("问题"); },
    value => { value.question.phrases = ["x"]; },
    value => { value.question.phrases = ["x".repeat(121)]; },
    value => { value.question.phrases = ["问题", " 问题 "]; },
    value => { value.options.marker = "x".repeat(121) + "{label}："; },
    value => { value.options = { marker: "【{label}】", labelStyle: "custom", labels: ["甲", "甲"] }; },
    value => { value.examples = [value.examples[0], value.examples[0]]; },
    value => { value.examples = [value.examples[1], value.examples[1]]; },
    value => { value.examples[0].text = "x".repeat(20001); },
    value => { value.examples[0].expected.question = "x".repeat(301); },
    value => { value.examples[0].expected.options = ["same", "same"]; },
    value => { value.examples[0].expected.options = ["x".repeat(101), "valid"]; },
    value => { value.examples[0].expected.options = ["one"]; },
    value => { value.description = "x".repeat(301); },
  ]) {
    const input = rule(); mutate(input);
    assert.throws(() => validateLearnedRule(input));
  }
  assert.throws(() => validateRuleDocument({ ...presetDocument, learnedRules: Array.from({ length: 101 }, (_, n) => rule({ id: `rule-${n}` })) }));
  assert.throws(() => validateRuleDocument({ ...presetDocument, learnedRules: Array.from({ length: 14 }, (_, n) => rule({
    id: `large-${n}`, examples: [{ text: "x".repeat(20000), expected: null }, ...rule().examples],
  })) }), /256 KiB/);
});

test("stores and caller-owned inputs remain isolated", t => {
  const { directory, file } = fixture(t);
  const first = new RuleStore(file);
  const second = new RuleStore(join(directory, "other", "rules.json"));
  const input = rule();
  first.append(input);
  input.options.marker = "changed{label}：";
  input.examples[0].expected.options[0] = "changed";
  assert.equal(first.load().learnedRules[0].options.marker, "方案{label}：");
  assert.equal(first.load().learnedRules[0].examples[0].expected.options[0], "速度");
  assert.equal(second.load().learnedRules.length, 0);
  assert.equal(presetDocument.learnedRules.length, 0);
});
