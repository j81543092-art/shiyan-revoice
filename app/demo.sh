#!/usr/bin/env bash
# 拾言 ReVoice · 答辩演示脚本
#
# 用途：第 6 周轮讲演练 + 评委现场演示。
#        每一步都对应一个可当场验证的机制点，不靠录屏。
#
# 运行：bash demo.sh   （需先启动服务）
#       node server/index.js        → 另开一个终端执行本脚本
#
# 说明：请求体一律写入 UTF-8 临时文件后用 --data-binary @file 发出。
#       直接行内传中文 JSON 会被 Windows shell 转码成乱码（非应用问题）。

set -u

BASE="${BASE:-http://localhost:3000}"
SID="demo-$(date +%s)"
TMPDIR_DEMO="$(dirname "$0")/.tmp"
mkdir -p "$TMPDIR_DEMO"
REQ="$TMPDIR_DEMO/demo-req.json"

hr() { printf '%s\n' "────────────────────────────────────────────────────────────"; }
step() { echo; hr; echo "  $1"; hr; }

# jq 不可用时退回原样输出
pretty() {
  if command -v python >/dev/null 2>&1; then
    python -c "import sys,json;print(json.dumps(json.load(sys.stdin),ensure_ascii=False,indent=2))" 2>/dev/null || cat
  else
    cat
  fi
}

# 把 JSON 写入 UTF-8 临时文件再 POST，规避 shell 中文转码
post() {
  printf '%s' "$2" > "$REQ"
  curl -s -X POST "$BASE$1" -H 'Content-Type: application/json' --data-binary "@$REQ"
  echo
}

get() { curl -s "$BASE$1"; echo; }

# 启动前自清洁：清掉上一次演示残留的表达 / 紧急 / 会话记录，
# 避免旧数据出现在家属端界面与指标看板里。
# 传 --keep 可跳过（例如想在答辩中展示「历史使用累积」）。
if [ "${1:-}" != "--keep" ]; then
  ( cd "$(dirname "$0")" && node scripts/seed.js --reset >/dev/null 2>&1 ) \
    && echo "（演示数据已重置；传 --keep 可保留历史记录）"
fi

# ── 0 ────────────────────────────────────────────────────────
step "0 · 健康检查 —— 当前接的是哪个 provider，规格版本是几"
get /api/health | pretty

# ── 1 ────────────────────────────────────────────────────────
step "1 · 常规线索 → 出候选（对应评测集 E08）"
echo "  点击：[麻] [腿]   关键词：左"
echo "  → 患者端只看到排序位置，不显示数字（R3）"
post /api/patient/understand \
  "{\"sessionId\":\"$SID\",\"patientId\":\"demo-patient\",\"clues\":{\"icons\":[\"麻\",\"腿\"],\"keywords\":[\"左\"]}}" | pretty

# ── 2 ────────────────────────────────────────────────────────
step "2 · 患者确认（R5）—— 控制权始终在患者手里"
echo "  患者点了第 1 个候选「我左腿麻」"
post /api/patient/confirm \
  "{\"sessionId\":\"$SID\",\"patientId\":\"demo-patient\",\"text\":\"我左腿麻\",\"confidence\":0.71}" | pretty
echo "  → AI 全程没有替患者说过一句话，只是把话摆到他面前"

# ── 3 ────────────────────────────────────────────────────────
step "3 · 单线索 → 触发澄清（R4①，不硬猜）"
echo "  只点：[水]"
post /api/patient/understand \
  "{\"sessionId\":\"clar-1\",\"patientId\":\"demo-patient\",\"clues\":{\"icons\":[\"水\"]}}" | pretty
echo "  → 证据不足时先确认，宁可多问一句，也不替他做决定"

# ── 4 ────────────────────────────────────────────────────────
step "4 · 紧急通道：连点 [疼] ×3 + [胸口]（R6②，零模型调用）"
post /api/patient/understand \
  "{\"sessionId\":\"emg-1\",\"patientId\":\"demo-patient\",\"clues\":{\"icons\":[\"疼\",\"胸口\"],\"repeatCounts\":{\"疼\":3}}}" | pretty
echo "  → 注意 modelCalled:false —— 命悬一线的事不允许 AI 猜一下"

# ── 5 ────────────────────────────────────────────────────────
step "5 · 紧急通道：一级紧急词 [跌倒了]（R6①）"
post /api/patient/understand \
  "{\"sessionId\":\"emg-2\",\"patientId\":\"demo-patient\",\"clues\":{\"icons\":[\"跌倒了\"],\"voiceFragments\":[\"啊\"]}}" | pretty

# ── 6 ────────────────────────────────────────────────────────
step "6 · 紧急一键大按钮（首屏常驻，不经任何层级）"
post /api/patient/emergency \
  "{\"sessionId\":\"$SID\",\"patientId\":\"demo-patient\"}" | pretty

# ── 7 ────────────────────────────────────────────────────────
step "7 · 家属端：看到表达记录与置信度数值（R3 反向）"
get "/api/caregiver/expressions?patientId=demo-patient&limit=3" | pretty

# ── 8 ────────────────────────────────────────────────────────
step "8 · 家属端：紧急事件留痕（R6）"
get "/api/caregiver/emergencies?patientId=demo-patient" | pretty

# ── 9 ────────────────────────────────────────────────────────
step "9 · 词库边界：删一级紧急词应被拒绝（R7）"
echo "  尝试删除 W-S10-01（救命）"
post /api/caregiver/words/delete \
  "{\"wordId\":\"W-S10-01\",\"actor\":\"演示\"}" | pretty
echo "  → 紧急词不可删，这是写死的边界，不是可配置项"

# ── 10 ───────────────────────────────────────────────────────
step "10 · 指标看板（四个数字直接进答辩材料）"
get "/api/caregiver/metrics?patientId=demo-patient" | pretty
echo "  → promptVersions 里的 v1-rule 是基线；接华为云大模型后每版追加一行，"
echo "     这就是「命中率 30% → 60%+」的版本迭代曲线"

# ── 收尾 ─────────────────────────────────────────────────────
echo
hr
echo "  演示完毕。"
echo "    患者端   $BASE/"
echo "    家属端   $BASE/caregiver.html"
hr
