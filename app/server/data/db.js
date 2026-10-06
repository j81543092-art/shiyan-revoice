/**
 * 数据与服务层 · 存储
 *
 * 用 node:sqlite（Node 内置）实现，零外部依赖。
 * 表结构与《A 阶段 0 交付物包》个性化词条 schema 一致，
 * Redis 部分用进程内 LRU + 命中统计实现同一套键语义 ——
 * 换到 RDS + Redis 时只替换本文件的实现，上层不动。
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENARIOS, flattenWords, WORD_SOURCE, WORD_CATEGORY } from '../domain/scenarios.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const DB_PATH = process.env.DB_PATH || join(DATA_DIR, 'revoice.db');

// ── 「线索组合 → 候选句」缓存 ─────────────────────────────────
// 对应系统设计层第 3 层：缓存命中率随使用上升，是「系统越用越懂患者」的量化证据。
//
// Redis 优先、进程内 LRU 兜底（任务 C）：
//   · get/set 保持**同步**——本地 LRU 是唯一同步读路径，上层 routes.js 零改动。
//   · set 同步写 LRU 的同时 fire-and-forget 异步写 Redis（跨实例共享、24h TTL）；
//   · 服务启动时 warmUp() 从 Redis 异步灌回 LRU；
//   · Redis 连接失败 / 读写抛错一律静默忽略，回退纯 LRU。
class ClueCandidateCache {
  constructor(maxSize = 500) {
    this.maxSize = maxSize;
    this.map = new Map(); // key → { value, hits, createdAt }
    this.stats = { hits: 0, misses: 0, sets: 0 };
    // ── Redis 适配层（可选，REDIS_HOST 存在时才启用）──
    this.redis = null;                   // 只有连接 ready 成功后才会赋值
    this.redisKeyPrefix = 'revoice:cache:';
    this.redisTtlSeconds = 24 * 60 * 60; // 24 小时 TTL，避免无限膨胀
    this._initRedis();
  }

  /** 键结构：patientId|scenario|icons|keywords|fragments（排序后，保证同组合同键） */
  static key(patientId, scenario, clues) {
    const norm = (arr) => [...(arr || [])].map(String).sort().join('+');
    return [
      patientId || 'anon',
      scenario || '-',
      norm(clues.icons),
      norm(clues.keywords),
      norm(clues.voiceFragments),
    ].join('|');
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) {
      this.stats.misses += 1;
      return null;
    }
    entry.hits += 1;
    this.stats.hits += 1;
    // LRU：命中后移到队尾
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, hits: 0, createdAt: Date.now() });
    this.stats.sets += 1;
    if (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    // Redis 跨实例持久化：fire-and-forget，失败静默，主流程不等它
    this._persistToRedis(key, value);
  }

  /** 命中率 —— 答辩材料里的指标之一 */
  hitRate() {
    const total = this.stats.hits + this.stats.misses;
    return total === 0 ? 0 : Math.round((this.stats.hits / total) * 10000) / 10000;
  }

  clear() {
    this.map.clear();
    this.stats = { hits: 0, misses: 0, sets: 0 };
  }

  // ── Redis 适配（全程异步、静默降级，不改变上面同步接口的语义）──

  /** 构造时若 REDIS_HOST 存在则后台建连；无 Redis 环境完全不 import ioredis */
  _initRedis() {
    if (!process.env.REDIS_HOST) return;
    // fire-and-forget：连接与 warmUp 都不阻塞启动
    this._connectRedis(process.env.REDIS_HOST);
  }

  async _connectRedis(host) {
    try {
      // ioredis 仅在需要时动态加载，保证无 Redis 部署仍零外部依赖、不报错
      const mod = await import('ioredis');
      const Redis = mod.default || mod.Redis;
      const client = new Redis({
        host,
        port: Number(process.env.REDIS_PORT) || 6379,
        password: process.env.REDIS_PASSWORD || undefined,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false, // 未 ready 时命令立即失败，不排队
        retryStrategy: () => null, // 不无限重连，失败就回退 LRU
      });

      // 等到 ready / error / 2s 超时，避免长挂
      const settled = await new Promise((resolve) => {
        let done = false;
        const settle = () => { if (!done) { done = true; resolve(client.status); } };
        client.on('ready', settle);
        client.on('error', settle);
        setTimeout(settle, 2000).unref?.();
      });

      if (settled !== 'ready') {
        try { client.disconnect(); } catch { /* 忽略断连异常 */ }
        return; // 连不上：保持纯 LRU
      }

      this.redis = client;
      // 运行期断连：静默标记不可用，后续读写自动走 LRU 兜底
      client.on('error', () => {
        if (this.redis === client) this.redis = null;
      });

      // 服务启动时从 Redis 灌回 LRU（异步，不阻塞启动）
      await this.warmUp();
    } catch {
      // import 失败 / 连接抛错 / warmUp 异常，一律静默回退纯 LRU
      this.redis = null;
    }
  }

  /** 从 Redis 把所有缓存键灌回进程内 LRU（跨实例的排序锁定不丢失） */
  async warmUp() {
    const client = this.redis;
    if (!client) return;
    try {
      const keys = [];
      let cursor = '0';
      do {
        const [next, batch] = await client.scan(cursor, 'MATCH', `${this.redisKeyPrefix}*`, 'COUNT', '100');
        cursor = String(next);
        keys.push(...batch);
      } while (cursor !== '0');

      for (const redisKey of keys) {
        const raw = await client.get(redisKey);
        if (!raw) continue;
        const value = this._safeParse(raw);
        if (value === undefined) continue;
        // 直接进 map，不算「写入」（stats.sets 不动），命中记录从 0 开始
        this.map.set(redisKey.slice(this.redisKeyPrefix.length), { value, hits: 0, createdAt: Date.now() });
      }
      // 容量裁剪：超出 maxSize 淘汰最旧
      while (this.map.size > this.maxSize) {
        const oldest = this.map.keys().next().value;
        this.map.delete(oldest);
      }
    } catch {
      // warmUp 失败不影响主流程，保持已有 LRU 状态
    }
  }

  _persistToRedis(key, value) {
    const client = this.redis;
    if (!client) return;
    try {
      client
        .set(`${this.redisKeyPrefix}${key}`, JSON.stringify(value), 'EX', this.redisTtlSeconds)
        .catch(() => { /* Redis 写失败静默，主流程继续 */ });
    } catch {
      // 同步异常（如 JSON.stringify 遇循环引用）也不上抛
    }
  }

  _safeParse(raw) {
    try { return JSON.parse(raw); } catch { return undefined; }
  }
}

// ── 数据库 ───────────────────────────────────────────────────
export function openDatabase(dbPath = DB_PATH) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    -- 词表库（基础库 + 家属配置 + 使用习得）—— 交付物二 schema
    CREATE TABLE IF NOT EXISTS words (
      word_id      TEXT PRIMARY KEY,
      text         TEXT NOT NULL,
      category     TEXT NOT NULL,          -- 常用词 / 护理者称呼 / 作息 / 偏好
      source       TEXT NOT NULL,          -- base / caregiver / learned
      priority     INTEGER NOT NULL DEFAULT 3,
      mapping      TEXT,                   -- 称呼类映射对象：小王 → 护工王姐
      locked       INTEGER NOT NULL DEFAULT 0,  -- 1 = 不可删（紧急词）
      scenario_id  TEXT,
      scenario_key TEXT,
      emergency    INTEGER NOT NULL DEFAULT 0,
      emergency_level INTEGER NOT NULL DEFAULT 0,
      approved_by  TEXT,
      updated_at   TEXT NOT NULL,
      deleted_at   TEXT
    );

    -- 表达记录 —— 每一次完整表达（确认后的最终句）
    CREATE TABLE IF NOT EXISTS expressions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    TEXT NOT NULL,
      patient_id    TEXT NOT NULL,
      scenario_key  TEXT,
      final_text    TEXT NOT NULL,          -- 患者确认的那一句
      confidence    REAL,                   -- 综合置信度
      breakdown     TEXT,                   -- JSON：四项分项
      clues         TEXT,                   -- JSON：原始线索
      clue_conflict TEXT,                   -- JSON：确定性的线索冲突结论（v1.4）
      clarify_rounds INTEGER NOT NULL DEFAULT 0,
      via_emergency INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL
    );

    -- 会话 —— 承载「排序后位置锁定」（R2）
    CREATE TABLE IF NOT EXISTS sessions (
      session_id    TEXT PRIMARY KEY,
      patient_id    TEXT NOT NULL,
      state         TEXT NOT NULL DEFAULT 'idle',
      round         INTEGER NOT NULL DEFAULT 0,
      locked_order  TEXT,                   -- JSON：候选顺序快照，锁定后不再变
      last_clues    TEXT,                   -- JSON：上一批线索，用于判定「同一批」
      last_clue_conflict TEXT,              -- JSON：上一批线索的冲突结论（v1.4，确认时落库）
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );

    -- 紧急事件留痕（R6）
    CREATE TABLE IF NOT EXISTS emergency_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL,
      patient_id  TEXT NOT NULL,
      rule        TEXT,
      reason      TEXT,
      message     TEXT,
      clues       TEXT,
      notified_at TEXT NOT NULL
    );

    -- prompt 版本库 —— 交付物四模板（每版三行 + 两个数字）
    CREATE TABLE IF NOT EXISTS prompt_versions (
      version        TEXT PRIMARY KEY,
      date           TEXT NOT NULL,
      change_desc    TEXT,
      hypothesis     TEXT,
      top3_hit_rate  REAL,
      avg_clarify_rounds REAL,
      fail_cases     INTEGER,
      created_at     TEXT NOT NULL
    );

    -- 家属端改词留痕（R7：改动留痕可回滚）
    CREATE TABLE IF NOT EXISTS word_audit (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      word_id    TEXT NOT NULL,
      action     TEXT NOT NULL,             -- add / update / delete / approve
      before     TEXT,
      after      TEXT,
      actor      TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_expr_patient ON expressions(patient_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_expr_session ON expressions(session_id);
    CREATE INDEX IF NOT EXISTS idx_words_scenario ON words(scenario_key);
    CREATE INDEX IF NOT EXISTS idx_emergency_patient ON emergency_events(patient_id, notified_at DESC);
  `);

  addColumnIfMissing(db, 'expressions', 'clue_conflict', 'clue_conflict TEXT');
  addColumnIfMissing(db, 'sessions', 'last_clue_conflict', 'last_clue_conflict TEXT');
}

/**
 * 轻量补列：`CREATE TABLE IF NOT EXISTS` 不会给**已存在**的表补列，
 * 所以老库（本地跑过的 SQLite、线上已启动的容器）必须显式补，
 * 否则新代码一 SELECT 到这一列就直接抛错。
 *
 * 幂等靠 PRAGMA 查列名实现 —— 不加迁移框架，只有两列要补，不划算。
 */
function addColumnIfMissing(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => c.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  return true;
}

// ── 词表仓库 ─────────────────────────────────────────────────
export function createWordRepository(db) {
  return {
    /** 初始化：把基础词表灌进去（幂等） */
    seedBase() {
      const now = new Date().toISOString();
      const stmt = db.prepare(`
        INSERT INTO words (word_id, text, category, source, priority, mapping, locked,
                           scenario_id, scenario_key, emergency, emergency_level, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(word_id) DO UPDATE SET
          text=excluded.text, scenario_id=excluded.scenario_id,
          scenario_key=excluded.scenario_key, emergency=excluded.emergency,
          emergency_level=excluded.emergency_level
      `);
      let n = 0;
      for (const w of flattenWords()) {
        stmt.run(
          w.wordId, w.text, w.category, WORD_SOURCE.BASE, w.priority, null,
          w.locked ? 1 : 0, w.scenarioId, w.scenarioKey, w.emergency ? 1 : 0,
          w.emergencyLevel, now,
        );
        n += 1;
      }
      return n;
    },

    /** 按场景取词（含家属配置与已审核的习得词） */
    byScenario(scenarioKey) {
      return db
        .prepare(`SELECT * FROM words WHERE scenario_key = ? AND deleted_at IS NULL ORDER BY priority DESC, word_id`)
        .all(scenarioKey)
        .map(mapWordRow);
    },

    all() {
      return db.prepare(`SELECT * FROM words WHERE deleted_at IS NULL`).all().map(mapWordRow);
    },

    /** 家属 / 治疗师配置词条（R7） */
    upsert({ wordId, text, category, source, priority, mapping, actor }) {
      const now = new Date().toISOString();
      const existing = db.prepare(`SELECT * FROM words WHERE word_id = ?`).get(wordId);

      // 红线：紧急词不可删；已存在且 locked 时不允许改 category/priority 为低值
      if (existing && existing.locked && Number(priority) < 5) {
        throw new Error(`词条「${existing.text}」为紧急词（locked），优先级不可下调`);
      }

      db.prepare(`
        INSERT INTO words (word_id, text, category, source, priority, mapping, locked, updated_at)
        VALUES (?,?,?,?,?,?,0,?)
        ON CONFLICT(word_id) DO UPDATE SET
          text=excluded.text, category=excluded.category, source=excluded.source,
          priority=excluded.priority, mapping=excluded.mapping, updated_at=excluded.updated_at
      `).run(wordId, text, category, source || WORD_SOURCE.CAREGIVER, priority ?? 3, mapping || null, now);

      this.audit(wordId, existing ? 'update' : 'add', existing, { text, category, priority, mapping }, actor);
      return db.prepare(`SELECT * FROM words WHERE word_id = ?`).get(wordId);
    },

    /** 删除（紧急词 locked 直接拒绝 —— R7 第三条边界） */
    remove(wordId, actor) {
      const existing = db.prepare(`SELECT * FROM words WHERE word_id = ?`).get(wordId);
      if (!existing) return { ok: false, reason: '词条不存在' };
      if (existing.locked) return { ok: false, reason: `紧急词「${existing.text}」不可删（R7）` };
      const now = new Date().toISOString();
      db.prepare(`UPDATE words SET deleted_at = ? WHERE word_id = ?`).run(now, wordId);
      this.audit(wordId, 'delete', existing, null, actor);
      return { ok: true };
    },

    /** 使用习得：从确认历史里生出候选词条，待家属审核 */
    proposeLearned(text, actor = 'system') {
      const wordId = `W-LRN-${Date.now().toString(36)}`;
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO words (word_id, text, category, source, priority, locked, approved_by, updated_at)
        VALUES (?,?,?,?,?,0,NULL,?)
      `).run(wordId, text, WORD_CATEGORY.COMMON, WORD_SOURCE.LEARNED, 3, now);
      this.audit(wordId, 'add', null, { text, source: WORD_SOURCE.LEARNED }, actor);
      return wordId;
    },

    /** 家属审核通过（R7：习得词须家属审核后生效） */
    approve(wordId, approver) {
      const now = new Date().toISOString();
      db.prepare(`UPDATE words SET approved_by = ?, updated_at = ? WHERE word_id = ?`)
        .run(approver, now, wordId);
      this.audit(wordId, 'approve', null, { approved_by: approver }, approver);
      return true;
    },

    /** 生效中的个性化词条（仅 base + caregiver + 已审核的 learned） */
    effective() {
      return db
        .prepare(`
          SELECT * FROM words
          WHERE deleted_at IS NULL
            AND (source != 'learned' OR approved_by IS NOT NULL)
        `)
        .all()
        .map(mapWordRow);
    },

    audit(wordId, action, before, after, actor) {
      db.prepare(`
        INSERT INTO word_audit (word_id, action, before, after, actor, created_at)
        VALUES (?,?,?,?,?,?)
      `).run(
        wordId, action,
        before ? JSON.stringify(before) : null,
        after ? JSON.stringify(after) : null,
        actor || 'unknown',
        new Date().toISOString(),
      );
    },
  };
}

// ── 表达与会话仓库 ───────────────────────────────────────────
export function createExpressionRepository(db) {
  return {
    save(record) {
      db.prepare(`
        INSERT INTO expressions
          (session_id, patient_id, scenario_key, final_text, confidence, breakdown,
           clues, clue_conflict, clarify_rounds, via_emergency, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        record.sessionId, record.patientId, record.scenarioKey || null,
        record.finalText, record.confidence ?? null,
        JSON.stringify(record.breakdown || {}),
        JSON.stringify(record.clues || {}),
        record.clueConflict ? JSON.stringify(record.clueConflict) : null,
        record.clarifyRounds || 0,
        record.viaEmergency ? 1 : 0,
        new Date().toISOString(),
      );
    },

    recent(patientId, limit = 20) {
      return db
        .prepare(`SELECT * FROM expressions WHERE patient_id = ? ORDER BY created_at DESC LIMIT ?`)
        .all(patientId, limit)
        .map(mapExpressionRow);
    },

    /** 最近 N 条已确认表达 —— 进 prompt 的 recent_confirmed 字段 */
    recentTexts(patientId, limit = 3) {
      return this.recent(patientId, limit).map((r) => r.finalText);
    },

    stats(patientId) {
      const row = db
        .prepare(`
          SELECT COUNT(*) AS total,
                 AVG(clarify_rounds) AS avg_rounds,
                 SUM(via_emergency) AS emergency_count
          FROM expressions WHERE patient_id = ?
        `)
        .get(patientId);
      return {
        total: Number(row?.total || 0),
        avgClarifyRounds: row?.avg_rounds ? Math.round(Number(row.avg_rounds) * 100) / 100 : 0,
        emergencyCount: Number(row?.emergency_count || 0),
      };
    },
  };
}

export function createSessionRepository(db) {
  return {
    get(sessionId) {
      const row = db.prepare(`SELECT * FROM sessions WHERE session_id = ?`).get(sessionId);
      return row ? mapSessionRow(row) : null;
    },

    upsert(sessionId, patch) {
      const now = new Date().toISOString();
      const existing = this.get(sessionId);
      if (!existing) {
        db.prepare(`
          INSERT INTO sessions (session_id, patient_id, state, round, locked_order, last_clues, last_clue_conflict, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?)
        `).run(
          sessionId, patch.patientId || 'demo-patient', patch.state || 'idle',
          patch.round || 0,
          patch.lockedOrder ? JSON.stringify(patch.lockedOrder) : null,
          patch.lastClues ? JSON.stringify(patch.lastClues) : null,
          patch.lastClueConflict ? JSON.stringify(patch.lastClueConflict) : null,
          now, now,
        );
      } else {
        db.prepare(`
          UPDATE sessions SET state = ?, round = ?, locked_order = ?, last_clues = ?, last_clue_conflict = ?, updated_at = ?
          WHERE session_id = ?
        `).run(
          patch.state ?? existing.state,
          patch.round ?? existing.round,
          JSON.stringify(patch.lockedOrder ?? existing.lockedOrder ?? null),
          JSON.stringify(patch.lastClues ?? existing.lastClues ?? null),
          JSON.stringify(patch.lastClueConflict ?? existing.lastClueConflict ?? null),
          now, sessionId,
        );
      }
      return this.get(sessionId);
    },

    reset(sessionId) {
      db.prepare(`UPDATE sessions SET state='idle', round=0, locked_order=NULL, last_clues=NULL, last_clue_conflict=NULL, updated_at=? WHERE session_id=?`)
        .run(new Date().toISOString(), sessionId);
    },
  };
}

export function createEmergencyRepository(db) {
  return {
    log(event) {
      db.prepare(`
        INSERT INTO emergency_events (session_id, patient_id, rule, reason, message, clues, notified_at)
        VALUES (?,?,?,?,?,?,?)
      `).run(
        event.sessionId, event.patientId, event.rule || null, event.reason || null,
        event.message || null, JSON.stringify(event.clues || {}),
        new Date().toISOString(),
      );
    },
    recent(patientId, limit = 20) {
      return db
        .prepare(`SELECT * FROM emergency_events WHERE patient_id = ? ORDER BY notified_at DESC LIMIT ?`)
        .all(patientId, limit)
        .map((r) => ({ ...r, clues: safeJSON(r.clues) }));
    },
  };
}

export function createPromptVersionRepository(db) {
  return {
    save(v) {
      db.prepare(`
        INSERT INTO prompt_versions (version, date, change_desc, hypothesis, top3_hit_rate, avg_clarify_rounds, fail_cases, created_at)
        VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(version) DO UPDATE SET
          date=excluded.date, change_desc=excluded.change_desc, hypothesis=excluded.hypothesis,
          top3_hit_rate=excluded.top3_hit_rate, avg_clarify_rounds=excluded.avg_clarify_rounds,
          fail_cases=excluded.fail_cases
      `).run(
        v.version, v.date, v.changeDesc || '', v.hypothesis || '',
        v.top3HitRate ?? null, v.avgClarifyRounds ?? null, v.failCases ?? null,
        new Date().toISOString(),
      );
    },
    all() {
      return db.prepare(`SELECT * FROM prompt_versions ORDER BY date, version`).all();
    },
  };
}

// ── 行映射 ───────────────────────────────────────────────────
function mapWordRow(r) {
  return {
    wordId: r.word_id, text: r.text, category: r.category, source: r.source,
    priority: r.priority, mapping: r.mapping, locked: !!r.locked,
    scenarioId: r.scenario_id, scenarioKey: r.scenario_key,
    emergency: !!r.emergency, emergencyLevel: r.emergency_level,
    approvedBy: r.approved_by, updatedAt: r.updated_at,
  };
}

function mapExpressionRow(r) {
  return {
    id: r.id, sessionId: r.session_id, patientId: r.patient_id,
    scenarioKey: r.scenario_key, finalText: r.final_text,
    confidence: r.confidence, breakdown: safeJSON(r.breakdown),
    clues: safeJSON(r.clues), clueConflict: safeJSON(r.clue_conflict),
    clarifyRounds: r.clarify_rounds,
    viaEmergency: !!r.via_emergency, createdAt: r.created_at,
  };
}

function mapSessionRow(r) {
  return {
    sessionId: r.session_id, patientId: r.patient_id, state: r.state,
    round: r.round, lockedOrder: safeJSON(r.locked_order),
    lastClues: safeJSON(r.last_clues),
    lastClueConflict: safeJSON(r.last_clue_conflict),
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function safeJSON(s) {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export { ClueCandidateCache, DB_PATH, DATA_DIR };
