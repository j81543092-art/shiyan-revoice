# 拾言 ReVoice · 华为云 CCE 部署指南（阶段 3）

> 目标：把 `app/` 容器化后跑在华为云 CCE 上，通过公网链接访问，RDS + Redis 走 VPC 内网。
> 已就绪：RDS `192.168.0.209:5432`（库 `revoice`）、Redis `192.168.0.201:6379`（密码不落文档，见 secret.yaml）。
> 本目录文件：`secret.yaml` / `deployment.yaml` / `service.yaml` / `README.md`。

---

## 步骤 0：确认三件前置（关键，漏了必翻车）

### ① VPC 必须统一
CCE 集群要建在 **`default_vpc`**（你 RDS/Redis 用的那个），否则内网 192.168.0.209/201 不通。
→ 创建集群时「虚拟私有云」选 `default_vpc`。

### ② RDS 安全组放行「内网」
RDS 详情页 → 连接管理 → 安全组 → **入方向**加一条：
| 协议 | 端口 | 源地址 |
|---|---|---|
| TCP | 5432 | `192.168.0.0/16`（或 default_vpc 的网段） |

> 你之前可能只加了公网 IP 的规则，内网同 VPC 访问也需要放行。保险起见加整段 VPC 网段。

### ③ Redis 白名单放行「内网」
DCS 详情页 → 白名单配置 → 追加：
- `192.168.0.0/16`（default_vpc 网段）

> DCS 用「白名单」而非安全组。CCE 容器节点在 default_vpc 内，白名单必须包含内网网段，否则容器连不上 Redis。

---

## 步骤 1：构建镜像并推到 SWR（二选一）

### 路线 A：华为云 SWR 在线构建（推荐，无需本地 Docker）
1. 控制台搜「容器镜像服务 SWR」→ 左侧「组织管理」→ 新建组织（如 `revoice`）
2. 左侧「构建管理」→「创建构建任务」→ 代码源选 **GitHub**，授权后选仓库 `j81543092-art/shiyan-revoice`，分支 `main`
3. 构建目录填 `app`，Dockerfile 路径 `Dockerfile`（保持默认）
4. 保存并「执行构建」→ 构建完成得到镜像地址，形如：
   `swr.cn-north-4.myhuaweicloud.com/revoice/shiyan-revoice:latest`

### 路线 B：本地构建 + 推送（需要本地装 Docker）
```bash
cd app
docker build -t swr.cn-north-4.myhuaweicloud.com/<组织>/revoice:latest .
# 登录 SWR（SWR 控制台「总览」页有 docker login 命令，粘贴执行）
docker login -u <区域>@<AK> swr.cn-north-4.myhuaweicloud.com
docker push swr.cn-north-4.myhuaweicloud.com/<组织>/revoice:latest
```

> 拿到的镜像地址，替换 `deployment.yaml` 里的 `image:` 字段。

---

## 步骤 2：创建 CCE 集群

1. 控制台搜「云容器引擎 CCE」→ 购买集群
2. 关键参数：
   | 参数 | 选 |
   |---|---|
   | 计费 | 按需（比赛用） |
   | 集群版本 | 最新稳定版即可 |
   | 虚拟私有云 | **default_vpc**（同 RDS/Redis） |
   | 节点 | 1 个节点、最小规格（2核4G 够） |
   | 集群形态 | 标准集群（或「托管」省事） |
3. 创建约 5~10 分钟，状态「运行中」后进入下一步。

---

## 步骤 3：部署三份清单

在 CCE 控制台左侧依次操作（顺序不能乱，Secret 要先建）：

1. **配置项与密钥** →「密钥」→「YAML 创建」→ 粘贴 `secret.yaml` 内容 → 确定
2. **工作负载** →「无状态负载」→「YAML 创建」→ 粘贴 `deployment.yaml`（**先把 image 改成你的真实镜像地址**）→ 确定
3. **服务** →「服务」→「YAML 创建」→ 粘贴 `service.yaml` → 确定

等 Deployment 的 Pod 状态变成「运行中」（就绪 1/1）。

---

## 步骤 4：灌基础词表（seed）

Pod 运行起来后，RDS 里只有空表结构，需要灌一次基础词表：

- **控制台方式**：工作负载 → 点进 `revoice` →「容器组」标签 → 找到 Pod → 右侧「更多」→「**登录**」（进终端）→ 执行：
  ```
  node scripts/seed.js
  ```
  看到「种子词表写入 N 条」即成功。

---

## 步骤 5：公网验证

1. 服务列表里 `revoice-service` 会显示一个「访问地址」（ELB 公网 IP，形如 `124.xxx.xxx.xxx:80`）
2. 浏览器打开 `http://<访问地址>/` → 应看到患者端首页
3. 家属端：`http://<访问地址>/caregiver.html`
4. 验证 RDS/Redis 真的生效：
   - 打开家属端「词表管理」→ 能看到 seed 灌进去的词 → 证明 RDS 读回成功
   - 患者端点选线索 → 确认一句 → 家属端「表达记录」出现这条 → 证明 RDS 写入成功
   - 家属端「指标看板」里 cache 命中率在变动 → 证明 Redis 生效

---

## 常见坑速查

| 症状 | 原因 | 解决 |
|---|---|---|
| Pod 一直「创建中/重启」 | 镜像地址错、或 SWR 没登录 | 核对 image、检查 `imagePullPolicy` 与密钥 |
| Pod「运行中」但就绪失败 | RDS 连不上（安全组没放行内网） | 回步骤 0-② |
| 页面 500 / 打不开 | Service 没绑上 ELB | 等几分钟，看服务「访问地址」是否生成 |
| 词表空 | 没跑 seed | 回步骤 4 |
| 命中率恒为 0 | Redis 白名单没加内网段 | 回步骤 0-③ |
