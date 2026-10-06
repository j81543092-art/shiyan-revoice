/**
 * 服务入口
 *
 * 启动：node server/index.js
 * 端口：PORT 环境变量，默认 3000
 *
 * 华为云凭证到位后（.env 或环境变量）：
 *   HW_MAAS_API_KEY / HW_MODEL_ENDPOINT / HW_MODEL  → 自动切到华为云
 *   （Bearer API Key 认证；AK/SK 签名是管控面 API 用的，与推理接口无关）
 * 未配置时自动降级到规则引擎，全链路照常可跑 —— 演示不中断。
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './api/routes.js';
import { PROMPT_V1 } from './model/prompt.js';
import { loadEnv } from './data/env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 必须在任何 provider 构造之前加载 —— provider 在构造时就读取 process.env，
// 晚一步加载就会导致「明明配了凭证却仍走规则引擎」的静默降级。
const envResult = loadEnv(join(__dirname, '..', '.env'));

const PORT = Number(process.env.PORT) || 3000;
// 部署环境必须绑定 0.0.0.0（容器内反代才能访问）。
// 本地开发同样可用；HOST 环境变量可覆盖。
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = join(__dirname, '..', 'public');

const { server, engine } = createApp({
  publicDir: PUBLIC_DIR,
  modelConfig: {
    provider: process.env.MODEL_PROVIDER || '',
    huawei: {},
    openai: {},
  },
});

server.listen(PORT, HOST, () => {
  const provider = engine.provider.id;
  const available = engine.provider.available();
  const line = '─'.repeat(58);
  console.log(`\n${line}`);
  console.log('  拾言 ReVoice · 意图重建沟通助手');
  console.log(`  AI 出候选，人做确认 —— 把「AI 猜」变成「人确认」`);
  console.log(line);
  console.log(`  监听地址   http://${HOST}:${PORT}`);
  console.log(`  患者端     /                  家属端 /caregiver.html`);
  console.log(`  意图理解   provider = ${provider}${available ? '' : '（未配置凭证，使用规则引擎兜底）'}`);
  console.log(`  环境变量   ${envResult.loaded ? `.env 已载入 ${envResult.count} 项` : '未找到 .env，使用外部环境变量'}`);
  console.log(`  prompt     ${PROMPT_V1.version} · ${PROMPT_V1.date}`);
  console.log(line);
  console.log('  合规声明：辅助沟通工具，不做诊断与疗效承诺');
  console.log(`${line}\n`);
});
