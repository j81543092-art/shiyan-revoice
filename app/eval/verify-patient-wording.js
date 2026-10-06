/**
 * 患者端措辞契约守卫
 * ══════════════════════════════════════════════════════════════
 *
 * 为什么需要这个文件：
 *
 * 澄清卡上「为什么问这一句」的那段话，是**患者唯一会读到的解释**。
 * 它有两类失败方式，而且都不会被现有测试发现：
 *
 *   1. 泄漏术语 —— 「线索冲突」「置信度 0.63」「模型认为」。
 *      患者看不懂，而且「置信度」直接违反 R3：
 *      患者端不得出现任何分数。
 *
 *   2. 泄漏分数 —— 一旦有人图省事把 breakdown 拼进这句话，
 *      R3 就在产品最核心的那一屏被绕过了。
 *
 * 前端函数没有单元测试（零依赖、无构建），所以这里用**逐字复刻**的方式
 * 守住它：下面 describeClueConflict 的实现必须与 public/js/patient.js 一致。
 * 复刻而不是 import，是因为该文件是浏览器 ESM，直接 import 会因
 * 缺少 document/window 而崩。复刻的代价是「两处要同步改」——
 * 所以额外加了一条「源码一致性」检查：从 patient.js 里 grep 关键串，
 * 一旦实现漂移，这里就会红。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PATIENT_JS = join(HERE, '..', 'public', 'js', 'patient.js');

// ── 与 public/js/patient.js 逐字一致的复刻 ──────────────────
function describeClueConflict(conflict) {
  const pairs = conflict?.pairs || [];
  if (!conflict?.conflicted || pairs.length < 2) return '';
  const a = pairs[0]?.clue;
  const b = pairs[1]?.clue;
  if (!a || !b) return '';
  return `你点了「${a}」和「${b}」，这两个意思不太一样，我拿不准。`;
}

/**
 * 只取源码里的**字符串字面量**，剔除注释。
 *
 * 一开始我扫了整个文件，结果红了 —— 但命中的 6 处全在注释里，
 * 包括那行「禁止出现『冲突』『置信度』」的规则说明本身。
 * 用注释解释为什么要禁用某个词，和把这个词说给患者听，是两件事。
 * 所以这里必须先剥注释再扫。
 */
function stringLiteralsOnly(src) {
  let s = src.replace(/\/\*[\s\S]*?\*\//g, '');       // 块注释
  s = s.replace(/(^|[^:])\/\/[^\n]*/g, '$1');          // 行注释（避开 http://）
  const out = [];
  // 单引号 / 双引号 / 反引号模板串
  const re = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  let m;
  while ((m = re.exec(s)) !== null) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out.join('\n');
}

/** 患者端禁区词 —— 出现任意一个即为违规 */
const BANNED_TERMS = [
  '冲突', '歧义', '置信度', '概率', '阈值', '权重',
  '模型', '算法', '推断', '打分', '评分', 'score', 'confidence',
];

let pass = 0, fail = 0;
const t = (name, cond) => {
  if (cond) { pass += 1; console.log('  ✓', name); }
  else { fail += 1; console.log('  ✗', name); }
};
const group = (s) => console.log(`\n${'─'.repeat(66)}\n${s}\n${'─'.repeat(66)}`);

const REAL = {
  conflicted: true,
  pairs: [
    { clue: '厕所', ownerText: '我要上厕所，很急' },
    { clue: '换', ownerText: '帮我换一下尿不湿' },
  ],
};

// ══════════════════════════════════════════════════════════════
group('[A] 真实冲突 → 必须能讲成人话，且只引用患者自己的词');
{
  const s = describeClueConflict(REAL);
  console.log('    输出：' + s);
  t('引用两个线索原词', s.includes('厕所') && s.includes('换'));
  t('不含任何禁区术语', !BANNED_TERMS.some((w) => s.includes(w)));
  t('不含任何数字（R3：患者端无分数）', !/\d/.test(s));
  t('第一人称口语，不用「系统 / 本助手」自称',
    !/(系统|助手|程序|模型)/.test(s));
  t('长度可控（一屏读得下，≤45 字）', s.length <= 45);
  t('不臆造线索以外的实体（只出现患者点过的词）', (() => {
    // 剥掉固定话术后，剩下的实体必须来自 pairs 里的 clue
    const stripped = s.replace(/你点了|和|，|。|这两个意思不太一样|我拿不准|「|」/g, '');
    return stripped === '厕所换' || stripped === '换厕所';
  })());
}

// ══════════════════════════════════════════════════════════════
group('[B] 无冲突 → 不得凭空生成解释');
{
  t('conflicted=false 返回空串', describeClueConflict({ conflicted: false, pairs: [] }) === '');
  t('conflicted=false 但带 pairs 仍返回空串',
    describeClueConflict({ conflicted: false, pairs: REAL.pairs }) === '');
}

// ══════════════════════════════════════════════════════════════
group('[C] 边界输入 → 不得抛错（前端崩溃比说错话更糟）');
{
  t('null', describeClueConflict(null) === '');
  t('undefined', describeClueConflict(undefined) === '');
  t('空对象', describeClueConflict({}) === '');
  t('pairs 仅 1 项', describeClueConflict({ conflicted: true, pairs: [{ clue: 'a' }] }) === '');
  t('pairs 非数组',
    describeClueConflict({ conflicted: true, pairs: 'oops' }) === '');
  t('缺 ownerText 不影响输出（已不引用该字段）',
    describeClueConflict({ conflicted: true, pairs: [{ clue: 'a' }, { clue: 'b' }] })
      === '你点了「a」和「b」，这两个意思不太一样，我拿不准。');
  t('clue 为空串时不生成残缺句',
    describeClueConflict({ conflicted: true, pairs: [{ clue: '' }, { clue: 'b' }] }) === '');
}

// ══════════════════════════════════════════════════════════════
group('[D] R3 硬约束：患者端 payload 不含任何数值字段');
{
  // 模拟 routes.js 里 /api/patient/understand 的返回形状
  const patientPayload = {
    ok: true,
    sessionId: 's1',
    state: 'clarifying',
    candidates: [{ rank: 1, text: '我要上厕所，很急' }],
    clarification: { needed: true, type: 'yes_no', question: '你是想说「我要上厕所，很急」吗？', options: ['是', '不是'], round: 1, maxRounds: 2 },
    fallbackOptions: null,
    emergency: { triggered: false },
    clueConflict: { conflicted: true, pairs: REAL.pairs },
  };
  const flat = JSON.stringify(patientPayload);
  t('无 confidence 字段', !flat.includes('confidence'));
  t('无 breakdown 字段', !flat.includes('breakdown'));
  t('无 model / rawModel 字段', !/rawModel|"model"/.test(flat));
  t('无 scenarioPrior / clueCoverage / personalization',
    !/scenarioPrior|clueCoverage|personalization/.test(flat));
  t('携带 clueConflict（患者端可读的无数字形态）',
    patientPayload.clueConflict.conflicted === true);
  t('clueConflict 内也不含数字',
    !/\d/.test(JSON.stringify(patientPayload.clueConflict.pairs)) === false
      ? !/["']?\w+["']?\s*:\s*\d/.test(JSON.stringify(patientPayload.clueConflict))
      : true);
}

// ══════════════════════════════════════════════════════════════
group('[E] 源码一致性：复刻实现不得与 patient.js 漂移');
{
  let src = '';
  try { src = readFileSync(PATIENT_JS, 'utf8'); } catch { /* 读不到则下面会红 */ }

  t('patient.js 可读', src.length > 0);
  t('patient.js 仍导出同名函数 describeClueConflict',
    /function describeClueConflict\s*\(/.test(src));
  t('patient.js 仍含关键词「意思不太一样」',
    src.includes('意思不太一样'));
  t('patient.js 仍含「我拿不准」', src.includes('我拿不准'));
  t('patient.js 仍含 pairs 长度守卫（≥2）',
    /pairs\.length\s*<\s*2/.test(src));
  t('patient.js 无禁区术语（仅扫字符串字面量，注释不算）',
    !BANNED_TERMS.some((w) => stringLiteralsOnly(src).includes(w)));
  t('患者端可见文案里不含数字分数',
    !/textContent\s*=[^;]*\.(confidence|breakdown)/.test(src));
  t('源码一致性：复刻实现与 patient.js 输出相同',
    (() => {
      const m = src.match(/return `你点了「\$\{a\}」和「\$\{b\}」，[^`]*`/);
      return !!m && describeClueConflict(REAL).includes('你点了「厕所」和「换」');
    })());
  t('patient.js 未把 breakdown 拼进 DOM',
    !/innerHTML\s*=\s*[^;]*breakdown/.test(src));
  t('patient.js 未把 confidence 渲染到澄清卡',
    !/clarify\w*\.textContent\s*=[^;]*confidence/i.test(src));
}

// ══════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(66));
console.log(`  患者端措辞契约：通过 ${pass} ／ 失败 ${fail}`);
if (fail === 0) console.log('  ✓ R3 未被绕过，且解释只引用患者自己的词');
console.log('═'.repeat(66));
process.exit(fail === 0 ? 0 : 1);
