import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';

const baseUrl = process.env.MODEL_SYNC_TEST_BASE_URL;
const key = process.env.MODEL_SYNC_TEST_KEY;
if (!baseUrl || !key) throw new Error('设置 MODEL_SYNC_TEST_BASE_URL 和 MODEL_SYNC_TEST_KEY 后再运行；密钥不会保存到项目。');
const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'openclaw-model-sync-live-'));
const path = join(temp, 'openclaw.json');
const env = { ...process.env, OPENCLAW_CONFIG_PATH: path, OPENCLAW_STATE_DIR: temp, NO_COLOR: '1' };
const staleId = 'model-sync-test-nonexistent-stale-entry';

async function cli(args) {
  const child = spawn(process.env.OPENCLAW_BIN || 'openclaw', args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', value => { stdout += value; });
  child.stderr.on('data', value => { stderr += value; });
  const timer = setTimeout(() => child.kill('SIGTERM'), 60000);
  try {
    const [code] = await once(child, 'exit');
    const redact = text => text.split(key).join('[REDACTED]');
    assert.equal(code, 0, redact(`Host command failed: ${stdout}\n${stderr}`));
    return stdout;
  } finally { clearTimeout(timer); }
}

try {
  await writeFile(path, JSON.stringify({
    models: { providers: { sub2api: { baseUrl, api: process.env.MODEL_SYNC_TEST_API || 'openai-completions', apiKey: '${MODEL_SYNC_TEST_KEY}', models: [{
      id: staleId, name: 'Temporary stale entry', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 4096,
    }] } } },
    plugins: { allow: ['openclaw-model-sync'], load: { paths: [root] }, entries: { 'openclaw-model-sync': { enabled: true, config: { timeoutMs: 30000 } } } },
  }, null, 2), { mode: 0o600 });
  await cli(['model-sync', 'sync', '--dry-run']);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).models.providers.sub2api.models[0].id, staleId);
  await cli(['model-sync', 'sync']);
  const config = JSON.parse(await readFile(path, 'utf8'));
  const models = config.models.providers.sub2api.models;
  assert.ok(models.length > 0);
  assert.ok(!models.some(model => model.id === staleId));
  assert.equal(config.models.providers.sub2api.apiKey, '${MODEL_SYNC_TEST_KEY}');
  assert.ok(config.agents.defaults.modelPolicy.allow.includes('sub2api/*'));
  console.log(JSON.stringify({ phase: 'sync', count: models.length, dryRun: 'passed', defaultPrune: 'passed', secretReference: 'preserved', modelPolicy: 'passed' }));
  const model = process.env.MODEL_SYNC_TEST_MODEL;
  if (model) {
    assert.ok(models.some(item => item.id === model), '测试模型必须存在于远端目录');
    const args = ['model-sync', 'probe', 'sub2api', model, '--apply'];
    if (process.env.MODEL_SYNC_TEST_FORMAT) args.push('--format', process.env.MODEL_SYNC_TEST_FORMAT);
    const output = await cli(args);
    // CLI output contains evidence and identifiers only, never raw completions.
    console.log(output.trim());
  }
  await cli(['config', 'validate']);
  console.log('Live-provider host config validation: OK');
} finally {
  await rm(temp, { recursive: true, force: true });
}
