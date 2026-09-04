#!/usr/bin/env node
// correctover-hook.mjs
// Kimi Code CLI PreToolUse hook：在 Agent 写文件 / 跑命令前调用 correctover-scan 安全扫描。
//
// 阻断语义（对齐 Kimi Code Hooks 官方文档）：
//   exit 0  -> 放行
//   exit 2  -> 阻断（stderr 内容作为阻断原因反馈给模型）
//   其他非零 / 超时 -> Kimi Code fail-open 放行
//
// 本脚本的策略：
//   - 扫描器成功运行且报告 fail 级问题  -> exit 2（阻断当前工具调用）
//   - 扫描器本身不可用 / 报错 / 超时     -> exit 0（fail-open，与 Kimi Code 设计哲学一致，
//                                          避免扫描器故障阻塞开发；原因写入 stderr 留痕）
//
// 扫描器退出码约定（correctover-scan v1.7.x 实测）：
//   0 = 无 fail 级发现；1 = 存在 fail 级发现（或扫描器自身错误，如配额用尽）
// 因此本脚本额外解析 JSON 输出中的 stats.fail，只有"确实扫到 fail"才升级为 exit 2。
//
// 可用环境变量：
//   CORRECTOVER_SCAN_CMD   扫描器命令，默认 "npx correctover-scan"
//                          （离线/CI 场景可指向本地镜像，如 "node /path/scan-mirror/index.js"）
//   CORRECTOVER_SCAN_INSTALLS  设为 "1" 时，npm/pnpm/yarn install 类命令执行前对整个
//                          项目目录跑一次 bundle 扫描（默认关闭：大仓库可能较慢）
//   CORRECTOVER_SCAN_TIMEOUT    单次扫描超时毫秒，默认 120000

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCAN_CMD = process.env.CORRECTOVER_SCAN_CMD || "npx correctover-scan";
const SCAN_INSTALLS = process.env.CORRECTOVER_SCAN_INSTALLS === "1";
const SCAN_TIMEOUT_MS = Number(process.env.CORRECTOVER_SCAN_TIMEOUT || 120000);

// correctover-scan bundle 模式收集 .js/.mjs/.cjs/.ts（基于文本信号扫描，非 TS 语义分析）
const SCANNABLE_CODE_EXT = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx"]);
const MCP_CONFIG_RE = /(^|[\/\\.])(mcp[_-]?.*\.(json|ya?ml)|.*\.mcp\.json)$/i;

function log(...a) {
  console.error("[correctover-hook]", ...a);
}

// ---- 读取 Kimi Code 通过 stdin 传入的事件 JSON ----
function readPayload() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8"));
  } catch (e) {
    log("无法解析 stdin 事件 JSON，放行（fail-open）：", e.message);
    process.exit(0);
  }
}

// ---- 调用扫描器；返回 { ran, fail, findingsText, error } ----
function runScan(args, label) {
  const [bin, ...binArgs] = SCAN_CMD.split(/\s+/);
  log(`扫描 ${label}: ${SCAN_CMD} ${args.join(" ")}`);
  let r;
  try {
    r = spawnSync(bin, [...binArgs, ...args], {
      encoding: "utf8",
      timeout: SCAN_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    return { ran: false, fail: false, error: `扫描器启动失败：${e.message}` };
  }
  if (r.error) {
    return { ran: false, fail: false, error: `扫描器执行异常：${r.error.message}` };
  }
  if (r.signal === "SIGTERM" || r.status === null) {
    return { ran: false, fail: false, error: `扫描超时（>${SCAN_TIMEOUT_MS / 1000}s）` };
  }

  const stdout = r.stdout || "";
  const stderr = r.stderr || "";

  // 机读判定：优先解析 JSON 输出中的 stats.fail
  let failCount = null;
  try {
    const j = JSON.parse(stdout);
    const stats = j.stats || {};
    failCount = typeof stats.fail === "number"
      ? stats.fail
      : (stats.findings && typeof stats.findings.fail === "number" ? stats.findings.fail : null);
  } catch (_) { /* 非 JSON 输出时退回退出码判定 */ }

  let fail;
  if (failCount !== null) {
    fail = failCount > 0;
  } else {
    // 无 JSON 时：退出码 1 视为发现问题（扫描器自身错误也可能是 1，
    // 但文本输出中含 FAIL/critical 字样时才判 fail，降低误阻断概率）
    fail = r.status === 1 && /(FAIL|critical)/i.test(stdout + stderr);
  }

  return { ran: true, fail, status: r.status, stdout, stderr };
}

function block(message) {
  console.error("────────────────────────────────────────────────");
  console.error("⛔ correctover-scan 安全扫描未通过，已阻断本次操作");
  console.error(message);
  console.error("────────────────────────────────────────────────");
  console.error("处理建议：移除/替换硬编码密钥与危险调用后重试；");
  console.error("如确认为误报，可人工复核后调整该文件（Hook 不替代人工确认）。");
  process.exit(2);
}

function allowWithNote(note) {
  log(note, "— 放行（fail-open）");
  process.exit(0);
}

// ---- 把 Agent 即将写入的内容落到临时文件，供扫描器检查 ----
function stageContent(content, hintExt) {
  const dir = path.join(os.tmpdir(), "correctover-hook");
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `stage-${process.pid}-${Date.now()}${hintExt || ".js"}`);
  fs.writeFileSync(f, typeof content === "string" ? content : String(content ?? ""), "utf8");
  return f;
}

function pickFilePath(toolInput) {
  return toolInput.path || toolInput.file_path || toolInput.filePath || toolInput.filename || "";
}

function main() {
  const payload = readPayload();
  const tool = payload.tool_name || "";
  const input = payload.tool_input || {};
  const cwd = payload.cwd || process.cwd();

  // ============ 场景一：写/改文件 ============
  if (/WriteFile|StrReplaceFile|^Write$|^Edit$/.test(tool)) {
    const filePath = pickFilePath(input);
    const ext = path.extname(filePath || "").toLowerCase();

    // 1) MCP 配置文件写入 -> config 层扫描（扫描落盘前的内容）
    if (MCP_CONFIG_RE.test(filePath || "")) {
      const content = input.content
        || (Array.isArray(input.edit) ? input.edit.map((e) => e.new || "").join("\n") : (input.edit?.new || ""));
      const staged = stageContent(content, path.extname(filePath) || ".json");
      // 注意：correctover-scan 中 --bundle <path> 是"选项+路径"成对结构，
      // -f 等选项必须放在路径之前，否则路径会被误解析
      const r = runScan(["-f", "json", "--", staged], `MCP 配置 ${filePath}`);
      fs.rmSync(staged, { force: true });
      if (!r.ran) return allowWithNote(r.error);
      if (r.fail) {
        const tail = (r.stderr + r.stdout).split("\n").filter(Boolean).slice(-12).join("\n");
        return block(`目标：MCP 配置文件 ${filePath}\n${tail}`);
      }
      return process.exit(0);
    }

    // 2) JS/TS 代码写入 -> bundle（代码）层扫描，单文件
    if (SCANNABLE_CODE_EXT.has(ext)) {
      const content = input.content
        || (Array.isArray(input.edit) ? input.edit.map((e) => `${e.old || ""}\n${e.new || ""}`).join("\n")
          : (input.edit ? `${input.edit.old || ""}\n${input.edit.new || ""}` : ""));
      // StrReplaceFile 的 edit 只含差异片段；若磁盘上已有完整文件，直接扫目标文件更准确
      const targetOnDisk = filePath && path.isAbsolute(filePath) && fs.existsSync(filePath)
        ? filePath
        : (filePath && fs.existsSync(path.resolve(cwd, filePath)) ? path.resolve(cwd, filePath) : stageContent(content, ext));
      // 注意：correctover-scan 的 --bundle 会"吃掉"下一个参数当路径，
      // -f json 必须放在路径之后（官方示例：correctover-scan --bundle ./pkg -f sarif）
      const r = runScan(["--bundle", targetOnDisk, "-f", "json"], `代码文件 ${filePath || targetOnDisk}`);
      if (targetOnDisk.startsWith(os.tmpdir())) fs.rmSync(targetOnDisk, { force: true });
      if (!r.ran) return allowWithNote(r.error);
      if (r.fail) {
        const tail = (r.stderr + r.stdout).split("\n").filter(Boolean).slice(-14).join("\n");
        return block(`目标：代码文件 ${filePath}\n扫描器发现 fail 级问题（如硬编码 sk- 密钥、危险执行原语等）。\n${tail}`);
      }
      return process.exit(0);
    }

    // 其他类型文件（.py/.md/.json 普通配置等）：correctover-scan 暂无对应代码层规则，放行
    return process.exit(0);
  }

  // ============ 场景二：执行 Shell 命令 ============
  if (/Shell|^Bash$|^CMD$/.test(tool)) {
    const cmd = String(input.command || input.cmd || "");

    // 2a) 涉及 MCP 配置变更/安装的命令 -> 对项目目录跑 config 层扫描
    if (/mcp|claude\.json|\.cursor|claude-code|add-mcp|mcpServers/i.test(cmd)) {
      const r = runScan(["-d", cwd, "-r", "-f", "json"], `命令关联 MCP 配置目录（${cwd}）`);
      if (!r.ran) return allowWithNote(r.error);
      if (r.fail) {
        const tail = (r.stderr + r.stdout).split("\n").filter(Boolean).slice(-14).join("\n");
        return block(`命令 "${cmd.slice(0, 120)}" 关联 MCP 配置，目录扫描发现 fail 级问题：\n${tail}`);
      }
      return process.exit(0);
    }

    // 2b) 安装依赖命令 -> 可选的全项目 bundle 扫描（默认关闭）
    if (SCAN_INSTALLS && /\b(npm|pnpm|yarn|bun)\s+(i|install|add)\b/.test(cmd)) {
      const r = runScan(["--bundle", cwd, "-f", "json"], `安装前项目代码（${cwd}）`);
      if (!r.ran) return allowWithNote(r.error);
      if (r.fail) {
        const tail = (r.stderr + r.stdout).split("\n").filter(Boolean).slice(-14).join("\n");
        return block(`依赖安装前项目扫描发现 fail 级问题：\n${tail}`);
      }
      return process.exit(0);
    }

    return process.exit(0);
  }

  // 其他工具不拦截
  process.exit(0);
}

main();
