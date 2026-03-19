# AgentWall — Technical Design Document

**Version:** 0.2 (updated — multi-runtime adapter architecture)
**Status:** Draft
**Date:** March 2026
**Companion doc:** AgentWall PRD v0.2

---

## Table of Contents

1. [Project Structure](#1-project-structure)
2. [Adapter Interface Contract](#2-adapter-interface-contract)
3. [Module Responsibilities](#3-module-responsibilities)
4. [OpenClaw Adapter](#4-openclaw-adapter)
5. [Claude Code Adapter](#5-claude-code-adapter)
6. [MCP Proxy Adapter (v0.2 design)](#6-mcp-proxy-adapter-v02-design)
7. [Action Interception Flow](#7-action-interception-flow)
8. [Policy Engine](#8-policy-engine)
9. [Approval Prompt](#9-approval-prompt)
10. [Event Logger](#10-event-logger)
11. [Error Handling](#11-error-handling)
12. [Data Schemas](#12-data-schemas)
13. [Dependencies](#13-dependencies)
14. [Open Risks](#14-open-risks)

---

## 1. Project Structure

Single npm package. Core and adapters are separated as directories inside `src/` so they can be split into separate packages later without restructuring.

```
agentwall/
├── src/
│   ├── cli.ts                    # Entry point. Parses args, routes commands,
│   │                             # constructs adapters, wires to core
│   ├── core/
│   │   ├── types.ts              # Shared types: ActionProposal, Decision, LogEntry
│   │   ├── policy.ts             # Policy engine — loads YAML, evaluates rules
│   │   ├── logger.ts             # Event logger — writes JSONL, serves replay
│   │   └── prompt.ts             # Approval prompt — terminal UI, session memory
│   └── adapters/
│       ├── interface.ts          # AgentWallAdapter interface — the contract
│       ├── openclaw/
│       │   └── client.ts         # OpenClaw WebSocket adapter
│       └── claude-code/
│           ├── hook.ts           # Hook script entry point (spawned per tool call)
│           └── daemon-client.ts  # IPC client used by hook.ts to reach running daemon
├── package.json
├── tsconfig.json
└── README.md
```

**Why this structure:**

`core/` has zero knowledge of any runtime. It receives an `ActionProposal` and returns a `Decision`. The adapter directories are the only place that knows anything runtime-specific. When the MCP proxy adapter arrives in v0.2, it slots in as `adapters/mcp/proxy.ts` and calls the same core interfaces. When the Cursor adapter arrives, it slots in as `adapters/cursor/hook.ts` following the same pattern as the Claude Code adapter.

`core/types.ts` is the single source of truth for all shared types. Every module imports from it rather than defining its own local versions.

---

## 2. Adapter Interface Contract

This is the boundary between adapters and the runtime-agnostic core. Every adapter must satisfy this interface. The core and CLI depend only on this interface — never on a concrete adapter class.

```typescript
// src/adapters/interface.ts

interface ActionProposal {
  approvalId:  string    // Unique ID for this action. Used to resolve the decision
                         // back to the runtime. For Claude Code hook, generate a UUID.
  runtime:     string    // "openclaw" | "claude-code" | "cursor" | "mcp"
  command:     string    // The shell command string or MCP tool name
  workingDir:  string    // Absolute path, or "" if unknown
  toolInput?:  unknown   // Raw tool input from the runtime, for logging
  sessionId?:  string    // Runtime session identifier if available
  agentId?:    string    // Runtime agent identifier if available
}

type Decision = "allow" | "deny" | "ask"

interface AgentWallAdapter {
  // Human-readable name shown in status output and log entries
  readonly name: string

  // Start the adapter. Resolves when ready to receive proposals.
  // Rejects if the adapter cannot connect or register.
  start(): Promise<void>

  // Stop the adapter cleanly. Close connections, deregister hooks.
  stop(): Promise<void>

  // Register a handler that the adapter calls for every intercepted action.
  // The handler is provided by the CLI and calls into core.
  // The adapter must not call the runtime's allow/deny until the handler resolves.
  onProposal(handler: ProposalHandler): void

  // The adapter calls this to send the final decision back to the runtime.
  // Called by the core after the handler resolves.
  resolve(approvalId: string, decision: "allow" | "deny"): Promise<void>
}

type ProposalHandler = (proposal: ActionProposal) => Promise<void>
```

**Key design decisions:**

The `resolve` method is on the adapter, not returned from the handler. This means the core does not need to know how to communicate back to the runtime — it just calls `resolve` on the adapter that produced the proposal. The adapter knows its own protocol.

The handler is async. For OpenClaw this means the WebSocket stays open and processing other events while waiting for user input. For Claude Code, the hook process stays alive and waiting for the daemon response.

---

## 3. Module Responsibilities

### 3.1 `cli.ts`

- Parses `process.argv`
- Routes to command handlers: `start`, `init`, `setup`, `replay`, `status`
- For `start`:
  - Detects which adapters are configured (checks for device.json, hook registration, etc.)
  - Constructs each configured adapter
  - Creates a `PolicyEngine`, `EventLogger`, and `PromptHandler` from core
  - Wires the proposal handler: policy → prompt if needed → logger → adapter.resolve
  - Registers SIGINT/SIGTERM handlers
  - Writes and cleans up a lock file
  - Keeps the process alive
- Owns no business logic itself

### 3.2 `core/types.ts`

Exports: `ActionProposal`, `Decision`, `LogEntry`. These three types are the entire surface area of the core's public API. Nothing else crosses the adapter/core boundary.

### 3.3 `core/policy.ts`

- Loads and parses `~/.agentwall/policy.yaml` on construction
- Validates the schema — exits with a clear error if invalid
- Exposes one public method: `evaluate(proposal: ActionProposal): Decision`
- Has no knowledge of WebSockets, hooks, or the terminal

### 3.4 `core/logger.ts`

- Opens an append-only write stream to `~/.agentwall/session-YYYY-MM-DD.jsonl` on construction
- Exposes one public method: `log(entry: LogEntry): void`
- Exposes one static method: `replay(n: number): void`
- Has no knowledge of any runtime

### 3.5 `core/prompt.ts`

- Owns the in-process session memory for `always` decisions (`Set<string>` of base executables)
- Exposes one public async method: `ask(proposal: ActionProposal): Promise<"allow" | "deny">`
- Checks session memory first, renders terminal prompt only if needed
- Has no knowledge of any runtime

### 3.6 `adapters/openclaw/client.ts`

- Owns the OpenClaw WebSocket connection lifecycle
- Translates `exec.approval.requested` events into `ActionProposal` objects
- Implements `AgentWallAdapter`
- Is the only file that imports `ws`

### 3.7 `adapters/claude-code/hook.ts`

- Standalone entry point compiled to its own binary: `agentwall-hook`
- Spawned by Claude Code per tool call
- Reads tool call details from stdin
- Communicates with the running AgentWall daemon via IPC (Unix socket)
- Exits 0 (allow) or 1 (deny) based on the daemon's response
- Must start and respond in under 20ms for auto-allow actions

### 3.8 `adapters/claude-code/daemon-client.ts`

- IPC client that `hook.ts` uses to reach the running AgentWall daemon
- Sends an `ActionProposal` over a Unix socket at `~/.agentwall/daemon.sock`
- Waits for a `Decision` response
- Times out and returns `"deny"` if the daemon does not respond within 10 seconds

---

## 4. OpenClaw Adapter

### 4.1 WebSocket Handshake Sequence

```
Gateway → Client   { type: "event", event: "connect.challenge", payload: { nonce, ts } }
Client  → Gateway  { type: "req", id, method: "connect", params: { ... } }
Gateway → Client   { type: "res", id, ok: true, payload: { type: "hello-ok", ... } }
```

The challenge event arrives before the connection handshake. The client must wait for it before sending the connect request.

### 4.2 Connect Request Shape

```json
{
  "type": "req",
  "id": "<unique string>",
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 3,
    "client": {
      "id": "agentwall",
      "version": "0.1.0",
      "platform": "<process.platform>",
      "mode": "operator"
    },
    "role": "operator",
    "scopes": ["operator.read", "operator.approvals"],
    "caps": [],
    "commands": [],
    "permissions": {},
    "auth": { "token": "<OPENCLAW_GATEWAY_TOKEN or empty string>" },
    "locale": "en-US",
    "userAgent": "agentwall/0.1.0",
    "device": {
      "id": "<stable device fingerprint>",
      "publicKey": "<base64 DER Ed25519 public key>",
      "signature": "<base64 Ed25519 signature>",
      "signedAt": "<unix ms>",
      "nonce": "<nonce from challenge>"
    }
  }
}
```

`scopes` must include `operator.approvals`. Without it, `exec.approval.resolve` calls are rejected by the gateway.

### 4.3 Device Identity and Persistence

AgentWall generates an Ed25519 keypair on first run and saves it to `~/.agentwall/device.json`. Subsequent runs load the saved keypair. This gives a stable device ID that avoids re-pairing on every launch.

The device ID is the first 16 hex characters of the SHA-256 hash of the public key bytes.

### 4.4 Signing Payload

The signature covers this JSON, fields in this exact order:

```json
{
  "deviceId": "<device.id>",
  "nonce": "<challenge nonce>",
  "ts": "<signedAt unix ms>",
  "role": "operator"
}
```

Algorithm: Ed25519, using Node's built-in `crypto` module. The signature bytes are base64-encoded.

### 4.5 ActionProposal Extraction

The `exec.approval.requested` event payload shape:

```json
{
  "approvalId": "...",
  "sessionId": "...",
  "agentId": "...",
  "systemRunPlan": {
    "rawCommand": "rm -rf ./dist",
    "argv": ["rm", "-rf", "./dist"],
    "cwd": "/home/user/myproject"
  }
}
```

Extraction priority for command:
1. `systemRunPlan.rawCommand`
2. `systemRunPlan.argv.join(" ")`
3. `"(unknown command)"`

Extraction priority for workingDir:
1. `systemRunPlan.cwd`
2. `""`

### 4.6 Connection Failure Modes

| Error | Message shown to developer |
|---|---|
| WebSocket connection refused | `✗ Cannot connect to OpenClaw gateway at <url>. Is the gateway running?` |
| `AUTH_TOKEN_MISMATCH` | `✗ Auth token mismatch. Set OPENCLAW_GATEWAY_TOKEN or pass --token.` |
| `DEVICE_AUTH_NONCE_MISMATCH` | `✗ Internal signing error (nonce mismatch). Please file a bug.` |
| `ok: false`, unrecognised code | `✗ Gateway rejected connection: <error>. Is OpenClaw up to date?` |

### 4.7 Reconnection

On close: wait 2 seconds, then reconnect with a full handshake. Print once on disconnect, once on successful reconnect. Do not print on every attempt.

---

## 5. Claude Code Adapter

### 5.1 Why a Daemon + Hook Architecture

Claude Code's PreToolUse hook is a process spawned per tool call. If the hook starts a full Node.js process each time, module loading overhead will add 100-300ms to every tool call — far above the 20ms target for auto-allow actions.

The solution is a two-component architecture:

- **AgentWall daemon** (`agentwall start`) runs as a long-lived process with the policy engine already loaded in memory. It listens on a Unix socket at `~/.agentwall/daemon.sock`.
- **Hook script** (`agentwall-hook`) is a minimal process that reads tool call details from stdin, sends them to the daemon via the Unix socket, waits for a decision, and exits with the appropriate code. It does not load the policy engine or open any log files.

This means the per-tool-call overhead is only the IPC round trip — expected to be under 5ms on a local Unix socket.

### 5.2 Hook Registration

The developer adds the following to `.claude/settings.json` (or the global `~/.claude.json`):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "agentwall-hook"
          }
        ]
      }
    ]
  }
}
```

`agentwall setup claude-code` prints this exact configuration with instructions for where to place it.

### 5.3 Hook Script stdin Format

Claude Code passes tool call details to the hook via stdin as a JSON object. The exact format needs to be confirmed against Claude Code's PreToolUse hook documentation, but is expected to contain:

```json
{
  "tool_name": "Bash",
  "tool_input": {
    "command": "rm -rf ./dist",
    "description": "Remove build artifacts"
  },
  "session_id": "...",
  "transcript_path": "..."
}
```

The hook reads this from stdin, constructs an `ActionProposal`, sends it to the daemon, and exits based on the response.

**Risk:** The exact stdin format must be confirmed before implementation. See Open Risks section.

### 5.4 Hook Exit Codes

| Exit code | Meaning | Claude Code behaviour |
|---|---|---|
| `0` | Allow | Tool call proceeds |
| `1` | Deny | Tool call is blocked, Claude Code reports the block |
| Any other | Error | Claude Code falls back to its native permission behaviour |

The hook must never exit with a non-zero code due to an internal error (daemon not running, IPC timeout) in a way that permanently blocks tool calls. If the daemon is unreachable, the hook exits 0 and logs a warning — allowing the action rather than breaking the developer's workflow. This is a deliberate fail-open choice for infrastructure failures, separate from policy denials.

### 5.5 Daemon IPC Protocol

The Unix socket at `~/.agentwall/daemon.sock` uses a simple newline-delimited JSON protocol:

Hook → Daemon:
```json
{"id":"<uuid>","runtime":"claude-code","command":"rm -rf ./dist","workingDir":"/home/user/project","toolInput":{...},"sessionId":"..."}
```

Daemon → Hook:
```json
{"id":"<uuid>","decision":"allow"}
```

The `id` field is echoed back so the daemon can handle multiple concurrent hook calls without confusion.

### 5.6 Concurrent Hook Calls

Claude Code may spawn multiple tool calls in rapid succession, each spawning a separate hook process. The daemon must handle concurrent IPC requests correctly. Each request is identified by its `id` and processed independently. Requests that require user approval are queued — only one approval prompt is shown at a time.

---

## 6. MCP Proxy Adapter (v0.2 Design)

This section documents the intended v0.2 design so that v0.1 implementation decisions do not inadvertently make it harder to add. No v0.2 code is written in v0.1.

### 6.1 How It Works

AgentWall runs as an MCP server. The developer points their MCP-compatible agent (Claude Code, Cursor, any other client) at AgentWall's MCP server instead of their tool servers directly. AgentWall's MCP server:

1. Receives every tool call from the agent
2. Runs it through the policy engine
3. If allowed, proxies it to the real MCP server and returns the result
4. If denied, returns an error to the agent
5. If ask, pauses, shows the approval prompt, and proceeds or denies based on the response

### 6.2 Configuration

The developer configures AgentWall as a proxy by telling it which real MCP servers sit behind it:

```yaml
# ~/.agentwall/policy.yaml additions for MCP proxy mode
mcp_servers:
  - name: filesystem
    upstream: "stdio://npx @modelcontextprotocol/server-filesystem /home/user"
  - name: github
    upstream: "sse://localhost:3001"
```

Their agent is configured to point at AgentWall's MCP server instead of these directly.

### 6.3 Why This Covers Cursor and Claude Code Generically

Any agent that speaks MCP — including Claude Code and Cursor — will route all tool calls through the proxy without requiring a separate hook adapter per agent. The MCP proxy is the generic long-term solution. The hook adapters in v0.1 are the pragmatic short-term solution for the two most popular runtimes.

---

## 7. Action Interception Flow

### 7.1 Normalised ActionProposal

The `ActionProposal` type (defined in `core/types.ts`) is the only object that crosses the adapter/core boundary. No adapter-specific types leak into core.

```typescript
interface ActionProposal {
  approvalId:  string
  runtime:     "openclaw" | "claude-code" | "cursor" | "mcp"
  command:     string
  workingDir:  string
  toolInput?:  unknown
  sessionId?:  string
  agentId?:    string
}
```

### 7.2 Decision Flow

```
Adapter receives event from runtime
        │
        ▼
Adapter extracts ActionProposal
        │
        ▼
ProposalHandler (wired in cli.ts) is called
        │
        ▼
policy.evaluate(proposal)  →  "allow" | "deny" | "ask"
        │
   ┌────┴──────────┬───────────────┐
 deny            allow            ask
   │               │               │
   ▼               ▼               ▼
logger.log()   logger.log()   prompt.ask(proposal)
   │               │               │
   ▼               ▼         ┌─────┴──────┐
adapter.resolve  adapter.resolve  "allow"     "deny"
("deny")       ("allow")      │             │
                              ▼             ▼
                         logger.log()  logger.log()
                              │             │
                              ▼             ▼
                         adapter.resolve  adapter.resolve
                         ("allow")       ("deny")
```

### 7.3 Pending Request Map

The OpenClaw adapter maintains a `Map<string, (res) => void>` of pending request callbacks keyed by request ID. When a response arrives from the gateway the ID is looked up and the callback is called.

The daemon maintains a `Map<string, (decision: Decision) => void>` for pending IPC requests from hook processes.

Request IDs: `aw-${Date.now()}-${randomHex(6)}`

### 7.4 Approval Queue

When multiple actions arrive concurrently that all require user approval, AgentWall queues them and shows one prompt at a time. The terminal prompt displays how many are queued:

```
  ⚠  AgentWall — approval required  (2 more pending)
```

Actions that are auto-allowed or auto-denied by policy are processed immediately without joining the queue.

---

## 8. Policy Engine

### 8.1 Rule Data Model

```typescript
interface PolicyRule {
  command?:  string    // Glob pattern matched against proposal.command
  path?:     string    // Glob pattern matched against proposal.workingDir
  tool?:     string    // Exact match or "*" matched against proposal.command
                       // when runtime is "mcp"
}

interface PolicyConfig {
  deny?:  PolicyRule[]
  ask?:   PolicyRule[]
  allow?: PolicyRule[]
}
```

### 8.2 Evaluation Algorithm

```
function evaluate(proposal):
  for each rule in config.deny ?? []:
    if ruleMatches(rule, proposal): return "deny"
  for each rule in config.allow ?? []:
    if ruleMatches(rule, proposal): return "allow"
  for each rule in config.ask ?? []:
    if ruleMatches(rule, proposal): return "ask"
  return "ask"   ← default: unknown actions always require approval
```

### 8.3 Rule Matching Logic

A rule with multiple fields requires ALL fields to match (AND logic). A rule with a single field requires only that field to match.

**Command matching:**
- Expand `*` to match any characters except `/`
- Expand `**` to match any characters including `/`
- Match against the full command string
- Also match if the command starts with the non-wildcard portion of the pattern (handles `sudo *` matching `sudo apt install foo`)

**Path matching:**
- Expand `~` to `os.homedir()` before matching
- Expand `*` and `**` as above
- For `outside:workspace`: resolve the working directory and check if it starts with `process.cwd()`
- If `proposal.workingDir` is `""`, path rules do not match — they are skipped

**Tool matching (MCP, v0.2):**
- `tool: "*"` matches any tool call
- `tool: "read_file"` matches only the exact tool name
- Tool matching only applies when `proposal.runtime === "mcp"`

### 8.4 Validation on Load

Validation rejects:
- Unknown top-level keys (anything other than `deny`, `allow`, `ask`)
- Values that are not arrays
- Array elements that are not objects
- Array elements with no `command`, `path`, or `tool` field
- Non-string values for `command`, `path`, or `tool`

On validation failure: print the error message identifying the exact problem, exit with code 1.

### 8.5 Missing Policy File

If `~/.agentwall/policy.yaml` does not exist, AgentWall starts with the built-in default policy and prints:

```
  notice: no policy.yaml found — using built-in defaults
  run "agentwall init" to create a customisable policy file
```

---

## 9. Approval Prompt

### 9.1 Session Memory

An in-process `Set<string>` stores base executables approved with `always` this session.

```
baseExecutable = proposal.command.split(" ")[0]
if sessionMemory.has(baseExecutable): return "allow" without prompting
```

### 9.2 Prompt Rendering

Written to `process.stderr` so it does not pollute any piped output. Uses Node's built-in `readline`.

```
  ⚠  AgentWall — approval required  (2 more pending)
  runtime: claude-code
  reason:  no policy rule matched

  command:  rm -rf ./node_modules
  path:     /home/user/myproject

  allow?  [y] yes   [n] no   [a] always allow this  ›
```

**ANSI colour codes:**
- Yellow `\x1b[33m` — warning header, ask prompt
- Green `\x1b[32m` — allow confirmation
- Red `\x1b[31m` — deny confirmation
- Dim `\x1b[2m` — secondary information (reason, runtime)
- Reset `\x1b[0m` — after every coloured segment

**Input handling:**
- `y` or `yes` → allow
- `n` or `no` → deny
- `a` or `always` → allow + add base executable to session memory
- Any other input → re-prompt once, then deny automatically
- Case-insensitive

### 9.3 Timeout

If no response within 5 minutes, auto-deny and print:

```
  ✗ DENY  (timeout — no response after 5 minutes)
```

---

## 10. Event Logger

### 10.1 Log Entry Schema

```typescript
interface LogEntry {
  ts:          string              // ISO 8601
  runtime:     string              // "openclaw" | "claude-code" | "cursor" | "mcp"
  decision:    "allow" | "deny" | "ask"
  resolvedBy:  "policy" | "user"
  command:     string
  workingDir:  string              // "" if unknown
  approvalId:  string
  sessionId:   string              // "" if unknown
  agentId:     string              // "" if unknown
}
```

Schema is frozen for v0.1. Future versions may add fields — existing fields will not change.

### 10.2 Write Strategy

- Append-only `fs.WriteStream`, opened on construction
- Write immediately on every decision: `JSON.stringify(entry) + "\n"`
- On write error: print warning to stderr, continue operating

### 10.3 Replay Rendering

`EventLogger.replay(n)`:

1. Finds all `session-*.jsonl` files in `~/.agentwall/`, sorts descending
2. Opens the most recent file
3. Reads the last `n` lines
4. Renders a fixed-width table to stdout

Column layout:

| Column | Width | Content |
|---|---|---|
| Time | 10 | `HH:MM:SS` |
| Runtime | 12 | `openclaw`, `claude-code`, etc. |
| Decision | 8 | `ALLOW`, `DENY`, `ASK` |
| Resolved by | 8 | `policy`, `user` |
| Command | remaining | truncated at 48 chars with `...` |

---

## 11. Error Handling

### 11.1 Strategy

| Category | Examples | Behaviour |
|---|---|---|
| **Fatal — exit** | Policy YAML parse error, device keypair corrupt | Clear message with fix suggestion, exit code 1 |
| **Recoverable — warn and continue** | Log write failure, IPC timeout | Warning to stderr, keep running |
| **Transient — retry** | WebSocket disconnect | Reconnect automatically, print status once |
| **Fail-open** | Daemon unreachable when hook is called | Hook exits 0, warning logged |

### 11.2 Startup Error Messages

| Situation | Message |
|---|---|
| Policy YAML syntax error | `error: policy.yaml has a syntax error on line N: <detail>` |
| Policy YAML unknown key | `error: policy.yaml has unknown key "<key>". Valid keys: deny, allow, ask` |
| Policy rule missing fields | `error: policy.yaml rule at <section>[N] must have at least one of: command, path, tool` |
| Device file corrupt | `error: ~/.agentwall/device.json is corrupt. Delete it and restart to regenerate.` |
| Lock file present, PID running | `error: AgentWall is already running (PID <N>). Stop it first.` |

### 11.3 Runtime Error Messages

| Situation | Message |
|---|---|
| Cannot connect to OpenClaw gateway | `✗ Cannot connect to OpenClaw at <url>. Is the gateway running?` |
| OpenClaw auth token mismatch | `✗ Auth token mismatch. Set OPENCLAW_GATEWAY_TOKEN or pass --token.` |
| OpenClaw gateway disconnected | `⚡ OpenClaw disconnected. Reconnecting in 2s...` |
| OpenClaw reconnected | `✓ Reconnected to OpenClaw gateway` |
| Claude Code daemon socket not found | `✗ AgentWall daemon not running. Start it with: agentwall start` |
| Log write failure | `warning: failed to write log entry: <detail>` |
| Approval timeout | `warning: approval <id> timed out — sending deny` |
| No approvals received in 30s (OpenClaw) | `warning: no exec approvals received in 30s — is exec approval mode enabled? Run: agentwall setup openclaw` |

### 11.4 Lock File

AgentWall writes `~/.agentwall/agentwall.lock` containing the current PID on start. It is deleted on clean exit (SIGINT, SIGTERM). On start, if the lock file exists and the PID is still running, AgentWall exits with the error message above. If the PID is not running (stale lock), the lock file is overwritten.

---

## 12. Data Schemas

### 12.1 `~/.agentwall/device.json`

```json
{
  "id": "a3f9c1d2e4b50678",
  "publicKeyBase64": "<base64 DER Ed25519 public key>",
  "privateKeyBase64": "<base64 DER Ed25519 private key>",
  "deviceToken": "<token from last hello-ok, or null>"
}
```

Created on first run with permissions `600`. AgentWall exits with a clear error if it cannot write to `~/.agentwall/`.

### 12.2 `~/.agentwall/policy.yaml`

See Section 7 of the PRD for default content. Internal TypeScript representation: `PolicyConfig` as defined in Section 8.1.

### 12.3 `~/.agentwall/session-YYYY-MM-DD.jsonl`

Each line is a `LogEntry` as defined in Section 10.1. Files are never deleted by AgentWall.

### 12.4 `~/.agentwall/agentwall.lock`

Plain text file containing the running AgentWall PID as a decimal integer.

### 12.5 `~/.agentwall/daemon.sock`

Unix domain socket. Created by the daemon on start, deleted on clean exit. The hook script connects to this socket to send `ActionProposal` objects and receive `Decision` responses.

---

## 13. Dependencies

### 13.1 Runtime Dependencies

| Package | Version | Purpose |
|---|---|---|
| `ws` | ^8.18.0 | WebSocket client for OpenClaw gateway |
| `js-yaml` | ^4.1.0 | Parse `policy.yaml` |

No other runtime dependencies. Both are pure JavaScript with no native addons.

**Deliberately excluded:**
- No terminal UI library — ANSI codes written directly
- No CLI framework — four commands, simple enough to parse manually
- No crypto library — Node's built-in `crypto` handles Ed25519
- No IPC library — Node's built-in `net` module handles the Unix socket

### 13.2 Dev Dependencies

| Package | Purpose |
|---|---|
| `typescript` | Compiler |
| `tsx` | Run TypeScript directly during development |
| `@types/node` | Node.js type definitions |
| `@types/ws` | ws type definitions |
| `@types/js-yaml` | js-yaml type definitions |

### 13.3 Node Built-ins Used

- `crypto` — Ed25519 keypair generation and signing
- `fs` — File I/O
- `net` — Unix domain socket for daemon IPC
- `path` — Path manipulation
- `os` — `os.homedir()` for `~` expansion
- `readline` — Terminal prompt input
- `process` — argv, env, stdin, stdout, stderr, signals

---

## 14. Open Risks

### Risk 1 — OpenClaw handshake signing payload format
**Severity: High**
The exact JSON field order and content of the signing payload is inferred from protocol documentation. If the gateway expects a different format, the connection will fail. This must be verified against OpenClaw's source code or by running a test connection before any other implementation work begins.

**Mitigation:** Build and test the handshake first, in isolation, before writing any other code. Use `--verbose` mode to inspect raw WebSocket traffic if it fails.

### Risk 2 — Claude Code PreToolUse hook stdin format
**Severity: High**
The exact JSON format Claude Code sends to the hook via stdin must be confirmed against Claude Code's hook documentation before implementation. If the hook mis-parses this, it will silently make wrong allow/deny decisions.

**Mitigation:** Test the hook with a simple logging script before wiring it to AgentWall. Log the raw stdin content and verify it matches expectations.

### Risk 3 — Claude Code hook startup latency
**Severity: High**
If Node.js module loading makes the hook too slow, every tool call will be noticeably delayed. The daemon + IPC architecture described in Section 5 addresses this, but the actual latency needs to be measured on a representative machine before committing to the design.

**Mitigation:** Build a minimal prototype hook that just connects to a Unix socket and measure the round-trip time before implementing the full hook logic.

### Risk 4 — Multiple AgentWall instances
**Severity: Medium**
If two instances run simultaneously, both will receive the same OpenClaw events and both will respond. The lock file handles the common case. The remaining edge case is a crash that leaves a stale lock file — the PID check handles this.

**Mitigation:** Lock file with PID check as described in Section 11.4.

### Risk 5 — MCP proxy latency for fast read operations
**Severity: Medium (v0.2 concern, design now)**
The MCP proxy sits in the critical path of every tool call, including fast read operations that are auto-allowed. If the proxy adds latency to reads, the agent will feel slower even for safe operations. Policy evaluation must be fast (under 10ms) and the IPC round trip must not introduce queuing delays for auto-allow decisions.

**Mitigation:** Auto-allow decisions bypass the approval queue entirely and are resolved inline without any async waiting. Only ask decisions join the queue.

### Risk 6 — Protocol version changes in OpenClaw
**Severity: Low**
OpenClaw's WebSocket protocol is versioned. A breaking protocol change will stop AgentWall from connecting. Acceptable for v0.1 — the README will document the tested OpenClaw version range.

**Mitigation:** Pin the tested OpenClaw version in the README. Add a clear error for protocol version mismatch. Open a discussion with OpenClaw for advance notice of breaking protocol changes.