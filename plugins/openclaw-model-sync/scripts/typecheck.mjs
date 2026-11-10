import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const npm = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' });
const globalRoot = npm.stdout?.trim();
const typeRoots = [
  process.env.NODE_TYPE_ROOTS,
  join(root, 'node_modules/@types'),
  process.env.OPENCLAW_PACKAGE_ROOT && join(process.env.OPENCLAW_PACKAGE_ROOT, 'node_modules/@types'),
  globalRoot && join(globalRoot, 'openclaw/node_modules/@types'),
  join(dirname(process.execPath), '../lib/node_modules/openclaw/node_modules/@types'),
].find(candidate => candidate && existsSync(join(candidate, 'node/package.json')));
if (!typeRoots) throw new Error('需要 Node 类型声明。可使用已安装 OpenClaw 的 node_modules/@types，设置 NODE_TYPE_ROOTS 指向该目录。');
const result = spawnSync(process.env.TSC_PATH || 'tsc', ['--project', join(root, 'tsconfig.json'), '--typeRoots', typeRoots], { stdio: 'inherit' });
if (result.error) throw new Error('需要系统可用的 TypeScript 编译器 tsc，或通过 TSC_PATH 指定；插件运行无需 TypeScript。');
process.exitCode = result.status ?? 1;
