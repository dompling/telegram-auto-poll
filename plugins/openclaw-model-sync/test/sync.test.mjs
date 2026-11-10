import test from 'node:test';
import assert from 'node:assert/strict';
import { createSynchronizer } from '../src/sync.mjs';
import { discoverModels } from '../src/transport.mjs';

const provider = () => ({ baseUrl: 'https://example.com/v1', api: 'openai-completions', apiKey: '${KEY}', models: [{ id: 'old', name: 'Old', reasoning: true }] });
const discovered = [{ id: 'fresh', reasoning: { supported: true, source: 'metadata', detail: 'supported' } }];
function fixture(initial = { models: { providers: { sub2api: provider() } } }) {
  let state = structuredClone(initial);
  let writes = 0;
  const runtime = {
    current: () => structuredClone(state),
    async mutateConfigFile({ mutate, afterWrite }) {
      assert.deepEqual(afterWrite, { mode: 'auto' });
      const draft = structuredClone(state);
      const result = mutate(draft);
      state = draft;
      writes++;
      return { result, followUp: { mode: 'auto', requiresRestart: false } };
    },
  };
  return { runtime, state: () => state, writes: () => writes, edit: change => change(state) };
}
const discovery = async () => ({ models: discovered, warnings: [] });

test('default discovery follows current provider additions, removals and connection settings', async () => {
  const f = fixture();
  const connections = [];
  const sync = createSynchronizer({ config: f.runtime, discover: async connection => {
    connections.push(structuredClone(connection));
    return discovery();
  } });
  assert.deepEqual(sync.list().providers.map(item => item.id), ['sub2api']);
  await sync.sync({ dryRun: true });
  assert.deepEqual(connections.splice(0), [f.state().models.providers.sub2api]);

  f.edit(state => {
    state.models.providers.kiro = { ...provider(), baseUrl: 'https://kiro.example/v1', api: 'openai-responses', apiKey: '${KIRO_KEY}', headers: { 'x-account': '${ACCOUNT}' } };
  });
  assert.deepEqual(sync.list().providers.map(item => item.id), ['sub2api', 'kiro']);
  const added = await sync.sync({ dryRun: true });
  assert.deepEqual(added.providers.map(item => item.provider), ['sub2api', 'kiro']);
  assert.deepEqual(connections.splice(0), Object.values(f.state().models.providers));

  f.edit(state => {
    delete state.models.providers.sub2api;
    state.models.providers.kiro.apiKey = '${UPDATED_KEY}';
  });
  assert.deepEqual(sync.list().providers.map(item => item.id), ['kiro']);
  const removed = await sync.sync({ dryRun: true });
  assert.deepEqual(removed.providers.map(item => item.provider), ['kiro']);
  assert.deepEqual(removed.errors, []);
  assert.deepEqual(connections, [f.state().models.providers.kiro]);
  assert.equal(f.writes(), 0);
});

test('legacy plugin provider lists do not restrict discovery from OpenClaw config', async () => {
  const f = fixture({ models: { providers: { sub2api: provider(), kiro: provider() } } });
  const sync = createSynchronizer({ config: f.runtime, settings: { providers: ['sub2api', 'removed'] }, discover: discovery });
  assert.deepEqual(sync.list().providers.map(item => [item.id, item.selected]), [['sub2api', true], ['kiro', true]]);
  const result = await sync.sync();
  assert.deepEqual(result.providers.map(item => item.provider), ['sub2api', 'kiro']);
  assert.deepEqual(result.errors, []);
});

test('empty host provider config directs setup to models.providers without making requests', async () => {
  const f = fixture({});
  const sync = createSynchronizer({ config: f.runtime, discover: async () => { throw new Error('must not request'); } });
  assert.deepEqual(sync.list().providers, []);
  await assert.rejects(sync.sync(), /models\.providers/);
  assert.equal(f.writes(), 0);
});

test('Sub2API catalog capabilities update existing reasoning without generation calls', async () => {
  const f = fixture({
    models: { providers: { sub2api: { ...provider(), models: [{ id: 'old', reasoning: false }] } } },
    agents: { defaults: { modelPolicy: { allow: ['sub2api/*'] } } },
  });
  let requests = 0;
  const sync = createSynchronizer({
    config: f.runtime,
    discover: (connection, options) => discoverModels(connection, { ...options, env: { KEY: 'test' }, fetchImpl: async (_url, init) => {
      assert.equal(init.method, 'GET');
      requests++;
      return Response.json({ data: [{ id: 'old', supports_reasoning: true }] });
    } }),
    probe: async () => { throw new Error('sync must not generate completions'); },
  });
  const result = await sync.sync();
  assert.equal(f.state().models.providers.sub2api.models[0].reasoning, true);
  assert.equal(result.providers[0].reasoning.old.source, 'metadata');
  assert.deepEqual(result.providers[0].warnings, []);
  assert.equal(requests, 1);
});

test('missing catalog capabilities produce only one warning after overrides', async () => {
  for (const override of [false, true]) {
    const f = fixture({ models: { providers: { sub2api: provider() } }, agents: { defaults: { modelPolicy: { allow: ['sub2api/*'] } } } });
    const sync = createSynchronizer({
      config: f.runtime,
      settings: override ? { reasoningOverrides: { 'sub2api/old': true } } : {},
      discover: (connection, options) => discoverModels(connection, { ...options, env: { KEY: 'test' }, fetchImpl: async () => Response.json({ data: [{ id: 'old' }] }) }),
    });
    const result = await sync.sync();
    assert.equal(result.providers[0].warnings.length, override ? 0 : 1);
    if (!override) assert.match(result.providers[0].warnings[0], /不代表已确认支持/);
    assert.equal(f.state().models.providers.sub2api.models[0].reasoning, true);
  }
});

test('successful sync defaults to pruning and writes provider policy transactionally', async () => {
  const f = fixture();
  const sync = createSynchronizer({ config: f.runtime, discover: discovery });
  const result = await sync.sync();
  assert.equal(result.prune, true);
  assert.deepEqual(result.providers[0].removed, ['old']);
  assert.deepEqual(f.state().models.providers.sub2api.models.map(m => m.id), ['fresh']);
  assert.deepEqual(f.state().agents.defaults.modelPolicy.allow, ['sub2api/*']);
  assert.equal(f.state().models.providers.sub2api.apiKey, '${KEY}');
  assert.equal(result.followUp.requiresRestart, false);
  assert.equal(f.writes(), 1);
  await sync.sync();
  assert.equal(f.writes(), 1, 'idempotent sync does not rewrite config');
});

test('dry run shows removals but never writes', async () => {
  const f = fixture();
  const before = structuredClone(f.state());
  const result = await createSynchronizer({ config: f.runtime, discover: discovery }).sync({ dryRun: true });
  assert.deepEqual(result.providers[0].removed, ['old']);
  assert.deepEqual(f.state(), before);
  assert.equal(f.writes(), 0);
});

test('no-prune and configured prune=false retain stale models', async () => {
  for (const settings of [{}, { prune: false }]) {
    const f = fixture();
    const sync = createSynchronizer({ config: f.runtime, settings, discover: discovery });
    await sync.sync(settings.prune === false ? {} : { prune: false });
    assert.deepEqual(f.state().models.providers.sub2api.models.map(m => m.id), ['fresh', 'old']);
  }
});

test('one failed provider stays intact while a successful provider syncs', async () => {
  const f = fixture({ models: { providers: { sub2api: provider(), kiro: { ...provider(), baseUrl: 'https://kiro.example/v1' } } } });
  const before = structuredClone(f.state().models.providers.kiro);
  const sync = createSynchronizer({ config: f.runtime, discover: async p => {
    if (p.baseUrl.includes('kiro')) throw new Error('HTTP 401');
    return discovery();
  } });
  const result = await sync.sync();
  assert.deepEqual(result.errors, [{ provider: 'kiro', message: 'HTTP 401' }]);
  assert.deepEqual(f.state().models.providers.kiro, before);
  assert.deepEqual(f.state().agents.defaults.modelPolicy.allow, ['sub2api/*', 'kiro/*']);
});

test('empty result and total failure do not write or prune', async () => {
  for (const discover of [async () => ({ models: [], warnings: [] }), async () => { throw new Error('timeout'); }]) {
    const f = fixture();
    const before = structuredClone(f.state());
    const result = await createSynchronizer({ config: f.runtime, discover }).sync();
    assert.equal(result.errors.length, 1);
    assert.equal(f.writes(), 0);
    assert.deepEqual(f.state(), before);
  }
});

test('provider targeting does not prune unrelated catalogs', async () => {
  const f = fixture({ models: { providers: { sub2api: provider(), kiro: provider() } } });
  await createSynchronizer({ config: f.runtime, settings: { providers: ['sub2api'] }, discover: discovery }).sync({ providers: ['kiro'] });
  assert.equal(f.state().models.providers.sub2api.models[0].id, 'old');
  assert.equal(f.state().models.providers.kiro.models[0].id, 'fresh');
});

test('connection edits during discovery are detected and never overwritten', async () => {
  const f = fixture();
  const sync = createSynchronizer({ config: f.runtime, discover: async () => {
    f.edit(state => { state.models.providers.sub2api.baseUrl = 'https://changed.example/v1'; });
    return discovery();
  } });
  const result = await sync.sync();
  assert.match(result.errors[0].message, /已改变/);
  assert.equal(f.state().models.providers.sub2api.models[0].id, 'old');
  assert.equal(f.state().models.providers.sub2api.baseUrl, 'https://changed.example/v1');
});

test('concurrent unrelated config changes survive transaction', async () => {
  const f = fixture();
  await createSynchronizer({ config: f.runtime, discover: async () => {
    f.edit(state => { state.gateway = { port: 22222 }; });
    return discovery();
  } }).sync();
  assert.equal(f.state().gateway.port, 22222);
});

test('add stores env references, adds policy, rejects duplicate and allows explicit replacement', async () => {
  const f = fixture({});
  const sync = createSynchronizer({ config: f.runtime });
  await sync.add({ id: 'sub2api-cpa', baseUrl: 'https://example.com/v1/', apiKeyEnv: 'CPA_KEY' });
  const p = f.state().models.providers['sub2api-cpa'];
  assert.equal(p.apiKey, '${CPA_KEY}');
  assert.deepEqual(p.models, []);
  assert.deepEqual(f.state().agents.defaults.modelPolicy.allow, ['sub2api-cpa/*']);
  await assert.rejects(sync.add({ id: 'sub2api-cpa', baseUrl: 'https://new.example/v1' }), /已存在/);
  await sync.add({ id: 'sub2api-cpa', baseUrl: 'https://new.example/v1', replace: true });
  assert.equal(f.state().models.providers['sub2api-cpa'].apiKey, '${CPA_KEY}');
});

test('add preview never changes config; list exposes neither keys nor credential URLs', async () => {
  const f = fixture();
  const sync = createSynchronizer({ config: f.runtime });
  await sync.add({ id: 'litellm', baseUrl: 'https://example.com/v1', dryRun: true });
  assert.equal(f.writes(), 0);
  assert.equal(f.state().models.providers.litellm, undefined);
  assert.ok(!JSON.stringify(sync.list()).includes('KEY'));
  assert.ok(!JSON.stringify(sync.list()).includes('https://'));
});

test('replace without api preserves the existing protocol', async () => {
  for (const api of ['anthropic-messages', 'openai-responses']) {
    const f = fixture({ models: { providers: { sub2api: { ...provider(), api } } } });
    await createSynchronizer({ config: f.runtime }).add({ id: 'sub2api', baseUrl: 'https://new.example/v1', replace: true });
    assert.equal(f.state().models.providers.sub2api.api, api);
  }
});

test('creating a policy keeps failed providers and existing built-in primary/fallback references allowed', async () => {
  const f = fixture({
    models: { providers: { sub2api: provider(), kiro: { ...provider(), baseUrl: 'https://kiro.example/v1' } } },
    agents: { defaults: { model: { primary: 'kiro/old', fallbacks: ['openai/gpt-5'] } } },
  });
  await createSynchronizer({ config: f.runtime, discover: async p => {
    if (p.baseUrl.includes('kiro')) throw new Error('HTTP 401');
    return discovery();
  } }).sync();
  assert.deepEqual(f.state().agents.defaults.modelPolicy.allow, ['sub2api/*', 'kiro/*', 'kiro/old', 'openai/gpt-5']);
});

test('probe applies only conclusive results and otherwise preserves reasoning', async () => {
  for (const supported of [null, true, false]) {
    const f = fixture();
    const sync = createSynchronizer({ config: f.runtime, probe: async () => ({ supported, source: 'probe', detail: 'evidence' }) });
    const result = await sync.probe({ provider: 'sub2api', model: 'old', apply: true });
    assert.equal(result.applied, supported !== null);
    assert.equal(f.writes(), supported === null ? 0 : 1);
    assert.equal(f.state().models.providers.sub2api.models[0].reasoning, supported ?? true);
  }
});

test('probe without apply is diagnostic and explicit override conflicts are rejected', async () => {
  const f = fixture();
  const sync = createSynchronizer({ config: f.runtime, settings: { reasoningOverrides: { 'sub2api/old': false } }, probe: async () => ({ supported: true, source: 'probe', detail: '' }) });
  await sync.probe({ provider: 'sub2api', model: 'old' });
  assert.equal(f.writes(), 0);
  await assert.rejects(sync.probe({ provider: 'sub2api', model: 'old', apply: true }), /覆盖/);
  assert.equal(f.writes(), 0);
});
