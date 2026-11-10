import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { discoverModels, probeReasoning } from '../src/transport.mjs';

const connection = { baseUrl: 'https://provider.invalid/v1', api: 'openai-completions' };
const jsonFetch = (data, status = 200) => async () => Response.json(data, { status });

test('catalog uses explicit metadata and never infers reasoning from a model name', async () => {
  const { models, warnings } = await discoverModels(connection, {
    fetchImpl: jsonFetch({ data: [
      { id: 'gpt-5-thinking', name: 'Unknown model' },
      { id: 'explicit', reasoning: true, context_length: 128000, top_provider: { max_completion_tokens: 8192 }, architecture: { input_modalities: ['text', 'image', 'text'] } },
      { id: 'no', reasoning: false, supported_parameters: ['reasoning'] },
      { id: 'router', supported_parameters: ['reasoning_effort'] },
      { id: 'adaptive', capabilities: { thinking: { supported: true, types: { enabled: { supported: false }, adaptive: { supported: true } } } } },
      { id: 'disabled', capabilities: { thinking: { supported: false, types: { disabled: { supported: true } } } }, supported_parameters: ['thinking'] },
    ] }),
  });
  assert.deepEqual(models.map((model) => model.reasoning.supported), [null, true, false, true, true, false]);
  assert.equal(models[1].contextWindow, 128000);
  assert.equal(models[1].maxTokens, 8192);
  assert.deepEqual(models[1].input, ['text', 'image']);
  assert.deepEqual(warnings, [], 'discovery leaves user-facing capability warnings to config merging');
});

test('Sub2API metadata preserves explicit reasoning support and known model limits', async () => {
  const { models } = await discoverModels(connection, {
    fetchImpl: jsonFetch({ data: [
      { id: 'reasoning-alias', type: 'model', display_name: 'Reasoning Alias', supports_reasoning: true, supports_images: true, max_input_tokens: 128000, max_output_tokens: 16000 },
      { id: 'plain', supports_reasoning: false, supports_images: false, supported_parameters: ['thinking'] },
      { id: 'grok', supportsReasoningEffort: true },
      { id: 'fixed-effort', supportsReasoningEffort: false },
      { id: 'missing', reasoning: { default_effort: 'high' } },
      { id: 'invalid', supports_reasoning: 'true', supports_images: 'false' },
    ] }),
  });
  assert.deepEqual(models.map(model => model.reasoning.supported), [true, false, true, null, null, null]);
  assert.equal(models[0].reasoning.detail, 'Catalog supports_reasoning is true.');
  assert.equal(models[0].name, 'Reasoning Alias');
  assert.equal(models[0].contextWindow, 128000);
  assert.equal(models[0].maxTokens, 16000);
  assert.deepEqual(models[0].input, ['text', 'image']);
  assert.deepEqual(models[1].input, ['text']);
  assert.equal(models[5].input, undefined);
});

test('explicit input modalities take precedence over provider image hints', async () => {
  const { models } = await discoverModels(connection, {
    fetchImpl: jsonFetch({ data: [{ id: 'explicit-input', supports_reasoning: true, supports_images: true, input_modalities: ['text'] }] }),
  });
  assert.deepEqual(models[0].input, ['text']);
});

test('Anthropic resolves env credentials and paginates using its own URL', async () => {
  const calls = [];
  const provider = {
    baseUrl: 'https://anthropic.invalid',
    api: 'anthropic-messages',
    apiKey: { source: 'env', provider: 'default', id: 'ANTHROPIC_KEY' },
    headers: { 'X-Route': '${ROUTE_NAME}' },
  };
  const { models } = await discoverModels(provider, {
    env: { ANTHROPIC_KEY: 'private-key', ROUTE_NAME: 'private-route' },
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      calls.push(url);
      const headers = new Headers(init.headers);
      assert.equal(headers.get('x-api-key'), 'private-key');
      assert.equal(headers.get('authorization'), null);
      assert.equal(headers.get('anthropic-version'), '2023-06-01');
      assert.equal(headers.get('x-route'), 'private-route');
      assert.equal(init.redirect, 'error');
      return calls.length === 1
        ? Response.json({ data: [{ id: 'first', display_name: 'First', capabilities: null }], has_more: true, last_id: 'first' })
        : Response.json({ data: [{ id: 'second', max_input_tokens: 200000, max_tokens: 64000 }], has_more: false });
    },
  });
  assert.equal(calls[0].pathname, '/v1/models');
  assert.equal(calls[0].searchParams.get('limit'), '1000');
  assert.equal(calls[1].searchParams.get('after_id'), 'first');
  assert.equal(models.length, 2);
  assert.equal(models[1].contextWindow, 200000);
});

test('Bearer auth and custom env headers are supported without mutating provider config', async () => {
  const provider = {
    ...connection,
    apiKey: '${TOKEN}',
    headers: { 'x-team': { source: 'env', id: 'TEAM' } },
  };
  const original = structuredClone(provider);
  await discoverModels(provider, {
    env: { TOKEN: 'secret', TEAM: 'test-team' },
    fetchImpl: async (_url, init) => {
      const headers = new Headers(init.headers);
      assert.equal(headers.get('authorization'), 'Bearer secret');
      assert.equal(headers.get('x-team'), 'test-team');
      return Response.json({ data: [] });
    },
  });
  assert.deepEqual(provider, original);
  await discoverModels({ ...provider, api: 'anthropic-messages', authHeader: true }, {
    env: { TOKEN: 'secret', TEAM: 'test-team' },
    fetchImpl: async (_url, init) => {
      const headers = new Headers(init.headers);
      assert.equal(headers.get('authorization'), 'Bearer secret');
      assert.equal(headers.get('x-api-key'), null);
      return Response.json({ data: [] });
    },
  });
});

test('unsupported or missing credentials fail before any network request', async () => {
  let requested = false;
  const fetchImpl = async () => { requested = true; return Response.json({ data: [] }); };
  for (const apiKey of ['${MISSING}', { source: 'exec', id: 'dangerous' }, { source: 'file', id: '/secret' }, { source: 'env', id: 'MISSING' }, '']) {
    await assert.rejects(discoverModels({ ...connection, apiKey }, { env: {}, fetchImpl }), /credential|apiKey|SecretRef/i);
  }
  assert.equal(requested, false);
});

test('invalid URLs and transport headers are rejected without leaking URL contents', async () => {
  for (const baseUrl of ['ftp://provider.invalid', 'https://user:password@provider.invalid', 'https://provider.invalid?key=secret', 'https://provider.invalid/#secret', 'not-a-url']) {
    await assert.rejects(discoverModels({ ...connection, baseUrl }), (error) => {
      assert.match(error.message, /baseUrl/);
      assert.doesNotMatch(error.message, /password|secret|not-a-url/);
      return true;
    });
  }
  await assert.rejects(discoverModels({ ...connection, headers: { host: 'another-host.invalid' } }), /transport header/);
  await assert.rejects(discoverModels({ ...connection, api: 'ollama' }), /Unsupported provider API/);
});

test('malformed, duplicate, and incomplete catalogs fail as a whole', async () => {
  for (const data of [
    {}, { data: [{ name: 'missing-id' }] }, { data: [{ id: 'ok' }, { id: 'bad id' }] },
    { data: [{ id: '__proto__' }] }, { data: [{ id: 'same' }, { id: 'same' }] },
    { data: [{ id: 'ok' }], has_more: true, last_id: 'ok' },
    { data: [{ id: 'ok' }], has_more: 'true' },
    { data: [{ id: 'ok' }], next_page_token: 'unhandled-next-page' },
  ]) {
    await assert.rejects(discoverModels(connection, { fetchImpl: jsonFetch(data) }), /catalog|model array|model id/);
  }
  await assert.rejects(discoverModels({ ...connection, api: 'anthropic-messages' }, {
    fetchImpl: jsonFetch({ data: [{ id: 'ok' }], has_more: true }),
  }), /pagination cursor/);
  await assert.rejects(discoverModels(connection, {
    fetchImpl: async () => new Response('<html>secret</html>'),
  }), /invalid JSON/);
});

test('HTTP and native network errors never contain response body, headers, or credentials', async () => {
  const provider = { ...connection, apiKey: 'do-not-print-me' };
  await assert.rejects(discoverModels(provider, {
    fetchImpl: jsonFetch({ error: { message: 'do-not-print-me echoed by upstream' } }, 401),
  }), { message: 'Model catalog request failed with HTTP 401.' });
  await assert.rejects(discoverModels(provider, {
    fetchImpl: async () => { throw new Error('do-not-print-me caused network failure'); },
  }), { message: 'Provider request failed (network, TLS, or blocked redirect).' });
});

test('response size limits apply even if content-length is missing', async () => {
  await assert.rejects(discoverModels(connection, {
    fetchImpl: async () => new Response(' '.repeat(4 * 1024 * 1024 + 1)),
  }), /4 MiB/);
  await assert.rejects(discoverModels(connection, {
    fetchImpl: async () => new Response('{}', { headers: { 'content-length': '99999999' } }),
  }), /4 MiB/);
});

test('timeout covers a response body that never finishes', async () => {
  let cancelled = false;
  const started = Date.now();
  await assert.rejects(discoverModels(connection, {
    timeoutMs: 25,
    fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })),
  }), /timed out/);
  assert.equal(cancelled, true);
  assert.ok(Date.now() - started < 1500);
});

test('real HTTP redirects are not followed with credentials', async (t) => {
  let redirectedCalls = 0;
  const server = createServer((request, response) => {
    if (request.url === '/v1/models') {
      response.writeHead(302, { location: '/capture-secret' });
      response.end();
    } else {
      redirectedCalls += 1;
      response.end('{"data":[]}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await assert.rejects(discoverModels({ ...connection, baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'secret' }), /blocked redirect/);
  assert.equal(redirectedCalls, 0);
});

test('successful probes require positive structural evidence, not HTTP 200 or plain text', async () => {
  for (const data of [
    { choices: [{ message: { content: '<think>I can think</think>' } }] },
    { reasoning_effort: 'low', usage: { completion_tokens_details: { reasoning_tokens: 0 } } },
    { content: [{ type: 'text', text: 'Thinking is supported.' }] },
  ]) {
    const result = await probeReasoning(connection, 'model', { fetchImpl: jsonFetch(data) });
    assert.equal(result.supported, null);
  }
  for (const data of [
    { choices: [{ message: { reasoning_content: 'working' } }] },
    { usage: { completion_tokens_details: { reasoning_tokens: 1 } } },
    { output: [{ type: 'reasoning', summary: [] }] },
    { usage: { output_tokens_details: { reasoning_tokens: 50 } } },
    { usage: { output_tokens_details: { thinking_tokens: 50 } } },
    { content: [{ type: 'thinking', thinking: '', signature: 'signed' }] },
    { content: [{ type: 'redacted_thinking', data: 'encrypted' }] },
  ]) {
    const result = await probeReasoning(connection, 'model', { fetchImpl: jsonFetch(data) });
    assert.equal(result.supported, true);
    assert.equal(result.source, 'probe');
  }
});

test('active probe constructs bounded payloads for each supported API format', async () => {
  for (const [api, format, path] of [
    ['openai-completions', 'openai', '/v1/chat/completions'],
    ['openai-completions', 'deepseek', '/v1/chat/completions'],
    ['openai-responses', 'openai', '/v1/responses'],
    ['anthropic-messages', 'anthropic', '/v1/messages'],
    ['anthropic-messages', 'anthropic-adaptive', '/v1/messages'],
  ]) {
    await probeReasoning({ ...connection, api }, 'model', {
      format,
      fetchImpl: async (url, init) => {
        assert.equal(new URL(String(url)).pathname, path);
        assert.equal(init.method, 'POST');
        const body = JSON.parse(init.body);
        assert.equal(body.model, 'model');
        if (format === 'anthropic') {
          assert.equal(body.thinking.type, 'enabled');
          assert.equal(body.thinking.budget_tokens, 1024);
          assert.equal(body.max_tokens, 1536);
        } else if (format === 'anthropic-adaptive') {
          assert.equal(body.thinking.type, 'adaptive');
        } else if (api === 'openai-responses') {
          assert.equal(body.max_output_tokens, 512);
          assert.equal(body.reasoning.effort, 'low');
          assert.equal(body.store, false);
        } else if (format === 'deepseek') {
          assert.equal(body.max_tokens, 512);
          assert.equal(body.thinking.type, 'enabled');
        } else {
          assert.equal(body.max_completion_tokens, 512);
          assert.equal(body.reasoning_effort, 'low');
        }
        return Response.json({});
      },
    });
  }
});

test('only explicit capability rejection is negative evidence', async () => {
  for (const status of [400, 422]) {
    const result = await probeReasoning(connection, 'model', {
      fetchImpl: jsonFetch({ error: { message: 'This model does not support reasoning.' } }, status),
    });
    assert.equal(result.supported, false);
  }
  for (const [status, message] of [
    [400, 'reasoning_effort must be one of medium, high'],
    [400, 'Unknown parameter: reasoning_effort'],
    [400, 'max_completion_tokens unsupported'],
    [400, 'The thinking budget must be at least 1024'],
    [400, 'Reasoning is not supported'],
    [400, 'This model does not support reasoning with low effort'],
    [400, 'This model endpoint does not support reasoning'],
    [401, 'This model does not support reasoning. secret-key'],
    [403, 'Forbidden'], [404, 'Model not found'], [429, 'Too many requests'], [500, 'Unexpected error'],
  ]) {
    const result = await probeReasoning(connection, 'model', { fetchImpl: jsonFetch({ error: { message } }, status) });
    assert.equal(result.supported, null);
    assert.doesNotMatch(result.detail, /secret-key/);
  }
});

test('invalid probe format and id fail before requesting generation', async () => {
  for (const api of ['anthropic-messages', 'openai-responses', 'openai-completions']) {
    await assert.rejects(probeReasoning({ ...connection, api }, 'model', { format: 'invalid' }), /probe format/);
  }
  await assert.rejects(probeReasoning(connection, 'bad id'), /valid model id/);
});

test('pagination stops after the bounded page count', async () => {
  let count = 0;
  await assert.rejects(discoverModels({ ...connection, api: 'anthropic-messages' }, {
    fetchImpl: async () => {
      const id = `model-${++count}`;
      return Response.json({ data: [{ id }], has_more: true, last_id: id });
    },
  }), /20-page limit/);
  assert.equal(count, 20);
});
