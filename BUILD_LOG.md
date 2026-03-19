# AgentWall — Build Log

## What Was Built

AgentWall is a runtime safety layer for local AI agents. It intercepts shell
commands proposed by AI agents before they execute, evaluates them against a
YAML policy, and either allows them automatically, blocks them, or asks the
developer for approval. Every decision is logged to a JSONL file for audit
and replay.

### Architecture

```
agentwall/
├── src/
│   ├── cli.ts                            # Entry point + command routing
│   ├── core/
│   │   ├── types.ts                      # Shared types (ActionProposal, Decision, LogEntry)
│   │   ├── policy.ts                     # YAML policy engine with glob matching
│   │   ├── logger.ts                     # JSONL event logger + formatted replay
│   │   └── prompt.ts                     # Terminal approval prompt with queue + session memory
│   └── adapters/
│       └── openclaw/
│           └── client.ts                 # OpenClaw WebSocket adapter with Ed25519 signing
├── package.json
├── tsconfig.json
├── .gitignore
└── README.md
```

### Modules Implemented

**`src/core/types.ts`** — Shared type definitions that cross the adapter/core
boundary. `ActionProposal`, `Decision` (allow/deny/ask), `LogEntry`, `Runtime`.

**`src/core/policy.ts`** — Loads `~/.agentwall/policy.yaml`, validates structure
and keys, evaluates rules in deny → allow → ask order. Supports glob pattern
matching (`*` matches any character except `/`, `**` matches anything), command
prefix matching, `~` home directory expansion, `workspace/**` expansion, and
`outside:workspace` special path value. Falls back to built-in defaults if no
policy file exists.

**`src/core/logger.ts`** — Appends one JSON line per decision to
`~/.agentwall/session-YYYY-MM-DD.jsonl`. Creates the directory if needed.
Write failures warn to stderr but never crash. `replay()` reads the latest
session log and prints a color-coded table (ALLOW=green, DENY=red, ASK=yellow).

**`src/core/prompt.ts`** — Displays an approval prompt on `process.stderr`.
Queues concurrent approvals and shows one at a time with a pending count.
Maintains a `Set<string>` of base executables approved with "always" during
the session. Auto-denies after 5 minutes of no response.

**`src/adapters/openclaw/client.ts`** — Connects to the OpenClaw gateway
WebSocket (`ws://127.0.0.1:18789`). Generates an Ed25519 keypair on first run,
stores device identity at `~/.agentwall/device.json` with `0o600` permissions.
Handles the challenge-response handshake with v2 pipe-delimited signing.
Intercepts `exec.approval.requested` events and resolves them via
`exec.approval.resolve`. Reconnects automatically on disconnect with a
2-second backoff.

**`src/cli.ts`** — Parses `process.argv` manually (no CLI framework). Commands:
`start`, `init`, `setup openclaw`, `replay [N]`, `status`, `--help`. Manages a
PID lock file at `~/.agentwall/agentwall.lock`. Wires policy → prompt → logger →
adapter together in the `start` command.

### Tech Stack

- TypeScript with `strict: true`, ESM modules
- Node.js ≥ 22
- Two runtime dependencies: `ws` (WebSocket), `js-yaml` (policy parsing)
- No CLI framework, no terminal color library — ANSI codes used directly
- Ed25519 signing via Node's built-in `crypto` module

---

## Test Results

All tests ran on 2026-03-19. TypeScript compiled with zero errors under strict
mode.

### CLI Commands — 13/13 pass

| Command | Result | Notes |
|---|---|---|
| `agentwall --help` | PASS | Formatted usage with all commands and flags |
| `agentwall status` (no policy) | PASS | Shows "not configured (using defaults)" |
| `agentwall status` (with policy) | PASS | Shows policy path and running state |
| `agentwall init` | PASS | Creates `~/.agentwall/policy.yaml` |
| `agentwall init` (2nd run) | PASS | "Policy already exists" — idempotent |
| `agentwall setup openclaw` | PASS | Prints JSON config + restart instructions |
| `agentwall setup badruntime` | PASS | Error + exit code 1 |
| `agentwall badcommand` | PASS | "Unknown command" error + exit code 1 |
| `agentwall start` (no token) | PASS | "No gateway token provided" error |
| `agentwall start --token fake` | PASS | Connects to gateway, rejects bad token |
| `agentwall replay` | PASS | Color-coded table of all session entries |
| `agentwall replay 2` | PASS | Limits output to last 2 entries |
| `npm run build` / `node dist/cli.js` | PASS | Compiled JS runs correctly |

### Policy Engine — 24/24 pass

| Category | Tests | Details |
|---|---|---|
| Deny rules | 8 | `rm -rf /`, `rm -rf /home` (prefix), `curl * \| bash`, `wget * \| bash`, `~/.ssh`, `~/.ssh/subdir`, `~/.aws`, `~/.gnupg` |
| Allow rules | 2 | Workspace root, workspace subdirectory |
| Allow > Ask precedence | 2 | Dangerous commands auto-allowed inside workspace (deny→allow→ask order) |
| Ask rules (outside workspace) | 5 | `rm -rf`, `rm -r`, `sudo`, `chmod -R`, `dd` — all flagged outside workspace |
| Default behavior | 1 | Unknown command with empty workingDir defaults to ask |
| Edge cases | 4 | Empty workingDir skips path rules, prefix boundary (cwdX ≠ cwd), `rm -rf` no trailing |

Key finding: the deny → allow → ask evaluation order means `allow: workspace/**`
fires before ask rules for commands run inside the workspace. Dangerous commands
like `rm -rf` or `sudo` are auto-allowed inside the workspace but flagged
outside it. Only deny-list patterns (`rm -rf /`, pipe-to-shell, sensitive paths)
block commands regardless of location.

### Device Identity — 7/7 pass

| Test | Result |
|---|---|
| Adapter name is "openclaw" | PASS |
| `device.json` created on first run | PASS |
| Device ID is 64-character hex SHA256 | PASS |
| Public key PEM format correct | PASS |
| Private key PEM format correct | PASS |
| Device token null initially | PASS |
| Second instantiation reuses same identity | PASS |

### Logger + Replay — pass

Wrote 3 synthetic log entries (ALLOW, ASK, DENY), verified JSONL file format,
replay renders correctly formatted table with color-coded decisions and proper
column alignment.

### Summary

```
  Component          Tests    Result
  ─────────────────────────────────────
  CLI commands         13     13 pass
  Policy engine        24     24 pass
  Device identity       7      7 pass
  Logger + replay       —     pass
  TypeScript strict     —     0 errors
  Production build      —     compiles + runs
  ─────────────────────────────────────
  Total                44+    ALL PASS
```

### Not Tested (requires live environment)

- End-to-end approval flow with a running OpenClaw gateway and an AI agent
  proposing a shell command
- Interactive approval prompt (y/n/a input, session memory "always" behavior,
  auto-deny timeout, concurrent queue)
- WebSocket reconnection after gateway disconnect
- Lock file conflict detection with a second running instance

---

## v0.2.0 — Native Plugin Build (2026-03-19)

### What Changed

v0.2 replaces the v0.1 WebSocket adapter (`exec.approval.requested` event hack)
with a native OpenClaw plugin using the `before_tool_call` hook. This intercepts
**all** tool calls — not just `exec` — before they execute.

### Reverse-Engineering Results

Plugin discovery was determined by reading the compiled OpenClaw runtime
(`skills-CtzUimzY.js`, `utils-B88a096J.js`, `frontmatter-D0K3qXQH.js`):

- `resolvePluginSourceRoots()` in `src/plugins/roots.ts` resolves three roots:
  - `stock` — bundled plugins shipped with OpenClaw
  - `global` — `path.join(resolveConfigDir(), "extensions")` → `~/.openclaw/extensions/`
  - `workspace` — `<workspaceRoot>/.openclaw/extensions/`
- `resolveConfigDir()` returns `~/.openclaw` (or `$OPENCLAW_STATE_DIR` if set)
- `discoverInDirectory()` scans each subdirectory, looks for `openclaw.plugin.json`
  manifest and falls back to `DEFAULT_PLUGIN_ENTRY_CANDIDATES` (`index.ts`,
  `index.js`, `index.mjs`, `index.cjs`)
- The `before_tool_call` hook returns `{ block, blockReason, params }` to
  control tool execution
- `MANIFEST_KEY` in `package.json` is `"openclaw"` — the `openclaw.extensions`
  array is required for `openclaw plugins install` to recognize the entry point

### Wiring — What Worked and What Didn't

**Attempt 1 — Symlink into `~/.openclaw/extensions/` (FAILED)**

```
ln -s ~/agentwall ~/.openclaw/extensions/agentwall
```

This did not work. `discoverInDirectory()` uses `fs.readdirSync(dir, { withFileTypes: true })`
and the resulting `Dirent` objects return `isDirectory() === false` for symlinks.
The code at line 622 (`if (!entry.isDirectory()) continue;`) skips them. No
diagnostic was emitted — the symlink was silently ignored.

**Attempt 2 — `openclaw plugins install --link` (FAILED initially)**

```
openclaw plugins install ~/agentwall --link
```

First run failed with: `package.json missing openclaw.extensions`. The install
command requires a `"openclaw": { "extensions": ["./index.js"] }` field in
`package.json` to know which file is the plugin entry point.

**Attempt 3 — Added `openclaw.extensions`, re-ran install (SUCCESS)**

After adding the `openclaw` metadata to `package.json`:

```json
"openclaw": {
  "extensions": ["./index.js"]
}
```

Re-ran `openclaw plugins install ~/agentwall --link`. Output:

```
[plugins] [AgentWall] v0.2 activated — intercepting all tool calls
Linked plugin path: ~/agentwall
Restart the gateway to load plugins.
```

This approach uses `discoverFromPath()` (via config `loadPaths`), which resolves
paths with `fs.statSync` — follows symlinks properly. The install command wrote
the path to `~/.openclaw/openclaw.json` under `plugins.installs`.

### New Files

```
agentwall/
├── openclaw.plugin.json          ← plugin manifest (id, name, version, configSchema)
├── index.js                      ← plugin entry point (activate → registers hook)
└── src/
    ├── hook.js                   ← before_tool_call handler (intercept → policy → prompt → log)
    ├── policy.js                 ← allow/block/prompt policy (configurable sets)
    ├── approver.js               ← terminal approval prompt (y/N, 5-min auto-deny)
    └── logger.js                 ← JSONL decision log at ~/.agentwall/decisions.jsonl
```

### Modified Files

- `package.json` — version → 0.2.0, added `"main": "index.js"`, added
  `"openclaw": { "extensions": ["./index.js"] }`

### Architecture

```
OpenClaw gateway
  └─ plugin loader (reads ~/.openclaw/openclaw.json → plugins.installs.agentwall)
       └─ loads ~/agentwall/index.js
            └─ activate(api) registers before_tool_call hook
                 └─ AgentWall handler (src/hook.js)
                      ├─ getPolicy(toolName) → allow | block | prompt
                      ├─ if 'block' → return { block: true, blockReason }
                      ├─ if 'allow' → return undefined (pass-through)
                      └─ if 'prompt':
                           ├─ promptApproval() → stderr prompt, y/N
                           ├─ logDecision() → ~/.agentwall/decisions.jsonl
                           └─ return { block: true } or undefined
```

### v0.1 Code Preserved

All v0.1 TypeScript source (`src/cli.ts`, `src/core/*`, `src/adapters/*`) remains
intact. The v0.2 plugin files are plain JS and coexist alongside the v0.1 code.
The v0.1 WebSocket adapter is now deprecated — v0.2 handles all tool calls
(including `exec`) through the plugin hook. Running both simultaneously would
cause double-prompting on `exec` calls.

### Test Results (2026-03-19)

Plugin installed via `openclaw plugins install --link`. Verified with
`openclaw plugins list` — shows `AgentWall (agentwall) loaded`, origin `config`,
version `0.2.0`.

After gateway restart, triggered two `exec` tool calls ("ls -la ~"):

| # | Tool | Decision | Reason | Logged |
|---|------|----------|--------|--------|
| 1 | exec | approved | user   | yes    |
| 2 | exec | blocked  | user   | yes    |

Both decisions written to `~/.agentwall/decisions.jsonl` with full context
(timestamp, toolName, params, agentId, sessionKey, runId).

### Still To Test

- Non-exec tool interception (`read_file`, `write_file`, `edit`, `apply_patch`)
- Auto-deny on prompt timeout (5 minutes no response)
- Policy auto-allow and auto-block (adding tools to `AUTO_ALLOW` / `AUTO_BLOCK`
  sets in `src/policy.js`)
- Headless mode behavior (no TTY → prompt fails → blocks for safety)

---

## v0.3.0 — MCP Proxy Build (2026-03-19)

### What Changed

v0.3 adds a protocol-level MCP proxy that sits between any MCP client (Cursor,
Claude Code, Claude Desktop, Windsurf, Cline, etc.) and any MCP server. This
makes AgentWall runtime-agnostic — it intercepts every `tools/call` request
regardless of which client issued it.

### Architecture

```
MCP Client (Cursor / Claude Code / Claude Desktop)
    ↓  tools/call (stdio JSON-RPC)
[ AgentWall MCP Proxy ]
├── StdioServerTransport (receives from client via stdin/stdout)
├── PolicyEngine (YAML rules: deny → allow → ask)
├── askUser via /dev/tty (approval prompt, when TTY available)
├── EventLogger (JSONL audit log)
└── StdioClientTransport (spawns real server as child process)
    ↓  approved calls only
[ Real MCP Server ]
```

Config changes from:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user"]
    }
  }
}
```

To:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "agentwall",
      "args": ["proxy", "--", "npx", "-y", "@modelcontextprotocol/server-filesystem", "/home/user"]
    }
  }
}
```

### New Files

```
src/adapters/mcp/proxy.ts       ← MCP proxy adapter (Server + Client composition)
```

### Modified Files

| File | Change |
|---|---|
| `src/core/prompt.ts` | Added `/dev/tty` input mode (`useTtyInput()`) — proxy mode reads approval input from TTY instead of stdin (stdin carries MCP traffic). Gracefully denies when no TTY available. |
| `src/core/types.ts` | Added `McpProxyOptions` interface |
| `src/cli.ts` | Added `proxy` subcommand, `setup mcp` instructions, version → 0.3.0 |
| `src/hook.js` | Migrated from `approver.js` to `prompt.ts` — unified approval UI |
| `package.json` | Version → 0.3.0, added `@modelcontextprotocol/sdk` dependency |

### Deleted Files

| File | Reason |
|---|---|
| `src/approver.js` | Replaced by canonical `src/core/prompt.ts` — one approval UI across all adapters |

### How the Proxy Works

1. `StdioClientTransport` spawns the real MCP server as a child process
2. `Client` connects to it, performs MCP initialization handshake
3. Real server's capabilities are read via `client.getServerCapabilities()`
4. `Server` is created with matching capabilities (mirroring the real server)
5. Handlers registered for all known MCP methods:
   - `tools/call` — **intercepted** through policy engine
   - `tools/list` — forwarded unchanged
   - `resources/*`, `prompts/*`, `completions/*`, `logging/*` — forwarded transparently
6. `StdioServerTransport` connects to the client (Cursor/Claude) via stdin/stdout
7. Blocked calls return `{ isError: true, content: [{ type: "text", text: "AgentWall: ..." }] }`

### Smart Command Extraction

For shell/exec tools (`bash`, `exec`, `shell`, `run_command`, etc.), the proxy
extracts the actual command from the tool arguments and uses it for policy
matching. This makes existing shell-oriented policy rules (`rm -rf*`, `sudo *`)
work for MCP bash tool calls.

For other tools, the tool name itself is used as the "command" for policy
matching (e.g., `list_directory`, `write_file`, `query`).

Path is extracted from common argument field names: `path`, `file`, `filename`,
`directory`, `uri`.

### Edge Cases Handled

| Edge case | How it's handled |
|---|---|
| No TTY (Cursor, Claude Desktop) | `openInput()` checks `/dev/tty` availability upfront via `openSync`. Falls back to auto-deny. |
| Real server crash | `realTransport.onclose` propagates clean error, proxy exits |
| Concurrent tool calls | `prompt.ts` queue — one prompt at a time, pending count shown |
| JSON-RPC framing | SDK's `StdioServerTransport` / `StdioClientTransport` handle framing — no manual parsing |
| Policy evaluation for MCP | deny → allow → ask order, same YAML file as v0.1/v0.2 |

### Known Limitations

| Limitation | Reason |
|---|---|
| Cannot intercept client's built-in tools | Cursor/Claude Desktop built-in tools don't go through MCP — they're internal to the client process |
| No interactive prompt in GUI clients | Cursor and Claude Desktop spawn MCP servers without a terminal. Approval prompts work only in CLI contexts (Claude Code, standalone terminal). |
| Policy not hot-reloaded | `PolicyEngine` reads YAML at startup. Proxy restart required for policy changes. |

### Research Findings (MCP SDK)

SDK version 1.27.1 (`@modelcontextprotocol/sdk`) found at
`/opt/homebrew/lib/node_modules/openclaw/node_modules/@modelcontextprotocol/sdk/`.

| Question | Answer |
|---|---|
| Separate transport classes? | Yes — `StdioServerTransport` (server/stdio.js) and `StdioClientTransport` (client/stdio.js) |
| `CallToolRequest` shape? | `{ method: "tools/call", params: { name: string, arguments?: Record<string, unknown> } }` |
| Transport type? | stdio — config uses `command` + `args` |
| Existing MCP proxy? | None generic — only OpenClaw's ACP-specific `mcp-proxy.mjs` and SDK's `ProxyOAuthServerProvider` |
| Decision | Compose two SDK transport instances (recommended path) |

### Test Results (2026-03-19)

#### Build

- TypeScript strict mode: **0 errors**
- `npm run build`: **clean**

#### Terminal Standalone Test

Piped test sending `initialize` → `notifications/initialized` → `tools/list` → `tools/call`:

| Step | Result |
|---|---|
| `initialize` | Proxy responded as `agentwall-proxy v0.3.0`, mirrored real server capabilities |
| `tools/list` | Forwarded 14 filesystem tools unchanged from real server |
| `tools/call` (list_directory) | Intercepted — approval prompt appeared, user approved, result returned |

#### Interactive Test (named pipe)

```bash
bash /tmp/mcp-test.sh
```

Approval prompt appeared for `list_directory`. User typed `y`, directory listing returned. Logged to JSONL.

#### Cursor Test

Configured `~/.cursor/mcp.json` to route filesystem server through proxy.
After reload, Cursor used the MCP `list_directory` tool:

```
17:37:49   mcp   ALLOW   policy   list_directory   ← auto-allowed by policy
17:37:55   mcp   ALLOW   policy   list_directory   ← auto-allowed by policy
```

Both calls auto-allowed (tool in allow list), logged, results returned to Cursor.

#### Claude Desktop Test

Configured `~/Library/Application Support/Claude/claude_desktop_config.json`.
Claude Desktop logs confirmed proxy started:

```
Server started and connected successfully
agentwall v0.3.0 — MCP proxy mode
✓ Connected to real MCP server
✓ Proxy ready — intercepting tool calls
```

Tested deny override — added `list_directory` to deny list:

```
18:14:45   mcp   ALLOW   policy   list_allowed_directories   ← allowed
18:14:47   mcp   DENY    policy   list_directory              ← BLOCKED despite Claude "Always allow"
```

Claude Desktop approved the call in its UI. AgentWall denied it anyway.
Confirms: client approval does not override AgentWall policy.

#### Backward Compatibility

| Version | Test | Result |
|---|---|---|
| v0.1 | `agentwall start --help` | CLI loads, all commands present |
| v0.2 | `import('./index.js')` | Plugin loads: "AgentWall 0.2.0" |

#### Audit Log (unified across all runtimes)

```
TIME       RUNTIME      DECISION  BY       COMMAND
──────────────────────────────────────────────────────────────────────────
13:13:21   openclaw     ALLOW     policy   git status
13:13:21   openclaw     ASK       user     rm -rf ./node_modules
13:13:21   openclaw     DENY      policy   cat ~/.ssh/id_rsa
17:25:34   mcp          ASK       user     list_directory
17:37:49   mcp          ALLOW     policy   list_directory
18:14:47   mcp          DENY      policy   list_directory
```

Both `openclaw` and `mcp` runtimes log to the same session file.

### Version History

| Version | What gets intercepted | How |
|---|---|---|
| v0.1 | `exec` — shell commands only | OpenClaw WebSocket event adapter |
| v0.2 | All tool calls inside OpenClaw | Native OpenClaw plugin (`before_tool_call` hook) |
| v0.3 | **Everything MCP-speaking** | **Protocol-level MCP proxy** |
