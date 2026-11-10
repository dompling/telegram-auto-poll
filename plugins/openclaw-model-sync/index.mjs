import { registerCli } from './src/cli.mjs';
import { readSettings } from './src/config.mjs';
import { createSynchronizer } from './src/sync.mjs';

export default {
  id: 'openclaw-model-sync',
  name: 'Model Sync',
  /** @param {any} api */
  register(api) {
    const settings = readSettings(api.pluginConfig ?? {});
    const makeSync = () => createSynchronizer({ config: api.runtime.config, settings });
    api.registerCli((/** @type {{program:any}} */ { program }) => registerCli(program, makeSync()), {
      descriptors: [{ name: 'model-sync', description: '同步供应商、模型及思考能力', hasSubcommands: true, machineOutput: () => true }],
    });
    if (!settings.enableAgentTool) return;
    api.registerTool({
      name: 'model_sync',
      label: 'Model Sync',
      description: 'Read providers and their connection settings directly from the current OpenClaw models.providers config. No separate provider setup is needed. List providers or sync all configured providers by default; providers optionally filters this invocation. Sync prunes stale models by default. dryRun defaults to true. Only set dryRun=false when the user explicitly requests applying config changes. Billable probes remain in CLI model-sync probe.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['action'],
        properties: {
          action: { type: 'string', enum: ['list', 'sync'] },
          providers: { type: 'array', items: { type: 'string' }, description: 'Optional IDs from models.providers for this sync only; omitted or empty selects all currently configured providers' },
          dryRun: { type: 'boolean', default: true },
          prune: { type: 'boolean', description: 'Defaults to plugin setting (true unless configured otherwise)' },
        },
      },
      /** @param {string} _id @param {{action:string,providers?:string[],dryRun?:boolean,prune?:boolean}} params */
      async execute(_id, params) {
        if (!['list', 'sync'].includes(params.action)) throw new Error('未知 action');
        const sync = makeSync();
        const result = params.action === 'list' ? sync.list() : await sync.sync({ ...params, dryRun: params.dryRun !== false });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], details: result };
      },
    }, { optional: true });
  },
};
