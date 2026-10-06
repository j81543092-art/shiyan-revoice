# 任务 A：SQLite → 华为云 RDS（PostgreSQL）适配层

> 本文件是给「华为云码道 CodeArts 代码智能体」的需求投喂材料。
> 目标：把本地 `node:sqlite` 存储层升级为「RDS(PostgreSQL) 优先、SQLite 兜底」的双轨适配层。

## ⚠️ 先读这一节：本任务的「同步 → 异步」改造（最重要）

原代码的存储层是**同步**的：`node:sqlite` 的 `DatabaseSync`，所有 repository 方法（`save/get/all/upsert/remove/…`）都**同步返回**，`routes.js` 里约 25 处对它们的调用**没有 `await`**。

而 PostgreSQL 标准驱动 `pg` 的 `query()` 是**异步**的（返回 Promise）。

因此本任务**不是**「换个连接字符串」，而是一次**同步接口 → 异步接口**的改造。改造契约如下，必须严格遵守：

### 契约一：repository 方法全部异步化

`db.js` 里 5 个 repository（`createWordRepository` / `createExpressionRepository` / `createSessionRepository` / `createEmergencyRepository` / `createPromptVersionRepository`）暴露的**所有方法都改成 `async`**，方法体内所有数据库访问统一写成 `await db.prepare(sql).all(...)` / `await db.prepare(sql).get(...)` / `await db.prepare(sql).run(...)` / `await db.exec(...)`。

> 为什么 `await` 对 SQLite 分支也成立：`db.prepare(sql).all()` 在 SQLite 下同步返回数组，`await 数组` 得到的就是那个数组；在 PG 下返回 Promise，`await` 得到结果。两边语义一致，所以 repository 内部**统一写 await**即可，不需要 `if (isPg)` 分支。

### 契约二：数据访问对象（db）的接口统一

`openDatabase()` 返回的对象，无论哪种分支，都必须提供：

```
db.exec(sql)                 → 建表 / 批量 DDL（migrate 用，无占位符）
db.prepare(sql)              → 返回 { all(...params), get(...params), run(...params) }
db.close()                   → 优雅关闭
```

- **SQLite 分支**：`db` 就是 `DatabaseSync` 实例，`prepare()` 返回原生 statement，`.all/.get/.run` 是同步的（被 await 兼容）。
- **PG 分支**：`db` 是自写 adapter，`prepare(sql)` 返回一个对象，其 `.all/.get/.run` 是 `async`，内部把 `?` 占位符转成 `$n` 后调 `pool.query`。

### 契约三：`openDatabase` 与 `createApp` 变为 async

- `openDatabase()` → `async`（PG 分支需 `await import('pg')` + 建连接池 + 建表）。
- `createApp()` → `async`，内部 `const db = await openDatabase()`、`await words.seedBase()`。
- `index.js` 里 `const { server, engine } = await createApp(...)`（Node >= 20 支持顶层 await，或包 `main()`）。
- `server.on('close', () => db.close())`：`db.close()` 对 PG 是 `pool.end()`（async），fire-and-forget 即可，不必 await。

### 契约四：`routes.js` 里 25 处调用加 `await`

以下位置（行号基于当前 `server/api/routes.js`）的 repository 调用全部加 `await`：

| 行 | 调用 | 改为 |
|---|---|---|
| 160 | `prompts.all()` | `await prompts.all()` |
| 208 | `sessions.get()` / `sessions.upsert()` | 各加 `await` |
| 217 | `expressions.recentTexts()` | `await` |
| 223 | `emergencies.log()` | `await` |
| 235 | `sessions.upsert()` | `await` |
| 255 | `sessions.upsert()` | `await` |
| 285 | `sessions.get()` | `await` |
| 304 | `sessions.upsert()` | `await` |
| 315 | `expressions.recentTexts()` | `await` |
| 342 | `sessions.get()` | `await` |
| 360 | `emergencies.log()` | `await` |
| 370 | `sessions.upsert()` | `await` |
| 385 | `sessions.reset()` | `await` |
| 395 | `expressions.recent()` / `expressions.stats()` | 各加 `await` |
| 405 | `emergencies.recent()` | `await` |
| 448 | `words.effective()` | `await` |
| 455 | `words.upsert()` | `await` |
| 466 | `words.remove()` | `await` |
| 473 | `words.approve()` | `await` |
| 484 | `expressions.stats()` | `await` |
| 485 | `prompts.all()` | `await` |
| 493 | `prompts.save()` | `await` |
| 499 | `prompts.all()` | `await` |
| 523 | `expressions.save()` | `await` |
| 554 | `words.effective()` | `await` |
| 559 | `sessions.reset()` | `await` |
| 574 | `wordRepo.effective()`（buildProfile 内） | `await` |

> 注意：`buildProfile()`（L573）会因此变成 async，它的两处调用点（L214、L311、L507）也要加 `await`。`recentTexts()`（db.js）内部调用 `this.recent()`，同样 async 化。
>
> 说明：`cache.get/set`（ClueCandidateCache）是任务 C 的进程内 LRU，**保持同步、不要动**——它不涉及数据库，不在本任务范围。

### 契约五：`buildProfile` 连带 async

`buildProfile(wordRepo, patientId)` 内部调 `wordRepo.effective()`，改为 async，三处调用点（understand 两处、debug 一处）加 `await`。

---

## 一、背景

拾言 ReVoice 是 Node 项目（`app/`，Node >= 20）。当前存储层在 `app/server/data/db.js`，用 `node:sqlite`（`DatabaseSync`）。赛题要求关联华为云 RDS，需把存储切到 PostgreSQL，同时保留本地无 RDS 时走 SQLite 的能力（评测、本地开发、无凭证演示仍能跑通）。

## 二、现状

`db.js` 导出：`openDatabase`、5 个 `create*Repository`、`ClueCandidateCache`、`DB_PATH`、`DATA_DIR`。repository 方法同步调用 `db.prepare(sql).all/.get/.run` 与 `db.exec(sql)`。表结构见 `migrate()`（6 表 + 4 索引），补列见 `addColumnIfMissing()`（用 `PRAGMA table_info`）。

## 三、目标

`RDS_HOST` 存在 → PostgreSQL（`pg` 驱动，动态 `import()`）；否则 → SQLite。`openDatabase()` 返回统一接口（见上文契约二）。`.env.example` 已预留变量（勿改字段名）：

```
RDS_HOST=          # 有值则启用 PostgreSQL
RDS_PORT=5432
RDS_USER=
RDS_PASSWORD=
RDS_DATABASE=
```

## 四、SQL 方言差异（必须处理）

1. **占位符**：SQLite `?` → PG `$1,$2,...`。在 PG adapter 的 `prepare(sql)` 内做转换（本项目 SQL 无 `?` 字面量，直接 `sql.replace(/\?/g, () => '$'+(++i))` 安全）。
2. **PRAGMA**：`PRAGMA journal_mode=WAL`、`PRAGMA table_info(...)` 是 SQLite 专属。PG 分支跳过前者；补列改用 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`（PG 9.6+ 原生支持）。
3. **自增主键**：SQLite `INTEGER PRIMARY KEY AUTOINCREMENT` → PG `INTEGER GENERATED ALWAYS AS IDENTITY`。
4. **`ON CONFLICT ... DO UPDATE ... SET x=excluded.x`**：两库都支持，保留（冲突目标列 word_id / version 均为 PRIMARY KEY，满足 PG 要求）。注意 `excluded` 是 PG 关键字，SQLite 也兼容。
5. **建表 DDL 用两套字符串**：`migrate()` 里 `isPg ? PG_DDL : SQLITE_DDL`，不要写「运行时转换 DDL」的复杂逻辑。索引同理（`CREATE INDEX IF NOT EXISTS ...` 两库通用，可共用）。
6. **布尔/整型**：`locked / emergency / via_emergency / emergency_level` 两库都用 `INTEGER 0/1`（PG 用 `SMALLINT` 或 `INTEGER`），**不要**用 PG `BOOLEAN`，避免上层 `!!r.locked` 语义变化。
7. **浮点**：SQLite `REAL` → PG `DOUBLE PRECISION`。
8. **`COUNT/SUM/AVG` 返回值类型**：PG 的 `COUNT(*)` 返回 bigint（JS 里是 string）、`SUM` 返回 numeric。**在 PG 建连时设置 type parser**，把 OID 20（int8）和 1700（numeric）解析为 JS number：
   ```js
   import pg from 'pg';
   pg.types.setTypeParser(20, (v) => parseInt(v, 10));
   pg.types.setTypeParser(1700, (v) => parseFloat(v));
   ```
   repository 里的 `Number(...)` 包裹（如 `stats()`）**保留不动**。
9. **`run()` 返回值**：上层不依赖 `run()` 的返回值（`seedBase` 自己累加计数）。PG 分支的 `run()` 返回 `{ changes: result.rowCount }` 即可。

## 五、完整表结构（6 表 + 4 索引，迁移时照抄字段名与语义）

见 `db.js` 的 `migrate()`：`words`、`expressions`、`sessions`、`emergency_events`、`prompt_versions`、`word_audit`；索引 `idx_expr_patient`、`idx_expr_session`、`idx_words_scenario`、`idx_emergency_patient`。字段名、类型语义、NOT NULL 约束一一对应。

## 六、依赖策略

- PG 驱动用 **`pg`**（`npm install pg`），**仅在 `RDS_HOST` 存在时动态 `import()`**，无 RDS 时完全不加载、零依赖不破坏。
- `package.json` 增加 `dependencies: { "pg": "^8.x" }`；`Dockerfile` 增加 `npm install --omit=dev`（如尚未有）。

## 七、验收标准（全部满足才算完成）

1. **步骤 1（只做异步化，不引 pg）完成后**：`cd app && npm run test:all` 全绿；服务能起；`/api/patient/understand` → `/api/patient/confirm` 端到端冒烟通过（本地无 RDS 走 SQLite 分支，行为与改造前完全一致）。
2. **步骤 2（引入 pg 分支）完成后**：
   - `RDS_HOST` 未设置 → 行为与步骤 1 完全一致，test:all 全绿。
   - 设置真实 RDS 连接后：`npm run seed` 能灌入基础词表，`/api/caregiver/words` 能读回，`/api/caregiver/expressions` 能查到确认记录。
   - 连接失败（假 RDS_HOST）→ 服务仍能起、不崩（`pg` 连不上时降级或报错但进程不退出，见下方说明）。

> 关于「连接失败」：`RDS_HOST` 有值但连不上时，可二选一：① `openDatabase` 抛错让启动失败（简单、明确）；② 静默回退 SQLite。**推荐①**——因为「配了 RDS 却悄悄走 SQLite」会在答辩/线上埋下「数据没进 RDS」的隐性事故，明确失败更安全。文档按①约定。

## 八、分两步执行（强烈建议，降低翻车概率）

- **步骤 1**：只做「同步 → 异步」改造（契约一~五），**不引入 `pg`**。改 `db.js` + `routes.js` + `index.js`，SQLite 分支照旧。验收见第七节第 1 条。
- **步骤 2**：在步骤 1 基础上加 PG 分支（adapter + 两套 DDL + 占位符转换 + `pg.types` + 动态 `import('pg')`）。验收见第七节第 2 条。

## 九、给 CodeArts 智能体的自然语言需求（分两次投喂）

### 步骤 1 投喂

> 请为「拾言 ReVoice」项目做一次存储层的同步→异步改造，**不引入任何新依赖**。
> 1. `server/data/db.js`：5 个 repository（词表/表达/会话/紧急/prompt）的所有方法改为 `async`，
>    方法体内 `db.prepare(...).all/get/run` 与 `db.exec(...)` 前统一加 `await`；
>    `openDatabase` 改为 `async`；`buildProfile` 相关不在此文件（在 routes.js）。
>    注意：`ClueCandidateCache` 类（进程内缓存）保持同步，不要动。
> 2. `server/api/routes.js`：约 25 处 repository 调用点加 `await`（含 `buildProfile` 变 async 后的调用点、
>    `confirmExpression` 里的 `expressions.save` / `words.effective` / `words.proposeLearned` / `sessions.reset`）。
> 3. `server/index.js`：`await createApp(...)`。
> 4. 完成后 `npm run test:all` 必须全绿；本地无 RDS 时行为与改造前一致。

### 步骤 2 投喂

> 在上一轮「同步→异步」改造基础上，为「拾言 ReVoice」实现 PostgreSQL 优先、SQLite 兜底的双轨存储。
> 1. `server/data/db.js`：`openDatabase` 里判断 `process.env.RDS_HOST`；存在时动态 `import('pg')` 建连接池，
>    设置 `pg.types` 把 int8/numeric 解析为 number，用一套 `PG_DDL` 建表（`INTEGER GENERATED ALWAYS AS IDENTITY`、
>    `DOUBLE PRECISION`、跳过 PRAGMA、补列用 `ADD COLUMN IF NOT EXISTS`），
>    返回一个 adapter：`exec(sql)` 调 `pool.query`，`prepare(sql)` 返回 `{all,get,run}`（async），
>    内部把 `?` 按顺序转成 `$1,$2,...`；`close()` 调 `pool.end()`。连不上时抛错让启动失败（不回退）。
> 2. `RDS_HOST` 未设置时仍走 `node:sqlite`，代码路径与上一轮一致。
> 3. `package.json` 增加 `pg` 依赖；`.env.example` 的 `RDS_*` 字段名不动。
> 4. 完成后：无 RDS 时 `npm run test:all` 全绿；有 RDS 时 `npm run seed` 能灌词、`/api/caregiver/words` 能读回。
