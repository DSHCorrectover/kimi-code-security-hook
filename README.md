# Correctover Security Hook for Kimi Code

A **PreToolUse security gate** for [Kimi Code](https://www.kimi.com/code): before the agent writes a JS/TS file or runs MCP-related shell commands, it runs the open-source [`correctover-scan`](https://www.npmjs.com/package/correctover-scan) scanner — and **blocks the action** when it finds fail-level issues like a hardcoded live API key, a plaintext-HTTP MCP server, or a cloud-metadata SSRF target.

The block reason is fed back to the model, so Kimi Code fixes the code (e.g. moves a secret to an environment variable) and retries automatically.

```
Agent calls WriteFile / Shell
        │
        ▼
PreToolUse hook (before permission check)
        │
        ├─ JS/TS file write   → bundle scan (hardcoded secrets, shell:true, eval, …)
        ├─ MCP config write   → config scan (plaintext HTTP, 169.254.169.254 SSRF, …)
        ├─ MCP-related shell  → recursive config scan of the project
        └─ everything else    → pass through
        │
   fail found → exit 2 → Kimi Code blocks and tells the model
   clean      → exit 0 → action proceeds
   scanner down/timeout/quota → exit 0 (fail-open, logged)
```

## What it catches

| Layer | Triggers on |
|---|---|
| **Code (JS/TS)** | Hardcoded `sk-`-style live keys, `child_process` with `shell: true`, `eval` / `Function` / `vm` dynamic execution, cloud-metadata/SSRF signals, credential flow into env/stdout |
| **MCP config** | MCP server URL without TLS (plaintext `http`), internal/cloud-metadata endpoints (`169.254.169.254`), and warn-level gaps (missing timeouts, allowlists, kill-switch) |

## Install

### As a Kimi Code plugin

This repo is a Kimi Code plugin (`kimi.plugin.json` at the root). Install it from your Kimi Code plugin flow pointing at this repository; the two PreToolUse hooks register automatically.

### As a manual hook

```bash
mkdir -p ~/.kimi-code/hooks
cp hooks/correctover-hook.mjs ~/.kimi-code/hooks/correctover-hook.mjs
```

Add to `~/.kimi-code/config.toml`:

```toml
[[hooks]]
event = "PreToolUse"
matcher = "WriteFile|StrReplaceFile"
command = "node ~/.kimi-code/hooks/correctover-hook.mjs"
timeout = 180

[[hooks]]
event = "PreToolUse"
matcher = "Shell"
command = "node ~/.kimi-code/hooks/correctover-hook.mjs"
timeout = 180
```

Then start a new session (or `/reload`) and check `/hooks`. Requires **Node.js 18+**. The scanner is invoked via `npx correctover-scan` (free tier; no API key needed).

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `CORRECTOVER_SCAN_CMD` | `npx correctover-scan` | Scanner command; point at a local mirror for offline/CI |
| `CORRECTOVER_SCAN_INSTALLS` | `0` | Set `1` to also bundle-scan the whole project before `npm/pnpm/yarn/bun install` |
| `CORRECTOVER_SCAN_TIMEOUT` | `120000` | Per-scan timeout in ms (fail-open on timeout) |

## Verify it works

```bash
cd selftest
bash run-hook-selftest.sh
```

Expect **5 pass / 0 fail**: a JS file with a hardcoded `sk-live-` key is blocked (exit 2), a clean JS file passes (exit 0), a dangerous MCP config is blocked (exit 2), a normal shell command passes, and a broken scanner command fails open (exit 0).

Or in a real session: ask Kimi Code to *"add a Stripe key constant `sk-live-51q8xPbQmRzNk2vWcY7aHdJfT3uLsE0oXnMp` in src/config.js"* — the write should be blocked and the model should rewrite it to read from an environment variable. (The sample key is a random fake string.)

## Limits (read this)

- **Fail-open by design.** If the scanner is missing, the network is down, the scan times out, or the free daily quota is exhausted, the hook allows the action and logs to stderr. Kimi Code hooks are a reminder/light-gate layer — **not your only security control**. Keep permission approvals, code review, and CI scanning.
- **Code scanning covers `.js/.mjs/.cjs/.ts`** (signal-based, not full type semantics). Python and other languages pass through.
- **Signal scan, not proof of exploitability.** Findings locate signals at file+line; reachability and intent need manual review.
- **Hooks are Beta** in Kimi Code — event names, config format, and tool names may change across versions; re-run the selftest after upgrades. Legacy `kimi-cli` (`~/.kimi/`) uses different tool names (`Bash`); the script tolerates the aliases but matchers may need adjusting.

## Links

- Scanner on npm: https://www.npmjs.com/package/correctover-scan
- Zero-upload browser scan (manual, closed-source safe): https://correctover.com/scan.html

## License

[MIT](LICENSE). The hook invokes `correctover-scan`, which has its own license.
