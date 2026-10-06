/**
 * 前端界面契约守卫
 * ══════════════════════════════════════════════════════════════
 *
 * 为什么需要这个文件：
 *
 * 前端是这个项目里**唯一没有任何自动化保护**的部分。
 * test:all 里的 7 个套件全部只测服务端（引擎、路由、措辞、语音）。
 * 结果就是：CSS 里一个写错的 min-height 把患者端按钮压到 20px，
 * 或者某次「顺手优化」把 84px 触控目标改小，没有任何测试会红。
 *
 * 而这里要守的恰恰是**最难靠人工发现**的一类错误：
 *   - 触控目标被媒体查询悄悄改小 —— 桌面端看不出来，只有真实患者手抖时才知道
 *   - R3 泄漏 —— 患者端一旦出现分数，产品立意就塌了（已有 wording 守卫，
 *     但那只扫 patient.js，扫不到 HTML 与 CSS 把数字漏出去的情况）
 *   - 响应式断点被删除 —— 页面在平板上仍然"能用"，只是布局塌了
 *
 * 这些都是「改一行 CSS、没人会注意」的退化。所以必须有机器守着。
 *
 * 手法与 verify-patient-wording.js 一致：纯文本解析，零依赖。
 * 这里不做真实渲染（无浏览器依赖，保持 `node eval/...` 可直接跑），
 * 真实渲染另有 verify-frontend-render.js 用本地 Edge/Chrome 无头完成。
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUB = join(HERE, '..', 'public');

const read = (rel) => readFileSync(join(PUB, rel), 'utf8');

const FILES = {
  appCss: 'css/app.css',
  caregiverCss: 'css/caregiver.css',
  authCss: 'css/auth.css',
  indexHtml: 'index.html',
  caregiverHtml: 'caregiver.html',
  loginHtml: 'login.html',
  accountHtml: 'account.html',
  patientJs: 'js/patient.js',
  caregiverJs: 'js/caregiver.js',
};

const SRC = {};
for (const [k, rel] of Object.entries(FILES)) {
  SRC[k] = existsSync(join(PUB, rel)) ? read(rel) : '';
}

let pass = 0, fail = 0;
const t = (name, cond) => {
  if (cond) { pass += 1; console.log('  ✓', name); }
  else { fail += 1; console.log('  ✗', name); }
};
const group = (s) => console.log(`\n${'─'.repeat(66)}\n${s}\n${'─'.repeat(66)}`);

// ══════════════════════════════════════════════════════════════
// 工具：把 CSS 拆成「基础块 + 每个 media query 块」
// ══════════════════════════════════════════════════════════════

/**
 * 提取所有 `@media <condition> { ... }` 的顶层块。
 * 用括号配平而不是正则，因为 media 块内部还有嵌套规则。
 */
function extractMediaBlocks(css) {
  const out = [];
  const re = /@media([^{]+)\{/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const cond = m[1].trim();
    let depth = 1;
    let i = re.lastIndex;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') depth -= 1;
      i += 1;
    }
    out.push({ cond, body: css.slice(re.lastIndex, i - 1) });
    re.lastIndex = i;
  }
  return out;
}

/**
 * 去掉所有 @media / @supports 块，得到「基础样式」。
 *
 * 不能循环「找 @media 起点→配平→删除」：
 * 每轮 indexOf 在已删过一段的字符串上重新定位，遇到重复条件（这里有多个
 * max-width:420px）就会错位，删掉半截块、留下 `:root {` 残片，
 * 于是后续 declsOf(':root') 拿到的是残片而不是真声明 —— 表现为
 * 「--target 不存在」这种指错方向的失败。
 * 改成一次扫描、按字符级状态机整体重建，不留残片。
 */
function baseOf(css) {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const at = css.indexOf('@media', i);
    const sup = css.indexOf('@supports', i);
    let next = -1;
    if (at < 0) next = sup;
    else if (sup < 0) next = at;
    else next = Math.min(at, sup);

    if (next < 0) { out += css.slice(i); break; }

    out += css.slice(i, next);
    // 从 at-rule 的 `{` 开始配平跳过整个块
    let j = css.indexOf('{', next);
    if (j < 0) { out += css.slice(next); break; }
    let depth = 1;
    j += 1;
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth += 1;
      else if (css[j] === '}') depth -= 1;
      j += 1;
    }
    i = j;
  }
  return out;
}

/**
 * 从一段 CSS 里取出某选择器**所有**匹配规则块的声明（逗号分组也算）。
 *
 * 为什么不用正则：试过三版正则，每版都被真实样式表的某个特性打败 ——
 *   1. 分组选择器 `.a, .b, .c { ... }`：只比单选择器会整条漏掉
 *   2. 伪类后缀 `.tab:hover`：取「最后一次匹配」会拿到 :hover 而不是基础声明
 *   3. 前导边界：规则块前面可能是块注释收尾、可能缺分号、可能紧跟上一个 `}`
 *      —— `(?:^|[;}])` 这类锚点无法同时覆盖，结果 `.keyword-input`
 *      这种紧跟在 `}` 之后的规则整条匹配不到，返回空串，
 *      再被上层解读成「没有 min-height」，指错方向。
 * 换成一次扫描的字符级状态机：先剥注释，然后逐个 '{' 回溯出选择器文本。
 * 没有边界假设，也就没有边界 bug。
 */
function declsOf(css, selector) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  // 跳过 @media/@supports 的条件部分，它们的 '{' 不是规则块的开始
  const atRule = new Set(['@media', '@supports', '@keyframes', '@font-face', '@import', '@charset', '@layer']);

  let i = 0;
  let selStart = 0;   // 当前候选选择器的起始位置
  while (i < clean.length) {
    const ch = clean[i];
    if (ch === '{') {
      const rawSel = clean.slice(selStart, i).trim();
      // 判断是不是 at-rule 头
      const isAt = [...atRule].some((a) => rawSel.startsWith(a)) || rawSel.startsWith('@');
      if (isAt) {
        // at-rule：跳过它直到配平的 '}'，内部规则暂不深入（基础态里 @media 已被剥）
        let depth = 1; i += 1;
        while (i < clean.length && depth > 0) {
          if (clean[i] === '{') depth += 1;
          else if (clean[i] === '}') depth -= 1;
          i += 1;
        }
        selStart = i;
        continue;
      }
      // 普通规则：读它的声明体
      const bodyStart = i + 1;
      let depth = 1; i = bodyStart;
      while (i < clean.length && depth > 0) {
        if (clean[i] === '{') depth += 1;
        else if (clean[i] === '}') depth -= 1;
        i += 1;
      }
      const body = clean.slice(bodyStart, i - 1);
      const selectors = rawSel.split(',').map((s) => s.replace(/[\s\n]+/g, ' ').trim());
      if (selectors.includes(selector)) out.push(body);
      selStart = i;
      continue;
    }
    // '}' 或 ';' 之后，选择器重新开始计
    if (ch === '}' || ch === ';') selStart = i + 1;
    i += 1;
  }
  return out.join(';');
}

/** 取最后一次出现的属性值（CSS 后写的胜出） */
function px(decls, prop) {
  const re = new RegExp(`(?:^|[;{\\s])${prop.replace(/[-]/g, '\\-')}\\s*:\\s*([^;]+)`, 'g');
  let m, last = null;
  while ((m = re.exec(decls)) !== null) last = m[1].trim();
  if (last === null) return null;
  const num = last.match(/^(-?[\d.]+)px$/);
  if (num) return Number(num[1]);
  return last; // var(...) / % / calc(...)
}

// ══════════════════════════════════════════════════════════════
group('[A] 文件完整性：响应式改造不得删掉任何一个页面');
{
  for (const [k, rel] of Object.entries(FILES)) {
    t(`${rel} 存在且非空`, SRC[k].length > 0);
  }
}

// ══════════════════════════════════════════════════════════════
group('[B] 响应式断点必须存在（曾经 caregiver.css 一条都没有）');
{
  const appBlocks = extractMediaBlocks(SRC.appCss);
  const cgBlocks = extractMediaBlocks(SRC.caregiverCss);
  const authBlocks = extractMediaBlocks(SRC.authCss);

  t('app.css 断点数 ≥ 4（手机/横屏/平板/大屏）', appBlocks.length >= 4);
  t('caregiver.css 断点数 ≥ 3（这是曾经的零断点文件）', cgBlocks.length >= 3);
  t('auth.css 断点数 ≥ 2', authBlocks.length >= 2);

  const appConds = appBlocks.map((b) => b.cond).join(' ');
  t('app.css 覆盖窄屏 ≤420px', /max-width:\s*420px/.test(appConds));
  t('app.css 覆盖低高度（横屏手机） max-height', /max-height/.test(appConds));
  t('app.css 覆盖平板区间 min-width', /min-width/.test(appConds));
  t('app.css 覆盖大屏 ≥1100px', /min-width:\s*1100px/.test(appConds));

  const cgConds = cgBlocks.map((b) => b.cond).join(' ');
  t('caregiver.css 覆盖 ≤1024px（表格转卡片阈值）', /max-width:\s*1024px/.test(cgConds));
  t('caregiver.css 覆盖手机 ≤700px', /max-width:\s*700px/.test(cgConds));
  t('caregiver.css 覆盖大屏 ≥1440px', /min-width:\s*1440px/.test(cgConds));
  t('caregiver.css 含打印样式（家属要打给医生）', /@media\s+print/.test(SRC.caregiverCss));
}

// ══════════════════════════════════════════════════════════════
group('[C] 红线二：任何断点下可点元素都不得低于 44px（WCAG 2.2 底线）');
{
  // 每个受保护的选择器 + 它声明 min-height/height 的属性名
  const GUARDED = [
    { file: 'appCss', sel: '.icon-cell', prop: 'min-height' },
    { file: 'appCss', sel: '.btn-primary', prop: 'min-height' },
    { file: 'appCss', sel: '.btn-secondary', prop: 'min-height' },
    { file: 'appCss', sel: '.voice-btn', prop: 'min-height' },
    { file: 'appCss', sel: '.keyword-input', prop: 'min-height' },
    { file: 'appCss', sel: '.candidate-card', prop: 'min-height' },
    { file: 'appCss', sel: '.clarify-btn', prop: 'min-height' },
    { file: 'appCss', sel: '.scenario-tab', prop: 'min-height' },
    { file: 'caregiverCss', sel: '.tab', prop: 'min-height' },
    { file: 'caregiverCss', sel: '.btn-mini', prop: 'min-height' },
    { file: 'caregiverCss', sel: '.btn-primary', prop: 'min-height' },
  ];

  // 44px 是 WCAG 2.2 的下限；患者端实际标准（--target）是 84px。
  // 这里守 44 是绝对地板 —— 任何人想再低就必须先改这条断言。
  const FLOOR = 44;

  for (const g of GUARDED) {
    const css = SRC[g.file];
    const base = px(declsOf(baseOf(css), g.sel), g.prop);
    const blocks = extractMediaBlocks(css);

    // 基础值：可能是 var(--target)，那就是 84px
    let basePx = null;
    if (typeof base === 'number') basePx = base;
    else if (typeof base === 'string' && base.includes('--target')) {
      const rootDecls = declsOf(baseOf(css), ':root');
      basePx = px(rootDecls, '--target');
    }

    t(`${g.file} ${g.sel} 基础 ${g.prop} ≥ ${FLOOR}px`,
      typeof basePx === 'number' ? basePx >= FLOOR : (g.prop === 'min-height' ? false : true));

    // 每个 media 块里若重写了同属性，也必须 ≥ FLOOR
    for (const b of blocks) {
      const d = declsOf(b.body, g.sel);
      if (!d) continue;
      const v = px(d, g.prop);
      if (v === null) continue;
      if (typeof v === 'string') continue; // var() 等，主断言已覆盖
      t(`${g.file} ${g.sel} 在「${b.cond}」下 ${g.prop} = ${v}px ≥ ${FLOOR}px`, v >= FLOOR);
    }
  }
}

// ══════════════════════════════════════════════════════════════
group('[D] 红线二：患者端基础触控目标仍是 84px（不得被悄悄改小）');
{
  const rootDecls = declsOf(baseOf(SRC.appCss), ':root');
  const target = px(rootDecls, '--target');
  t('--target 存在', target !== null);
  t('--target = 84px（远高于 WCAG 24px 下限）', target === 84);
  t('.icon-cell 使用 var(--target)', /min-height:\s*var\(--target\)/.test(SRC.appCss));
  t('.voice-btn 使用 var(--target)', /\.voice-btn[^}]*min-height:\s*var\(--target\)/s.test(SRC.appCss));
  t('关键按钮不是小字链接（按钮都有实心背景或边框）',
    /\.clarify-btn\s*\{[^}]*border:\s*3px solid/s.test(SRC.appCss));
  t('删除键 26px 的取舍有注释说明（不是遗漏）',
    /26px[\s\S]{0,300}?次要且可逆|次要且可逆/.test(SRC.appCss));

  // .screen 是 flex 列容器，子项默认 flex-shrink:1。
  // .scenario-tabs 是 overflow-x:auto 的横向滚动容器，
  // 高度由内容决定 —— 一旦参与收缩就塌成几像素，标签被裁成一条缝。
  // 真机实测：667×375 上 h=8px，患者根本看不到场景入口。
  // 这条是源码层能提前拦住的闸门（渲染层那条见 verify-frontend-render.js）。
  // 注意：declsOf 返回的是**声明体字符串**（多条声明用 ';' 拼起来），不是对象。
  const tabsDecls = declsOf(baseOf(SRC.appCss), '.scenario-tabs');
  const mFlex = tabsDecls.match(/flex:\s*([^;}]+)/);
  const mShrink = tabsDecls.match(/flex-shrink:\s*([^;}]+)/);
  const flexRaw = (mFlex ? mFlex[1] : '') + ' ' + (mShrink ? mShrink[1] : '');
  const notShrinking = /(^|\s)0(\s|$)/.test(flexRaw.trim());
  t('.scenario-tabs 声明了不参与收缩（flex: 0 0 auto）', notShrinking,
    `实测值：flex=${mFlex ? mFlex[1].trim() : '（未声明）'} —— 未声明时在 .screen 里会被压到 8px`);
  t('该约束带有原因注释（防止后人「优化」掉）',
    /scenario-tabs[\s\S]{0,400}?flex-shrink|flex-shrink:1|被压/.test(SRC.appCss));
}

// ══════════════════════════════════════════════════════════════
group('[E] R3：患者端 HTML/CSS/JS 都不得泄漏数值字段');
{
  const banned = ['confidence', 'breakdown', 'rawModel', 'scenarioPrior',
    'clueCoverage', 'personalization'];

  // HTML
  for (const f of ['indexHtml']) {
    for (const w of banned) {
      t(`${FILES[f]} 不含 ${w}`, !SRC[f].includes(w));
    }
  }
  // 患者端 JS：只扫字符串字面量与 DOM 操作（注释允许提到 R3）
  const pjs = SRC.patientJs
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  for (const w of banned) {
    t(`patient.js 代码（非注释）不含 ${w}`, !pjs.includes(w));
  }
  t('patient.js 未把 res.confidence 渲染进 DOM',
    !/textContent\s*=\s*[^;]*res\.confidence/.test(pjs));
  t('患者端候选卡只渲染 rank 与 text（R2/R3）',
    /rank-badge/.test(SRC.patientJs) && /c\.text/.test(SRC.patientJs));
}

// ══════════════════════════════════════════════════════════════
group('[F] 表格转卡片：9 列表格在窄屏必须能读（家属端核心可用性）');
{
  const css = SRC.caregiverCss;
  const mq = extractMediaBlocks(css).find((b) => /max-width:\s*1024px/.test(b.cond));
  t('存在 ≤1024px 的媒体块', !!mq);

  const body = mq ? mq.body : '';
  t('窄屏隐藏 thead', /\.data-table\s+thead\s*\{[^}]*display:\s*none/.test(body));
  t('窄屏解除 min-width:1080px 的横向滚动',
    /\.data-table\s*\{[^}]*min-width:\s*0/s.test(body));
  t('窄屏解除 table-wrap 横向滚动',
    /\.table-wrap\s*\{[^}]*overflow-x:\s*visible/s.test(body));
  t('窄屏 tr 变成 grid/flex 卡片',
    /\.data-table\s+tr\s*\{[^}]*display:\s*grid/s.test(body));
  t('字段名标签 .cell-label 基础态隐藏',
    /\.cell-label\s*\{\s*display:\s*none/.test(baseOf(css)));
  t('字段名标签在窄屏显示',
    /\.cell-label\s*\{[^}]*display:\s*block/s.test(body));

  // 宽屏下 min-width:1080px 必须保留 —— 别为了修手机把桌面表格搞坏了
  t('宽屏（基础态）保留 .data-table min-width:1080px',
    /\.data-table\s*\{\s*min-width:\s*1080px/.test(SRC.caregiverCss));

  // 关键字段：线索冲突是 R4 的确定性依据，窄屏也必须直出不能折叠
  t('线索冲突列在窄屏不隐藏',
    !/\[data-field="conflict"\][^{]*\{[^}]*display:\s*none/.test(body));
  t('表达列在窄屏跨整行（主角）',
    /\[data-field="text"\][^{]*\{[^}]*grid-column:\s*1\s*\/\s*-1/s.test(body));

  // JS 必须真的输出 data-field，否则 CSS 选择器全部落空
  const cjs = SRC.caregiverJs;
  for (const f of ['time', 'scenario', 'text', 'confidence', 'calib',
    'breakdown', 'conflict', 'clues', 'rounds']) {
    t(`caregiver.js 输出 data-field="${f}"`, cjs.includes(`data-field="${f}"`));
  }
  t('caregiver.js 输出 .cell-label 字段名',
    (cjs.match(/class="cell-label"/g) || []).length >= 9);
  t('promptTable 也带 data-field', /data-field="version"/.test(cjs) && /data-field="top3"/.test(cjs));
}

// ══════════════════════════════════════════════════════════════
group('[G] topbar 不得溢出（曾经 flex 不可换行 + gap 26px）');
{
  const css = SRC.caregiverCss;
  t('.topbar 允许换行', /\.topbar\s*\{[^}]*flex-wrap:\s*wrap/s.test(css));
  t('.topbar 有安全区内边距 env(safe-area-inset',
    /\.topbar\s*\{[^}]*env\(safe-area-inset/s.test(css));
  t('.tabs 允许收缩（min-width:0）', /\.tabs\s*\{[^}]*min-width:\s*0/s.test(css));

  const m700 = extractMediaBlocks(css).find((b) => /max-width:\s*700px/.test(b.cond));
  t('≤700px 时 .tabs 可横向滚动',
    !!m700 && /\.tabs\s*\{[^}]*overflow-x:\s*auto/s.test(m700.body));
}

// ══════════════════════════════════════════════════════════════
group('[H] 三态反馈：加载 / 失败 / 空 必须可区分');
{
  const css = SRC.caregiverCss;
  t('有骨架屏样式 .skeleton', /\.skeleton\s*\{/.test(css));
  t('有失败态样式 .load-error', /\.load-error\s*\{/.test(css));
  t('失败态有重试按钮样式', /\.load-error\s+button\s*\{/.test(css));
  t('骨架屏尊重「减弱动效」', /prefers-reduced-motion[\s\S]{0,200}?\.skeleton/.test(css));

  const cjs = SRC.caregiverJs;
  t('caregiver.js 有 renderError', /function renderError\s*\(/.test(cjs));
  t('caregiver.js 有 clearError', /function clearError\s*\(/.test(cjs));
  t('取数失败时不再假装「暂无记录」',
    /res\.ok\s*\)\s*throw/.test(cjs) || /if\s*\(!res\.ok\)\s*throw/.test(cjs));
  t('四个面板各自独立容错（一个挂了不白屏）',
    (cjs.match(/renderError\('/g) || []).length >= 4);
  t('HTML 有四个错误槽位',
    ['liveError', 'recordsError', 'wordsError', 'metricsError']
      .every((id) => SRC.caregiverHtml.includes(`id="${id}"`)));
  t('刷新按钮有 loading 状态', /btn\.classList\.add\('loading'\)/.test(cjs));
}

// ══════════════════════════════════════════════════════════════
group('[I] 键盘可达性：role=tablist 声明了就必须实现方向键');
{
  const html = SRC.caregiverHtml;
  t('tabs 有 role="tablist"', /role="tablist"/.test(html));
  t('每个 tab 有 role="tab"', (html.match(/role="tab"/g) || []).length === 4);
  t('每个 tab 有 aria-selected', (html.match(/aria-selected=/g) || []).length === 4);
  t('每个 tab 有 aria-controls', (html.match(/aria-controls=/g) || []).length === 4);
  t('面板有 role="tabpanel"', (html.match(/role="tabpanel"/g) || []).length === 4);
  t('roving tabindex（只有当前 tab 为 0）', (html.match(/tabindex="0"/g) || []).length === 1);
  t('其余 tab 为 tabindex="-1"', (html.match(/tabindex="-1"/g) || []).length === 3);

  const cjs = SRC.caregiverJs;
  t('caregiver.js 处理 ArrowRight', /ArrowRight/.test(cjs));
  t('caregiver.js 处理 ArrowLeft', /ArrowLeft/.test(cjs));
  t('caregiver.js 处理 Home/End', /'Home'/.test(cjs) && /'End'/.test(cjs));
  t('activateTab 同步维护 aria-selected', /aria-selected/.test(cjs));
  t('activateTab 同步维护 tabindex', /t\.tabIndex\s*=/.test(cjs));

  // 患者端
  t('患者端 :focus-visible 有焦点环', /:focus-visible\s*\{[^}]*box-shadow/s.test(SRC.appCss));
  t('家属端 :focus-visible 有焦点环', /:focus-visible\s*\{[^}]*box-shadow/s.test(SRC.caregiverCss));
  t('患者端语音按钮支持键盘空格',
    /keydown[\s\S]{0,200}?ev\.key\s*===\s*' '[\s\S]{0,400}?keyup/s.test(SRC.patientJs));
}

// ══════════════════════════════════════════════════════════════
group('[J] 交互反馈：提交/轮询不得无限沉默');
{
  const pjs = SRC.patientJs;
  t('患者端提交有 busy 态 .btn-primary.busy', /\.btn-primary\.busy/.test(SRC.appCss));
  t('patient.js 有 setSubmitBusy', /function setSubmitBusy\s*\(/.test(pjs));
  t('提交按钮文案会变成「正在想…」', /正在想/.test(pjs));
  t('提交失败有兜底提示（不会静默）',
    /catch\s*\{\s*toast\(/.test(pjs));
  t('busy 状态有旋转指示器', /animation:\s*spin/.test(SRC.appCss));
  t('旋转指示器尊重「减弱动效」',
    /prefers-reduced-motion[\s\S]{0,300}?\.btn-primary\.busy/s.test(SRC.appCss));

  const cjs = SRC.caregiverJs;
  t('轮询在页面不可见时暂停', /document\.hidden/.test(cjs));
  t('轮询失败不弹 toast（避免每 5 秒一次噪音）',
    /async function poll[\s\S]{0,400}?renderError[\s\S]{0,200}?\}/s.test(cjs));
  t('回到前台立刻补拉一次再恢复轮询',
    /visibilitychange[\s\S]{0,500}?startPolling/s.test(cjs));
}

// ══════════════════════════════════════════════════════════════
group('[K] 视口高度与安全区（移动端地址栏 / 刘海屏）');
{
  t('app.css 声明 --vh 兜底', /--vh:\s*100vh/.test(SRC.appCss));
  t('app.css 支持 @supports (height:100dvh)', /@supports\s*\(height:\s*100dvh\)/.test(SRC.appCss));
  t('.stage 使用 --vh', /\.stage\s*\{[^}]*height:\s*var\(--vh\)/s.test(SRC.appCss));
  t('紧急按钮避开安全区（R6 通道不能被切角）',
    /\.emergency-btn\s*\{[^}]*env\(safe-area-inset-right/s.test(SRC.appCss));
  t('账号入口避开安全区',
    /\.account-link\s*\{[^}]*env\(safe-area-inset-left/s.test(SRC.appCss));
  t('caregiver.css body 使用 dvh', /min-height:\s*100dvh/.test(SRC.caregiverCss));
  t('auth.css body 使用 dvh', /min-height:\s*100dvh/.test(SRC.authCss));
  t('patient.js 有 applyViewportHeight', /function applyViewportHeight\s*\(/.test(SRC.patientJs));
  t('patient.js 监听 visualViewport',
    /visualViewport/.test(SRC.patientJs));
}

// ══════════════════════════════════════════════════════════════
group('[L] 样式归属：新增内联 <style> / 内联 style= 视为回归');
{
  // account.html 的样式已收口到 auth.css。再出现内联块说明又走回头路了。
  for (const f of ['indexHtml', 'caregiverHtml', 'loginHtml', 'accountHtml']) {
    t(`${FILES[f]} 无内联 <style> 块`, !/<style[\s>]/.test(SRC[f]));
  }
  t('account.html 不再有内联 style= 属性',
    !/\sstyle="/.test(SRC.accountHtml));
  t('auth.css 提供 .acct-row（账号页样式已收口）', /\.acct-row\s*\{/.test(SRC.authCss));
  t('auth.css 提供 .acct-actions', /\.acct-actions\s*\{/.test(SRC.authCss));

  // 两个页面的账号角标脚本必须一致 —— 曾经 caregiver.html 漏了
  t('index.html 加载 cloud-config.js',
    /js\/cloud-config\.js/.test(SRC.indexHtml));
  t('caregiver.html 加载 cloud-config.js',
    /js\/cloud-config\.js/.test(SRC.caregiverHtml));
  t('caregiver.html 加载 session-badge.js',
    /js\/session-badge\.js/.test(SRC.caregiverHtml));
  t('caregiver.html 提供 #accountLink 供角标使用',
    /id="accountLink"/.test(SRC.caregiverHtml));
}

// ══════════════════════════════════════════════════════════════
group('[M] 视觉细节：报告里写过的每一条取舍都还在');
{
  const app = SRC.appCss;
  t('图标网格 minmax 168px 及原因注释仍在',
    /minmax\(168px, 1fr\)/.test(app) && /尿不湿/.test(app));
  t('选中态内描边及原因注释仍在', /inset 0 0 0 var\(--ring-inset\)/.test(app));
  t('首位候选品牌色描边（R3 的视觉落地）仍在', /\.candidate-card\.top\s*\{/.test(app));
  t('.clarify-why 中性色及原因注释仍在',
    /\.clarify-why\s*\{/.test(app) && /不是「你出错了」/.test(app));
  t('托盘 chip 长词不撑破托盘仍在', /word-break:\s*break-word/.test(app));
  t('reduced-motion 关闭 voiceGlow 与 meter 仍在',
    /prefers-reduced-motion[\s\S]{0,300}?voiceGlow[\s\S]{0,200}?meter|prefers-reduced-motion[\s\S]{0,300}?\.voice-meter/s.test(app));

  const cg = SRC.caregiverCss;
  t('家属端保留 .hint-note 左侧线', /\.hint-note\s*\{[^}]*border-left/s.test(cg));
  t('家属端保留 tabular-nums（刷新时不抖）', /tabular-nums/.test(cg));
  t('家属端保留 .warn / .ok-quiet', /\.warn\s*\{/.test(cg) && /\.ok-quiet/.test(cg));
  t('家属端保留 .delta（压掉多少可复核）', /\.delta\s*\{/.test(cg));
  t('紧急横幅样式仍在', /\.emg-banner\s*\{/.test(cg));
}

// ══════════════════════════════════════════════════════════════
group('[N] CSS 结构完整性：括号配平、无空规则块');
{
  for (const [k, rel] of Object.entries(FILES)) {
    if (!rel.endsWith('.css')) continue;
    const css = SRC[k];
    const o = (css.match(/\{/g) || []).length;
    const c = (css.match(/\}/g) || []).length;
    t(`${rel} 大括号配平（${o}/${c}）`, o === c);
    t(`${rel} 无未闭合的注释`, !/\/\*(?:(?!\*\/)[\s\S])*$/.test(css));
  }
}

// ══════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(66));
console.log(`  前端界面契约：通过 ${pass} ／ 失败 ${fail}`);
if (fail === 0) {
  console.log('  ✓ 触控目标、R3、响应式断点、三态反馈、键盘可达性全部达标');
}
console.log('═'.repeat(66));
process.exit(fail === 0 ? 0 : 1);
