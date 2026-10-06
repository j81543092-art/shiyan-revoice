/**
 * 逐一试跑候选模型，找出真正可用且符合本项目契约的那个
 *
 * 判定标准不只是「HTTP 200」，还要看：
 *   1. 能否稳定输出严格 JSON（本项目的输出契约）
 *   2. 响应速度（患者端等不起）
 *   3. 是否遵守「第一阶段人称口语、≤15字」等 R8 约束
 */

import { loadEnv } from '../server/data/env.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv(join(__dirname, '..', '.env'));

const CANDIDATES = [
  'deepseek-v4.1-flash',
  'deepseek-v4-flash',
  'qwen3-32b',
  'glm-5.3',
  'openpangu-2.0-pro',
  'kimi-k2.6',
];

const apiKey = process.env.HW_MAAS_API_KEY;

const SYSTEM = `你是失语症患者的意图理解助手。
根据线索输出 3 个候选意图，只输出 JSON，不要任何解释。
第一人称口语，每条不超过 15 字，不得臆造线索中不存在的对象。
格式：{"candidates":[{"text":"...","model_confidence":0.0}]}`;

const USER = '场景：如厕。线索：图标「厕所」「急」。请输出候选。';

for (const model of CANDIDATES) {
  const t0 = Date.now();
  try {
    const res = await fetch('https://api.modelarts-maas.com/v2/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: USER },
        ],
        temperature: 0.2,
        max_tokens: 300,
        stream: false,
      }),
      signal: AbortSignal.timeout(40000),
    });
    const ms = Date.now() - t0;
    const raw = await res.text();

    if (!res.ok) {
      console.log(`\n✗ ${model}  HTTP ${res.status}  (${ms}ms)`);
      console.log(`   ${raw.slice(0, 200)}`);
      continue;
    }

    let content = '';
    try {
      const j = JSON.parse(raw);
      content = j?.choices?.[0]?.message?.content ?? j?.result?.content ?? '';
    } catch { content = raw; }

    const cleaned = content.replace(/```(?:json)?/gi, '').trim();
    const s = cleaned.indexOf('{');
    const e = cleaned.lastIndexOf('}');
    let parsed = null;
    if (s >= 0 && e > s) {
      try { parsed = JSON.parse(cleaned.slice(s, e + 1)); } catch { /* JSON 不合法 */ }
    }

    console.log(`\n${parsed ? '✓' : '△'} ${model}  HTTP 200  (${ms}ms)  JSON=${parsed ? '合法' : '解析失败'}`);
    if (parsed?.candidates) {
      for (const c of parsed.candidates.slice(0, 3)) console.log(`   ${c.text}  (${c.model_confidence})`);
      console.log(`   字数检查：${parsed.candidates.map((c) => [...String(c.text)].length).join('/')}`);
    } else {
      console.log(`   原始输出：${cleaned.slice(0, 200)}`);
    }
  } catch (err) {
    console.log(`\n✗ ${model}  ${err?.name === 'TimeoutError' ? '超时(40s)' : err.message}  (${Date.now() - t0}ms)`);
  }
}
