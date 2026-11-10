/**
 * Provider discovery and explicitly requested reasoning probes.
 * Standard OpenAI /models has no reasoning capability guarantee:
 * https://developers.openai.com/api/reference/resources/models/methods/list
 * Anthropic exposes capabilities.thinking.supported on newer model catalogs:
 * https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/models.ts
 */

/** @typedef {{supported: boolean | null, source: string, detail: string}} ReasoningEvidence */
/** @typedef {{id: string, name?: string, reasoning: ReasoningEvidence, input?: ('text'|'image')[], contextWindow?: number, maxTokens?: number}} DiscoveredModel */
/** @typedef {{baseUrl: string, api?: string, apiKey?: unknown, headers?: Record<string, unknown>, authHeader?: boolean}} ProviderConnection */
/** @typedef {{env?: Record<string, string | undefined>, fetchImpl?: typeof fetch, timeoutMs?: number, format?: string}} TransportOptions */

const SUPPORTED_APIS = new Set(['openai-completions', 'openai-responses', 'anthropic-messages']);
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_PAGES = 20;
const DEFAULT_TIMEOUT_MS = 15_000;
const PROBE_PROMPT = 'Compute 17 * 23 + 19 * 13. Return only the final integer.';

class TransportError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'TransportError';
  }
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is string} */
function validModelId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 300
    && !/[\s\u0000-\u001f\u007f]/u.test(value)
    && !['__proto__', 'prototype', 'constructor'].includes(value);
}

/** @param {unknown} value @param {Record<string, string | undefined>} env */
function resolveSecret(value, env) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => {
      const secret = env[name];
      if (typeof secret !== 'string' || secret.length === 0) {
        throw new TransportError('Required credential environment variable is missing.');
      }
      return secret;
    });
  }
  if (isObject(value) && value.source === 'env' && typeof value.id === 'string'
    && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value.id)) {
    const secret = env[value.id];
    if (typeof secret !== 'string' || secret.length === 0) {
      throw new TransportError('Required credential environment variable is missing.');
    }
    return secret;
  }
  throw new TransportError('Only literal credentials, ${ENV_NAME}, and env SecretRefs are supported.');
}

/** @param {ProviderConnection} provider @param {string} path */
function endpoint(provider, path) {
  if (!SUPPORTED_APIS.has(provider.api ?? 'openai-completions')) {
    throw new TransportError('Unsupported provider API; use openai-completions, openai-responses, or anthropic-messages.');
  }
  let url;
  try {
    url = new URL(provider.baseUrl);
  } catch {
    throw new TransportError('Provider baseUrl must be an absolute HTTP(S) URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new TransportError('Provider baseUrl must use HTTP(S) without credentials, query, or fragment.');
  }
  let root = url.pathname.replace(/\/+$/, '');
  if (provider.api === 'anthropic-messages' && root === '') root = '/v1';
  url.pathname = `${root}/${path}`;
  return url;
}

/** @param {ProviderConnection} provider @param {Record<string, string | undefined>} env @param {boolean} hasBody */
function requestHeaders(provider, env, hasBody) {
  try {
    const headers = new Headers({ accept: 'application/json' });
    if (hasBody) headers.set('content-type', 'application/json');
    if (provider.api === 'anthropic-messages') headers.set('anthropic-version', '2023-06-01');
    if (provider.apiKey !== undefined) {
      const key = resolveSecret(provider.apiKey, env);
      if (key.length === 0) throw new TransportError('Provider apiKey must not be empty.');
      if (provider.api === 'anthropic-messages' && provider.authHeader !== true) {
        headers.set('x-api-key', key);
      } else {
        headers.set('authorization', `Bearer ${key}`);
      }
    }
    if (provider.headers !== undefined && !isObject(provider.headers)) {
      throw new TransportError('Provider headers must be an object.');
    }
    for (const [name, value] of Object.entries(provider.headers ?? {})) {
      if (['host', 'content-length', 'connection', 'transfer-encoding'].includes(name.toLowerCase())) {
        throw new TransportError('Provider headers contain an unsupported transport header.');
      }
      headers.set(name, resolveSecret(value, env));
    }
    return headers;
  } catch (error) {
    if (error instanceof TransportError) throw error;
    throw new TransportError('Provider credentials or headers are invalid.');
  }
}

/**
 * Bound the entire operation, including reading a stalled response body. Never
 * pass server response bodies, URLs, native fetch errors, or credentials upward.
 * @param {URL} url
 * @param {ProviderConnection} provider
 * @param {TransportOptions} options
 * @param {Record<string, unknown>} [body]
 * @returns {Promise<{status: number, data: any}>}
 */
async function requestJson(url, provider, options, body) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new TransportError('timeoutMs must be an integer between 1 and 120000.');
  }
  const headers = requestHeaders(provider, options.env ?? process.env, body !== undefined);
  const controller = new AbortController();
  /** @type {ReadableStreamDefaultReader<Uint8Array> | undefined} */
  let reader;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TransportError('Provider request timed out.'));
    }, timeoutMs);
  });
  const operation = async () => {
    const response = await (options.fetchImpl ?? fetch)(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      throw new TransportError('Provider redirects are not allowed.');
    }
    if (Number(response.headers.get('content-length')) > MAX_BODY_BYTES) {
      throw new TransportError('Provider response exceeds the 4 MiB limit.');
    }
    const chunks = [];
    let length = 0;
    reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_BODY_BYTES) throw new TransportError('Provider response exceeds the 4 MiB limit.');
        chunks.push(value);
      }
    }
    const combined = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let data;
    try {
      data = JSON.parse(new TextDecoder().decode(combined));
    } catch {
      if (response.ok) throw new TransportError('Provider returned invalid JSON.');
    }
    return { status: response.status, data };
  };
  try {
    // timedOut only rejects; the cast keeps the JS type checker precise.
    return /** @type {{status: number, data: any}} */ (await Promise.race([operation(), timedOut]));
  } catch (error) {
    if (error instanceof TransportError) throw error;
    if (controller.signal.aborted) throw new TransportError('Provider request timed out.');
    throw new TransportError('Provider request failed (network, TLS, or blocked redirect).');
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) void reader.cancel().catch(() => {});
  }
}

/** @param {Record<string, any>} model @returns {ReasoningEvidence} */
function metadataReasoning(model) {
  const candidates = [
    ['reasoning', model.reasoning],
    ['supports_reasoning', model.supports_reasoning],
    ['capabilities.thinking.supported', model.capabilities?.thinking?.supported],
    ['capabilities.reasoning.supported', model.capabilities?.reasoning?.supported],
    ['capabilities.reasoning', model.capabilities?.reasoning],
    ['capabilities.thinking', model.capabilities?.thinking],
  ];
  // Explicit false is authoritative even when a generic supported-parameter
  // list advertises reasoning fields for every model behind a gateway.
  for (const expected of [false, true]) {
    const match = candidates.find(([, value]) => value === expected);
    if (match) return { supported: expected, source: 'metadata', detail: `Catalog ${match[0]} is ${expected}.` };
  }
  // Adjustable effort proves reasoning support; lacking effort controls does
  // not prove that a model cannot think at a fixed level.
  if (model.supportsReasoningEffort === true) {
    return { supported: true, source: 'metadata', detail: 'Catalog supportsReasoningEffort is true.' };
  }
  const parameters = model.supported_parameters;
  if (Array.isArray(parameters) && parameters.some((value) => ['reasoning', 'reasoning_effort', 'thinking', 'enable_thinking'].includes(value))) {
    return { supported: true, source: 'metadata', detail: 'Catalog supported_parameters advertises reasoning controls.' };
  }
  if (Array.isArray(model.capabilities) && model.capabilities.some((value) => ['reasoning', 'thinking'].includes(value))) {
    return { supported: true, source: 'metadata', detail: 'Catalog capabilities advertises reasoning.' };
  }
  return { supported: null, source: 'unknown', detail: 'Catalog does not explicitly report reasoning support.' };
}

/** @param {unknown} value @returns {number | undefined} */
function positiveInteger(value) {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

/** @param {unknown} value @returns {DiscoveredModel} */
function normalizeModel(value) {
  if (!isObject(value) || !validModelId(value.id)) {
    throw new TransportError('Model catalog contains an invalid or missing model id; synchronization was stopped.');
  }
  /** @type {DiscoveredModel} */
  const model = { id: value.id, reasoning: metadataReasoning(value) };
  const name = value.display_name ?? value.name;
  if (typeof name === 'string' && name.length > 0 && name.length <= 300 && !/[\u0000-\u001f\u007f]/u.test(name)) model.name = name;
  const input = value.architecture?.input_modalities ?? value.input_modalities ?? value.input;
  if (Array.isArray(input)) {
    const modalities = [...new Set(input.filter((item) => item === 'text' || item === 'image'))];
    if (modalities.length) model.input = modalities;
  }
  if (!model.input && typeof value.supports_images === 'boolean') {
    model.input = value.supports_images ? ['text', 'image'] : ['text'];
  }
  const contextWindow = positiveInteger(value.contextWindow ?? value.context_length ?? value.max_input_tokens);
  const maxTokens = positiveInteger(value.maxTokens ?? value.max_output_tokens ?? value.max_tokens ?? value.top_provider?.max_completion_tokens);
  if (contextWindow !== undefined) model.contextWindow = contextWindow;
  if (maxTokens !== undefined) model.maxTokens = maxTokens;
  return model;
}

/**
 * Discover configured provider models without sending a generation request.
 * Invalid or incomplete catalogs fail as a whole, so callers cannot replace a
 * working model list with a partial response.
 * @param {ProviderConnection} provider
 * @param {TransportOptions} [options]
 * @returns {Promise<{models: DiscoveredModel[], warnings: string[]}>}
 */
export async function discoverModels(provider, options = {}) {
  const url = endpoint(provider, 'models');
  if (provider.api === 'anthropic-messages') url.searchParams.set('limit', '1000');
  /** @type {DiscoveredModel[]} */
  const models = [];
  const ids = new Set();
  const cursors = new Set();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { status, data } = await requestJson(url, provider, options);
    if (status < 200 || status >= 300) throw new TransportError(`Model catalog request failed with HTTP ${status}.`);
    const entries = Array.isArray(data) ? data : data?.data ?? data?.models;
    if (!Array.isArray(entries)) throw new TransportError('Provider response does not contain a model array.');
    if (data?.has_more !== undefined && typeof data.has_more !== 'boolean') {
      throw new TransportError('Model catalog contains an invalid pagination flag.');
    }
    if (data?.next_page || data?.next_page_token || data?.next_cursor || data?.next_url) {
      throw new TransportError('Provider returned an unsupported paginated catalog; synchronization was stopped.');
    }
    for (const entry of entries) {
      const model = normalizeModel(entry);
      if (ids.has(model.id)) throw new TransportError('Model catalog contains duplicate model ids; synchronization was stopped.');
      ids.add(model.id);
      models.push(model);
    }
    if (data?.has_more === true) {
      if (provider.api !== 'anthropic-messages') throw new TransportError('Provider returned an unsupported paginated catalog; synchronization was stopped.');
      if (!validModelId(data.last_id) || cursors.has(data.last_id) || entries.length === 0) {
        throw new TransportError('Provider returned an invalid pagination cursor.');
      }
      cursors.add(data.last_id);
      url.searchParams.set('after_id', data.last_id);
      continue;
    }
    return { models, warnings: [] };
  }
  throw new TransportError('Model catalog exceeded the 20-page limit; synchronization was stopped.');
}

/** @param {any} data */
function probeHasEvidence(data) {
  const usage = data?.usage;
  if ([usage?.completion_tokens_details?.reasoning_tokens,
    usage?.output_tokens_details?.reasoning_tokens,
    usage?.output_tokens_details?.thinking_tokens].some((tokens) => typeof tokens === 'number' && tokens > 0)) {
    return 'Provider reported nonzero reasoning/thinking token usage.';
  }
  if (Array.isArray(data?.output) && data.output.some((/** @type {unknown} */ item) => isObject(item) && item.type === 'reasoning')) {
    return 'Provider returned a structured reasoning output item.';
  }
  if (Array.isArray(data?.content) && data.content.some((/** @type {unknown} */ item) => isObject(item)
    && ((item.type === 'thinking' && (nonEmptyString(item.thinking) || nonEmptyString(item.signature)))
      || (item.type === 'redacted_thinking' && nonEmptyString(item.data))))) {
    return 'Provider returned a structured thinking content block.';
  }
  if (Array.isArray(data?.choices) && data.choices.some((/** @type {any} */ choice) => nonEmptyString(choice?.message?.reasoning_content))) {
    return 'Provider returned the reasoning_content extension.';
  }
  return undefined;
}

/** @param {unknown} value */
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/** @param {any} data */
function explicitlyUnsupported(data) {
  const message = data?.error?.message ?? data?.message;
  if (typeof message !== 'string') return false;
  // Rejecting an effort value or token budget is not evidence that the model
  // lacks reasoning. Restrict false to an explicit capability rejection.
  if (/\b(budget|must be|allowed values|one of|invalid value|effort|parameter|field|protocol|endpoint|mode|format)\b/i.test(message)) return false;
  return /\bmodel\b.{0,100}\b(?:does not|doesn't|cannot|can't) support (?:the )?(?:reasoning|thinking|extended thinking)\b/i.test(message)
    || /\b(?:reasoning|thinking|extended thinking) (?:is |are )?(?:not supported|unsupported|unavailable) (?:for|by|on|with) (?:this |the )?model\b/i.test(message);
}

/**
 * Send one bounded, explicitly requested generation request. Positive evidence
 * demonstrates reasoning for this protocol; missing evidence remains unknown.
 * @param {ProviderConnection} provider
 * @param {string} modelId
 * @param {TransportOptions} [options]
 * @returns {Promise<ReasoningEvidence>}
 */
export async function probeReasoning(provider, modelId, options = {}) {
  if (!validModelId(modelId)) throw new TransportError('A valid model id is required for a reasoning probe.');
  const api = provider.api ?? 'openai-completions';
  const format = options.format ?? (api === 'anthropic-messages' ? 'anthropic' : 'openai');
  /** @type {Record<string, unknown>} */
  let body;
  let path;
  if (api === 'anthropic-messages') {
    if (!['anthropic', 'anthropic-adaptive'].includes(format)) throw new TransportError('Anthropic API requires anthropic or anthropic-adaptive probe format.');
    path = 'messages';
    body = {
      model: modelId,
      messages: [{ role: 'user', content: PROBE_PROMPT }],
      max_tokens: 1536,
      thinking: format === 'anthropic-adaptive' ? { type: 'adaptive' } : { type: 'enabled', budget_tokens: 1024 },
    };
  } else if (api === 'openai-responses') {
    if (format !== 'openai') throw new TransportError('Responses API requires openai probe format.');
    path = 'responses';
    body = { model: modelId, input: PROBE_PROMPT, max_output_tokens: 512, reasoning: { effort: 'low' }, store: false };
  } else if (api === 'openai-completions') {
    if (!['openai', 'deepseek'].includes(format)) throw new TransportError('Completions API requires openai or deepseek probe format.');
    path = 'chat/completions';
    body = {
      model: modelId,
      messages: [{ role: 'user', content: PROBE_PROMPT }],
      stream: false,
      ...(format === 'deepseek'
        ? { max_tokens: 512, thinking: { type: 'enabled' } }
        : { max_completion_tokens: 512, reasoning_effort: 'low' }),
    };
  } else {
    throw new TransportError('Unsupported provider API for a reasoning probe.');
  }
  const url = endpoint(provider, path);
  const { status, data } = await requestJson(url, provider, options, body);
  if (status >= 200 && status < 300) {
    const detail = probeHasEvidence(data);
    return detail
      ? { supported: true, source: 'probe', detail }
      : { supported: null, source: 'probe', detail: 'Request succeeded without explicit reasoning evidence; support remains unknown.' };
  }
  if ([400, 422].includes(status) && explicitlyUnsupported(data)) {
    return { supported: false, source: 'probe', detail: `Provider explicitly reported that this model does not support reasoning (HTTP ${status}).` };
  }
  return { supported: null, source: 'probe', detail: `Probe failed with HTTP ${status}; this does not establish reasoning support.` };
}
