# OpenClaw 插件

本仓库包含两个独立的 OpenClaw 插件：

| 插件 | 目录 | 功能 |
| --- | --- | --- |
| Telegram Auto Poll | [plugins/telegram-auto-poll](plugins/telegram-auto-poll/README.md) | 将 Telegram 对话中的选择转换为原生投票 |
| OpenClaw Model Sync | [plugins/openclaw-model-sync](plugins/openclaw-model-sync/README.md) | 同步供应商模型目录和思考能力配置 |

两个插件分别安装和配置，具体步骤见各自的说明。仓库根目录保留投票插件的兼容入口，原有从根目录安装的方式仍可使用。

分别验证插件：

```sh
npm --prefix plugins/telegram-auto-poll test
npm --prefix plugins/openclaw-model-sync run check
```
