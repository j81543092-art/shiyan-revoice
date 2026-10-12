/**
 * 零依赖语法检查 —— 对 server / eval / scripts 下所有 .js 逐个跑 node --check。
 * 项目不引入 ESLint 等重型依赖，构建前用这个守住「能解析」这条底线。
 * 用法：node scripts/lint.js（或 npm run lint）
 */
import { readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const DIRS = ['server', 'eval', 'scripts'];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (extname(p) === '.js') out.push(p);
  }
  return out;
}

let checked = 0;
let failed = 0;
for (const d of DIRS) {
  for (const f of walk(join(ROOT, d))) {
    checked++;
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) {
      failed++;
      console.error(`✗ ${f}\n${r.stderr}`);
    }
  }
}

console.log(`语法检查：${checked} 个文件，${failed} 个失败`);
process.exit(failed ? 1 : 0);