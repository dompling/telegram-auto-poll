import { appendFileSync, closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const MAX_BYTES = 256 * 1024;
const MAX_RULES = 100;

function fail(message) { throw new Error(`Invalid poll rules: ${message}`); }
function object(value, fields, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !fields.includes(key))) fail(`${name} has unsupported fields or is not an object`);
}
function string(value, min, max, name, trim = true) {
  if (typeof value !== "string") fail(`${name} must be a string`);
  const result = trim ? value.trim() : value;
  if (result.length < min || result.length > max) fail(`${name} must contain ${min}..${max} characters`);
  return result;
}
function bool(value, fallback, name) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") fail(`${name} must be boolean`);
  return value;
}
function array(value, min, max, name) {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(`${name} must contain ${min}..${max} entries`);
  return value;
}
function unique(values, name) {
  if (new Set(values).size !== values.length) fail(`${name} must be unique`);
  return values;
}
function id(value, name) {
  const result = string(value, 1, 80, name);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(result)) fail(`${name} contains unsupported characters`);
  return result;
}
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function checkSize(value) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { fail("document must be JSON serializable"); }
  if (Buffer.byteLength(serialized) > MAX_BYTES) fail("document exceeds 256 KiB");
}

export function validateLearnedRule(rule) {
  object(rule, ["id", "description", "enabled", "question", "options", "examples"], "learned rule");
  object(rule.question, ["phrases", "allowStatement"], "question");
  object(rule.options, ["marker", "labelStyle", "labels"], "options");
  const phrases = unique(array(rule.question.phrases, 1, 12, "question.phrases")
    .map(phrase => string(phrase, 2, 120, "question phrase")), "question phrases");
  const marker = string(rule.options.marker, 1, 120, "options.marker", false);
  if (marker.split("{label}").length !== 2 || !marker.split("{label}")[1].length) {
    fail("options.marker must contain exactly one {label} and a nonempty literal suffix");
  }
  if (/[{}]/.test(marker.replace("{label}", ""))) fail("options.marker contains an unsupported placeholder");
  const labelStyle = rule.options.labelStyle;
  if (!["number", "letter", "custom"].includes(labelStyle)) fail("unsupported options.labelStyle");
  let labels;
  if (labelStyle === "custom") {
    labels = unique(array(rule.options.labels, 2, 12, "options.labels")
      .map(label => string(label, 1, 30, "custom label")), "custom labels");
    if (labels.some(label => label.includes("\n") || label.includes("\r"))) fail("custom labels must fit on one line");
  } else if (rule.options.labels !== undefined) fail("options.labels requires custom labelStyle");
  const examples = array(rule.examples, 2, 12, "examples").map(example => {
    object(example, ["text", "expected"], "example");
    const text = string(example.text, 1, 20000, "example.text", false);
    if (example.expected === null) return { text, expected: null };
    object(example.expected, ["question", "options"], "example.expected");
    return { text, expected: {
      question: string(example.expected.question, 1, 300, "expected.question"),
      options: unique(array(example.expected.options, 2, 12, "expected.options")
        .map(option => string(option, 1, 100, "expected option")), "expected options"),
    } };
  });
  if (!examples.some(example => example.expected) || !examples.some(example => example.expected === null)) {
    fail("examples must include positive and negative cases");
  }
  const result = {
    id: id(rule.id, "rule.id"), description: string(rule.description, 1, 300, "rule.description"),
    enabled: bool(rule.enabled, true, "rule.enabled"),
    question: { phrases, allowStatement: bool(rule.question.allowStatement, false, "question.allowStatement") },
    options: { marker, labelStyle, ...(labels ? { labels } : {}) }, examples,
  };
  checkSize(result);
  return result;
}

// This file is shipped with the plugin; learned rule proposals cannot supply regex.
const shipped = JSON.parse(readFileSync(new URL("../rules/presets.json", import.meta.url), "utf8"));
const patternKeys = Object.keys(shipped.patterns).sort();

export function validateRuleDocument(document) {
  checkSize(document);
  object(document, ["version", "patterns", "learnedRules", "families"], "document");
  if (document.version !== 1) fail("version must be 1");
  object(document.patterns, patternKeys, "patterns");
  if (JSON.stringify(Object.keys(document.patterns).sort()) !== JSON.stringify(patternKeys)) fail("patterns must contain all preset keys");
  const patterns = {};
  for (const key of patternKeys) {
    const pattern = document.patterns[key];
    object(pattern, ["source", "flags"], `patterns.${key}`);
    const source = string(pattern.source, 1, 10000, `${key}.source`, false);
    const flags = string(pattern.flags, 0, 8, `${key}.flags`, false);
    try { new RegExp(source, flags); } catch { fail(`${key} is not a valid regular expression`); }
    patterns[key] = { source, flags };
  }
  const learnedRules = array(document.learnedRules, 0, MAX_RULES, "learnedRules").map(validateLearnedRule);
  unique(learnedRules.map(rule => rule.id), "rule IDs");
  const families = array(document.families, 1, 30, "families").map(family => {
    object(family, ["id", "description"], "family");
    return { id: id(family.id, "family.id"), description: string(family.description, 1, 500, "family.description") };
  });
  unique([...families.map(family => family.id), ...learnedRules.map(rule => rule.id)], "family and rule IDs");
  const result = { version: 1, patterns, learnedRules, families };
  checkSize(result);
  return result;
}

export const presetDocument = freeze(validateRuleDocument(shipped));

function semanticKey(rule) {
  const normalize = value => value.trim().replace(/\s+/g, " ").toLowerCase();
  return JSON.stringify({
    question: { ...rule.question, phrases: rule.question.phrases.map(normalize).sort() },
    options: { ...rule.options },
  });
}

function atomicWrite(filePath, contents, seed = false) {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, contents, "utf8");
    closeSync(fd); fd = undefined;
    if (seed) {
      try { linkSync(temporary, filePath); } catch (error) { if (error.code !== "EEXIST") throw error; }
    } else renameSync(temporary, filePath);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

export class RuleStore {
  constructor(filePath, { logger } = {}) {
    this.filePath = filePath;
    this.logger = logger;
    this.document = presetDocument;
    this.lastRead = undefined;
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    if (!existsSync(filePath)) atomicWrite(filePath, `${JSON.stringify(presetDocument, null, 2)}\n`, true);
  }

  warn(message, error) {
    try { this.logger?.warn?.(`${message}: ${error.message}`); } catch { /* Logging must not interrupt delivery. */ }
  }

  load() {
    try {
      if (statSync(this.filePath).size > MAX_BYTES) fail("document exceeds 256 KiB");
      const contents = readFileSync(this.filePath, "utf8");
      if (contents === this.lastRead) return this.document;
      this.lastRead = contents;
      this.document = freeze(validateRuleDocument(JSON.parse(contents)));
    } catch (error) { this.warn("Keeping last valid poll rules", error); }
    return this.document;
  }

  append(input, validateCandidate) {
    const current = this.load();
    const rule = validateLearnedRule(input);
    const existingId = current.learnedRules.find(existing => existing.id === rule.id);
    const key = semanticKey(rule);
    if (existingId && semanticKey(existingId) !== key) fail(`rule ID ${rule.id} already exists with different matching semantics`);
    const duplicate = current.learnedRules.find(existing => semanticKey(existing) === key);
    if (duplicate) return { added: false, ruleId: duplicate.id };
    const candidate = freeze(validateRuleDocument({ ...current, learnedRules: [...current.learnedRules, rule] }));
    if (validateCandidate !== undefined) {
      if (typeof validateCandidate !== "function") fail("validateCandidate must be a function");
      const result = validateCandidate(candidate);
      if (result && typeof result.then === "function") fail("validateCandidate must be synchronous");
      if (result === false) fail("candidate validation failed");
    }
    const contents = `${JSON.stringify(candidate, null, 2)}\n`;
    if (Buffer.byteLength(contents) > MAX_BYTES) fail("document exceeds 256 KiB");
    atomicWrite(this.filePath, contents);
    this.lastRead = contents;
    this.document = candidate;
    try {
      appendFileSync(join(dirname(this.filePath), "history.jsonl"), `${JSON.stringify({
        timestamp: new Date().toISOString(), action: "learned-rule-added", ruleId: rule.id,
      })}\n`, { encoding: "utf8", mode: 0o600 });
    } catch (error) { this.warn("Poll rule activated but history could not be saved", error); }
    return { added: true, ruleId: rule.id };
  }
}
