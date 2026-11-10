import test from 'node:test';
import assert from 'node:assert/strict';
import { addPolicy, mergeModels, readSettings, sameConnection, validateProviderId, validateBaseUrl } from '../src/config.mjs';

const unknown = { supported: null, source: 'unknown', detail: 'No metadata' };
const makeConfig = () => ({
  models: { mode: 'merge', providers: {
    sub2api: { baseUrl: 'https://example.com/v1', api: 'openai-completions', apiKey: '${API_KEY}', models: [
      { id: 'current', name: 'Custom name', reasoning: true, input: ['text', 'image'], contextWindow: 10000, maxTokens: 1000, cost: { input: 3 }, compat: { supportsStore: false } },
      { id: 'gone', reasoning: false },
    ] },
  } },
  agents: { defaults: { model: { primary: 'elsewhere/keep' }, modelPolicy: { allow: ['elsewhere/*'] } }, entries: { personal: { modelPolicy: { allow: ['personal/*'] } } } },
  gateway: { port: 18789 },
});

test('defaults prune stale models and validate settings', () => {
  assert.equal(readSettings().prune, true);
  assert.deepEqual(readSettings({ providers: ['sub2api', 'sub2api'] }).providers, ['sub2api']);
  assert.throws(() => readSettings({ prune: 'false' }));
  assert.throws(() => readSettings({ timeoutMs: 0 }));
  assert.throws(() => readSettings({ defaultContextWindow: 1024, defaultMaxTokens: 4096 }));
  assert.throws(() => readSettings({ reasoningOverrides: { 'bad': true } }));
});

test('merge prunes by default, preserves manual metadata, references and unrelated config', () => {
  const draft = makeConfig();
  const original = structuredClone(draft);
  const report = mergeModels(draft, 'sub2api', [
    { id: 'current', name: 'Remote name', reasoning: unknown, contextWindow: 999999 },
    { id: 'new', reasoning: { supported: true, source: 'metadata', detail: 'reasoning: true' } },
  ], readSettings(), true);
  assert.deepEqual(report.removed, ['gone']);
  assert.deepEqual(report.added, ['new']);
  assert.deepEqual(draft.models.providers.sub2api.models[0], original.models.providers.sub2api.models[0]);
  assert.equal(draft.models.providers.sub2api.models[1].reasoning, true);
  assert.equal(draft.models.providers.sub2api.apiKey, '${API_KEY}');
  assert.deepEqual(draft.agents.defaults.modelPolicy.allow, ['elsewhere/*', 'sub2api/*']);
  assert.deepEqual(draft.agents.entries, original.agents.entries);
  assert.deepEqual(draft.agents.defaults.model, original.agents.defaults.model);
  assert.deepEqual(draft.gateway, original.gateway);
});

test('no-prune retains stale models and repeat sync is idempotent', () => {
  const draft = makeConfig();
  const discovered = [{ id: 'current', reasoning: unknown }];
  const first = mergeModels(draft, 'sub2api', discovered, readSettings(), false);
  assert.deepEqual(first.retained, ['gone']);
  assert.deepEqual(first.removed, []);
  const before = structuredClone(draft);
  const next = mergeModels(draft, 'sub2api', discovered, readSettings(), false);
  assert.deepEqual(draft, before);
  assert.equal(next.policyAdded, false);
  assert.deepEqual(next.updated, []);
});

test('explicit false and manual overrides remain meaningful', () => {
  const draft = makeConfig();
  mergeModels(draft, 'sub2api', [{ id: 'current', reasoning: { supported: false, source: 'metadata', detail: '' } }], readSettings(), false);
  assert.equal(draft.models.providers.sub2api.models[0].reasoning, false);
  mergeModels(draft, 'sub2api', [{ id: 'current', reasoning: { supported: false, source: 'metadata', detail: '' } }], readSettings({ reasoningOverrides: { 'sub2api/current': true } }), false);
  assert.equal(draft.models.providers.sub2api.models[0].reasoning, true);
});

test('empty or duplicate discovery never clears config', () => {
  for (const data of [[], [{ id: '', reasoning: unknown }], [{ id: 'a', reasoning: unknown }, { id: 'a', reasoning: unknown }]]) {
    const draft = makeConfig();
    const before = structuredClone(draft);
    assert.throws(() => mergeModels(draft, 'sub2api', data, readSettings(), true));
    assert.deepEqual(draft, before);
  }
});

test('new unknown models default to reasoning enabled while reporting uncertainty', () => {
  const draft = makeConfig();
  const report = mergeModels(draft, 'sub2api', [{ id: 'unknown/model', reasoning: unknown }], readSettings(), true);
  const model = draft.models.providers.sub2api.models[0];
  assert.equal(model.reasoning, true);
  assert.equal(model.contextWindow, 32768);
  assert.equal(model.maxTokens, 4096);
  assert.equal(report.reasoning['unknown/model'].supported, null);
  assert.equal(report.warnings.length, 1);
});

test('unknown capabilities enable reasoning for existing models unless explicitly overridden', () => {
  const draft = makeConfig();
  const discovered = [{ id: 'gone', reasoning: unknown }];
  const first = mergeModels(draft, 'sub2api', discovered, readSettings(), false);
  assert.equal(draft.models.providers.sub2api.models.find(model => model.id === 'gone').reasoning, true);
  assert.deepEqual(first.updated, ['gone']);
  assert.equal(first.reasoning.gone.supported, null);

  const second = mergeModels(draft, 'sub2api', discovered, readSettings({ reasoningOverrides: { 'sub2api/gone': false } }), false);
  assert.equal(draft.models.providers.sub2api.models.find(model => model.id === 'gone').reasoning, false);
  assert.equal(second.reasoning.gone.source, 'override');
});

test('policy only adds exact provider wildcard and never overwrites other entries', () => {
  const draft = { agents: { defaults: { modelPolicy: { allow: ['sub2api/exact', 'kiro/*'] } } } };
  assert.equal(addPolicy(draft, 'sub2api'), true);
  assert.equal(addPolicy(draft, 'sub2api'), false);
  assert.deepEqual(draft.agents.defaults.modelPolicy.allow, ['sub2api/exact', 'kiro/*', 'sub2api/*']);
});

test('provider ids and URLs reject prototype keys and credential URLs', () => {
  for (const id of ['__proto__', 'constructor', 'prototype', 'a/b', 'a.b', 'A', '']) assert.throws(() => validateProviderId(id));
  assert.equal(validateProviderId('sub2api-cpa'), 'sub2api-cpa');
  for (const url of ['file:///tmp/a', 'https://a:b@example.com', 'https://example.com?key=secret', 'http://localhost/#x']) assert.throws(() => validateBaseUrl(url));
  assert.equal(validateBaseUrl('http://localhost:1234/v1/'), 'http://localhost:1234/v1');
});

test('transaction connection check resolves env refs but detects endpoint changes', () => {
  const a = { baseUrl: 'http://localhost/v1', apiKey: '${KEY}', headers: { 'x-key': { source: 'env', provider: 'default', id: 'KEY' } } };
  const b = { baseUrl: 'http://localhost/v1', apiKey: 'secret', headers: { 'x-key': 'secret' } };
  assert.equal(sameConnection(a, b, { KEY: 'secret' }), true);
  assert.equal(sameConnection(a, { ...b, baseUrl: 'http://different/v1' }, { KEY: 'secret' }), false);
});
