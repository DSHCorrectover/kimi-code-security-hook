#!/usr/bin/env bash
# run-hook-selftest.sh
# 端到端自测：模拟 Kimi Code CLI 的 PreToolUse stdin JSON 载荷，
# 验证 correctover-hook.mjs 的退出码（0=放行，2=阻断）。
#
# 用法：
#   CORRECTOVER_SCAN_CMD="node /path/to/scan-mirror/index.js" bash run-hook-selftest.sh
# 默认使用 npx correctover-scan；离线环境用环境变量指向本地镜像。
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
HOOK="$HERE/../hooks/correctover-hook.mjs"
SCAN_CMD="${CORRECTOVER_SCAN_CMD:-npx correctover-scan}"
export CORRECTOVER_SCAN_CMD="$SCAN_CMD"

PASS=0; FAIL=0
check() { # <期望退出码> <实际退出码> <场景名>
  if [ "$2" = "$1" ]; then echo "  ✅ 场景：$3（exit=$2）"; PASS=$((PASS+1));
  else echo "  ❌ 场景：$3（期望 exit=$1，实际 exit=$2）"; FAIL=$((FAIL+1)); fi
}

echo "═══ correctover-scan × Kimi Code Hook 自测 ═══"
echo "扫描器命令：$SCAN_CMD"
echo

# ---------- 场景 A：WriteFile 写入含硬编码 sk-live 密钥的 .js -> 应阻断 (exit 2) ----------
echo "[A] WriteFile 写入含 sk-live 密钥的 JS 文件"
PAYLOAD=$(node -e '
const fs=require("fs");
const content=fs.readFileSync("'$HERE'/pkgs/leaky.js","utf8");
process.stdout.write(JSON.stringify({
  hook_event_name:"PreToolUse", session_id:"selftest", cwd:"'$HERE'",
  tool_name:"WriteFile", tool_input:{ path:"/proj/src/leaky.js", content }
}));')
echo "$PAYLOAD" | node "$HOOK" >/tmp/hook-a.out 2>/tmp/hook-a.err
RC=$?
check 2 "$RC" "写入含硬编码密钥的 JS 文件应阻断"
echo "    └─ hook stderr 摘要："; sed 's/^/       /' /tmp/hook-a.err | tail -6
echo

# ---------- 场景 B：WriteFile 写入干净 .js -> 应放行 (exit 0) ----------
echo "[B] WriteFile 写入干净 JS 文件"
PAYLOAD=$(node -e '
const fs=require("fs");
const content=fs.readFileSync("'$HERE'/pkgs/clean.js","utf8");
process.stdout.write(JSON.stringify({
  hook_event_name:"PreToolUse", session_id:"selftest", cwd:"'$HERE'",
  tool_name:"WriteFile", tool_input:{ path:"/proj/src/clean.js", content }
}));')
echo "$PAYLOAD" | node "$HOOK" >/tmp/hook-b.out 2>/tmp/hook-b.err
RC=$?
check 0 "$RC" "写入干净 JS 文件应放行"
echo

# ---------- 场景 C：WriteFile 写入不安全 MCP 配置（http + 云元数据地址）-> 应阻断 (exit 2) ----------
echo "[C] WriteFile 写入不安全 MCP 配置（明文 http + 169.254.169.254）"
PAYLOAD=$(node -e '
const fs=require("fs");
const content=fs.readFileSync("'$HERE'/mcpdir/bad-mcp.json","utf8");
process.stdout.write(JSON.stringify({
  hook_event_name:"PreToolUse", session_id:"selftest", cwd:"'$HERE'",
  tool_name:"WriteFile", tool_input:{ path:"/proj/.mcp.json", content }
}));')
echo "$PAYLOAD" | node "$HOOK" >/tmp/hook-c.out 2>/tmp/hook-c.err
RC=$?
check 2 "$RC" "写入不安全 MCP 配置应阻断"
echo "    └─ hook stderr 摘要："; sed 's/^/       /' /tmp/hook-c.err | tail -6
echo

# ---------- 场景 D：Shell 执行普通 ls 命令 -> 应放行 (exit 0) ----------
echo "[D] Shell 执行普通命令（ls -la）"
echo '{"hook_event_name":"PreToolUse","session_id":"selftest","cwd":"'$HERE'","tool_name":"Shell","tool_input":{"command":"ls -la"}}' \
  | node "$HOOK" >/tmp/hook-d.out 2>/tmp/hook-d.err
RC=$?
check 0 "$RC" "普通 shell 命令应放行"
echo

# ---------- 场景 E：扫描器不可用时 fail-open（exit 0） ----------
echo "[E] 扫描器命令不存在（模拟故障）-> fail-open 放行"
CORRECTOVER_SCAN_CMD="npx this-package-does-not-exist-xyz" \
  echo '{"hook_event_name":"PreToolUse","session_id":"selftest","cwd":"'$HERE'","tool_name":"WriteFile","tool_input":{"path":"/proj/x.js","content":"const a=1;"}}' \
  | CORRECTOVER_SCAN_CMD="npx this-package-does-not-exist-xyz" node "$HOOK" >/tmp/hook-e.out 2>/tmp/hook-e.err
RC=$?
check 0 "$RC" "扫描器故障时应 fail-open 放行"
echo

echo "═══ 结果：$PASS 通过 / $FAIL 失败 ═══"
[ "$FAIL" -eq 0 ]
