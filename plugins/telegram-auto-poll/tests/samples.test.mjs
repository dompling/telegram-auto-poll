import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SampleStore } from "../src/samples.mjs";

function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "poll-samples-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "private", "samples.json");
  return { dir, path, store: new SampleStore(path, options) };
}

const sample = { to: "telegram:-1001", accountId: "main", content: "Choose A or B" };

test("capture persists private records and reloads their state", t => {
  const { path, store } = fixture(t, { now: () => 1234 });
  const record = store.capture(sample);
  assert.equal(typeof record.id, "string");
  assert.ok(record.id);
  assert.deepEqual(record, { ...sample, id: record.id, status: "pending", createdAt: 1234 });
  assert.equal(statSync(join(path, "..")).mode & 0o777, 0o700);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { version: 1, records: [record] });
  assert.deepEqual(new SampleStore(path, { now: () => 1234 }).get(record.id), record);
  assert.deepEqual(readdirSync(join(path, "..")), ["samples.json"]);
});

test("capture dedupes content and origin only inside the exact chat and account", t => {
  const { store } = fixture(t);
  const record = store.capture({ ...sample, originKey: "message:1" });
  assert.equal(store.capture(sample).id, record.id);
  assert.equal(store.capture({ ...sample, content: "Changed", originKey: "message:1" }).id, record.id);
  const otherChat = store.capture({ ...sample, to: "telegram:-1002", originKey: "message:1" });
  const otherAccount = store.capture({ ...sample, accountId: "other", originKey: "message:1" });
  assert.notEqual(otherChat.id, record.id);
  assert.notEqual(otherAccount.id, record.id);
  assert.deepEqual(store.pending(sample), [record]);
});

test("pending requires exact account and chat, excludes resolved records, and honors limit", t => {
  const { store } = fixture(t);
  const records = Array.from({ length: 5 }, (_, i) => store.capture({ ...sample, content: `Question ${i}` }));
  store.resolve(records[0].id, "learned");
  assert.deepEqual(store.pending(sample).map(r => r.id), records.slice(1, 4).map(r => r.id));
  assert.equal(store.pending({ ...sample, limit: 1 }).length, 1);
  assert.deepEqual(store.pending({ to: sample.to }), []);
  assert.deepEqual(store.pending({ ...sample, to: "other" }), []);
  assert.deepEqual(store.pending({ ...sample, limit: 0 }), []);
  const defaultAccount = store.capture({ ...sample, accountId: "", content: "Default account" });
  assert.deepEqual(store.pending({ to: sample.to }), [defaultAccount]);
});

test("resolved samples stay deduped after reload and only valid resolutions are accepted", t => {
  const { path, store } = fixture(t);
  const record = store.capture(sample);
  assert.throws(() => store.resolve(record.id, "pending"));
  assert.equal(store.get(record.id).status, "pending");
  assert.equal(store.resolve(record.id, "dismissed").status, "dismissed");
  const reloaded = new SampleStore(path);
  assert.equal(reloaded.capture(sample).id, record.id);
  assert.deepEqual(reloaded.pending(sample), []);
  assert.equal(reloaded.resolve("missing", "learned"), undefined);
});

test("public return values cannot mutate stored records", t => {
  const { store } = fixture(t);
  const record = store.capture(sample);
  const id = record.id;
  record.status = "dismissed";
  store.get(id).content = "Mutated";
  store.pending(sample)[0].to = "other";
  store.capture(sample).accountId = "other";
  store.resolve(id, "learned").content = "Also mutated";
  assert.deepEqual(store.get(id), { ...sample, id, status: "learned", createdAt: record.createdAt });
});

test("capture rejects invalid values before creating storage", t => {
  const { path, store } = fixture(t);
  for (const values of [
    { to: "" }, { to: "  " }, { to: 12 }, { accountId: 12 },
    { content: null }, { content: "x".repeat(20001) }, { originKey: 12 },
  ]) assert.throws(() => store.capture({ ...sample, ...values }));
  assert.throws(() => readFileSync(path), { code: "ENOENT" });
  assert.equal(store.capture({ ...sample, content: "x".repeat(20000) }).content.length, 20000);
});

test("retention expires resolved and pending records at the seven-day boundary", t => {
  let now = 100;
  const { path, store } = fixture(t, { now: () => now });
  const first = store.capture(sample);
  const second = store.capture({ ...sample, content: "Second" });
  store.resolve(first.id, "dismissed");
  now += 7 * 86400000;
  assert.ok(store.get(second.id));
  now++;
  assert.equal(store.get(first.id), undefined);
  assert.deepEqual(store.pending(sample), []);
  const replacement = store.capture(sample);
  assert.notEqual(replacement.id, first.id);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).records, [replacement]);
});

test("reload filters expired records and supports a shorter retention window", t => {
  const { path, store } = fixture(t, { now: () => 100 });
  const record = store.capture(sample);
  const reloaded = new SampleStore(path, { now: () => 111, retentionMs: 10 });
  assert.equal(reloaded.get(record.id), undefined);
});

test("capacity evicts oldest resolved records before oldest pending records", t => {
  let now = 100;
  const { path, store } = fixture(t, { now: () => now++, maxRecords: 3 });
  const first = store.capture(sample);
  const second = store.capture({ ...sample, content: "Second" });
  const third = store.capture({ ...sample, content: "Third" });
  store.resolve(second.id, "dismissed");
  const fourth = store.capture({ ...sample, content: "Fourth" });
  assert.equal(store.get(second.id), undefined);
  assert.ok(store.get(first.id));
  const fifth = store.capture({ ...sample, content: "Fifth" });
  assert.equal(store.get(first.id), undefined);
  assert.deepEqual(store.pending({ ...sample, limit: 100 }).map(r => r.id), [third.id, fourth.id, fifth.id]);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).records.length, 3);
});

test("the default capacity bounds the persisted journal to 100 records", t => {
  const { path, store } = fixture(t);
  const oldest = store.capture(sample);
  for (let i = 0; i < 100; i++) store.capture({ ...sample, content: `Sample ${i}` });
  assert.equal(store.get(oldest.id), undefined);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).records.length, 100);
});

test("corrupt or malformed journals are rejected without overwriting the file", t => {
  const { dir } = fixture(t);
  const valid = { ...sample, id: "sample-1", status: "pending", createdAt: Date.now() };
  const invalid = ["not json", "null", {}, { version: 2, records: [] }, { version: 1, records: null },
    ...[null, { ...valid, content: 1 }, { ...valid, status: "unknown" }, { ...valid, to: "" },
      { ...valid, accountId: null }, { ...valid, id: "" }, { ...valid, createdAt: "100" },
      { ...valid, content: "x".repeat(20001) }, { ...valid, originKey: {} }, { ...valid, unexpected: "secret" }]
      .map(record => ({ version: 1, records: [record] })),
    { version: 1, records: [valid, valid] }];
  for (const [i, value] of invalid.entries()) {
    const path = join(dir, `corrupt-${i}.json`);
    const bytes = typeof value === "string" ? value : JSON.stringify(value);
    writeFileSync(path, bytes);
    assert.throws(() => new SampleStore(path), /Cannot read sample journal/);
    assert.equal(readFileSync(path, "utf8"), bytes);
  }
  assert.throws(() => new SampleStore(dir), /Cannot read sample journal/);
});

test("failed capture rolls back capacity eviction and removes its temporary file", t => {
  const { path, store } = fixture(t, { maxRecords: 1 });
  const record = store.capture(sample);
  const originalBytes = readFileSync(path, "utf8");
  const backup = `${path}.backup`;
  renameSync(path, backup);
  mkdirSync(path);
  assert.throws(() => store.capture({ ...sample, content: "Cannot save" }));
  assert.deepEqual(store.get(record.id), record);
  assert.deepEqual(store.pending(sample), [record]);
  assert.equal(readFileSync(backup, "utf8"), originalBytes);
  assert.deepEqual(readdirSync(join(path, "..")).sort(), ["samples.json", "samples.json.backup"]);
  rmSync(path, { recursive: true });
  renameSync(backup, path);
  assert.equal(new SampleStore(path).get(record.id).status, "pending");
});

test("failed resolution preserves the previous status in memory and on disk", t => {
  const { path, store } = fixture(t);
  const record = store.capture(sample);
  const backup = `${path}.backup`;
  renameSync(path, backup);
  mkdirSync(path);
  assert.throws(() => store.resolve(record.id, "learned"));
  assert.equal(store.get(record.id).status, "pending");
  assert.equal(new SampleStore(backup).get(record.id).status, "pending");
});

test("failed initial write leaves no sample in memory", t => {
  const { dir } = fixture(t);
  const blocker = join(dir, "regular-file");
  const store = new SampleStore(join(blocker, "samples.json"));
  writeFileSync(blocker, "unchanged");
  assert.throws(() => store.capture(sample));
  assert.deepEqual(store.pending(sample), []);
  assert.equal(readFileSync(blocker, "utf8"), "unchanged");
});
