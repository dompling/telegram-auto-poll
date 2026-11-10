import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

// This smoke test owns its temporary config/state and only talks to loopback.
const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'openclaw-model-sync-'));
const path = join(temp, 'openclaw.json');
let requests = 0;
const server = createServer((req, res) => {
  requests++;
  res.setHeader('content-type', 'application/json');
  if (req.headers.authorization !== 'Bearer local-test-only') { res.writeHead(401).end('{}'); return; }
  if (req.url === '/v1/models') {
    res.end(JSON.stringify({ data: [{ id: 'fresh', supports_reasoning: true, supports_images: true, max_input_tokens: 128000, max_output_tokens: 16000 }, { id: 'unknown' }] }));
  } else if (req.url === '/v1/chat/completions') {
    req.resume();
    res.end(JSON.stringify({ choices: [{ message: { content: '638' } }], usage: { completion_tokens_details: { reasoning_tokens: 12 } } }));
  } else { res.writeHead(404).end('{}'); }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const env = { ...process.env, OPENCLAW_CONFIG_PATH: path, OPENCLAW_STATE_DIR: temp, MODEL_SYNC_TEST_KEY: 'local-test-only', NO_COLOR: '1' };

async function cli(args) {
  const child = spawn(process.env.OPENCLAW_BIN || 'openclaw', args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const timeout = setTimeout(() => child.kill('SIGTERM'), 60000);
  try {
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, `openclaw ${args.join(' ')}\n${output}`);
    return output;
  } finally { clearTimeout(timeout); }
}

try {
  await writeFile(path, JSON.stringify({
    plugins: { allow: ['openclaw-model-sync'], load: { paths: [root] }, entries: { 'openclaw-model-sync': { enabled: true } } },
  }, null, 2), { mode: 0o600 });
  assert.match(await cli(['model-sync', '--help']), /probe/);
  console.log('Host plugin discovery and CLI registration: OK');
  await cli(['model-sync', 'add', 'sub2api', '--base-url', baseUrl, '--api-key-env', 'MODEL_SYNC_TEST_KEY']);
  let config = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(config.models.providers.sub2api.apiKey, '${MODEL_SYNC_TEST_KEY}');
  assert.deepEqual(config.agents.defaults.modelPolicy.allow, ['sub2api/*']);
  config.models.providers.sub2api.models = [{ id: 'stale', name: 'Stale', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 4096 }];
  await writeFile(path, JSON.stringify(config, null, 2), { mode: 0o600 });
  console.log('Host transactional provider add and secret preservation: OK');
  await cli(['model-sync', 'sync', '--dry-run']);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).models.providers.sub2api.models[0].id, 'stale');
  await cli(['model-sync', 'sync', '--no-prune']);
  assert.ok(JSON.parse(await readFile(path, 'utf8')).models.providers.sub2api.models.some(model => model.id === 'stale'));
  await cli(['model-sync', 'sync']);
  config = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(config.models.providers.sub2api.models.map(model => model.id), ['fresh', 'unknown']);
  assert.equal(config.models.providers.sub2api.models[0].reasoning, true);
  assert.equal(config.models.providers.sub2api.models[1].reasoning, true);
  assert.deepEqual(config.models.providers.sub2api.models[0].input, ['text', 'image']);
  assert.equal(config.models.providers.sub2api.models[0].contextWindow, 128000);
  assert.equal(config.models.providers.sub2api.models[0].maxTokens, 16000);
  assert.equal(config.models.providers.sub2api.apiKey, '${MODEL_SYNC_TEST_KEY}');
  console.log('Host dry run, --no-prune, default prune and model serialization: OK');
  config.models.providers.sub2api.models.find(model => model.id === 'unknown').reasoning = false;
  await writeFile(path, JSON.stringify(config, null, 2), { mode: 0o600 });
  await cli(['model-sync', 'probe', 'sub2api', 'unknown', '--apply']);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).models.providers.sub2api.models.find(model => model.id === 'unknown').reasoning, true);
  console.log('Host explicit reasoning probe and apply: OK');
  await cli(['config', 'validate']);
  assert.equal(requests, 4);
  console.log('Host final config validation: OK');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
