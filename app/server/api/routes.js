/**
 * HTTP API —— 患者端与家属端分流（对应系统设计层第 3 层）
 *
 * 路由约定：
 *   患者端  /api/patient/*    —— 不返回置信度数值（R3）
 *   家属端  /api/caregiver/*  —— 可见数值、可配词库、可看记录
 *
 * 零外部依赖，用 node:http 手写路由。
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip as gzipCallback } from 'node:zlib';
// node:zlib/promises 子路径在部分 Node 版本（含 v24.19）不在内置模块白名单，
// 服务会因此起不来 —— 用 promisify 包回调版 gzip，语义与 promises 版一致
const gzip = promisify(gzipCallback);

import { SCENARIOS } from '../domain/scenarios.js';
import { createIntentEngine } from '../domain/engine.js';
import { createVisualResolver } from '../domain/visual.js';
import { createSpeechRecognizer } from '../model/speech-index.js';
import { normalizeFragments, normalizeStats, disambiguateStats } from '../domain/normalize.js';
import { CLARIFY_STATE } from '../domain/clarify.js';
import { applyClarificationAnswer } from '../domain/clarify.js';
import { EMERGENCY_WORDS_PRIMARY } from '../domain/scenarios.js';
import { PROMPT_V1 } from '../model/prompt.js';
import {
  openDatabase,
  createWordRepository,
  createExpressionRepository,
  createSessionRepository,
  createEmergencyRepository,
  createPromptVersionRepository,
  ClueCandidateCache,
} from '../data/db.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

export function createApp({ publicDir, modelConfig = {} } = {}) {
  const db = openDatabase();
  const words = createWordRepository(db);
  const expressions = createExpressionRepository(db);
  const sessions = createSessionRepository(db);
  const emergencies = createEmergencyRepository(db);
  const prompts = createPromptVersionRepository(db);
  const cache = new ClueCandidateCache();
  const engine = createIntentEngine({ model: modelConfig });
  // 语音识别（华为云 SIS）—— 患者的第一手线索来源；无凭证时自动不可用
  const speech = createSpeechRecognizer(modelConfig.speech || {});
  // 图片解析（图标库优先 + 文生图兜底）
  const visual = createVisualResolver(modelConfig.image || {});

  // ── SSE 订阅器：家属端实时推送（进程内事件总线，零外部依赖）──
  // 患者确认表达 / 触发紧急时，把单条数据推给所有在线家属端页面；
  // 客户端断开由 /api/caregiver/stream 的 close 清理负责移除，避免内存泄漏。
  const sseClients = new Set();
  const broadcast = (event, data) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
      try { res.write(frame); } catch { sseClients.delete(res); }
    }
  };

  // 首次启动灌入基础词表
  words.seedBase();

  const routes = buildRoutes({
    words, expressions, sessions, emergencies, prompts, cache, engine, speech, visual,
    broadcast, sseClients,
  });

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = decodeURIComponent(url.pathname);

      // API 路由
      if (pathname.startsWith('/api/')) {
        const handler = matchRoute(routes, req.method, pathname);
        if (!handler) return sendJSON(res, 404, { ok: false, error: 'API 不存在' });
        const body = await readBody(req);
        const result = await handler({ params: handler.__params || {}, query: url.searchParams, body, req, res });
        // SSE 端点自己管理连接（writeHead + 持续 write，不 end），
        // 返回 __sse 标记后通用 sendJSON 不再接管该响应
        if (result && result.__sse) return;
        return sendJSON(res, result.__status || 200, result);
      }

      // 静态资源
      return await serveStatic(res, publicDir, pathname === '/' ? '/index.html' : pathname, req);
    } catch (err) {
      console.error('[error]', err);
      // SSE 响应头已发出后再报错只能断开连接，writeHead 会二次抛错
      if (res.headersSent) return res.end();
      return sendJSON(res, 500, { ok: false, error: String(err.message || err) });
    }
  });

  server.on('close', () => db.close());
  return { server, db, engine, cache, routes };
}

// ── 路由表 ───────────────────────────────────────────────────
function buildRoutes(ctx) {
  const { words, expressions, sessions, emergencies, prompts, cache, engine, speech, visual, broadcast, sseClients } = ctx;

  return [
    // ── 公共 ──
    {
      method: 'GET', pattern: '/api/health',
      handler: async () => ({
        ok: true,
        provider: engine.provider.id,
        providerAvailable: engine.provider.available(),
        // 语音：患者第一手线索来源（华为云 SIS，华北-北京四）
        speech: {
          provider: speech.id,
          available: speech.available(),
          region: speech.status().region,
          // 口语 → 词表原词的归一化能力（语音链路能否落地，全看它）
          normalize: { ...normalizeStats(), ...disambiguateStats() },
        },
        // 图片：图标库优先，文生图兜底
        visual: visual.stats(),
        scenarios: SCENARIOS.length,
        promptVersion: PROMPT_V1.version,
        time: new Date().toISOString(),
      }),
    },
    {
      method: 'GET', pattern: '/api/scenarios',
      handler: async () => ({
        ok: true,
        scenarios: SCENARIOS.map((s) => ({
          id: s.id, key: s.key, name: s.name, order: s.order, emergency: s.emergency,
          words: s.words.map((w) => ({ id: w.id, text: w.text, emergency: !!w.emergency })),
        })),
      }),
    },
    {
      method: 'GET', pattern: '/api/prompt',
      handler: async () => ({
        ok: true,
        version: PROMPT_V1.version,
        date: PROMPT_V1.date,
        system: PROMPT_V1.system,
        fewShotCount: PROMPT_V1.fewShot.length,
        versions: prompts.all(),
      }),
    },

    // ── 患者端：语音识别 → 线索碎片 ──
    // 失语症患者的第一手线索来源。识别不准是常态，因此**失败也算成功响应**：
    // 返回 ok:false + reason，前端据此提示「没听清，再试或点图标」，不阻断表达。
    {
      method: 'POST', pattern: '/api/patient/speech',
      handler: async ({ body }) => {
        const started = Date.now();
        const result = await speech.transcribe({
          audioBase64: body.audioBase64 || body.audio || '',
          audioFormat: body.audioFormat || 'wav',
        });

        // 关键一步：把识别出的自由文本归一化回词表原词。
        // 患者说「我想喝水」，SIS 返回「我想喝水」，而引擎只认词表里的「水」。
        // 不做这一步，语音链路会静默失效（表现为 fallback_list，且不报错）。
        const normalized = normalizeFragments(result.fragments || []);

        return {
          ok: result.ok,
          // 识别出的原文（供家属端排障与 A 迭代 prompt 时参考）
          text: result.text || '',
          // 切分并归一化后的碎片，直接可当 clues.voiceFragments 用
          fragments: normalized.words,
          // 原始切分结果。归一化可能全部落空（患者说了词表外的内容），
          // 这时原文仍要留着，家属端才能看出「他到底想说什么」
          rawFragments: normalized.raw,
          reason: result.reason || null,
          durationMs: Date.now() - started,
          // 明确暴露「本次是否真的调了模型」，与 R6 的零调用声明口径一致
          provider: speech.id,
          providerAvailable: speech.available(),
        };
      },
    },

    // ── 患者端：线索提交 → 候选 / 澄清 ──
    {
      method: 'POST', pattern: '/api/patient/understand',
      handler: async ({ body }) => {
        const sessionId = body.sessionId || randomUUID();
        const patientId = body.patientId || 'demo-patient';
        const clues = body.clues || {};
        const scenario = body.scenario || '';

        const session = sessions.get(sessionId) || sessions.upsert(sessionId, { patientId });

        // 缓存：同一批线索在会话内位置锁定（R2），直接复用上次顺序
        const cacheKey = ClueCandidateCache.key(patientId, scenario, clues);
        const cached = cache.get(cacheKey);

        const profile = buildProfile(words, patientId);
        const result = await engine.understand({
          clues, scenario, profile,
          recentConfirmed: expressions.recentTexts(patientId, 3),
          round: session.round || 0,
        });

        // 紧急：落库留痕 + 通知家属端，零模型调用
        if (result.state === CLARIFY_STATE.EMERGENCY) {
          emergencies.log({
            sessionId, patientId,
            rule: result.emergency.rule, reason: result.emergency.reason,
            message: result.emergency.message, clues,
          });
          // SSE 实时推送：家属端立即收到，无需等轮询（字段与 /api/caregiver/emergencies 对齐）
          broadcast('emergency', {
            session_id: sessionId, patient_id: patientId,
            rule: result.emergency.rule, reason: result.emergency.reason,
            message: result.emergency.message, clues,
            notified_at: new Date().toISOString(),
          });
          sessions.upsert(sessionId, { state: CLARIFY_STATE.EMERGENCY, patientId });
          return { ok: true, sessionId, emergency: result.emergency, candidates: [], clarification: null };
        }

        // 排序锁定：同一批线索命中缓存则沿用旧顺序，避免患者刚记住位置就变
        let candidates = result.candidates;
        if (cached && sameClueBatch(session.lastClues, clues)) {
          candidates = reorderAsLocked(result.candidates, cached.order);
        } else if (candidates.length > 0) {
          cache.set(cacheKey, { order: candidates.map((c) => c.text) });
        }

        // 线索冲突结论 —— 患者端可读形态（无数字）。
        // 必须**先声明再使用**：下面 sessions.upsert 要把它存进会话，
        // 确认时才能落库。放到 return 前会导致 TDZ 报错。
        const conflict = result.trace?.clueConflict;
        const clueConflict = conflict?.conflicted
          ? { conflicted: true, pairs: conflict.pairs || [] }
          : { conflicted: false, pairs: [] };

        sessions.upsert(sessionId, {
          patientId, state: result.state, round: session.round || 0,
          lastClues: clues,
          lastClueConflict: conflict?.conflicted ? clueConflict : null,
          lockedOrder: candidates.map((c) => c.text),
        });

        // 患者端不暴露置信度数值（R3）—— 用排序位置表达。
        //
        // v1.4：把「为什么问这一句」透出去，但**只透确定性依据**。
        // 这里刻意只带 clueConflict（纯结构判断：两条线索各自指向不同候选），
        // 不带任何置信度数字 —— 否则 R3 就被绕过了。
        return {
          ok: true,
          sessionId,
          state: result.state,
          candidates: candidates.map((c) => ({ rank: c.rank, text: c.text })),
          clarification: result.clarification,
          fallbackOptions: result.fallbackOptions,
          emergency: { triggered: false },
          clueConflict,
        };
      },
    },

    // ── 患者端：澄清回答 ──
    {
      method: 'POST', pattern: '/api/patient/clarify',
      handler: async ({ body }) => {
        const { sessionId, answer } = body;
        const session = sessions.get(sessionId);
        if (!session) return { __status: 404, ok: false, error: '会话不存在' };

        const ranked = (session.lockedOrder || []).map((text, i) => ({ id: text, text, confidence: 0, rank: i + 1 }));
        const applied = applyClarificationAnswer({
          clarification: body.clarification || { type: 'yes_no' },
          answer, ranked,
        });

        if (applied.action === 'confirm' && applied.confirmed) {
          return await confirmExpression(ctx, {
            sessionId, patientId: session.patientId, candidate: applied.confirmed,
            clues: session.lastClues, clarifyRounds: session.round || 0,
            clueConflict: session.lastClueConflict || null,
          });
        }

        // 不是 → 轮次 +1，排除该候选后重跑
        const nextRound = (session.round || 0) + 1;
        sessions.upsert(sessionId, {
          patientId: session.patientId,
          round: nextRound,
          state: CLARIFY_STATE.EVALUATING,
          lastClues: session.lastClues,
        });

        const profile = buildProfile(words, session.patientId);
        const result = await engine.understand({
          clues: session.lastClues || {},
          profile,
          recentConfirmed: expressions.recentTexts(session.patientId, 3),
          round: nextRound,
          excludeIds: applied.exclude ? [applied.exclude] : [],
        });

        // 两轮仍未收敛 → 全量候选 + 「都不是，重来」（R4③）
        const nextConflict = result.trace?.clueConflict;
        const nextClueConflict = nextConflict?.conflicted
          ? { conflicted: true, pairs: nextConflict.pairs || [] }
          : { conflicted: false, pairs: [] };
        return {
          ok: true,
          sessionId,
          state: result.state,
          candidates: result.candidates.map((c) => ({ rank: c.rank, text: c.text })),
          clarification: result.clarification,
          fallbackOptions: result.fallbackOptions,
          round: nextRound,
          clueConflict: nextClueConflict,
        };
      },
    },

    // ── 患者端：确认输出（R5）──
    {
      method: 'POST', pattern: '/api/patient/confirm',
      handler: async ({ body }) => {
        const session = sessions.get(body.sessionId);
        if (!session) return { __status: 404, ok: false, error: '会话不存在' };
        return await confirmExpression(ctx, {
          sessionId: body.sessionId, patientId: session.patientId,
          candidate: { text: body.text, confidence: body.confidence, breakdown: body.breakdown },
          clues: session.lastClues, clarifyRounds: session.round || 0,
          clueConflict: session.lastClueConflict || null,
        });
      },
    },

    // ── 患者端：紧急一键（R6，零模型）──
    {
      method: 'POST', pattern: '/api/patient/emergency',
      handler: async ({ body }) => {
        const sessionId = body.sessionId || randomUUID();
        const patientId = body.patientId || 'demo-patient';
        const message = body.message || '我按了紧急按钮，快来帮我';
        emergencies.log({
          sessionId, patientId, rule: 'R6-手动一键',
          reason: '患者按下首屏常驻紧急按钮', message, clues: {},
        });
        // SSE 实时推送：一键通道不走 AI，但通知必须最快到达家属端
        broadcast('emergency', {
          session_id: sessionId, patient_id: patientId, rule: 'R6-手动一键',
          reason: '患者按下首屏常驻紧急按钮', message, clues: {},
          notified_at: new Date().toISOString(),
        });
        sessions.upsert(sessionId, { patientId, state: CLARIFY_STATE.EMERGENCY });
        return {
          ok: true, sessionId,
          emergency: {
            triggered: true, level: 1, rule: 'R6-手动一键',
            message, notify: 'caregiver', modelCalled: false,
          },
        };
      },
    },

    // ── 患者端：重来 ──
    {
      method: 'POST', pattern: '/api/patient/reset',
      handler: async ({ body }) => {
        sessions.reset(body.sessionId);
        return { ok: true, state: CLARIFY_STATE.IDLE };
      },
    },

    // ── 家属端：表达记录 ──
    {
      method: 'GET', pattern: '/api/caregiver/expressions',
      handler: async ({ query }) => ({
        ok: true,
        expressions: expressions.recent(query.get('patientId') || 'demo-patient', Number(query.get('limit')) || 20),
        stats: expressions.stats(query.get('patientId') || 'demo-patient'),
      }),
    },

    // ── 家属端：紧急事件 ──
    {
      method: 'GET', pattern: '/api/caregiver/emergencies',
      handler: async ({ query }) => ({
        ok: true,
        emergencies: emergencies.recent(query.get('patientId') || 'demo-patient', 20),
      }),
    },

    // ── 家属端：SSE 实时推送（轮询的主动通道替代，轮询仍作兜底）──
    // text/event-stream：心跳防中间层回收空闲连接，req/res 两侧 close 清理防内存泄漏。
    // 事件：expression / emergency，data 与对应 GET 端点返回的单条结构一致。
    {
      method: 'GET', pattern: '/api/caregiver/stream',
      handler: async ({ req, res }) => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          // 告知反向代理（如 Nginx）不要缓冲本响应，否则事件会被攒住不推
          'X-Accel-Buffering': 'no',
        });
        res.write(': connected\n\n');
        sseClients.add(res);

        // 心跳：纯注释行（客户端不解析），15 秒一条，只为保持连接
        const heartbeat = setInterval(() => {
          try { res.write(': ping\n\n'); } catch { /* 断连由 close 事件清理 */ }
        }, 15000);

        // 断连清理：req/res 两侧都挂，Set.delete / clearInterval 幂等，重复触发无害
        const cleanup = () => {
          clearInterval(heartbeat);
          sseClients.delete(res);
        };
        req.on('close', cleanup);
        res.on('close', cleanup);

        // __sse：告知分发层该连接由本 handler 自管理，不走 sendJSON
        return { __sse: true };
      },
    },

    // ── 家属端：词库（可见数值，可配 —— R7）──
    {
      method: 'GET', pattern: '/api/caregiver/words',
      handler: async () => ({
        ok: true,
        words: words.effective(),
        emergencyWords: EMERGENCY_WORDS_PRIMARY,
      }),
    },
    {
      method: 'POST', pattern: '/api/caregiver/words',
      handler: async ({ body }) => {
        const saved = words.upsert({
          wordId: body.wordId || `W-CFG-${Date.now().toString(36)}`,
          text: body.text, category: body.category, source: 'caregiver',
          priority: body.priority, mapping: body.mapping, actor: body.actor || '家属',
        });
        return { ok: true, word: saved };
      },
    },
    {
      method: 'POST', pattern: '/api/caregiver/words/delete',
      handler: async ({ body }) => {
        const r = words.remove(body.wordId, body.actor || '家属');
        return { __status: r.ok ? 200 : 400, ...r };
      },
    },
    {
      method: 'POST', pattern: '/api/caregiver/words/approve',
      handler: async ({ body }) => {
        words.approve(body.wordId, body.actor || '家属');
        return { ok: true };
      },
    },

    // ── 家属端：指标看板 ──
    {
      method: 'GET', pattern: '/api/caregiver/metrics',
      handler: async ({ query }) => ({
        ok: true,
        cache: { hitRate: cache.hitRate(), ...cache.stats },
        expression: expressions.stats(query.get('patientId') || 'demo-patient'),
        promptVersions: prompts.all(),
      }),
    },

    // ── 家属端：保存 prompt 版本记录（交付物四）──
    {
      method: 'POST', pattern: '/api/caregiver/prompt-version',
      handler: async ({ body }) => {
        prompts.save({
          version: body.version, date: body.date || new Date().toISOString().slice(0, 10),
          changeDesc: body.changeDesc, hypothesis: body.hypothesis,
          top3HitRate: body.top3HitRate, avgClarifyRounds: body.avgClarifyRounds,
          failCases: body.failCases,
        });
        return { ok: true, versions: prompts.all() };
      },
    },

    // ── 调试：完整推理详情（含置信度分解，仅供开发与答辩演示）──
    {
      method: 'POST', pattern: '/api/debug/understand',
      handler: async ({ body }) => {
        const profile = buildProfile(words, body.patientId || 'demo-patient');
        const result = await engine.understand({
          clues: body.clues || {}, scenario: body.scenario || '',
          profile, recentConfirmed: body.recentConfirmed || [],
          round: body.round || 0,
        });
        return { ok: true, ...result };
      },
    },
  ];
}

// ── 确认输出（R5）───────────────────────────────────────────
async function confirmExpression(ctx, { sessionId, patientId, candidate, clues, clarifyRounds, clueConflict }) {
  const { expressions, sessions, words, broadcast } = ctx;

  expressions.save({
    sessionId, patientId,
    scenarioKey: candidate.scenarioKey || null,
    finalText: candidate.text,
    confidence: candidate.confidence ?? null,
    breakdown: candidate.breakdown || {},
    clues: clues || {},
    clueConflict: clueConflict || null,
    clarifyRounds: clarifyRounds || 0,
    viaEmergency: false,
  });

  // SSE 实时推送：家属端立即看到新表达，不再等 5 秒轮询。
  // data 与 /api/caregiver/expressions 返回的单条结构一致，前端两种来源可互换。
  // 此处同时覆盖 confirm 与 clarify「是」两条确认路径。
  broadcast('expression', {
    sessionId, patientId,
    scenarioKey: candidate.scenarioKey || null,
    finalText: candidate.text,
    confidence: candidate.confidence ?? null,
    breakdown: candidate.breakdown || {},
    clues: clues || {},
    clueConflict: clueConflict || null,
    clarifyRounds: clarifyRounds || 0,
    viaEmergency: false,
    createdAt: new Date().toISOString(),
  });

  // 使用习得：确认过的表达进入习得池，待家属审核（R7）
  if (candidate.text && candidate.text.length <= 15) {
    try {
      const existing = words.effective().some((w) => w.text === candidate.text);
      if (!existing) words.proposeLearned(candidate.text);
    } catch { /* 习得失败不影响主流程 */ }
  }

  sessions.reset(sessionId);

  return {
    ok: true,
    confirmed: true,
    finalText: candidate.text,
    state: CLARIFY_STATE.CONFIRMED,
    // R5：确认后进入「已表达」状态并朗读（可选），家属端实时同步
    speak: true,
    notifiedCaregiver: true,
  };
}

// ── 个性化画像：从词表库聚合出 prompt 需要的形态 ──────────────
function buildProfile(wordRepo, patientId) {
  const all = wordRepo.effective();
  const caregiverNames = {};
  const preferredWords = [];
  const routine = [];

  for (const w of all) {
    if (w.category === 'caregiver_name' && w.mapping) caregiverNames[w.text] = w.mapping;
    if (w.category === 'common' && w.source !== 'base') preferredWords.push(w.text);
    if (w.category === 'routine') routine.push({ scenarioKey: w.scenarioKey || w.text, weight: w.priority / 5 });
    if (w.category === 'preference') preferredWords.push(w.text);
  }

  return { patientId, caregiverNames, preferredWords, routine };
}

// ── 排序锁定：按缓存顺序重排（R2）────────────────────────────
function reorderAsLocked(candidates, lockedOrder) {
  if (!lockedOrder || lockedOrder.length === 0) return candidates;
  const byText = new Map(candidates.map((c) => [c.text, c]));
  const ordered = [];
  for (const text of lockedOrder) {
    const c = byText.get(text);
    if (c) { ordered.push(c); byText.delete(text); }
  }
  // 新增的候选排在后面，但不影响既有位置
  for (const c of byText.values()) ordered.push(c);
  return ordered.map((c, i) => ({ ...c, rank: i + 1 }));
}

function sameClueBatch(a, b) {
  if (!a || !b) return false;
  const norm = (c) => [c.icons || [], c.keywords || [], c.voiceFragments || []]
    .map((arr) => [...arr].map(String).sort().join('+')).join('|');
  return norm(a) === norm(b);
}

// ── 路由匹配 ─────────────────────────────────────────────────
function matchRoute(routes, method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    if (r.pattern === pathname) return r.handler;
    // 支持简单参数段 /api/x/:id
    if (r.pattern.includes(':')) {
      const pp = r.pattern.split('/');
      const ap = pathname.split('/');
      if (pp.length !== ap.length) continue;
      const params = {};
      let okAll = true;
      for (let i = 0; i < pp.length; i++) {
        if (pp[i].startsWith(':')) params[pp[i].slice(1)] = ap[i];
        else if (pp[i] !== ap[i]) { okAll = false; break; }
      }
      if (okAll) { const h = r.handler; h.__params = params; return h; }
    }
  }
  return null;
}

// ── IO 工具 ──────────────────────────────────────────────────
function sendJSON(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    if (req.method === 'GET' || req.method === 'HEAD') return resolve({});
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { resolve({}); }
    });
  });
}

/** 可 gzip 压缩的 MIME 类型前缀 */
const COMPRESSIBLE_TYPES = new Set(['text/', 'application/json', 'application/javascript', 'application/manifest+json', 'image/svg+xml']);

/** 静态资源缓存策略：HTML 需验证，其余缓存 1 天 */
function cacheControlFor(ext) {
  if (ext === '.html') return 'no-cache';
  if (ext === '.webmanifest') return 'public, max-age=3600';
  return 'public, max-age=86400';
}

async function serveStatic(res, publicDir, pathname, req) {
  const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(publicDir, safe);
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    const ext = extname(filePath);
    const contentType = MIME[ext] || 'application/octet-stream';

    const etag = `"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': cacheControlFor(ext) });
      return res.end();
    }

    let data = await readFile(filePath);
    const headers = {
      'Content-Type': contentType,
      'Cache-Control': cacheControlFor(ext),
      ETag: etag,
    };

    const acceptEnc = req.headers['accept-encoding'] || '';
    if (acceptEnc.includes('gzip') && COMPRESSIBLE_TYPES.has(contentType.split(';')[0]) && data.length > 1024) {
      data = await gzip(data);
      headers['Content-Encoding'] = 'gzip';
    }
    headers['Content-Length'] = data.length;

    res.writeHead(200, headers);
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>404</h1><p>找不到页面</p>');
  }
}
