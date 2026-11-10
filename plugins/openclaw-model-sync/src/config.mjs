import { isDeepStrictEqual } from 'node:util';

export const SUPPORTED_APIS = ['openai-completions', 'openai-responses', 'anthropic-messages'];
export const DEFAULT_SETTINGS = Object.freeze({
  providers: [], timeoutMs: 15000, prune: true, defaultContextWindow: 32768,
  defaultMaxTokens: 4096, reasoningOverrides: {}, enableAgentTool: false,
});

/** @param {string} id */
export function validateProviderId(id) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(id)
    || ['__proto__', 'prototype', 'constructor'].includes(id)) {
    throw new Error('供应商 ID 只能使用小写字母、数字、横线和下划线，且不能是保留名称');
  }
  return id;
}

/** @param {unknown} value */
export function validateBaseUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw new Error('baseUrl 必须是有效的 HTTP(S) API 根地址'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('baseUrl 必须是 HTTP(S) 地址，不能包含账号、密码、查询参数或片段');
  }
  return url.toString().replace(/\/+$/, '');
}

/** @param {Partial<import('./types.js').Settings>} [raw] @returns {import('./types.js').Settings} */
export function readSettings(raw = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...raw };
  if (!Array.isArray(settings.providers)) throw new Error('providers 必须是供应商 ID 数组');
  settings.providers = [...new Set(settings.providers.map(validateProviderId))];
  for (const [name, min, max] of /** @type {[keyof typeof settings, number, number][]} */ ([
    ['timeoutMs', 100, 120000], ['defaultContextWindow', 1024, 10000000], ['defaultMaxTokens', 1, 1000000],
  ])) {
    const n = settings[name];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) throw new Error(`${name} 超出允许范围`);
  }
  if (settings.defaultMaxTokens > settings.defaultContextWindow) throw new Error('defaultMaxTokens 不能超过 defaultContextWindow');
  if (typeof settings.prune !== 'boolean' || typeof settings.enableAgentTool !== 'boolean') throw new Error('prune 和 enableAgentTool 必须是布尔值');
  if (!settings.reasoningOverrides || typeof settings.reasoningOverrides !== 'object' || Array.isArray(settings.reasoningOverrides)
    || Object.entries(settings.reasoningOverrides).some(([key, value]) => !key.includes('/') || typeof value !== 'boolean')) {
    throw new Error('reasoningOverrides 必须是 provider/model 到布尔值的映射');
  }
  return settings;
}

/** @param {import('./types.js').Config} config @param {string} id */
export function getProvider(config, id) {
  validateProviderId(id);
  const providers = config.models?.providers;
  if (!providers || !Object.hasOwn(providers, id)) throw new Error(`供应商 ${id} 尚未配置`);
  const provider = providers[id];
  if (!SUPPORTED_APIS.includes(provider.api ?? '')) throw new Error(`供应商 ${id} 的 api 不受支持，请显式配置 API 类型`);
  validateBaseUrl(provider.baseUrl);
  return provider;
}

/** @param {import('./types.js').Config} draft @param {string} id */
export function addPolicy(draft, id) {
  draft.agents ??= {};
  draft.agents.defaults ??= {};
  draft.agents.defaults.modelPolicy ??= {};
  const policy = draft.agents.defaults.modelPolicy;
  const wasUnrestricted = !policy.allow?.length;
  if (wasUnrestricted) {
    // Establishing a provider policy must not lock out failed/unselected
    // providers or models already referenced by existing agents.
    const refs = new Set(Object.keys(draft.models?.providers ?? {}).map(provider => `${provider}/*`));
    const agents = [draft.agents.defaults, ...Object.values(/** @type {Record<string, any>} */ (draft.agents.entries ?? {}))];
    for (const agent of agents) {
      if (!agent || typeof agent !== 'object') continue;
      for (const key of ['model', 'imageModel']) {
        const model = agent[key];
        const values = typeof model === 'string' ? [model] : [model?.primary, ...(model?.fallbacks ?? [])];
        for (const value of values) if (typeof value === 'string' && value.includes('/')) refs.add(value);
      }
      for (const value of Object.keys(agent.models ?? {})) if (value.includes('/')) refs.add(value);
    }
    policy.allow = [...refs];
  }
  policy.allow ??= [];
  const wildcard = `${id}/*`;
  if (policy.allow.includes(wildcard)) return wasUnrestricted;
  policy.allow.push(wildcard);
  return true;
}

/** Merge against the transaction's latest draft; never replace the entire config.
 * @param {import('./types.js').Config} draft
 * @param {string} id
 * @param {import('./types.js').DiscoveredModel[]} discovered
 * @param {import('./types.js').Settings} settings
 * @param {boolean} prune
 * @returns {import('./types.js').ProviderReport}
 */
export function mergeModels(draft, id, discovered, settings, prune) {
  const provider = getProvider(draft, id);
  if (!Array.isArray(discovered) || discovered.length === 0) throw new Error('远端模型列表为空，已保留本地配置');
  const ids = new Set();
  for (const model of discovered) {
    if (typeof model.id !== 'string' || !model.id.trim() || ids.has(model.id)) throw new Error('远端返回无效或重复的模型 ID，已保留本地配置');
    ids.add(model.id);
  }
  const existing = new Map((provider.models ?? []).map(model => [model.id, model]));
  /** @type {import('./types.js').ProviderReport} */
  const report = { provider: id, added: [], updated: [], unchanged: [], removed: [], retained: [], reasoning: Object.create(null), warnings: [], policyAdded: false };
  /** @type {import('./types.js').Model[]} */
  const next = discovered.map(remote => {
    const previous = existing.get(remote.id);
    const ref = `${id}/${remote.id}`;
    const hasOverride = Object.hasOwn(settings.reasoningOverrides, ref);
    const evidence = hasOverride
      ? { supported: settings.reasoningOverrides[ref], source: 'override', detail: '使用插件显式覆盖' }
      : remote.reasoning;
    report.reasoning[remote.id] = evidence;
    const contextWindow = previous?.contextWindow ?? remote.contextWindow ?? settings.defaultContextWindow;
    const maxTokens = previous?.maxTokens ?? Math.min(remote.maxTokens ?? settings.defaultMaxTokens, contextWindow);
    const model = {
      id: remote.id, name: previous?.name ?? remote.name ?? remote.id,
      input: previous?.input ?? remote.input ?? ['text'], contextWindow, maxTokens,
      cost: previous?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ...previous,
      reasoning: evidence.supported ?? true,
    };
    if (!previous) report.added.push(remote.id);
    else if (isDeepStrictEqual(previous, model)) report.unchanged.push(remote.id);
    else report.updated.push(remote.id);
    return model;
  });
  for (const previous of provider.models ?? []) {
    if (ids.has(previous.id)) continue;
    if (prune) report.removed.push(previous.id);
    else { next.push(previous); report.retained.push(previous.id); }
  }
  const unknown = Object.values(report.reasoning).filter(value => value.supported === null).length;
  if (unknown) report.warnings.push(`${unknown} 个模型的目录未声明思考能力；默认设置 reasoning 为 true，不代表已确认支持，可用 probe 确认或配置 reasoningOverrides`);
  if (!draft.agents?.defaults?.modelPolicy?.allow?.length) {
    report.warnings.push('已建立供应商 allow 列表，包含所有已配置供应商及现有模型引用；未配置且未引用的内置模型将不再自动放行');
  }
  provider.models = next;
  report.policyAdded = addPolicy(draft, id);
  return report;
}

/** @param {import('./types.js').ProviderReport} report */
export function reportChanged(report) {
  return report.policyAdded || Boolean(report.added.length + report.updated.length + report.removed.length);
}

/** Resolve only environment references for comparison; never expose this result.
 * @param {unknown} value @param {NodeJS.ProcessEnv} env @returns {unknown}
 */
function comparable(value, env) {
  if (typeof value === 'string') return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, key) => env[key] ?? whole);
  if (Array.isArray(value)) return value.map(item => comparable(item, env));
  if (value && typeof value === 'object') {
    const record = /** @type {Record<string, unknown>} */ (value);
    if (record.source === 'env' && typeof record.id === 'string' && env[record.id] !== undefined) return env[record.id];
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, comparable(item, env)]));
  }
  return value;
}

/** @param {import('./types.js').Provider} a @param {import('./types.js').Provider} b @param {NodeJS.ProcessEnv} env */
export function sameConnection(a, b, env) {
  const keys = ['baseUrl', 'api', 'apiKey', 'headers', 'authHeader'];
  return keys.every(key => isDeepStrictEqual(comparable(a[key], env), comparable(b[key], env)));
}
