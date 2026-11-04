import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

const fields = new Set(["id", "to", "accountId", "content", "originKey", "status", "createdAt"]);
const statuses = new Set(["pending", "learned", "dismissed"]);

function validateSample(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)
    || typeof record.to !== "string" || !record.to.trim()
    || typeof record.accountId !== "string"
    || typeof record.content !== "string" || record.content.length > 20000
    || (record.originKey !== undefined && typeof record.originKey !== "string")) {
    throw new Error("Invalid sample fields");
  }
}

// Local, bounded single-Gateway journal. All returned records are snapshots.
export class SampleStore {
  #records = [];
  #filePath;
  #now;
  #retentionMs;
  #maxRecords;

  constructor(filePath, { now = Date.now, retentionMs = 7 * 86400000, maxRecords = 100 } = {}) {
    if (typeof now !== "function" || !Number.isFinite(retentionMs) || retentionMs <= 0
      || !Number.isSafeInteger(maxRecords) || maxRecords < 1) {
      throw new Error("Invalid sample journal options");
    }
    this.#filePath = filePath;
    this.#now = now;
    this.#retentionMs = retentionMs;
    this.#maxRecords = maxRecords;
    try {
      const data = JSON.parse(readFileSync(filePath, "utf8"));
      if (!data || data.version !== 1 || !Array.isArray(data.records)
        || Object.keys(data).some(key => key !== "version" && key !== "records")) {
        throw new Error("Invalid journal format");
      }
      const ids = new Set();
      for (const record of data.records) {
        validateSample(record);
        if (Object.keys(record).some(key => !fields.has(key))
          || typeof record.id !== "string" || !record.id.trim() || ids.has(record.id)
          || !statuses.has(record.status) || !Number.isFinite(record.createdAt) || record.createdAt < 0) {
          throw new Error("Invalid sample record");
        }
        ids.add(record.id);
      }
      this.#records = this.#bounded(data.records);
    } catch (error) {
      if (error?.code !== "ENOENT") throw new Error(`Cannot read sample journal: ${error.message}`);
    }
  }

  #bounded(records) {
    const cutoff = this.#now() - this.#retentionMs;
    const retained = records.filter(record => record.createdAt >= cutoff);
    if (retained.length <= this.#maxRecords) return retained;
    const evictionOrder = [...retained].sort((a, b) =>
      Number(a.status === "pending") - Number(b.status === "pending") || a.createdAt - b.createdAt);
    const evicted = new Set(evictionOrder.slice(0, retained.length - this.#maxRecords).map(record => record.id));
    return retained.filter(record => !evicted.has(record.id));
  }

  #save(records) {
    mkdirSync(dirname(this.#filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.#filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      writeFileSync(temporaryPath, JSON.stringify({ version: 1, records }, null, 2), { mode: 0o600, flag: "wx" });
      renameSync(temporaryPath, this.#filePath);
    } catch (error) {
      try { unlinkSync(temporaryPath); } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") throw new AggregateError([error, cleanupError], "Cannot save sample journal");
      }
      throw error;
    }
    this.#records = records;
  }

  capture({ to, accountId, content, originKey }) {
    validateSample({ to, accountId, content, originKey });
    const records = this.#bounded(this.#records);
    const existing = records.find(record => record.to === to && record.accountId === accountId
      && (record.content === content || (originKey && record.originKey === originKey)));
    if (existing) return { ...existing };
    let id;
    do { id = randomBytes(8).toString("hex"); } while (records.some(record => record.id === id));
    const record = { id, to, accountId, content, status: "pending", createdAt: this.#now() };
    if (originKey !== undefined) record.originKey = originKey;
    this.#save(this.#bounded([...records, record]));
    return { ...record };
  }

  pending({ to, accountId = "", limit = 3 }) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Invalid sample limit");
    return this.#bounded(this.#records)
      .filter(record => record.status === "pending" && record.to === to && record.accountId === accountId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit).map(record => ({ ...record }));
  }

  get(id) {
    const record = this.#bounded(this.#records).find(record => record.id === id);
    return record ? { ...record } : undefined;
  }

  resolve(id, status) {
    if (status !== "learned" && status !== "dismissed") throw new Error("Invalid sample resolution");
    const records = this.#bounded(this.#records);
    const record = records.find(record => record.id === id);
    if (!record) return undefined;
    const resolved = { ...record, status };
    this.#save(records.map(record => record.id === id ? resolved : record));
    return { ...resolved };
  }
}
