# OpenClaw Model Sync

原生 OpenClaw 插件，直接读取当前 OpenClaw 配置中的 `models.providers`，同步已有供应商的模型列表、思考能力和供应商白名单。无需在插件里重复填写供应商、地址或密钥。

- 每次执行时读取已有供应商的 `baseUrl`、`api`、`apiKey` 和 `headers`；新增或删除供应商后，下次执行自动跟随当前配置。
- 从供应商的 `/models` 拉取模型并合并目录，**默认清理远端已不存在的模型**。
- 检测模型是否支持 reasoning / thinking，并写入模型的 `reasoning`。
- 合并 `agents.defaults.modelPolicy.allow` 中的 `provider/*`，保留已有规则。
- 提供 CLI，以及可选择启用的 `model_sync` Agent 工具。

零第三方运行依赖，不需要构建。需要 Node.js 22.16+；已使用 OpenClaw **2026.10.5** 验证。依赖新版 `api.runtime.config.current()` 和 `mutateConfigFile()`，不兼容仅提供旧 `loadConfig/writeConfigFile` 的宿主。

## 安装

从仓库根目录执行：

```sh
cd plugins/openclaw-model-sync
openclaw plugins install --link . --force
openclaw plugins enable openclaw-model-sync
openclaw model-sync --help
```

如果已从其他目录链接过同名插件，先移除旧加载路径并按 OpenClaw 的提示更新安装记录，避免重复加载同一个插件 ID。

在另一台机器上也可以复制整个项目目录后执行上面的命令，或 `npm pack` 后安装生成的 `.tgz`。安装和启用插件时，以宿主返回的后续操作提示为准。

插件通过宿主配置事务修改当前 profile 对应的配置文件，遵循 `OPENCLAW_CONFIG_PATH`；没有自行覆盖 `~/.openclaw/openclaw.json` 的逻辑。配置热重载/重启由宿主决定，CLI 会返回 `followUp`。

## 读取已有供应商并同步

只要供应商已经配置在 OpenClaw 的 `models.providers` 中，安装后即可执行：

```sh
# 查看当前配置中已存在的供应商，不显示密钥
openclaw model-sync list

# 从所有已配置供应商拉取模型并预览改动
openclaw model-sync sync --dry-run

# 应用同步结果，默认清理远端已不存在的模型
openclaw model-sync sync
```

从 0.1.2 起，默认同步始终选择当前 `models.providers` 中的全部供应商，不再要求维护插件的 `providers` 列表。旧配置中的该字段仍可加载，但不再参与筛选。已有供应商不需要运行 `model-sync add`；密钥引用继续从运行 OpenClaw 的环境中解析，不会复制到插件配置。

## 同步与默认清理

```sh
# 从 OpenClaw 配置读取全部供应商，默认删除远端已不存在的模型
openclaw model-sync sync

# 本次只同步这些已配置供应商，不影响下次默认同步
openclaw model-sync sync sub2api kiro litellm sub2api-cpa

# 预览新增、更新、移除、能力证据和警告，不写配置
openclaw model-sync sync --dry-run

# 本次同步保留旧模型
openclaw model-sync sync --no-prune
```

CLI 输出 JSON，包含 `added`、`updated`、`removed`、`retained`、`unchanged`、`reasoning`、`warnings`。部分供应商失败时，其余成功的供应商照常同步，并返回非零退出码和 `errors`，便于脚本发现问题。

清理只针对这次成功取得**完整非空模型目录**的供应商。超时、鉴权失败、无效 JSON、重复/无效 ID、异常分页或空列表均保留本地模型；未选中的供应商不清理。Anthropic 支持分页，其他 API 如果报告分页但不支持其协议，则拒绝用不完整目录执行清理。

已有模型的显示名、输入类型、价格、上下文窗口、最大输出和 `compat` 等自定义字段会保留。新模型优先使用远端元数据，缺失时暂用 32,768 上下文、4,096 最大输出、文本输入及零价格；这些是配置占位值，不代表真实能力或免费。可调整下面的默认值，或编辑已生成模型。

本插件不修改默认模型和 fallback。默认清理可能移除这些引用所指向的失效模型，需将默认模型切换到远端仍提供的模型；不要把本地失效条目保留与模型仍然可调用混为一谈。

## 可选：添加新供应商

仅在 OpenClaw 中尚未配置供应商时，可使用 `add` 写入 `models.providers`，也可以用 OpenClaw 自身的配置方式添加。它不是同步已有供应商的前置步骤。

先让 OpenClaw CLI 和 Gateway 进程能够读取密钥环境变量，再执行：

```sh
openclaw model-sync add sub2api \
  --base-url https://your-provider.example/v1 \
  --api openai-completions \
  --api-key-env SUB2API_API_KEY
```

插件仅保存 `"apiKey": "${SUB2API_API_KEY}"`。不需要鉴权的本地服务可以省略 `--api-key-env`。`add` 同时将供应商加入模型策略，不会立即发请求。

可选 API 类型：`openai-completions`、`openai-responses`、`anthropic-messages`。`baseUrl` 是 API 根地址，不是完整的 `/models`、`/chat/completions` 或 `/responses` 地址。OpenAI 兼容接口通常需要包含 `/v1`；Anthropic 地址若只有域名，会自动补 `/v1`。

更新已有供应商需要 `--replace`，已有模型和其他字段会保留。省略 `--api` 或 `--api-key-env` 时，保留已有协议或密钥引用；新建供应商默认使用 `openai-completions`。

```sh
openclaw model-sync add sub2api --replace --base-url https://new-provider.example/v1
```

## 供应商白名单

你提供的配置对应：

```json
{
  "agents": {
    "defaults": {
      "modelPolicy": {
        "allow": [
          "sub2api/*",
          "kiro/*",
          "litellm/*",
          "sub2api-cpa/*"
        ]
      }
    }
  }
}
```

模型目录存于 `models.providers`，上面的策略决定可以选择哪些模型。插件只合并默认策略，不覆盖 `agents.entries` 中各 Agent 的独立策略。

若原本已经有非空 `allow`，保留已有规则并追加本次供应商。若原本省略或为空（OpenClaw 的含义是允许所有模型），建立白名单时会加入**所有已配置供应商**和已有 Agent 的 primary/fallback/模型映射引用，避免同步失败或未选中的供应商被间接锁出。未配置、未引用的内置模型需要另外加入策略。

## 思考能力检测

普通同步只请求模型目录，不发送生成请求。检测优先级为：

1. 插件 `reasoningOverrides` 的显式覆盖。
2. 远端明确能力字段，例如 `reasoning`、`supports_reasoning`、`supportsReasoningEffort`、`capabilities.thinking.supported`、`supported_parameters`。
3. 缺少证据时，新旧模型都默认设为 `reasoning: true`，报告中仍标为 `supported: null`（未知）。

默认值不代表已经确认模型支持思考，也不会自动开启 OpenClaw 的思考级别；不支持思考的模型可能出现请求错误，可通过 `reasoningOverrides` 将其设为 `false`。远端缺少证据时，同步会把已有的 `reasoning: false` 改为默认的 `true`；如需长期保留 `false`，请设置覆盖。OpenAI 标准 `/models` 没有 reasoning 能力字段，因此仅靠模型列表通常无法确认。HTTP 200、回显参数或正文里的 `<think>` 都不算支持证据。

### Sub2API 能力元数据

从插件 0.1.1 起，支持直接读取 Sub2API 返回的能力扩展，不需要先发送生成请求：

```json
{
  "id": "your-model-alias",
  "type": "model",
  "display_name": "your-model-alias",
  "supports_reasoning": true,
  "supports_images": true,
  "max_input_tokens": 128000,
  "max_output_tokens": 16000
}
```

`supports_reasoning: true` 会将模型设为 `reasoning: true`；显式 `false` 同样有效，字段缺失表示未知并使用默认值。新模型还会使用已声明的图片支持和 token 限制，已有模型的自定义输入和限制仍保留。Grok 的 `supportsReasoningEffort` 也能识别。

配套的 Sub2API 修改为普通 CodeBuddy 分组输出已保存或缓存的真实元数据。别名按实际映射解析；多个可调度账号的布尔能力不一致或证据不全时省略对应字段，已知 token 限制取保守值。组合分组没有可靠来源时不会猜测能力。

需要先部署包含该修改的 Sub2API，并确保账号已有完整模型元数据，再更新插件并执行 `openclaw model-sync sync sub2api`。只更新插件无法补出旧服务端没有返回的数据。目录仍缺少能力声明时，只输出一条中文提示；配置了 `reasoningOverrides` 的模型不会再收到该能力缺失提示。

显式探测会发出一次小规模生成请求，可能产生费用：

```sh
# 只检测，不修改配置
openclaw model-sync probe sub2api MODEL_ID

# 检测后，将确认结果写入模型 reasoning
openclaw model-sync probe sub2api MODEL_ID --apply

# DeepSeek 风格的 thinking 参数
openclaw model-sync probe sub2api MODEL_ID --format deepseek --apply

# Anthropic adaptive thinking
openclaw model-sync probe anthropic MODEL_ID --format anthropic-adaptive --apply
```

先同步再探测，模型必须存在于本地供应商目录。支持 `openai`、`deepseek`、`anthropic`、`anthropic-adaptive` 四种探测格式；缺省按供应商 API 选择。Chat Completions / Responses 的探测输出预算上限为 512 tokens，Anthropic 为 1,536（enabled 模式的 thinking budget 为 1,024）。

只有结构化 thinking/reasoning 输出或非零思考 token 统计等证据才确认支持。仅明确“该模型不支持 reasoning/thinking”的错误才确认不支持；参数值、模式、预算、鉴权或限流错误均不作为不支持证据。探测结果未知时不会覆盖配置；若探测确认不支持并写入 `false`，但远端目录没有提供能力信息，下次同步仍会默认设为 `true`，需要使用 `reasoningOverrides` 持久保留 `false`。`reasoning: true` 是模型能力配置，不会替你更改 OpenClaw 的默认思考级别。

有些代理会删除思考字段，或采用其他参数格式。此时使用供应商明确文档和 `reasoningOverrides`，不要将未知强行理解为不支持。

## 插件设置

插件不需要供应商配置。以下可选设置写在 `plugins.entries.openclaw-model-sync.config`：

```json
{
  "prune": true,
  "timeoutMs": 15000,
  "defaultContextWindow": 32768,
  "defaultMaxTokens": 4096,
  "reasoningOverrides": {
    "sub2api/your-confirmed-thinking-model": true
  },
  "enableAgentTool": false
}
```

省略 CLI / Agent 工具的 `providers` 参数时，读取 `models.providers` 中全部供应商；明确给定的 ID 仅筛选本次同步。旧版插件设置中的 `providers` 已停用，可以删除。不支持的 API 会单独报告错误并保持不变。`prune` 默认 `true`；设置为 `false` 可长期关闭清理。

将 `enableAgentTool` 设为 `true`，再在 OpenClaw 的工具策略中放行可选工具 `model_sync`，即可让 Agent 执行 `list` / `sync`。工具同步缺省 `dryRun: true`，只有明确要求应用时使用 `dryRun: false`。供应商凭据管理和收费探测保留在 CLI。

最小插件配置见 [examples/openclaw.json](examples/openclaw.json)。将插件条目和白名单合并到已有配置中，保留已有供应商及其他插件，不要直接覆盖整份配置。

## 开发与验证

```sh
npm test                  # 单元及本地 HTTP 测试
npm run lint              # Node 语法、源文件格式和 manifest 一致性检查
npm run typecheck         # 使用系统 tsc 和本机 OpenClaw 的 Node 类型声明
npm run check             # 以上全部
npm run test:host         # 真实 OpenClaw + 临时配置 + 本地模拟供应商
npm pack --dry-run        # 检查安装包内容
```

类型检查不安装依赖，需要系统已提供 `tsc`；可用 `TSC_PATH` 指定编译器，`NODE_TYPE_ROOTS` 指定包含 `node/` 的类型声明目录。`OPENCLAW_PACKAGE_ROOT` 可指定宿主包目录；宿主测试可以用 `OPENCLAW_BIN` 指定 CLI 路径。运行插件本身不需要 TypeScript。

真实供应商验证使用进程环境中的 `MODEL_SYNC_TEST_BASE_URL` 和 `MODEL_SYNC_TEST_KEY`，然后执行 `npm run test:provider`。它只修改临时 OpenClaw 配置，验证真实发现、dry-run、默认清理、白名单和密钥引用保持。若同时设置 `MODEL_SYNC_TEST_MODEL`，还会发出一次主动探测并应用到临时配置；可通过 `MODEL_SYNC_TEST_FORMAT` 选择探测协议。

HTTP 请求限制为每页 4 MiB，最多 20 页；不跟随重定向，不输出供应商响应正文或密钥。支持字面量凭据、`${ENV_NAME}` 和 `source: "env"` 的 SecretRef；file/exec SecretRef 和仅存在于 OAuth auth profile 中的凭据不在本插件解析范围。

参考：[OpenClaw 模型策略](https://docs.openclaw.ai/concepts/models)、[OpenClaw 插件](https://docs.openclaw.ai/tools/plugin)、[OpenAI Models API](https://developers.openai.com/api/reference/resources/models/methods/list)、[Anthropic 模型 API 类型](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/models.ts)。
