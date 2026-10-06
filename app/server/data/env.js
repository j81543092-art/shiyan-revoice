/**
 * 极简 .env 加载器 —— 零依赖
 *
 * 【为什么需要这个文件】
 * 原实现只读 process.env，不加载 .env 文件 —— 也就是说写了 .env 也不生效。
 * 这在本地开发与答辩演示时都很致命：凭证明明填了，provider 却仍是 rule，
 * 且不会报错（静默降级），排查起来很费时间。
 *
 * Node 20.6+ 有内置的 `node --env-file=.env`，但：
 *   1. 需要改启动命令，容易漏（npm start / node server/index.js / 容器 CMD 三处）
 *   2. 文件不存在时 --env-file 会直接报错退出，而本项目要求「无凭证也能跑通」
 * 所以自己写一个：文件不存在就静默跳过，符合「演示不中断」的项目原则。
 *
 * 【与 process.env 的优先级】
 * **已存在的环境变量优先，.env 不覆盖它。**
 * 这样部署平台注入的变量（华为云容器、CodeArts）永远赢过本地文件，
 * 避免本地调试用的值意外覆盖线上配置。
 *
 * 支持语法（刻意保持最小集）：
 *   KEY=value
 *   KEY="value with spaces"
 *   KEY='value'
 *   # 注释行
 *   （空行忽略）
 * 不支持多行值与变量插值 —— 本项目用不到，且插值容易引入难以发现的错误。
 */

import { readFileSync, existsSync } from 'node:fs';

/**
 * 解析 .env 文本为键值对（纯函数，便于测试）。
 * @param {string} text
 * @returns {Record<string,string>}
 */
export function parseEnv(text) {
  const out = {};
  if (typeof text !== 'string') return out;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    // 跳过空行与注释
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    if (!key) continue;

    let value = line.slice(eq + 1).trim();

    // 剥离配对引号（支持值内含空格）
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }

    out[key] = value;
  }
  return out;
}

/**
 * 把 .env 载入 process.env（不覆盖已存在的变量）。
 *
 * @param {string} envPath .env 文件路径
 * @param {object} [target] 目标对象，默认 process.env（测试时可传普通对象）
 * @returns {{loaded:boolean, count:number, path:string}} 载入结果，绝不抛异常
 */
export function loadEnv(envPath, target = process.env) {
  try {
    if (!envPath || !existsSync(envPath)) {
      return { loaded: false, count: 0, path: envPath || '' };
    }
    const parsed = parseEnv(readFileSync(envPath, 'utf8'));
    let count = 0;
    for (const [k, v] of Object.entries(parsed)) {
      // 已存在的环境变量优先 —— 部署平台注入的配置永远赢
      if (target[k] === undefined || target[k] === '') {
        target[k] = v;
        count += 1;
      }
    }
    return { loaded: true, count, path: envPath };
  } catch {
    // 读取失败（权限/编码）不能影响服务启动 —— 降级为「无凭证」照常可跑
    return { loaded: false, count: 0, path: envPath || '' };
  }
}
