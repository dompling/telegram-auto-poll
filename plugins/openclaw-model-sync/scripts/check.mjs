import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../src/config.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
for (const directory of ['', 'src', 'scripts', 'test']) {
  for (const name of await readdir(join(root, directory))) {
    if (!name.endsWith('.mjs')) continue;
    const file = join(root, directory, name);
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const source = await readFile(file, 'utf8');
    assert.ok(!/[ \t]+$/m.test(source), `Trailing whitespace: ${file}`);
    assert.ok(!/^([<=>])\1{6}/m.test(source), `Conflict marker: ${file}`);
  }
}
const manifest = JSON.parse(await readFile(join(root, 'openclaw.plugin.json'), 'utf8'));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
assert.equal(manifest.id, pkg.name);
assert.equal(manifest.version, pkg.version);
for (const [name, value] of Object.entries(DEFAULT_SETTINGS)) assert.deepEqual(manifest.configSchema.properties[name].default, value, `Manifest default: ${name}`);
assert.deepEqual(pkg.openclaw.extensions, ['./index.mjs']);
console.log('Syntax, source hygiene, plugin metadata and config defaults: OK');
