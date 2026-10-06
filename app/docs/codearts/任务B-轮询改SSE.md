# 任务 B：家属端 5 秒轮询 → SSE 实时推送

> 本文件是给「华为云码道 CodeArts 代码智能体」的需求投喂材料。
> 目标：家属端「实时表达」从 5 秒轮询升级为服务端主动推送（SSE），保留轮询兜底。

## 一、背景

家属端（`app/public/js/caregiver.js`）当前通过 `setInterval(poll, 5000)` 每 5 秒轮询一次
`/api/caregiver/expressions` 和 `/api/caregiver/emergencies` 来刷新「实时表达」列表。

问题：患者确认一句表达后，家属端最坏要等 5 秒才显示，观感「卡了一下」，与产品承诺的
「实时同步」（R5）不符。答辩演示时尤其明显。

目标：新增服务端主动推送通道（SSE，`text/event-stream`），患者确认/触发紧急时立即推给家属端；
SSE 不可用时自动回退到原轮询，不破坏现有功能。

## 二、现状：相关代码位置

- 轮询逻辑：`app/public/js/caregiver.js`（`setInterval`，约 404 行附近，函数名 `poll`）
- 数据产生点（需要广播的时机）：
  - `app/server/api/routes.js` 的 `confirmExpression()`（患者确认表达，约 452 行）
  - `app/server/api/routes.js` 的 `/api/patient/emergency` 路由（紧急一键，约 327 行）
  - `app/server/api/routes.js` 的 `/api/patient/understand` 路由（紧急状态分支，约 201 行）
- 服务端为 `node:http` 手写路由，`createApp()` 在 `routes.js` 顶部，零外部依赖。

## 三、目标实现（保持零依赖，用 Node 内置能力）

1. **新增订阅器**：一个进程内的事件总线（`Map<clientId, res>` 或回调集合），
   `createApp()` 里创建并注入到需要广播的 handler。
2. **新增端点**：`GET /api/caregiver/stream`
   - 响应头：`Content-Type: text/event-stream`、`Cache-Control: no-cache`、`Connection: keep-alive`、`X-Accel-Buffering: no`
   - 心跳：每 15~30 秒发一条 `: ping\n\n`（纯注释行，保持连接）
   - 客户端断开（`req.on('close')`）时从订阅器移除，避免内存泄漏
3. **事件格式**：`event: expression\n` / `event: emergency\n`，`data: <JSON>`（与现有
   `/api/caregiver/expressions`、`/api/caregiver/emergencies` 返回的单条结构一致）。
4. **广播时机**：在 `confirmExpression` 落库成功后、紧急事件 `emergencies.log()` 后调用 `bus.broadcast(...)`。

## 四、前端改造（caregiver.js）

- 优先用 `EventSource` 连接 `/api/caregiver/stream` 监听 `expression` / `emergency` 事件。
- 收到事件后，复用现有渲染函数增量更新「实时表达」列表与紧急横幅（不要重写渲染逻辑，只新增数据来源）。
- **保留轮询兜底**：`EventSource` 出错（`onerror`）或浏览器不支持时，回退到原 `setInterval(poll, 5000)`。
- 注意：`verify-frontend.js` 守卫测试里 `poll`、`renderError`、`document.hidden` 等既有结构必须保留，
  不得删除或改名（这是契约测试的硬约束）。

## 五、验收标准

1. `cd app && npm run test:all` 全绿（含 `verify-frontend.js` 156 条前端守卫）。
2. 本地起服务后，患者端确认一句，家属端 1 秒内（实为立即）显示，无需等 5 秒。
3. 断开/禁用 SSE 后，家属端仍能通过轮询看到新表达（兜底不失效）。
4. 多次刷新家属端不会产生内存泄漏（断开连接被正确清理）。

## 六、给 CodeArts 智能体的自然语言需求

> 请为「拾言 ReVoice」家属端实现 SSE 实时推送，替换现有的 5 秒轮询，但保留轮询兜底。
> 服务端用 Node 内置 http 新增 `GET /api/caregiver/stream` 端点（text/event-stream，含心跳与断连清理），
> 在患者确认表达、触发紧急时广播 `expression` / `emergency` 事件；
> 前端 caregiver.js 用 EventSource 接收并增量更新，出错时回退原轮询。
> 不得删除或重命名前端契约测试依赖的 `poll` / `renderError` / `document.hidden` 结构。
> 完成后 `npm run test:all` 必须全绿。
