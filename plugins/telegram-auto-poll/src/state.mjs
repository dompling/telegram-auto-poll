import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

// Durable, local, single-Gateway journal. The command send is never retried
// automatically after an attempt may have reached Telegram.
export class PollJournal {
  constructor(filePath, { now = () => Date.now(), retentionMs = 7 * 86400000 } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.retentionMs = retentionMs;
    this.records = [];
    try {
      const data = JSON.parse(readFileSync(filePath, "utf8"));
      if (!Array.isArray(data.records)) throw new Error("invalid records");
      this.records = data.records.filter(r => r && typeof r === "object" && typeof r.token === "string");
    } catch (error) {
      if (error?.code !== "ENOENT") throw new Error(`Cannot read poll journal: ${error.message}`);
    }
    this.prune();
  }

  prune() {
    const cutoff = this.now() - this.retentionMs;
    this.records = this.records.filter(r => Number.isFinite(r.createdAt) && r.createdAt >= cutoff);
  }

  save() {
    this.prune();
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ version: 1, records: this.records }, null, 2), { mode: 0o600, flag: "wx" });
      renameSync(tmp, this.filePath);
    } finally {
      try { unlinkSync(tmp); } catch (e) { if (e?.code !== "ENOENT") throw e; }
    }
  }

  getByToken(token) { return this.records.find(r => r.token === token); }
  getByOrigin(originKey) { return originKey ? this.records.find(r => r.originKey === originKey) : undefined; }

  countRecent(to, accountId, sinceMs) {
    return this.records.filter(r => r.to === to && r.accountId === accountId && r.createdAt >= sinceMs && r.status !== "anchor_failed").length;
  }

  create(fields) {
    let token;
    do { token = randomBytes(8).toString("hex"); } while (this.getByToken(token));
    const record = { ...fields, token, createdAt: this.now(), status: "pending" };
    this.records.push(record);
    try { this.save(); } catch (e) { this.records = this.records.filter(r => r !== record); throw e; }
    return record;
  }

  setStatus(token, status) {
    const r = this.getByToken(token);
    if (!r) return;
    const previous = r.status;
    r.status = status;
    r.updatedAt = this.now();
    try { this.save(); } catch (e) { r.status = previous; throw e; }
    return r;
  }
}
