import test from "node:test";
import assert from "node:assert/strict";
import { runCli, pollArguments } from "../src/send.mjs";

test("captures successful CLI JSON for native poll answer-routing diagnostics", async () => {
  const result = await runCli(process.execPath, ["-e", 'console.log(JSON.stringify({payload:{pollId:"test",pollAnswerRouting:"enabled"}}))'], 2000);
  assert.equal(result?.payload?.pollId, "test");
  assert.equal(result.payload.pollAnswerRouting, "enabled");
});

test("successful legacy CLI output stays compatible without pretending answers can route", async () => {
  assert.equal(await runCli(process.execPath, ["-e", 'console.log("Sent poll successfully")'], 2000), undefined);
});

test("requests CLI JSON so public answer-routing failures can be reported", () => {
  const args = pollArguments({ to: "123", poll: { question: "Q", options: ["A", "B"], durationSeconds: 300, anonymous: false } });
  assert.ok(args.includes("--json"));
  assert.ok(args.includes("--poll-public"));
});
