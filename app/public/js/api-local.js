/**
 * 本地 API 适配器 —— GitHub Pages 上无后端时，用前端规则引擎提供完整功能
 *
 * 与后端 API 接口完全一致，patient.js 无需感知差异。
 * 语音识别不可用（需华为云 SIS 凭证），其余功能全部本地可用。
 */

import { understand } from '../engine/engine-lite.js';
import { SCENARIOS } from '../engine/scenarios.js';
import { applyClarificationAnswer } from '../engine/clarify.js';
import { evaluateEmergency, emergencyMessage } from '../engine/emergency.js';

const sessions = new Map();

function getSession(id) {
  if (!sessions.has(id)) {
    sessions.set(id, { ranked: [], clarification: null, profile: null });
  }
  return sessions.get(id);
}

export const localApi = {
  async get(path) {
    if (path === '/api/scenarios') {
      return { scenarios: SCENARIOS };
    }
    if (path === '/api/health') {
      return { speech: { available: false } };
    }
    return { ok: false, error: 'unknown endpoint' };
  },

  async post(path, body = {}) {
    if (path === '/api/patient/understand') {
      const sess = getSession(body.sessionId);
      const res = await understand({
        clues: body.clues || {},
        scenario: body.scenario || '',
        profile: sess.profile,
        round: 0,
      });
      sess.ranked = res.candidates || [];
      sess.clarification = res.clarification;
      return res;
    }

    if (path === '/api/patient/clarify') {
      const sess = getSession(body.sessionId);
      const action = applyClarificationAnswer({
        clarification: body.clarification || sess.clarification,
        answer: body.answer,
        ranked: sess.ranked,
      });

      if (action.action === 'confirm' && action.confirmed) {
        return { confirmed: true, finalText: action.confirmed.text };
      }

      if (action.action === 'reclue') {
        const res = await understand({
          clues: { voiceFragments: action.residualClues || [] },
          profile: sess.profile,
          round: (body.clarification?.round || 0),
          excludeIds: action.exclude ? [action.exclude] : [],
        });
        sess.ranked = res.candidates || [];
        sess.clarification = res.clarification;
        return res;
      }

      return { confirmed: false, ok: true, state: 'fallback_list', candidates: sess.ranked, fallbackOptions: ['都不是，重来'] };
    }

    if (path === '/api/patient/confirm') {
      return { ok: true, finalText: body.text };
    }

    if (path === '/api/patient/emergency') {
      const emg = evaluateEmergency({});
      return {
        ok: true,
        emergency: {
          triggered: true,
          message: '我很不舒服，快来人',
          level: 1,
        },
      };
    }

    if (path === '/api/patient/reset') {
      sessions.delete(body.sessionId);
      return { ok: true };
    }

    return { ok: false, error: 'unknown endpoint' };
  },
};