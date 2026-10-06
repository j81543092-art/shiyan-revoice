# 任务 C：进程内 LRU 缓存 → 华为云 DCS(Redis)

> 本文件是给「华为云码道 CodeArts 代码智能体」的需求投喂材料。
> 目标：把候选排序缓存从「进程内 LRU」升级为「Redis 优先、LRU 兜底」，键语义不变。

## 一、背景

拾言 ReVoice 用「线索组合 → 候选排序」缓存实现「排序位置锁定」（R2）——同一组线索
第二次出现时沿用上次顺序，避免患者刚记住位置就变。缓存命中率是答辩指标之一。

当前实现在 `app/server/data/db.js` 的 `ClueCandidateCache` 类：进程内 `Map`，容量 500，
自带命中率统计（`hits/misses/sets` + `hitRate()`）。

赛题要求关联华为云 Redis（DCS），因此需要把缓存切换到 Redis，同时**保留无 Redis 时回退进程内 LRU**。

## 二、现状接口（必须保持不变）

```js
// 键结构（静态方法）
ClueCandidateCache.key(patientId, scenario, clues)
//   = `${patientId|'anon'}|${scenario|'-'}|${icons+}|${keywords+}|${voiceFragments+}`
//   其中每组线索数组先 map(String) 再 sort 再 join('+')

// 实例方法
cache.get(key)      // 命中返回 value，未命中返回 null，并累计 stats
cache.set(key, value) // 写入，超出 maxSize 淘汰最旧
cache.hitRate()     // 命中率 0~1，四舍五入 4 位
cache.stats         // { hits, misses, sets }
cache.clear()
```

调用点在 `routes.js` 的 `/api/patient/understand`：`cache.get(cacheKey)`、`cache.set(cacheKey, { order: [...] })`，
以及 `/api/caregiver/metrics` 的 `cache.hitRate()` / `cache.stats`。这些调用方式不能变。

## 三、目标实现

产出 `cache-redis.js`（或在 `db.js` 内按环境变量分发），保证暴露同一份接口：

- `REDIS_HOST` 存在 → 用 Redis（华为云 DCS 兼容 Redis 协议）
- 否则 → 回退到现有进程内 `ClueCandidateCache`

`.env.example` 已预留变量（直接使用，勿改字段名）：

```
REDIS_HOST=
REDIS_PORT=6379
REDIS_PASSWORD=
```

## 四、实现要点

0. **同步/异步的硬决策（先定方案，别让智能体自己发挥）**：`routes.js` 里
   `cache.get()` / `cache.set()` 是**同步调用**（`/api/patient/understand` 与 `/api/caregiver/metrics` 两处），
   而 `ioredis` 的 get/set 是异步的。必须选【方案 A·推荐】保持 get/set 同步：
   本地 LRU 仍是**唯一同步读路径**，Redis 定位为「异步持久化 + 跨实例共享」——
   `set` 时同步写 LRU 并 fire-and-forget 异步写 Redis，服务启动时 `warmUp()` 从 Redis 异步灌回 LRU。
   这样上层 routes.js 零改动、零 await，Redis 挂了也不影响主流程。
   不选【方案 B】把 get/set 改成 async（要动 routes.js 加 await，收益低、破坏「上层零改动」约束）。

1. **驱动**：用 **`ioredis`**（`npm install ioredis`），仅在 `REDIS_HOST` 存在时动态 `import()`，
   保证无 Redis 时仍零依赖、不报错。`package.json` 增加 `dependencies: { "ioredis": "^5.x" }`。
2. **键前缀**：所有键加统一前缀（如 `revoice:cache:`）避免与其他数据冲突。
3. **TTL**：给缓存设一个合理过期时间（建议 24 小时），避免 Redis 无限膨胀。
4. **命中率统计**：Redis 分支也要正确累计 `hits/misses/sets` 并支持 `hitRate()`——可用本地计数器，
   因为命中/未命中是本次进程运行期的统计口径，与 `stats` 语义一致。
5. **值序列化**：value 是对象，存 Redis 用 JSON 序列化，取回时反序列化。
6. **降级**：Redis 连接失败或读写抛错时，**静默回退到进程内 LRU**，不影响主流程（对齐项目「演示不中断」原则）。

## 五、验收标准

1. `cd app && npm run test:all` 全绿（无 Redis 时回退 LRU，必须仍绿）。
2. 设置真实 Redis 连接后，`/api/caregiver/metrics` 的 cache.hitRate() 能反映 Redis 读写。
3. 停止 Redis 后服务不崩溃，自动回退 LRU 继续工作。
4. repository/domain 上层代码零改动。

## 六、给 CodeArts 智能体的自然语言需求

> 请为「拾言 ReVoice」实现 Redis 优先、进程内 LRU 兜底的候选缓存适配层。
> **硬约束：`get / set / hitRate / stats / clear` 及静态 `key()` 接口不变，且 get/set 必须保持同步调用**
> （本地 LRU 是唯一同步读路径；不要把它们改成 async 或返回 Promise，否则会破坏 routes.js 的同步调用）。
> `REDIS_HOST` 存在时：set 同步写 LRU 的同时异步 fire-and-forget 写 Redis
> （ioredis 动态 import，键前缀 revoice:cache:、24 小时 TTL、JSON 序列化），
> 服务启动时从 Redis 异步 warmUp 灌回 LRU；Redis 连接失败/读写抛错一律静默忽略，回退纯 LRU。
> 上层 routes.js 不得改动。完成后 `npm run test:all` 必须全绿（无 Redis 时回退 LRU 也要绿）。
