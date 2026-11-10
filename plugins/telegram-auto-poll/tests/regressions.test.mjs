import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { detectChoicePoll } from "../src/detect.mjs";

// Literal expectations are shared with the learned-rule activation gate.
const corpus = JSON.parse(readFileSync(new URL("../rules/regressions.json", import.meta.url), "utf8"));
assert.equal(corpus.version, 1);
assert.ok(corpus.cases.length > 0);
assert.equal(new Set(corpus.cases.map(entry => entry.id)).size, corpus.cases.length);

for (const { id, text, expected } of corpus.cases) {
  test(`regression corpus: ${id}`, () => {
    const detected = detectChoicePoll(text);
    const actual = detected ? { question: detected.poll.question, options: detected.poll.options } : null;
    assert.deepEqual(actual, expected);
  });
}
