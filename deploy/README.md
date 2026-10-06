# 拾言 ReVoice · 华为云 CCE 部署清单
#
# 用法：把下面每个文件里的 <...> 占位符替换成你的真实值，然后逐个 kubectl apply，
# 或在 CCE 控制台「工作负载/服务/配置项与密钥」里「通过 YAML 创建」粘贴进去。
#
# 连接信息（已按你开的实例填好）：
#   RDS  192.168.0.209:5432  账号 root  库 revoice
#   Redis 192.168.0.201:6379
# 密码统一由 secret.yaml 承载，不落明文到 Deployment。
