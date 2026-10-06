/**
 * 家属端逻辑
 *
 * 与患者端的关键差异（R3）：
 *   - 这里显示置信度数值与分项拆解
 *   - 可配置词库、可审核习得词、可看指标
 */

const api = {
  async get(path) { return (await fetch(path)).json(); },
  async post(path, body) {
    return (await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    })).json();
  },
};

const PATIENT_ID = 'demo-patient';
const $ = (id) => document.getElementById(id);

const CATEGORY_LABEL = {
  common: '常用词', caregiver_name: '护理者称呼', routine: '作息', preference: '偏好',
};
const SOURCE_LABEL = { base: '基础库', caregiver: '家属配置', learned: '使用习得' };

// ══ Tab 切换 ════════════════════════════════════════════════
const TABS = () => [...document.querySelectorAll('.tab')];

/**
 * 切到某个 tab。
 * 同时维护三项状态，缺一不可：
 *   - .active 视觉类（CSS 靠它显示/隐藏面板）
 *   - aria-selected（读屏用户靠它知道自己在哪一页）
 *   - tabindex 的 roving 模式（只有当前 tab 可 Tab 键聚焦，
 *     其余用方向键切换 —— 这是 WAI-ARIA tabs 的标准做法，
 *     否则键盘用户要按 4 次 Tab 才能越过这排页签）
 */
function activateTab(tab, { focus = false } = {}) {
  const list = TABS();
  list.forEach((t) => {
    const on = t === tab;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
  });
  document.querySelectorAll('.panel').forEach((p) => {
    p.classList.toggle('active', p.id === tab.dataset.panel);
  });
  if (focus) tab.focus();
}

$('tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  activateTab(tab);
  refreshAll();
});

// 方向键 / Home / End 在页签之间移动 —— role=tablist 声明了就必须实现，
// 否则等于对读屏用户承诺了一个不存在的交互。
$('tabs').addEventListener('keydown', (e) => {
  const list = TABS();
  const cur = list.findIndex((t) => t.classList.contains('active'));
  if (cur < 0) return;

  let next = null;
  if (e.key === 'ArrowRight') next = (cur + 1) % list.length;
  else if (e.key === 'ArrowLeft') next = (cur - 1 + list.length) % list.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = list.length - 1;
  else return;

  e.preventDefault();
  activateTab(list[next], { focus: true });
  refreshAll();
});

$('refreshBtn').onclick = () => refreshAll({ manual: true });

// ══ 数据加载 ════════════════════════════════════════════════

/**
 * 三态渲染。原来只有「有数据」和「暂无记录」两种输出，
 * 一旦请求失败，界面显示的是「暂无记录」—— 家属会以为患者没说过话，
 * 而实际可能是服务端挂了。这里把「加载中 / 失败 / 真的空」分开。
 */
function renderError(hostId, label, retry) {
  const host = $(hostId);
  if (!host) return;
  host.innerHTML = `
    <div class="load-error">
      <span><strong>${label}没取到。</strong>可能是服务端未响应，下面的内容不代表真实状态。</span>
      <button type="button">重试</button>
    </div>`;
  host.querySelector('button').onclick = () => retry();
}

function clearError(hostId) {
  const host = $(hostId);
  if (host) host.innerHTML = '';
}

/** 取数包装：失败时抛出带标签的错误，由调用方决定怎么呈现 */
async function getJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function refreshAll({ manual = false } = {}) {
  const btn = $('refreshBtn');
  if (manual) {
    btn.disabled = true;
    btn.classList.add('loading');
    btn.textContent = '刷新中…';
  }
  try {
    // 四个面板各自独立容错：一个挂了不该让另外三个也白屏
    await Promise.all([
      loadLive().catch(() => renderError('liveError', '实时表达', () => loadLive().catch(() => {}))),
      loadRecords().catch(() => renderError('recordsError', '表达记录', () => loadRecords().catch(() => {}))),
      loadWords().catch(() => renderError('wordsError', '词库', () => loadWords().catch(() => {}))),
      loadMetrics().catch(() => renderError('metricsError', '指标', () => loadMetrics().catch(() => {}))),
    ]);
    $('lastUpdate').textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN');
  } finally {
    if (manual) {
      btn.disabled = false;
      btn.classList.remove('loading');
      btn.textContent = '刷新';
    }
  }
}

// ── 实时表达 ──
async function loadLive() {
  const [exp, emg] = await Promise.all([
    getJSON(`/api/caregiver/expressions?patientId=${PATIENT_ID}&limit=10`),
    getJSON(`/api/caregiver/emergencies?patientId=${PATIENT_ID}`),
  ]);
  clearError('liveError');

  const latestEmg = (emg.emergencies || [])[0];
  const banner = $('emgBanner');
  if (latestEmg) {
    banner.hidden = false;
    $('emgBannerBody').textContent =
      `${latestEmg.message || '紧急求助'}（${fmtTime(latestEmg.notified_at)} · ${latestEmg.rule || '规则通道'}）`;
  } else {
    banner.hidden = true;
  }

  const feed = $('liveFeed');
  const list = exp.expressions || [];
  if (list.length === 0) {
    feed.innerHTML = '<p class="empty">还没有表达记录。患者确认过的表达会出现在这里。</p>';
    return;
  }
  feed.innerHTML = '';
  for (const r of list) {
    const card = document.createElement('div');
    card.className = 'feed-card' + (r.viaEmergency ? ' emg' : '');
    // 曾经因为线索冲突而被澄清过的表达，在实时流里也标出来 ——
    // 家属据此知道「这一句是患者被问过才确认的」，而不是一眼就懂的
    const conflictTag = r.clueConflict?.conflicted ? '<span class="feed-tag">经线索澄清确认</span>' : '';
    card.innerHTML = `
      <span class="feed-text">${esc(r.finalText)}${conflictTag}</span>
      <div class="feed-meta">
        <div class="feed-conf">${r.confidence != null ? '置信度 ' + r.confidence.toFixed(2) : '—'}</div>
        <div>${fmtTime(r.createdAt)} · ${r.scenarioKey || '未标场景'}</div>
      </div>`;
    feed.appendChild(card);
  }
}

// ── 表达记录 ──
async function loadRecords() {
  const data = await getJSON(`/api/caregiver/expressions?patientId=${PATIENT_ID}&limit=50`);
  clearError('recordsError');
  const tbody = $('recordTable').querySelector('tbody');
  tbody.innerHTML = '';
  for (const r of data.expressions || []) {
    const b = r.breakdown || {};
    const tr = document.createElement('tr');
    // data-field 供窄屏卡片模式定位；.cell-label 在宽屏下被 CSS 隐藏，
    // 窄屏表头消失后由它补出字段名。
    tr.innerHTML = `
      <td data-field="time">${fmtTime(r.createdAt)}</td>
      <td data-field="scenario">${esc(r.scenarioKey || '—')}</td>
      <td data-field="text"><span class="cell-label">表达</span><strong>${esc(r.finalText)}</strong></td>
      <td data-field="confidence"><span class="cell-label">综合置信度</span>${r.confidence != null ? r.confidence.toFixed(3) : '—'}</td>
      <td data-field="calib" class="mono"><span class="cell-label">模型原始分 → 校准后</span>${modelCalib(b)}</td>
      <td data-field="breakdown" class="mono"><span class="cell-label">分项拆解</span>模型 ${num(b.model)} · 先验 ${num(b.scenarioPrior)} · 覆盖 ${num(b.clueCoverage)} · 个性 ${num(b.personalization)}</td>
      <td data-field="conflict"><span class="cell-label">线索冲突</span>${conflictCell(r.clueConflict)}</td>
      <td data-field="clues" class="mono"><span class="cell-label">线索</span>${esc(JSON.stringify(r.clues || {}))}</td>
      <td data-field="rounds"><span class="cell-label">澄清轮次</span>${r.clarifyRounds || 0}</td>`;
    tbody.appendChild(tr);
  }
  if (!tbody.children.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty">暂无记录。患者在表达台确认一次，这里就会出现一条。</td></tr>';
  }
}

/**
 * 模型原始分 → 校准后。
 * 两者并排，是为了让「自报分数有多飘、被压掉多少」直接可读 ——
 * 只留校准后一个数，就把证据藏起来了。
 */
function modelCalib(b) {
  const raw = b.rawModel;
  const cal = b.model;
  if (raw == null && cal == null) return '—';
  const delta = raw != null && cal != null ? Math.abs(raw - cal).toFixed(3) : null;
  return `${num(raw)} → ${num(cal)}${delta != null ? ` <span class="delta">(压 ${delta})</span>` : ''}`;
}

/**
 * 线索冲突列。
 * 空 = 线索可互证；有值 = 两条线索各自指向不同候选（R4 的确定性澄清依据）。
 * 直接引用患者点过的原词，不复述服务端那句话 —— 措辞改动不会拗断界面。
 */
function conflictCell(c) {
  if (!c || !c.conflicted) return '<span class="ok-quiet">无（线索可互证）</span>';
  const pairs = c.pairs || [];
  if (pairs.length < 2) return '<span class="warn">有冲突</span>';
  const detail = pairs.map((p) => `「${esc(p.clue)}」→ ${esc(p.ownerText || '?')}`).join(' ／ ');
  return `<span class="warn">有冲突</span> <span class="mono">${detail}</span>`;
}

// ── 词库 ──
async function loadWords() {
  const data = await getJSON('/api/caregiver/words');
  clearError('wordsError');
  const grid = $('wordGrid');
  grid.innerHTML = '';

  const words = (data.words || []).filter((w) => w.source !== 'base' || w.emergency || w.mapping);
  // 紧急词优先展示（强调不可删）
  words.sort((a, b) => (b.locked ? 1 : 0) - (a.locked ? 1 : 0));

  for (const w of words) {
    const card = document.createElement('div');
    card.className = 'word-card' + (w.locked ? ' locked' : '') + (w.source === 'learned' ? ' learned' : '');
    const tag = w.locked
      ? '<span class="word-tag locked">紧急词 · 不可删</span>'
      : w.source === 'learned'
        ? '<span class="word-tag learned">待审核</span>'
        : `<span class="word-tag">${CATEGORY_LABEL[w.category] || w.category}</span>`;

    card.innerHTML = `
      <div class="word-top">
        <span class="word-text">${esc(w.text)}</span>
        ${tag}
      </div>
      <div class="word-meta">
        来源：${SOURCE_LABEL[w.source] || w.source} · 优先级 ${w.priority}
        ${w.mapping ? '· 映射 → ' + esc(w.mapping) : ''}
      </div>
      <div class="word-actions">
        ${w.source === 'learned' && !w.approvedBy ? '<button data-act="approve">审核通过</button>' : ''}
        <button data-act="delete" class="danger" ${w.locked ? 'disabled' : ''}
                ${w.locked ? 'title="紧急词不可删（R7）"' : ''}>删除</button>
      </div>`;

    card.querySelectorAll('button[data-act]').forEach((btn) => {
      btn.onclick = async () => {
        // 破坏性操作给一次确认：删词条是不可逆的，误点一下少一个词
        if (btn.dataset.act === 'delete' && !confirm(`确定删除「${w.text}」？此操作不可撤销。`)) return;
        try {
          if (btn.dataset.act === 'delete') {
            const r = await api.post('/api/caregiver/words/delete', { wordId: w.wordId, actor: '家属' });
            if (!r.ok) { toast(r.reason || '删除失败'); return; }
            toast('已删除');
          } else {
            await api.post('/api/caregiver/words/approve', { wordId: w.wordId, actor: '家属' });
            toast('已审核通过，即时生效');
          }
          loadWords();
        } catch {
          toast('操作没成功，检查一下网络或服务端');
        }
      };
    });
    grid.appendChild(card);
  }

  if (!grid.children.length) {
    grid.innerHTML = '<p class="empty">暂无自定义词条。使用上方「添加词条」为患者配置称呼、作息与偏好。</p>';
  }
}

$('addWordBtn').onclick = async () => {
  const text = $('wText').value.trim();
  if (!text) { toast('请填写词条文本'); return; }
  const btn = $('addWordBtn');
  btn.disabled = true;
  try {
    const r = await api.post('/api/caregiver/words', {
      text,
      category: $('wCategory').value,
      mapping: $('wMapping').value.trim() || null,
      priority: Number($('wPriority').value),
      actor: '家属',
    });
    if (r.ok) {
      toast('已添加，即时生效');
      $('wText').value = ''; $('wMapping').value = '';
      loadWords();
    } else {
      toast(r.error || '添加失败');
    }
  } catch {
    toast('添加没成功，检查一下网络或服务端');
  } finally {
    btn.disabled = false;
  }
};

// ── 指标 ──
async function loadMetrics() {
  const data = await getJSON(`/api/caregiver/metrics?patientId=${PATIENT_ID}`);
  clearError('metricsError');
  const cards = $('metricCards');
  const emgCount = (await getJSON(`/api/caregiver/emergencies?patientId=${PATIENT_ID}`)).emergencies?.length || 0;

  const items = [
    { label: '缓存命中率', value: pct(data.cache?.hitRate), sub: `命中 ${data.cache?.hits || 0} / 未命中 ${data.cache?.misses || 0}` },
    { label: '平均澄清轮次', value: (data.expression?.avgClarifyRounds ?? 0).toFixed(2), sub: '目标 ≤1 轮收敛' },
    { label: '累计表达', value: data.expression?.total || 0, sub: '患者确认过的表达总数' },
    { label: '紧急事件', value: emgCount, sub: '规则通道留痕，零模型调用' },
  ];

  cards.innerHTML = items.map((i) => `
    <div class="metric-card">
      <div class="metric-label">${i.label}</div>
      <div class="metric-value">${i.value}</div>
      <div class="metric-sub">${i.sub}</div>
    </div>`).join('');

  const tbody = $('promptTable').querySelector('tbody');
  tbody.innerHTML = '';
  for (const v of data.promptVersions || []) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td data-field="version"><span class="cell-label">版本</span><strong>${esc(v.version)}</strong></td>
      <td data-field="date"><span class="cell-label">日期</span>${esc(v.date)}</td>
      <td data-field="change"><span class="cell-label">改了什么</span>${esc(v.change_desc || '')}</td>
      <td data-field="hypothesis"><span class="cell-label">验证什么假设</span>${esc(v.hypothesis || '')}</td>
      <td data-field="top3"><span class="cell-label">Top-3 命中率</span>${v.top3_hit_rate != null ? pct(v.top3_hit_rate) : '—'}</td>
      <td data-field="rounds"><span class="cell-label">平均澄清轮次</span>${v.avg_clarify_rounds != null ? v.avg_clarify_rounds.toFixed(2) : '—'}</td>
      <td data-field="fails"><span class="cell-label">失败 case 数</span>${v.fail_cases ?? '—'}</td>`;
    tbody.appendChild(tr);
  }
  if (!tbody.children.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">还没有版本记录。跑一次评测即可写入 v1。</td></tr>';
  }
}

// ══ 工具 ════════════════════════════════════════════════════
function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function num(v) { return v == null ? '—' : Number(v).toFixed(3); }
function pct(v) { return v == null ? '—' : (Number(v) * 100).toFixed(1) + '%'; }
function fmtTime(t) {
  if (!t) return '—';
  try { return new Date(t).toLocaleString('zh-CN', { hour12: false }); } catch { return t; }
}
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2400);
}

// ══ 启动 ════════════════════════════════════════════════════
refreshAll();

/**
 * 实时同步轮询。
 *
 * 两条纪律：
 *   1. 页面不可见时不轮询 —— 家属切到别的 App 后没必要继续打服务端
 *   2. 失败不弹 toast —— 每 5 秒弹一次的报错会变成噪音。
 *      失败只在实时流顶部留一条可点击重试的提示。
 */
let pollTimer = null;

async function poll() {
  if (document.hidden) return;
  try {
    await loadLive();
    clearError('liveError');
  } catch {
    renderError('liveError', '实时表达', () => poll());
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(poll, 5000);
}
function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { stopPolling(); return; }
  // 回到前台先立刻补一次，再恢复轮询 —— 否则要等满 5 秒才看到新数据
  poll();
  startPolling();
});
startPolling();
