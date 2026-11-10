import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function findRepository(start) {
  let current = start;
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    if (current === parse(current).root) return undefined;
    current = dirname(current);
  }
}

const repo = findRepository(dirname(fileURLToPath(import.meta.url)));
const groupedPlugins = repo && existsSync(join(repo, "plugins/openclaw-model-sync/openclaw.plugin.json"));

test("legacy root entry loads the grouped poll plugin with the same manifest", { skip: !groupedPlugins }, async () => {
  const plugin = join(repo, "plugins/telegram-auto-poll");
  const childManifest = join(plugin, "openclaw.plugin.json");
  assert.ok(existsSync(childManifest), "the poll plugin must have its own manifest");
  assert.deepEqual(
    JSON.parse(readFileSync(join(repo, "openclaw.plugin.json"), "utf8")),
    JSON.parse(readFileSync(childManifest, "utf8")),
  );
  const rootPackage = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  const childPackage = JSON.parse(readFileSync(join(plugin, "package.json"), "utf8"));
  assert.equal(rootPackage.name, childPackage.name);
  assert.equal(rootPackage.version, childPackage.version);
  const rootEntry = await import(pathToFileURL(join(repo, "index.mjs")));
  const childEntry = await import(pathToFileURL(join(plugin, "index.mjs")));
  assert.equal(rootEntry.default, childEntry.default);
  assert.equal(rootEntry.createPlugin, childEntry.createPlugin);
});
