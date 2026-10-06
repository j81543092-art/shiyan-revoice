# 任务 A：SQLite → 华为云 RDS（PostgreSQL）适配层

> 本文件是给「华为云码道 CodeArts 代码智能体」的需求投喂材料。
> 目标：把本地 `node:sqlite` 存储层升级为「RDS(PostgreSQL) 优先、SQLite 兜底」的双轨适配层，上层 repository 一行不改。

## 一、背景

拾言 ReVoice 是零外部依赖的 Node 项目（`app/`，Node >= 20）。当前存储层在
`app/server/data/db.js`，用 Node 内置的 `node:sqlite`（`DatabaseSync`）。
赛题要求关联华为云 RDS，因此需要把存储切换到 PostgreSQL，同时**保留本地无 RDS 时走 SQLite 的能力**（评测、本地开发、无凭证演示都必须仍能跑通）。

关键约束：
- 上层业务（`server/api/routes.js`、`server/domain/*`）**一行都不能改**——它们只依赖 repository 暴露的方法。
- repository 内部通过 `db.prepare(sql).all()/.get()/.run()` 和 `db.exec(sql)` 访问数据库，这是需要被适配的接口。

## 二、现状：需要适配的 SQLite 接口

`db.js` 导出并使用了这些能力：

```js
// 打开数据库（自动建目录 + 迁移）
const db = openDatabase(dbPath);   // 返回 DatabaseSync 实例

// 三种访问模式
db.exec(sql)                       // 建表、PRAGMA、批量 DDL
db.prepare(sql).all(...params)     // 返回对象数组
db.prepare(sql).get(...params)     // 返回单行或 undefined
db.prepare(sql).run(...params)     // 写操作

// 服务关闭
db.close();
```

repository 层（`createWordRepository` / `createExpressionRepository` / `createSessionRepository` /
`createEmergencyRepository` / `createPromptVersionRepository`）都通过上面这组接口操作数据。

## 三、目标接口（保持不变）

产出一个新的 `app/server/data/db.js` 改造（或新增 `db-pg.js` + 在 `db.js` 顶部按环境变量分发），
保证 `openDatabase()` 的返回值仍提供 `exec / prepare / close` 三个成员，`prepare().all/get/run` 行为不变。
`RDS_HOST` 存在 → PostgreSQL；否则 → SQLite。

`.env.example` 已预留的变量（直接使用，勿改字段名）：

```
RDS_HOST=        # 有值则启用 PostgreSQL
RDS_PORT=5432
RDS_USER=
RDS_PASSWORD=
RDS_DATABASE=
```

## 四、必须处理的 SQL 方言差异（这是「问题修复」环节的重点）

1. **占位符**：SQLite 用 `?`，PostgreSQL 用 `$1, $2, ...`。适配层需在内部把 `?` 按出现顺序改写为 `$n`。
2. **PRAGMA**：`PRAGMA journal_mode = WAL`、`PRAGMA table_info(...)` 是 SQLite 专属，PostgreSQL 分支必须跳过/等价替换。
3. **自增主键**：SQLite 用 `INTEGER PRIMARY KEY AUTOINCREMENT`；PostgreSQL 用 `INTEGER GENERATED ALWAYS AS IDENTITY`（或 `SERIAL`）。
4. **`ON CONFLICT`**：`INSERT ... ON CONFLICT(word_id) DO UPDATE SET ...` 两种库都支持，可保留，但注意占位符已改为 `$n`。
5. **`addColumnIfMissing`**：当前用 `PRAGMA table_info()` 查列名补列；PostgreSQL 分支改用 `information_schema.columns` 或 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`。
6. **布尔/整型**：SQLite 用 `0/1` 存布尔，PostgreSQL 建议 `BOOLEAN`；保持表内语义一致即可，不要改上层对字段的读取逻辑。

## 五、完整表结构（共 6 张表 + 3 个索引，迁移时照抄）

见 `app/server/data/db.js` 的 `migrate()` 函数：`words`、`expressions`、`sessions`、
`emergency_events`、`prompt_versions`、`word_audit`，索引 `idx_expr_patient`、`idx_expr_session`、
`idx_words_scenario`、`idx_emergency_patient`。字段名、类型语义、NOT NULL 约束必须一一对应。

## 六、依赖策略

本项目坚持「零依赖」，但接 RDS 必须引入驱动。约定：
- PostgreSQL 驱动用 **`pg`**（`npm install pg`），仅在 `RDS_HOST` 存在时才 `import`（动态 `import()`），
  保证「无 RDS 时仍零依赖、不报错」。
- `package.json` 增加 `dependencies: { "pg": "^8.x" }`；`Dockerfile` 增加 `npm install --omit=dev` 一步。

## 七、验收标准（全部满足才算完成）

1. `cd app && npm run test:all` 全绿（269 条守卫，本地无 RDS 走 SQLite 分支，必须仍绿）。
2. 本地 `RDS_HOST` 未设置时，行为与改造前完全一致。
3. 设置真实 RDS 连接后，`npm run seed` 能灌入基础词表，`/api/caregiver/words` 能读回。
4. repository 层（`routes.js` 及 `domain/*`）**零改动**。

## 八、给 CodeArts 智能体的自然语言需求

> 请为「拾言 ReVoice」项目实现一个 PostgreSQL 优先、SQLite 兜底的双轨数据访问适配层。
> 保持 `openDatabase()` 返回对象的 `exec` / `prepare().all|get|run` / `close` 接口不变，
> 内部处理 SQLite 与 PostgreSQL 的占位符（? vs $n）、PRAGMA、自增主键、补列等方言差异。
> `RDS_HOST` 环境变量存在时用 `pg` 驱动连接 PostgreSQL，否则回退到 `node:sqlite`。
> 上层 repository 与 domain 代码不得改动。完成后运行 `npm run test:all` 必须全绿。
