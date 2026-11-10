import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Real host loader, isolated configuration. No Telegram messages are sent.
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = process.argv.includes("--legacy-root") ? resolve(pluginRoot, "../..") : pluginRoot;
const previewMode = process.argv.includes("--preview");
const state = mkdtempSync(join(tmpdir(), "telegram-auto-poll-host-"));
try {
  const configPath = join(state, "openclaw.json");
  writeFileSync(configPath, JSON.stringify({ plugins: {
    allow: ["telegram-auto-poll"], load: { paths: [root] },
    entries: { "telegram-auto-poll": {
      enabled: true, hooks: { allowConversationAccess: true, allowPromptInjection: true },
      config: { statePath: join(state, "poll-state.json"), ...(previewMode ? { previewMode: true, previewSafeChats: [{ chatId: "123", accountId: "default" }] } : {}) },
    } },
  } }), { mode: 0o600 });
  const output = execFileSync("openclaw", ["plugins", "inspect", "telegram-auto-poll", "--runtime", "--json"], {
    env: { ...process.env, OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: configPath },
    encoding: "utf8", timeout: 45000, stdio: ["ignore", "pipe", "pipe"],
  });
  const result = JSON.parse(output);
  assert.equal(result.plugin.status, "loaded");
  assert.deepEqual(result.typedHooks.map(hook => hook.name).sort(), previewMode
    ? ["before_prompt_build", "message_sent"] : ["before_prompt_build", "message_sending", "message_sent"]);
  assert.equal(result.diagnostics.filter(item => item.level === "error" || item.severity === "error").length, 0);
  console.log(JSON.stringify({ status: result.plugin.status, version: result.plugin.version,
    hooks: result.typedHooks.map(hook => hook.name), diagnostics: result.diagnostics }));
} finally { rmSync(state, { recursive: true, force: true }); }
