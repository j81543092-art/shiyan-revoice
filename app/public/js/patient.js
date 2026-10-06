/**
 * 患者端三屏逻辑
 *
 * 三屏：表达台 → 候选确认（或澄清卡）→ 已表达
 * 紧急按钮首屏常驻，走规则通道，零模型调用。
 *
 * 关键约束：
 *   - 患者端不显示任何置信度数字（R3）
 *   - 候选位置锁定：同一批线索重提交，位置不变（R2）
 *   - 澄清按钮与候选按钮同级，不做小字链接（红线二）
 *   - 语音是线索来源之一，但绝不是唯一来源：录音不可用时
 *     必须静默降级为图标输入，不能让患者卡在表达台
 */

import { createSpeechCapture } from './speech-client.js';
import { localApi } from './api-local.js';

let _useLocal = false;

const api = {
  async post(path, body) {
    if (_useLocal) return localApi.post(path, body);
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      if (!res.ok) throw new Error(res.status);
      return res.json();
    } catch {
      _useLocal = true;
      return localApi.post(path, body);
    }
  },
  async get(path) {
    if (_useLocal) return localApi.get(path);
    try {
      const res = await fetch(path);
      if (!res.ok) throw new Error(res.status);
      return res.json();
    } catch {
      _useLocal = true;
      return localApi.get(path);
    }
  },
};
const state = {
  scenarios: [],
  activeScenario: null,
  icons: [],       // 已点选图标文本
  keywords: [],    // 已输入关键词
  fragments: [],   // 语音碎片（由麦克风实录识别而来）
  sessionId: null,
  lastClarification: null,
  // 上一批线索的「冲突结论」（确定性依据），用于澄清卡讲理由。不含任何数字。
  lastClueConflict: null,
  patientId: 'demo-patient',
};

// 图标用文字符号，ARASAAC 正式符号见 拾言-关键屏导出/ARASAAC-符号出处
const GLYPH = {
  起床: '☀', 睡觉: '☾', 翻身: '↻', 坐起: '↑', 躺下: '↓', 开灯: '☀', 关灯: '☾',
  冷: '❄', 热: '♨', 被子: '▤',
  水: '💧', 饭: '🍚', 粥: '🥣', 汤: '🍲', 饿: '😋', 渴: '🥤', 烫: '♨', 凉: '❄',
  饱: '😌', 不要了: '✕',
  厕所: '🚻', 小便: '💧', 大便: '💩', 尿不湿: '🩲', 擦: '✋', 洗: '🚿', 换: '🔄',
  帮忙: '🤝', 急: '❗', 脏: '⚠',
  疼: '😖', 麻: '⚡', 晕: '💫', 痒: '✋', 恶心: '🤢', 没力气: '🪫',
  头: '🙂', 胸口: '🫀', 肚子: '🫃', 腿: '🦵',
  药: '💊', 吃药: '💊', 几点: '🕐', 医院: '🏥', 医生: '👨‍⚕️', 护士: '👩‍⚕️',
  量血压: '🩺', 复查: '📋', 忘吃药: '❗', 饭前: '🍽',
  想你: '💭', 高兴: '😊', 烦: '😤', 害怕: '😨', 谢谢: '🙏', 对不起: '😔',
  老伴: '💑', 儿子: '👨', 闺女: '👩', 安静: '🤫',
  电视: '📺', 收音机: '📻', 戏曲: '🎭', 象棋: '♟', 晒太阳: '🌞', 出去转转: '🚶',
  声音大: '🔊', 声音小: '🔉', 换一个: '🔄', 不看: '✕',
  出去: '🚪', 回家: '🏠', 轮椅: '🦽', 散步: '🚶', 楼下: '🏢', 菜市场: '🛒',
  走走: '🚶', 推我: '👉', 太累: '😮‍💨', 回来: '↩',
  打电话: '📞', 视频: '📹', 手机: '📱', 接一下: '📲', 挂断: '📴',
  发消息: '✉', 听不见: '🔇',
  救命: '🆘', 跌倒了: '🤕', 疼得厉害: '😫', 喘不上气: '😮‍💨', 来人: '🙋',
  快: '⚡', 出血: '🩸', 叫救护车: '🚑', 按铃: '🔔', 别动我: '✋',
};

const $ = (id) => document.getElementById(id);

// ══ 语音采集（华为云 SIS）════════════════════════════════════
// 注意：这里只做「采集 + 上传」，不做任何意图判断。
// 识别出的碎片和图标点选一样，都只是线索，最终由患者确认。
const speech = createSpeechCapture({
  onLevel: (lv) => {
    // 音量反馈是可选的增强，失败也不影响录音
    const meter = $('voiceMeter');
    if (meter && meter.classList.contains('on')) {
      [...meter.children].forEach((bar, i) => {
        const scale = 0.35 + lv * (0.65 + (i % 3) * 0.22);
        bar.style.transform = `scaleY(${Math.min(1.6, scale)})`;
      });
    }
  },
});

// ══ 初始化 ══════════════════════════════════════════════════
(async function init() {
  applyViewportHeight();

  const data = await api.get('/api/scenarios');
  state.scenarios = data.scenarios || [];
  state.sessionId = 'sess-' + Math.random().toString(36).slice(2, 10);

  renderScenarioTabs();
  selectScenario(state.scenarios[0]);
  bindEvents();
  initVoiceButton();
})();

/**
 * 真实视口高度。
 * 移动浏览器的地址栏会伸缩，100vh 恒定按「地址栏收起时」算，
 * 于是 body 是 overflow:hidden 的患者端会把底部按钮推到屏幕外。
 * 这里把实测高度写进 --vh（CSS 里 100dvh 优先，此处是它的兜底）。
 */
function applyViewportHeight() {
  const set = () => {
    // visualViewport 在缩放/地址栏变化时也会更新，比 innerHeight 更准
    const h = window.visualViewport?.height || window.innerHeight;
    if (h) document.documentElement.style.setProperty('--vh', h + 'px');
  };
  set();
  window.addEventListener('resize', set);
  window.addEventListener('orientationchange', set);
  window.visualViewport?.addEventListener('resize', set);
}

/**
 * 探测语音通道可用性。
 * 两个条件缺一不可：浏览器能录 + 后端配了识别凭证。
 * 任一不满足就明确降级 —— 按钮置灰并说明原因，而不是点了没反应。
 */
async function initVoiceButton() {
  const btn = $('voiceBtn');
  if (!btn) return;

  if (!speech.supported()) {
    markVoiceUnavailable('这台设备不支持录音，用图标说也行');
    return;
  }

  try {
    const health = await api.get('/api/health');
    if (!health?.speech?.available) {
      markVoiceUnavailable('语音暂时不可用，用图标说也行');
    }
  } catch {
    markVoiceUnavailable('语音暂时不可用，用图标说也行');
  }
}

function markVoiceUnavailable(hint) {
  const btn = $('voiceBtn');
  if (!btn) return;
  btn.classList.add('unavailable');
  $('voiceLabel').textContent = '语音暂不可用';
  $('voiceHint').textContent = hint;
}

function renderScenarioTabs() {
  const nav = $('scenarioTabs');
  nav.innerHTML = '';
  for (const s of state.scenarios) {
    const btn = document.createElement('button');
    btn.className = 'scenario-tab' + (s.emergency ? ' emg' : '');
    btn.textContent = s.name.replace('（不可删）', '');
    btn.setAttribute('role', 'tab');
    btn.onclick = () => selectScenario(s);
    nav.appendChild(btn);
  }
}

function selectScenario(s) {
  state.activeScenario = s;
  [...$('scenarioTabs').children].forEach((el, i) => {
    el.classList.toggle('active', state.scenarios[i].key === s.key);
  });
  renderIconGrid();
}

function renderIconGrid() {
  const grid = $('iconGrid');
  grid.innerHTML = '';
  for (const w of state.activeScenario.words) {
    const cell = document.createElement('button');
    const selected = state.icons.includes(w.text);
    cell.className = 'icon-cell'
      + (w.emergency ? ' emg' : '')
      + (selected ? ' selected' : '');
    cell.setAttribute('aria-pressed', String(selected));
    cell.innerHTML = `<span class="glyph" aria-hidden="true">${GLYPH[w.text] || '●'}</span><span>${w.text}</span>`;
    cell.onclick = () => toggleIcon(w.text);
    grid.appendChild(cell);
  }
}

function toggleIcon(text) {
  const i = state.icons.indexOf(text);
  if (i >= 0) state.icons.splice(i, 1);
  else state.icons.push(text);
  renderIconGrid();
  renderTray();
}

function renderTray() {
  const tray = $('tray');
  const total = state.icons.length + state.keywords.length + state.fragments.length;
  if (total === 0) {
    tray.innerHTML = '<span class="tray-empty">还没选</span>';
  } else {
    tray.innerHTML = '';
    const chips = [
      ...state.icons.map((t) => ({ t, cls: '' })),
      ...state.keywords.map((t) => ({ t, cls: 'word' })),
      ...state.fragments.map((t) => ({ t, cls: 'voice' })),
    ];
    for (const c of chips) {
      const el = document.createElement('span');
      el.className = 'tray-chip ' + c.cls;
      el.innerHTML = `${c.t}<button aria-label="移除 ${c.t}">×</button>`;
      el.querySelector('button').onclick = () => {
        state.icons = state.icons.filter((x) => x !== c.t);
        state.keywords = state.keywords.filter((x) => x !== c.t);
        state.fragments = state.fragments.filter((x) => x !== c.t);
        renderIconGrid();
        renderTray();
      };
      tray.appendChild(el);
    }
  }
  $('submitBtn').disabled = total === 0;
}
function bindEvents() {
  $('keywordAdd').onclick = addKeyword;
  $('keywordInput').onkeydown = (e) => { if (e.key === 'Enter') addKeyword(); };
  $('clearBtn').onclick = () => {
    state.icons = []; state.keywords = []; state.fragments = [];
    state.lastClarification = null;
    renderIconGrid(); renderTray();
    showScreen('screen-compose');
  };
  $('submitBtn').onclick = submitClues;
  $('againBtn').onclick = () => $('clearBtn').click();
  $('candRestart').onclick = () => $('clearBtn').click();
  $('clarifyRestart').onclick = () => $('clearBtn').click();
  $('emgBackBtn').onclick = () => {
    api.post('/api/patient/reset', { sessionId: state.sessionId });
    $('clearBtn').click();
  };
  $('emergencyBtn').onclick = triggerEmergency;
  bindVoiceEvents();
}

/**
 * 按住说话。
 * 用 pointer 事件而非 click —— 患者手会抖，也需要「按住」这个
 * 符合直觉的物理隐喻（松开即停）。同时兼容键盘空格，别把
 * 只用键盘的人排除在外。
 */
function bindVoiceEvents() {
  const btn = $('voiceBtn');
  if (!btn) return;

  let held = false;

  const begin = async (ev) => {
    if (btn.classList.contains('unavailable') || btn.classList.contains('busy')) return;
    if (ev) ev.preventDefault();
    held = true;
    const r = await speech.start();
    if (!r.ok) {
      held = false;
      toast(r.reason || '录不上，用图标说吧');
      return;
    }
    btn.classList.add('recording');
    btn.setAttribute('aria-pressed', 'true');
    $('voiceLabel').textContent = '松开就停';
    $('voiceHint').textContent = '正在听你说…';
    const meter = $('voiceMeter');
    if (meter) meter.classList.add('on');
  };

  const end = async (ev) => {
    if (ev) ev.preventDefault();
    if (!held) return;
    held = false;
    btn.classList.remove('recording');
    btn.setAttribute('aria-pressed', 'false');
    const meter = $('voiceMeter');
    if (meter) meter.classList.remove('on');

    const captured = speech.stop();
    if (!captured.ok) {
      $('voiceLabel').textContent = '按住说话';
      $('voiceHint').textContent = '说不清也没关系，慢慢说，说几个字也行';
      toast(captured.reason || '没听清，再说一次');
      return;
    }

    // 识别中：按钮置灰防止连点
    btn.classList.add('busy');
    btn.disabled = true;
    $('voiceLabel').textContent = '正在听懂…';

    const result = await speech.transcribe(captured);

    btn.classList.remove('busy');
    btn.disabled = false;
    $('voiceLabel').textContent = '按住说话';
    $('voiceHint').textContent = '说不清也没关系，慢慢说，说几个字也行';

    // 归一化可能把整句话都过滤掉（患者说了词表外的内容）。
    // 这时不能静默无言 —— 必须让患者知道「听到了，但没对上」，
    // 并明确引导他用图标补充，否则他会以为机器坏了。
    if (result.fragments.length === 0) {
      const heard = (result.rawFragments || []).slice(0, 2).join(' · ') || result.text;
      $('voiceHint').textContent = heard
        ? `听到「${heard}」，点个图标帮我确认一下`
        : '没听清，点个图标也行';
      toast('听到了，再点个图标帮我确认');
      return;
    }

    // 去重后并入碎片。同一句话按住两次不该出现两个一样的碎片
    const before = state.fragments.length;
    for (const f of result.fragments) {
      if (!state.fragments.includes(f)) state.fragments.push(f);
    }
    renderTray();
    const added = state.fragments.length - before;
    if (added > 0) showRecognized(result.fragments, result.text);
  };

  btn.addEventListener('pointerdown', begin);
  btn.addEventListener('pointerup', end);
  btn.addEventListener('pointercancel', end);
  btn.addEventListener('pointerleave', (ev) => { if (held) end(ev); });

  // 键盘可达：空格按住说话
  btn.addEventListener('keydown', (ev) => {
    if (ev.key === ' ' && !held) begin(ev);
  });
  btn.addEventListener('keyup', (ev) => {
    if (ev.key === ' ') end(ev);
  });
}

/**
 * 让患者看到「它听成了什么」—— 这是建立信任的关键一步。
 *
 * 显示原文而非归一化后的词：患者要确认的是「你有没有听懂我」，
 * 给他看被规整过的标准词，等于替他说话 —— 违背产品立意。
 * 归一化的痕迹留在托盘和候选里，那才是系统内部的语言。
 */
function showRecognized(fragments, fullText) {
  const hint = $('voiceHint');
  if (!hint) return;
  const heard = fullText || fragments.slice(0, 3).join(' · ');
  hint.textContent = `听到「${heard}」，可以再点图标补充`;
  // 患者可能没注意到托盘变化，Toast 兜一层
  toast(`听到「${fragments[0]}」`);
  // 识别原文留在控制台，方便家属端排障与 A 迭代 prompt
  if (fullText) console.info('[speech] 识别原文：', fullText);
}

function addKeyword() {
  const v = $('keywordInput').value.trim();
  if (!v) return;
  state.keywords.push(v);
  $('keywordInput').value = '';
  renderTray();
}

// ══ 提交线索 ════════════════════════════════════════════════
async function submitClues() {
  const btn = $('submitBtn');
  // 提交中：按钮变形 + 屏蔽重复点击。
  // 模型调用可达数秒，没有这个反馈患者会以为没点上而反复重击 ——
  // 那会发出多份请求，也可能把他刚选的线索搞乱。
  setSubmitBusy(true);
  try {
    const res = await api.post('/api/patient/understand', {
      sessionId: state.sessionId,
      patientId: state.patientId,
      scenario: state.activeScenario?.key || '',
      clues: {
        icons: state.icons,
        keywords: state.keywords,
        voiceFragments: state.fragments,
      },
    });
    handleResult(res);
  } catch {
    toast('没连上，再试一次');
  } finally {
    setSubmitBusy(false);
  }
}

function setSubmitBusy(on) {
  const btn = $('submitBtn');
  if (!btn) return;
  btn.classList.toggle('busy', on);
  btn.disabled = on || (state.icons.length + state.keywords.length + state.fragments.length === 0);
  btn.textContent = on ? '正在想…' : '看候选';
}

function handleResult(res) {
  if (!res.ok) { toast(res.error || '出错了，再试一次'); return; }

  // 线索冲突结论（确定性依据，无数字）—— 先存下来，澄清卡要用它讲理由
  state.lastClueConflict = res.clueConflict || null;

  if (res.state === 'emergency' && res.emergency?.triggered) {
    $('emergencyText').textContent = res.emergency.message || '需要紧急帮助';
    showScreen('screen-emergency');
    return;
  }

  if (res.state === 'clarifying' && res.clarification) {
    renderClarify(res.clarification);
    showScreen('screen-clarify');
    return;
  }

  if (res.state === 'fallback_list' || (res.candidates || []).length > 0) {
    renderCandidates(res.candidates || [], res.fallbackOptions);
    showScreen('screen-candidates');
    return;
  }

  toast('没听懂，再点几个图标试试');
}

// ══ 澄清卡 ══════════════════════════════════════════════════

/**
 * 把「线索冲突」翻译成患者能听懂的一句话。
 *
 * 为什么要在患者端讲理由：
 *   患者刚点了两个意思不一样的图标，突然被问「你是想说 X 吗」——
 *   如果不解释，他只会觉得「这东西没听懂我」，从而不再信任它。
 *   把「你点的两个词对不上」说出来，是在告诉患者：**是我在犹豫，不是你没说清**。
 *
 * 措辞纪律（与 R8 同源）：
 *   - 只用口语，禁止出现「冲突」「歧义」「置信度」「概率」这类词
 *   - 只引用患者自己点过的词，不臆造任何新实体
 *   - 不出现任何数字（R3：患者端不给分）
 */
function describeClueConflict(conflict) {
  const pairs = conflict?.pairs || [];
  if (!conflict?.conflicted || pairs.length < 2) return '';
  const a = pairs[0]?.clue;
  const b = pairs[1]?.clue;
  if (!a || !b) return '';
  // 刻意只留「你点了哪两个词」这一句。
  // 实测把「每个词各自像是指什么」也写出来会到 78 字 ——
  // 护理平板上要占满两行，把下面的选项按钮挤出首屏。
  // 患者真正需要的只是「它不是没听懂我，而是在两个意思之间犹豫」，
  // 「该改哪一个」由下面的候选按钮自己回答。
  return `你点了「${a}」和「${b}」，这两个意思不太一样，我拿不准。`;
}

function renderClarify(cl) {
  state.lastClarification = cl;
  $('clarifyRound').textContent = cl.round
    ? `第 ${cl.round} 次确认（最多 ${cl.maxRounds} 次）`
    : '';
  $('clarifyQuestion').textContent = cl.question;

  const why = $('clarifyWhy');
  const whyText = describeClueConflict(state.lastClueConflict);
  if (why) {
    if (whyText) {
      why.textContent = whyText;
      why.hidden = false;
    } else {
      why.textContent = '';
      why.hidden = true;
    }
  }

  const box = $('clarifyOptions');
  box.innerHTML = '';
  cl.options.forEach((opt, i) => {
    const btn = document.createElement('button');
    // 二选一时第一个是「更像的那个」，做成实心以示默认
    btn.className = 'clarify-btn' + (cl.type === 'either_or' && i === 0 ? ' affirm' : '');
    btn.textContent = opt;
    btn.onclick = () => answerClarify(opt);
    box.appendChild(btn);
  });
}

async function answerClarify(answer) {
  const res = await api.post('/api/patient/clarify', {
    sessionId: state.sessionId,
    answer,
    clarification: state.lastClarification,
  });

  if (res.confirmed) {
    showExpressed(res.finalText);
    return;
  }
  handleResult(res);
}

// ══ 候选确认 ════════════════════════════════════════════════
function renderCandidates(candidates, fallbackOptions) {
  const list = $('candidateList');
  list.innerHTML = '';

  if (candidates.length === 0) {
    const p = document.createElement('p');
    p.className = 'cand-sub';
    p.textContent = '还是没对上，换几个图标再试试';
    list.appendChild(p);
  }

  candidates.forEach((c, i) => {
    const btn = document.createElement('button');
    btn.className = 'candidate-card' + (i === 0 ? ' top' : '');
    // 患者端只显示排序位置，不显示置信度数字（R3）
    btn.innerHTML = `<span class="rank-badge" aria-hidden="true">${i + 1}</span><span>${c.text}</span>`;
    btn.onclick = () => confirmCandidate(c);
    list.appendChild(btn);
  });

  if (fallbackOptions?.length) {
    const btn = document.createElement('button');
    btn.className = 'candidate-card';
    btn.innerHTML = `<span class="rank-badge" aria-hidden="true">✕</span><span>${fallbackOptions[0]}</span>`;
    btn.onclick = () => $('clearBtn').click();
    list.appendChild(btn);
  }
}

async function confirmCandidate(c) {
  const res = await api.post('/api/patient/confirm', {
    sessionId: state.sessionId,
    text: c.text,
  });
  if (res.ok) showExpressed(res.finalText || c.text);
  else toast('没成功，再点一次');
}

function showExpressed(text) {
  $('expressedText').textContent = text;
  showScreen('screen-expressed');
  // R5：确认后朗读（可选）
  speak(text);
}

// ══ 紧急一键（R6：零模型）═══════════════════════════════════
async function triggerEmergency() {
  const res = await api.post('/api/patient/emergency', {
    sessionId: state.sessionId,
    patientId: state.patientId,
  });
  $('emergencyText').textContent = res.emergency?.message || '需要紧急帮助';
  showScreen('screen-emergency');
}

// ══ 工具 ════════════════════════════════════════════════════
function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $(id).classList.add('active');
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2400);
}

function speak(text) {
  try {
    if (!('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    u.rate = 0.9;
    speechSynthesis.speak(u);
  } catch { /* 朗读是增强，不阻塞主流程 */ }
}

// 供答辩现场调试与家属端排障使用
window.__revoice = { state, api, speech };
