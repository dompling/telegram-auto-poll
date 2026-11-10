/** @typedef {ReturnType<import('./sync.mjs').createSynchronizer>} Synchronizer */

/** Commander is supplied by OpenClaw; the plugin does not depend on a second copy.
 * @param {any} program @param {Synchronizer} sync
 */
export function registerCli(program, sync) {
  const root = program.command('model-sync').description('同步模型、思考能力和供应商白名单（默认清理旧模型）');
  /** @param {() => unknown | Promise<unknown>} action */
  const run = async action => {
    try {
      const result = await action();
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      if (result && typeof result === 'object' && 'errors' in result && Array.isArray(result.errors) && result.errors.length) process.exitCode = 1;
    } catch (error) {
      process.stderr.write(`model-sync: ${error instanceof Error ? error.message : '操作失败'}\n`);
      process.exitCode = 1;
    }
  };
  root.command('list').description('列出供应商和 modelPolicy.allow（隐藏密钥）').action(() => run(() => sync.list()));
  root.command('add <provider>')
    .description('添加供应商并写入 provider/*；已有供应商需 --replace')
    .requiredOption('--base-url <url>', 'API 根地址，例如 https://example.com/v1')
    .option('--api <type>', 'openai-completions | openai-responses | anthropic-messages；新建默认 completions，更新时保留原值')
    .option('--api-key-env <name>', '保存 API key 的环境变量名称，配置中仅写入引用')
    .option('--replace', '更新已有供应商连接，保留模型及其他字段')
    .option('--dry-run', '只预览，不写配置')
    .action((/** @type {string} */ id, /** @type {any} */ options) => run(() => sync.add({ id, ...options })));
  root.command('sync [providers...]')
    .description('发现并同步模型，默认删除远端已不存在的模型')
    .option('--dry-run', '获取远端模型并预览增删，不写配置')
    .option('--no-prune', '保留远端已不存在的模型')
    .action((/** @type {string[]} */ providers, /** @type {any} */ options, /** @type {any} */ command) => run(() => sync.sync({
      providers, dryRun: options.dryRun === true,
      ...(command.getOptionValueSource('prune') === 'cli' ? { prune: options.prune } : {}),
    })));
  root.command('probe <provider> <model>')
    .description('发送一次生成请求检测思考能力（可能产生费用）')
    .option('--format <format>', 'openai | deepseek | anthropic | anthropic-adaptive；默认按 API 选择')
    .option('--apply', '将确认支持/不支持的结果写入 reasoning；未知不修改')
    .action((/** @type {string} */ provider, /** @type {string} */ model, /** @type {any} */ options) => run(() => sync.probe({ provider, model, ...options })));
}
