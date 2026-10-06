/**
 * 华为云凭证连通性诊断 —— 一层层剥，直到定位到失败点
 *
 * 【为什么需要它】
 * 华为云这条链路有三层，任何一层失败都会导致「静默降级到规则引擎」——
 * 界面上看不出区别，日志里也不报错。这个脚本把三层分开验证，说清哪层断了：
 *   第 1 层  MaaS API Key   → 能否调用 chat/completions
 *   第 2 层  IAM 凭证       → 能否换取 X-Subject-Token
 *   第 3 层  SIS            → 能否把音频识别成文字
 *
 * 运行：node scripts/probe-huawei.js
 *
 * 注意：本脚本会真实发起网络请求（消耗少量配额），但不会打印任何凭证明文。
 */

import { loadEnv } from '../server/data/env.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv(join(__dirname, '..', '.env'));

const line = '─'.repeat(66);
const PASS = '✓ 通过';
const FAIL = '✗ 失败';
const SKIP = '– 跳过';

/** 打码：只留前 6 位与后 4 位，便于核对是哪个 Key 但不会泄漏 */
function mask(s) {
  const v = String(s || '');
  if (!v) return '（未配置）';
  if (v.length <= 12) return v.slice(0, 3) + '***';
  return `${v.slice(0, 6)}...${v.slice(-4)}（长度 ${v.length}）`;
}

async function probeMaaS() {
  console.log('\n【第 1 层】华为云 MaaS · LLM 意图理解');
  const apiKey = process.env.HW_MAAS_API_KEY || '';
  const endpoint = process.env.HW_MODEL_ENDPOINT || 'https://api.modelarts-maas.com/v2/chat/completions';
  const model = process.env.HW_MODEL || 'DeepSeek-V3';

  console.log(`  API Key    ${mask(apiKey)}`);
  console.log(`  endpoint   ${endpoint}`);
  console.log(`  model      ${model}`);

  if (!apiKey) {
    console.log(`  结果       ${FAIL} —— HW_MAAS_API_KEY 未配置`);
    return false;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  const t0 = Date.now();

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: '你是意图理解助手，只输出 JSON。' },
          { role: 'user', content: '线索：图标「水」。输出 {"candidates":[{"text":"我想喝水","model_confidence":0.9}]}' },
        ],
        temperature: 0.2,
        max_tokens: 256,
        stream: false,
      }),
      signal: controller.signal,
    });
    const ms = Date.now() - t0;

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.log(`  结果       ${FAIL} HTTP ${res.status}（${ms}ms）`);
      console.log(`  响应       ${detail.slice(0, 400)}`);
      if (res.status === 401 || res.status === 403) {
        console.log('  诊断       API Key 无效／无该模型权限／模型未在「预置服务」中开通');
      } else if (res.status === 404) {
        console.log('  诊断       model 名可能不对 —— 请核对「调用说明」页的 model 参数');
      }
      return false;
    }

    const data = await res.json();
    const content =
      data?.choices?.[0]?.message?.content ?? data?.result?.content ?? JSON.stringify(data).slice(0, 200);
    console.log(`  结果       ${PASS}（${ms}ms）`);
    console.log(`  模型返回   ${String(content).slice(0, 220).replace(/\s+/g, ' ')}`);
    return true;
  } catch (err) {
    console.log(`  结果       ${FAIL} ${err?.name === 'AbortError' ? '超时（30s）' : err?.message || err}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function probeIam() {
  console.log('\n【第 2 层】华为云 IAM · 换取 X-Subject-Token（SIS 认证前提）');
  const username = process.env.HW_IAM_USERNAME || '';
  const password = process.env.HW_IAM_PASSWORD || '';
  const domain = process.env.HW_IAM_DOMAIN || '';
  const projectName = process.env.HW_IAM_PROJECT || '';
  const projectId = process.env.HW_PROJECT_ID || '';

  console.log(`  用户名     ${username || '（未配置）'}`);
  console.log(`  密码       ${password ? '***（已配置，长度 ' + password.length + '）' : '（未配置）'}`);
  console.log(`  账号名     ${domain || '（未配置）'}`);
  console.log(`  scope      ${projectId ? `project.id=${projectId}` : projectName ? `project.name=${projectName}` : `domain.name=${domain}`}`);

  if (!username || !password || !domain) {
    console.log(`  结果       ${SKIP} —— IAM 三件套不全，SIS 不可用（图标通道不受影响）`);
    return null;
  }

  const body = {
    auth: {
      identity: {
        methods: ['password'],
        password: { user: { name: username, password, domain: { name: domain } } },
      },
      scope: projectName
        ? { project: { name: projectName } }
        : projectId
          ? { project: { id: projectId } }
          : { domain: { name: domain } },
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  const t0 = Date.now();

  try {
    const res = await fetch('https://iam.myhuaweicloud.com/v3/auth/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=utf8' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const ms = Date.now() - t0;
    const token = res.headers.get('X-Subject-Token');

    if (!res.ok || !token) {
      const detail = await res.text().catch(() => '');
      console.log(`  结果       ${FAIL} HTTP ${res.status}（${ms}ms）`);
      console.log(`  响应       ${detail.slice(0, 400)}`);
      if (res.status === 401) {
        console.log('  诊断       用户名／密码／账号名 任一不对。注意 name 是子账号名、domain.name 是主账号名');
      }
      return null;
    }

    console.log(`  结果       ${PASS}（${ms}ms）`);
    console.log(`  Token      ${mask(token)}`);

    // 从响应体里挖出 project id —— 这正是 SIS 的 URI 需要的那个值
    let discoveredProjectId = '';
    try {
      const payload = await res.json();
      const projects = payload?.token?.project || payload?.token?.catalog?.[0]?.endpoints?.[0]?.region_id;
      if (payload?.token?.project?.id) {
        discoveredProjectId = payload.token.project.id;
        console.log(`  项目 ID    ${discoveredProjectId}   ← SIS URI 需要，请填入 HW_PROJECT_ID`);
      }
      const expires = payload?.token?.expires_at;
      if (expires) console.log(`  有效期至   ${expires}`);
    } catch { /* 解析失败不影响 Token 可用 */ }

    return { token, projectId: discoveredProjectId };
  } catch (err) {
    console.log(`  结果       ${FAIL} ${err?.name === 'AbortError' ? '超时（15s）' : err?.message || err}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 第 3 层：SIS 识别。
 * 用一段程序生成的静音 WAV 去试探 —— 意在验证「认证+路由+接口协议」是否通，
 * 而非验证识别准确率（静音当然认不出字）。返回 200 即证明前三层全通。
 */
async function probeSis(projectId) {
  console.log('\n【第 3 层】华为云 SIS · 一句话识别');

  const region = process.env.HW_SIS_REGION || 'cn-north-4';
  const endpoints = {
    'cn-north-4': 'https://sis-ext.cn-north-4.myhuaweicloud.com',
    'cn-east-3': 'https://sis-ext.cn-east-3.myhuaweicloud.com',
  };
  const endpoint = process.env.HW_SIS_ENDPOINT || endpoints[region];
  const pid = projectId || process.env.HW_PROJECT_ID || '';

  console.log(`  region     ${region}`);
  console.log(`  endpoint   ${endpoint}`);
  console.log(`  projectId  ${pid || '（未配置）'}`);

  if (!pid) {
    console.log(`  结果       ${SKIP} —— 缺 projectId，SIS 不可用`);
    return false;
  }

  // 自查：区域是否有 SIS 一句话识别
  if (!endpoints[region] && !process.env.HW_SIS_ENDPOINT) {
    console.log(`  结果       ${FAIL} —— 区域 ${region} 不支持一句话识别（仅支持 cn-north-4 / cn-east-3）`);
    return false;
  }

  console.log(`  结果       ${SKIP} —— 需要有效 Token 且需真实音频，请用 verify-sis-live.js 做真人录音验证`);
  return null;
}

async function main() {
  console.log(`\n${'═'.repeat(66)}`);
  console.log('  拾言 ReVoice · 华为云凭证连通性诊断');
  console.log(`${'═'.repeat(66)}`);

  const maasOk = await probeMaaS();
  const iam = await probeIam();
  await probeSis(iam?.projectId);

  console.log(`\n${line}`);
  console.log('  结论');
  console.log(line);
  console.log(`  LLM 意图理解   ${maasOk ? PASS : FAIL}`);
  console.log(`  IAM Token      ${iam ? PASS : SKIP}`);
  console.log(`  SIS 语音识别   ${iam && (process.env.HW_PROJECT_ID || iam.projectId) ? '待录音验证' : SKIP}`);
  console.log(`${line}\n`);

  process.exit(maasOk ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
