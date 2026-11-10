import { addPolicy, getProvider, mergeModels, readSettings, reportChanged, sameConnection, SUPPORTED_APIS, validateBaseUrl, validateProviderId } from './config.mjs';
import { discoverModels, probeReasoning } from './transport.mjs';

/** @typedef {import('./types.js').Config} Config */
/** @typedef {import('./types.js').Provider} Provider */
/** @typedef {{id:string,baseUrl:string,api?:string,apiKeyEnv?:string,replace?:boolean,dryRun?:boolean}} AddOptions */

/** @param {{config:import('./types.js').ConfigRuntime,settings?:Partial<import('./types.js').Settings>,env?:NodeJS.ProcessEnv,discover?:typeof discoverModels,probe?:typeof probeReasoning}} options */
export function createSynchronizer({ config, settings: rawSettings, env = process.env, discover = discoverModels, probe = probeReasoning }) {
  const settings = readSettings(rawSettings);
  if (!config || typeof config.current !== 'function' || typeof config.mutateConfigFile !== 'function') {
    throw new Error('需要支持 runtime.config.current/mutateConfigFile 的 OpenClaw（已验证 2026.10.5）');
  }

  /** @param {string[] | undefined} selected @param {Config} snapshot */
  function selectProviders(selected, snapshot) {
    const ids = selected?.length ? selected : settings.providers.length ? settings.providers : Object.keys(snapshot.models?.providers ?? {});
    if (!ids.length) throw new Error('没有可同步的供应商，请先运行 model-sync add');
    return [...new Set(ids.map(validateProviderId))];
  }

  return {
    list() {
      const snapshot = config.current();
      return {
        providers: Object.entries(snapshot.models?.providers ?? {}).map(([id, provider]) => ({
          id, api: provider.api, modelCount: provider.models?.length ?? 0,
          supported: SUPPORTED_APIS.includes(provider.api ?? ''),
          selected: settings.providers.length === 0 || settings.providers.includes(id),
        })),
        allow: snapshot.agents?.defaults?.modelPolicy?.allow ?? [],
        prune: settings.prune,
      };
    },

    /** @param {{providers?:string[],dryRun?:boolean,prune?:boolean}} [options] */
    async sync({ providers: selected, dryRun = false, prune = settings.prune } = {}) {
      const snapshot = structuredClone(config.current());
      const ids = selectProviders(selected, snapshot);
      /** @type {Map<string, {connection:Provider,models:import('./types.js').DiscoveredModel[],warnings:string[]}>} */
      const catalogs = new Map();
      /** @type {import('./types.js').SyncReport} */
      const preview = { dryRun, prune, changed: false, providers: [], errors: [] };
      // Bound requests sequentially; no generation calls occur during synchronization.
      for (const id of ids) {
        try {
          const connection = getProvider(snapshot, id);
          const discovered = await discover(connection, { timeoutMs: settings.timeoutMs, env });
          const report = mergeModels(snapshot, id, discovered.models, settings, prune);
          report.warnings.push(...discovered.warnings);
          preview.providers.push(report);
          catalogs.set(id, { connection: structuredClone(connection), ...discovered });
        } catch (error) {
          preview.errors.push({ provider: id, message: error instanceof Error ? error.message : '同步失败' });
        }
      }
      preview.changed = preview.providers.some(reportChanged);
      if (dryRun || !preview.changed) return preview;

      const write = await config.mutateConfigFile({
        afterWrite: { mode: 'auto' },
        mutate(draft) {
          /** @type {import('./types.js').SyncReport} */
          const result = { dryRun: false, prune, changed: false, providers: [], errors: [...preview.errors] };
          for (const [id, catalog] of catalogs) {
            try {
              const latest = getProvider(draft, id);
              if (!sameConnection(latest, catalog.connection, env)) throw new Error('同步期间供应商连接配置已改变，请重试');
              const report = mergeModels(draft, id, catalog.models, settings, prune);
              report.warnings.push(...catalog.warnings);
              result.providers.push(report);
            } catch (error) {
              result.errors.push({ provider: id, message: error instanceof Error ? error.message : '同步失败' });
            }
          }
          result.changed = result.providers.some(reportChanged);
          return result;
        },
      });
      if (!write.result) throw new Error('OpenClaw 未返回配置事务结果');
      return { ...write.result, followUp: write.followUp };
    },

    /** @param {AddOptions} options */
    async add({ id, baseUrl, api, apiKeyEnv, replace = false, dryRun = false }) {
      validateProviderId(id);
      const url = validateBaseUrl(baseUrl);
      if (api !== undefined && !SUPPORTED_APIS.includes(api)) throw new Error(`api 必须是 ${SUPPORTED_APIS.join('、')}`);
      if (apiKeyEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) throw new Error('apiKeyEnv 必须是环境变量名称');
      /** @param {Config} draft */
      const apply = draft => {
        draft.models ??= {};
        draft.models.providers ??= {};
        const exists = Object.hasOwn(draft.models.providers, id);
        if (exists && !replace) throw new Error(`供应商 ${id} 已存在；使用 --replace 更新连接配置`);
        const previous = exists ? draft.models.providers[id] : undefined;
        draft.models.providers[id] = {
          ...previous, baseUrl: url, api: api ?? previous?.api ?? 'openai-completions', models: previous?.models ?? [],
          ...(apiKeyEnv ? { apiKey: '${' + apiKeyEnv + '}' } : {}),
        };
        const policyAdded = addPolicy(draft, id);
        return { provider: id, operation: exists ? 'updated' : 'added', policyAdded, dryRun };
      };
      if (dryRun) return apply(structuredClone(config.current()));
      const write = await config.mutateConfigFile({ afterWrite: { mode: 'auto' }, mutate: apply });
      return { ...write.result, followUp: write.followUp };
    },

    /** @param {{provider:string,model:string,apply?:boolean,format?:string}} options */
    async probe({ provider: id, model, apply = false, format }) {
      if (typeof model !== 'string' || !model.trim()) throw new Error('需要模型 ID');
      const connection = structuredClone(getProvider(config.current(), id));
      if (!(connection.models ?? []).some(item => item.id === model)) throw new Error('请先同步模型，再探测已配置的模型 ID');
      const reasoning = await probe(connection, model, { env, timeoutMs: settings.timeoutMs, format });
      const result = { provider: id, model, reasoning, applied: false };
      if (!apply || reasoning.supported === null) return result;
      const ref = `${id}/${model}`;
      if (Object.hasOwn(settings.reasoningOverrides, ref) && settings.reasoningOverrides[ref] !== reasoning.supported) {
        throw new Error('探测结果与 reasoningOverrides 冲突，请先调整显式覆盖');
      }
      const write = await config.mutateConfigFile({
        afterWrite: { mode: 'auto' },
        mutate(draft) {
          const latest = getProvider(draft, id);
          if (!sameConnection(latest, connection, env)) throw new Error('探测期间供应商连接配置已改变，请重试');
          const target = latest.models?.find(item => item.id === model);
          if (!target) throw new Error('模型已被移除，请重新同步');
          target.reasoning = /** @type {boolean} */ (reasoning.supported);
          return { ...result, applied: true };
        },
      });
      return { ...write.result, followUp: write.followUp };
    },
  };
}
