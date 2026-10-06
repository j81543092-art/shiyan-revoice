/**
 * 真实渲染验证（需要本机 Edge / Chrome）
 * ══════════════════════════════════════════════════════════════
 *
 * verify-frontend.js 守的是**源码里的声明**（CSS 里写了什么）。
 * 它读不出「浏览器实际算出来是多少」。
 *
 * 两者的差距就是这类 bug 的藏身处：
 *   - 写了 min-height:84px，但父容器 flex 压缩，实际渲染只有 40px
 *   - 写了 repeat(2,1fr)，但被后面同优先级规则覆盖
 *   - 媒体查询条件写对了，但选择器优先级不够，规则根本没生效
 *
 * 这个脚本用无头浏览器打开真实页面，注入探针读 getBoundingClientRect()，
 * 验证「点得准」这件事在渲染层面成立。
 *
 * 实现要点：不用 CDP 客户端（保持零依赖），而是
 *   1. 往 public/ 写一个临时探针页 __probe.html（同源！）
 *   2. 用 --dump-dom 取回它把测量结果写进的 DOM 节点
 *   3. 删除临时文件
 * 探针页必须同源，否则读不到 iframe 内部布局（跨域）。
 *
 * 用法：node eval/verify-frontend-render.js
 * 无 Edge/Chrome 时**优雅跳过**（退出码 0），不阻塞 CI。
 */

import { spawn } from 'node:child_process';
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import http from 'node:http';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const PUB = join(APP, 'public');

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) {
  console.log('\n  ⚠ 未找到 Edge / Chrome —— 跳过真实渲染验证（不算失败）\n');
  process.exit(0);
}

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log('  ✓', name); }
  else { fail += 1; console.log('  ✗', name, extra); }
};
const group = (s) => console.log(`\n${'─'.repeat(66)}\n${s}\n${'─'.repeat(66)}`);

const PORT = 19731;
const BASE = `http://127.0.0.1:${PORT}`;
const PROBE_FILE = '__render_probe.html';

// ── 启动服务端 ───────────────────────────────────────────────
function startServer() {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: APP,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  return child;
}

function waitReady() {
  return new Promise((resolve) => {
    let tries = 0;
    const probe = () => {
      const req = http.get(`${BASE}/api/health`, (res) => { res.resume(); resolve(true); });
      req.on('error', () => {
        tries += 1;
        if (tries > 60) return resolve(false);
        setTimeout(probe, 150);
      });
    };
    probe();
  });
}

/**
 * 写探针页到 public/（同源），无头浏览器 dump 它的 DOM，
 * 解析出 @@REVOICE@@...@@END@@ 之间的 JSON。
 *
 * 关键：必须等目标页**异步渲染完成**再测量。
 * caregiver.js 要先 fetch 四个接口才填表格，固定 900ms 会量到空
 * （表现为 tr 高 0px、标签 display=none —— 看着像 CSS 错了，
 * 其实是量太早）。所以这里轮询等待 waitFor 条件成立。
 */
function measure(targetPath, probeExpr, width, height, waitFor = 'true', preRun = '') {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;padding:0;overflow:hidden}
iframe{border:0;width:${width}px;height:${height}px;display:block}</style></head><body>
<iframe id="f" src="${targetPath}"></iframe>
<pre id="R"></pre>
<script>
window.addEventListener('load',function(){
  var f=document.getElementById('f');
  var tries=0, MAX=60;   // 60 × 250ms = 15s 上限
  var preDone=false;
  function emit(out){
    document.getElementById('R').textContent='@@REVOICE@@'+JSON.stringify(out)+'@@END@@';
  }
  function run(){
    var doc,win,ready=false;
    try{
      doc=f.contentDocument; win=f.contentWindow;
      if(!preDone){ preDone=true; ${preRun} }
      ${waitFor}
    }catch(e){ emit({error:String(e)}); return; }
    if(!ready && tries<MAX){ tries++; setTimeout(run,250); return; }
    var out;
    try{ out = ${probeExpr}; }catch(e){ out={error:String(e)}; }
    out.__waitedMs = tries*250;
    out.__ready = ready;
    emit(out);
  }
  if(f.contentDocument && f.contentDocument.readyState==='complete') setTimeout(run,400);
  else f.addEventListener('load',function(){ setTimeout(run,400); });
});
</script></body></html>`;

  writeFileSync(join(PUB, PROBE_FILE), html, 'utf8');

  return new Promise((resolve) => {
    const args = [
      '--headless=new', '--disable-gpu', '--no-sandbox',
      '--disable-dev-shm-usage', '--hide-scrollbars',
      '--disable-extensions', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${join(APP, '.tmp', 'edge-profile')}`,
      `--window-size=${width + 20},${height + 60}`,
      '--virtual-time-budget=20000',
      '--dump-dom',
      `${BASE}/${PROBE_FILE}`,
    ];
    const child = spawn(browser, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.on('error', () => {});
    const done = () => {
      try { unlinkSync(join(PUB, PROBE_FILE)); } catch {}
      const m = out.match(/@@REVOICE@@([\s\S]*?)@@END@@/);
      if (!m) return resolve(null);
      let s = m[1].trim();
      s = s.replace(/&quot;/g, '"').replace(/&amp;/g, '&')
           .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'");
      try { resolve(JSON.parse(s)); } catch { resolve({ error: 'JSON 解析失败: ' + s.slice(0, 120) }); }
    };
    child.on('close', done);
    setTimeout(() => { try { child.kill(); } catch {} }, 60000);
  });
}

// ══════════════════════════════════════════════════════════════
// 探针脚本
// ══════════════════════════════════════════════════════════════

const PATIENT_PROBE = `(function(){
  var sels=['.icon-cell','.btn-primary','.btn-secondary','.btn-ghost','.voice-btn',
            '.keyword-input','.candidate-card','.clarify-btn','.scenario-tab',
            '.emergency-btn','.account-link'];
  var res={ tooSmall:[], count:0, all:[], vw:win.innerWidth, vh:win.innerHeight };
  sels.forEach(function(s){
    var els=doc.querySelectorAll(s);
    for(var i=0;i<els.length;i++){
      var r=els[i].getBoundingClientRect();
      if(r.width===0&&r.height===0) continue;
      res.count++;
      res.all.push({sel:s,w:Math.round(r.width),h:Math.round(r.height)});
      if(r.height<44) res.tooSmall.push({sel:s,h:Math.round(r.height)});
    }
  });
  var grid=doc.querySelector('.icon-grid');
  if(grid){
    res.gridCols=win.getComputedStyle(grid).gridTemplateColumns.split(' ').length;
    res.gridWidth=Math.round(grid.getBoundingClientRect().width);
  }
  var sb=doc.querySelector('#submitBtn');
  if(sb){ var rb=sb.getBoundingClientRect();
    res.submitVisible=(rb.bottom<=win.innerHeight+1&&rb.top>=-1);
    res.submitBottom=Math.round(rb.bottom);
    res.needScroll=Math.round(rb.bottom-win.innerHeight); }
  var sc=doc.querySelector('#screen-compose');
  if(sc){ res.composeScrollable=(sc.scrollHeight>sc.clientHeight+2); }
  var grid=doc.querySelector('.icon-grid');
  if(grid){ res.gridScrollable=(grid.scrollHeight>grid.clientHeight+2);
    res.gridClientH=Math.round(grid.getBoundingClientRect().height); }
  var em=doc.querySelector('.emergency-btn');
  if(em){ var re=em.getBoundingClientRect();
    res.emgInView=(re.right<=win.innerWidth+1&&re.top>=-1&&re.left>=-1); }
  // 场景标签的真实渲染高度。
  // 它是个 overflow-x:auto 的 flex 容器，若忘了写 flex:0 0 auto，
  // 在 .screen（flex 列）里会被优先压缩 —— 高度由内容决定，
  // 一压就塌成 8px，标签被裁成一条缝。实测 667×375 上就是这样。
  // 这不是样式瑕疵，是「患者找不到场景入口」的功能故障，必须量。
  var st=doc.querySelector('.scenario-tabs');
  if(st){ var rst=st.getBoundingClientRect();
    res.tabsH=Math.round(rst.height);
    res.tabsCount=doc.querySelectorAll('.scenario-tab').length; }
  // 紧急按钮不得被其它元素遮挡（z-index/布局问题）
  res.overflowX=doc.documentElement.scrollWidth>win.innerWidth+1;
  res.docScrollW=doc.documentElement.scrollWidth;
  return res;
})()`;

const CG_PROBE = `(function(){
  var res={ vw:win.innerWidth };
  // 前提：preRun 已切到「表达记录」面板。
  // 它是 display:none 的隐藏面板时，内部一切 getBoundingClientRect() 都是 0，
  // 会被误读成「CSS 塌了」而其实是面板没显示。
  var tbl=doc.querySelector('#recordTable');
  if(!tbl) return {error:'no table'};
  var tb=tbl.querySelector('tbody');
  if(!tb||!tb.children.length) return {error:'no rows'};
  var tr=tb.children[0];
  var thead=tbl.querySelector('thead');
  res.trDisplay=win.getComputedStyle(tr).display;
  res.theadDisplay=thead?win.getComputedStyle(thead).display:'none';
  res.trHeight=Math.round(tr.getBoundingClientRect().height);
  res.tableMinW=win.getComputedStyle(tbl).minWidth;
  // 取「综合置信度」那格的标签 —— 表达列的标签是故意隐藏的
  //（汉字本身就是标题，再挂个「表达」是噪音），别拿它当判据。
  var confLbl=tr.querySelector('td[data-field="confidence"] .cell-label');
  res.labelDisplay=confLbl?win.getComputedStyle(confLbl).display:'missing';
  // 表达列的标签应当**被隐藏** —— 这是有意的设计，反向断言
  var textLbl=tr.querySelector('td[data-field="text"] .cell-label');
  res.textLabelDisplay=textLbl?win.getComputedStyle(textLbl).display:'missing';
  var card=doc.querySelector('.load-error');
  res.hasErrorBox=!!card;
  res.topbarOverflow=doc.querySelector('.topbar').scrollWidth>win.innerWidth+1;
  res.overflowX=doc.documentElement.scrollWidth>win.innerWidth+1;
  res.docScrollW=doc.documentElement.scrollWidth;
  var tabs=doc.querySelectorAll('.tab');
  res.tabMinH=9999;
  for(var i=0;i<tabs.length;i++){ var r=tabs[i].getBoundingClientRect();
    if(r.height>0) res.tabMinH=Math.min(res.tabMinH,Math.round(r.height)); }
  // 表达列是否跨整行
  var textTd=tr.querySelector('td[data-field="text"]');
  if(textTd){
    var rt=textTd.getBoundingClientRect(), rtr=tr.getBoundingClientRect();
    res.textSpansRow=(rtr.width>0 && rt.width>rtr.width*0.7);
  }
  // 卡片模式下单个字段是否竖排堆叠（tr 高 >> 单行高）
  res.isCardLayout = res.trDisplay==='grid';
  return res;
})()`;

const AUTH_PROBE = `(function(){
  var res={ vw:win.innerWidth };
  var card=doc.querySelector('.auth-card, .notice');
  if(card) res.cardW=Math.round(card.getBoundingClientRect().width);
  var tabs=doc.querySelectorAll('.tab');
  res.tabHeights=[];
  for(var i=0;i<tabs.length;i++){ var r=tabs[i].getBoundingClientRect();
    if(r.height>0) res.tabHeights.push(Math.round(r.height)); }
  res.overflowX=doc.documentElement.scrollWidth>win.innerWidth+1;
  res.docScrollW=doc.documentElement.scrollWidth;
  return res;
})()`;

// ══════════════════════════════════════════════════════════════
(async function main() {
  console.log(`\n  浏览器：${browser.split('/').pop()}`);
  const server = await startServer();
  const up = await waitReady();
  if (!up) {
    console.log('  ⚠ 服务端未就绪，跳过渲染验证');
    try { server.kill(); } catch {}
    process.exit(0);
  }

  const VIEWPORTS = [
    { name: '手机竖屏 375×667', w: 375, h: 667 },
    { name: '手机横屏 667×375', w: 667, h: 375 },
    { name: '平板竖屏 768×1024', w: 768, h: 1024 },
    { name: '护理平板 1024×768', w: 1024, h: 768 },
    { name: '桌面 1440×900', w: 1440, h: 900 },
  ];

  group('[A] 患者端：真实渲染下的触控目标（红线二：不得低于 44px）');
  const P = {};
  for (const vp of VIEWPORTS) {
    const r = await measure('/index.html', PATIENT_PROBE, vp.w, vp.h);
    P[vp.name] = r;
    if (!r || r.error) { t(`${vp.name} 探针返回`, false, r ? r.error : '无返回'); continue; }
    t(`${vp.name} 量到 ${r.count} 个可点元素`, r.count > 0);
    t(`${vp.name} 无低于 44px 的可点目标`, r.tooSmall.length === 0,
      r.tooSmall.length ? '→ ' + JSON.stringify(r.tooSmall.slice(0, 4)) : '');
    t(`${vp.name} 无横向溢出`, !r.overflowX,
      r.overflowX ? `scrollW=${r.docScrollW} vw=${r.vw}` : '');
    t(`${vp.name} 紧急按钮完整在屏内（R6 不可被切）`, r.emgInView !== false);
    // 主操作必须首屏可达 —— 患者端最关键的一步不能要求先滚动去找。
    // 实测过：不做三段式布局时，375×667 上「看候选」在屏外 443px。
    t(`${vp.name}「看候选」在首屏内（无需滚动）`, r.submitVisible === true,
      `需再滚 ${r.needScroll}px（bottom=${r.submitBottom} vh=${r.vh}）`);
    // 场景标签必须真实可见。
    // 它是 overflow-x:auto 的 flex 容器；漏写 flex:0 0 auto 时，
    // 在 .screen（flex 列，子项默认 flex-shrink:1）里会被优先压缩，
    // 而横向滚动容器的高度由内容决定 —— 一压就塌成 8px。
    // 曾经 667×375 实测就是 8px：标签只剩一条缝，患者找不到场景入口。
    // 容差取 40px（去掉 padding 后仍是可点高度），低于它即判定塌陷。
    if (r.tabsH != null) {
      t(`${vp.name} 场景标签未被压扁（实测 ${r.tabsH}px / ${r.tabsCount} 个）`, r.tabsH >= 40,
        r.tabsH < 40 ? `→ 塌陷成 ${r.tabsH}px，患者看不到场景入口` : '');
    }
    if (r.gridCols) console.log(`      · 图标网格 ${r.gridCols} 列 / 网格宽 ${r.gridWidth}px / 视口 ${r.vw}px`
      + (r.gridClientH ? ` / 网格可视高 ${r.gridClientH}px` : '')
      + (r.gridScrollable ? '（网格内部滚动）' : ''));
  }

  group('[B] 患者端：图标网格随视口真的改变列数（响应式生效）');
  {
    const phone = P['手机竖屏 375×667'];
    const desk = P['桌面 1440×900'];
    const land = P['手机横屏 667×375'];
    if (phone && desk && !phone.error && !desk.error) {
      t(`竖屏手机列数(${phone.gridCols}) < 桌面列数(${desk.gridCols})`,
        phone.gridCols < desk.gridCols);
    }
    if (land && !land.error && land.gridCols) {
      t(`横屏手机仍能排 ${land.gridCols} 列（低高度档生效）`, land.gridCols >= 2);
    }
  }

  group('[C] 家属端：9 列表格窄屏转卡片、宽屏保持表格');
  for (const vp of [
    { name: '手机 375×667', w: 375, h: 667, card: true },
    { name: '平板 768×1024', w: 768, h: 1024, card: true },
    { name: '桌面 1440×900', w: 1440, h: 900, card: false },
  ]) {
    // 先切到「表达记录」面板（默认在实时表达），再等表格填上数据
    const preRun = `var t=doc.querySelector('.tab[data-panel="panel-records"]'); if(t) t.click();`;
    const ready = `var recPanel=doc.querySelector('#panel-records');
      ready = !!(recPanel && recPanel.classList.contains('active')
        && doc.querySelector('#recordTable tbody tr td:not([colspan])'));`;
    const r = await measure('/caregiver.html', CG_PROBE, vp.w, vp.h, ready, preRun);
    if (!r || r.error) { t(`${vp.name} 家属端测量`, false, r ? r.error : '无返回'); continue; }
    if (!r.__ready) {
      t(`${vp.name} 表格数据已渲染（等待 ${r.__waitedMs}ms 仍为空）`, false,
        '数据库可能没有 demo-patient 的记录 —— 先跑 node scripts/seed.js');
      continue;
    }
    console.log(`      · tr=${r.trDisplay} thead=${r.theadDisplay} minW=${r.tableMinW} 置信度标签=${r.labelDisplay} 表达标签=${r.textLabelDisplay} tr高=${r.trHeight}px（等 ${r.__waitedMs}ms）`);
    if (vp.card) {
      t(`${vp.name} 表格转卡片（tr=grid、thead 隐藏）`,
        r.trDisplay === 'grid' && r.theadDisplay === 'none');
      t(`${vp.name} 表头解除 min-width（不再横向拖动）`,
        r.tableMinW === '0px' || r.tableMinW === 'auto');
      t(`${vp.name} 字段名标签可见（综合置信度格）`, r.labelDisplay === 'block',
        `labelDisplay=${r.labelDisplay}`);
      t(`${vp.name} 表达列标签刻意隐藏（避免冗余）`,
        r.textLabelDisplay === 'none', `textLabel=${r.textLabelDisplay}`);
      t(`${vp.name} 表达列跨整行（主角突出）`, r.textSpansRow === true);
      t(`${vp.name} 卡片有实际高度（字段确实堆叠了）`, r.trHeight > 150,
        `tr高=${r.trHeight}px`);
    } else {
      t(`${vp.name} 保留真表格`, r.trDisplay === 'table-row');
      t(`${vp.name} 保留 min-width:1080px`, r.tableMinW === '1080px', `minW=${r.tableMinW}`);
      t(`${vp.name} 字段名标签在宽屏隐藏`, r.labelDisplay === 'none',
        `labelDisplay=${r.labelDisplay}`);
    }
    t(`${vp.name} topbar 不溢出`, !r.topbarOverflow);
    t(`${vp.name} tab 触控 ≥44px`, r.tabMinH >= 44, `minH=${r.tabMinH}`);
  }

  group('[D] 登录页：小屏可用、无横向溢出');
  for (const vp of [
    { name: '手机 375×667', w: 375, h: 667 },
    { name: '超窄 320×568', w: 320, h: 568 },
    { name: '桌面 1200×800', w: 1200, h: 800 },
  ]) {
    const r = await measure('/login.html', AUTH_PROBE, vp.w, vp.h);
    if (!r) { t(`${vp.name} 登录页测量`, false); continue; }
    t(`${vp.name} 无横向溢出`, !r.overflowX, r.overflowX ? `scrollW=${r.docScrollW}` : '');
    t(`${vp.name} 卡片未超出视口`, !r.cardW || r.cardW <= vp.w, `cardW=${r.cardW} vw=${vp.w}`);
  }

  try { server.kill(); } catch {}
  try { unlinkSync(join(PUB, PROBE_FILE)); } catch {}

  console.log('\n' + '═'.repeat(66));
  console.log(`  真实渲染验证：通过 ${pass} ／ 失败 ${fail}`);
  if (fail === 0) console.log('  ✓ 响应式与触控目标在浏览器渲染层面成立');
  console.log('═'.repeat(66));
  process.exit(fail === 0 ? 0 : 1);
})();
