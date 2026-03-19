# AgentWall — Technical Design Document

**Version:** 0.1
**Status:** Draft
**Date:** March 2026
**Companion doc:** AgentWall PRD v0.1

---

## Table of Contents

1. [Project Structure](#1-project-structure)
2. [Module Responsibilities](#2-module-responsibilities)
3. [OpenClaw WebSocket Handshake](#3-openclaw-websocket-handshake)
4. [Action Interception Flow](#4-action-interception-flow)
5. [Policy Engine](#5-policy-engine)
6. [Approval Prompt](#6-approval-prompt)
7. [Event Logger](#7-event-logger)
8. [Error Handling](#8-error-handling)
9. [Data Schemas](#9-data-schemas)
10. [Dependencies](#10-dependencies)
11. [Open Risks](#11-open-risks)

---

## 1. Project Structure

Single npm package, no monorepo. The core and adapter are separated as directories inside `src/` so they can be split into separate packages later without restructuring.

```
agentwall/
├── src/
│   ├── cli.ts               # Entry point. Parses args, routes to commands
│   ├── core/
│   │   ├── policy.ts        # Policy engine — loads YAML, evaluates rules
│   │   ├── logger.ts        # Event logger — writes JSONL, serves replay
│   │   └── prompt.ts        # Approval prompt — terminal UI, session memory
│   └── adapters/
│       └── openclaw/
│           └── client.ts    # OpenClaw WebSocket adapter
├── package.json
├── tsconfig.json
└── README.md
```

**Why this structure:**
The `core/` directory has zero knowledge of OpenClaw. It receives a normalised `ActionProposal` object and returns a `Decision`. The `adapters/openclaw/client.ts` is the only file that knows about WebSockets, the OpenClaw protocol, or anything OpenClaw-specific. When the MCP adapter arrives in v0.2, it slots in as `adapters/mcp/server.ts` and calls the same core interfaces.

---

## 2. Module Responsibilities

### 2.1 `cli.ts`

- Parses `process.argv`
- Routes to one of four command handlers: `start`, `init`, `setup`, `replay`
- For `start`: constructs the OpenClaw client, wires it to the core modules, registers SIGINT/SIGTERM handlers, keeps the process alive
- Owns no business logic itself

### 2.2 `core/policy.ts`

- Loads and parses `~/.agentwall/policy.yaml` on construction
- Validates the schema — exits with a clear error if invalid
- Exposes one public method: `evaluate(proposal: ActionProposal): Decision`
- Decision is one of three string literals: `"allow"` | `"deny"` | `"ask"`
- Has no knowledge of WebSockets, OpenClaw, or the terminal

### 2.3 `core/logger.ts`

- Opens an append-only write stream to `~/.agentwall/session-YYYY-MM-DD.jsonl` on construction
- Exposes one public method: `log(entry: LogEntry): void`
- Exposes one static method: `replay(n: number): void` — reads the latest log file and prints a formatted table to stdout
- Has no knowledge of WebSockets, OpenClaw, or the terminal prompt

### 2.4 `core/prompt.ts`

- Owns the in-process session memory for `always` decisions (a `Set<string>` of base executables)
- Exposes one public async method: `ask(proposal: ActionProposal): Promise<"allow" | "deny">` — checks session memory first, then renders the terminal prompt if needed
- Has no knowledge of WebSockets or OpenClaw

### 2.5 `adapters/openclaw/client.ts`

- Owns the WebSocket connection lifecycle: connect, authenticate, reconnect
- Listens for `exec.approval.requested` events
- Extracts an `ActionProposal` from the event payload
- Calls `policy.evaluate()`, then `prompt.ask()` if needed
- Calls `logger.log()` for every decision
- Calls `exec.approval.resolve` on the gateway with the final decision
- Is the only file that imports `ws`

---

## 3. OpenClaw WebSocket Handshake

This is the highest-risk part of the implementation. The protocol must be followed exactly or the gateway closes the connection immediately.

### 3.1 Sequence

```
Gateway → Client   { type: "event", event: "connect.challenge", payload: { nonce, ts } }
Client  → Gateway  { type: "req", id, method: "connect", params: { ... } }
Gateway → Client   { type: "res", id, ok: true, payload: { type: "hello-ok", ... } }
```

The challenge event arrives before the connection handshake is complete. The client must wait for it before sending the connect request.

### 3.2 Connect Request — Full Shape

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
    "auth": {
      "token": "<OPENCLAW_GATEWAY_TOKEN or empty string>"
    },
    "locale": "en-US",
    "userAgent": "agentwall/0.1.0",
    "device": {
      "id": "<stable device fingerprint>",
      "publicKey": "<base64 DER-encoded Ed25519 public key>",
      "signature": "<base64 Ed25519 signature over signing payload>",
      "signedAt": "<unix ms timestamp>",
      "nonce": "<nonce from challenge event>"
    }
  }
}
```

**Critical fields:**

- `scopes` must include `operator.approvals` — without this scope, `exec.approval.resolve` calls will be rejected
- `device.nonce` must exactly match the nonce from the `connect.challenge` event
- `device.signedAt` must be close to the server's clock — the gateway checks for stale signatures

### 3.3 Device Identity

AgentWall generates an Ed25519 keypair on first run and saves it to `~/.agentwall/device.json`. On subsequent runs it loads the saved keypair. This gives a stable device ID across restarts, which avoids triggering re-pairing on every launch.

```
~/.agentwall/
├── device.json        # { id, publicKeyBase64, privateKeyBase64 }
├── policy.yaml
└── session-YYYY-MM-DD.jsonl
```

The device ID is derived as the first 16 hex characters of the SHA-256 hash of the public key bytes.

### 3.4 Signing Payload

The signature is computed over a JSON string with these exact fields in this exact order:

```json
{
  "deviceId": "<device.id>",
  "nonce": "<nonce from challenge>",
  "ts": "<signedAt unix ms>",
  "role": "operator"
}
```

Algorithm: Ed25519. The signature bytes are base64-encoded and placed in `device.signature`.

### 3.5 Hello-OK Response

A successful handshake returns:

```json
{
  "type": "res",
  "id": "<same id as request>",
  "ok": true,
  "payload": {
    "type": "hello-ok",
    "protocol": 3,
    "policy": { "tickIntervalMs": 15000 },
    "auth": {
      "deviceToken": "<token string>",
      "role": "operator",
      "scopes": ["operator.read", "operator.approvals"]
    }
  }
}
```

The `deviceToken` in the response should be saved to `~/.agentwall/device.json` alongside the keypair. On subsequent connects, the device token can be sent as `auth.token` instead of the gateway token, which avoids requiring the user to set `OPENCLAW_GATEWAY_TOKEN` after the first successful pairing.

### 3.6 Connection Failure Modes

| Error | Likely cause | Message to show user |
|---|---|---|
| WebSocket connection refused | OpenClaw gateway not running | "Cannot connect to OpenClaw gateway at <url>. Is the gateway running?" |
| `AUTH_TOKEN_MISMATCH` in response | Wrong or missing token | "Auth token mismatch. Set OPENCLAW_GATEWAY_TOKEN or pass --token." |
| `DEVICE_AUTH_NONCE_MISMATCH` | Signing bug — nonce not included | Internal error — log and exit |
| `DEVICE_AUTH_SIGNATURE_INVALID` | Signing bug — wrong payload | Internal error — log and exit |
| `ok: false` with no recognised code | Protocol version mismatch | "Gateway rejected connection: <error>. Check that OpenClaw is up to date." |

### 3.7 Reconnection Strategy

- On close, wait 2 seconds then attempt reconnect
- On reconnect, repeat the full handshake (new challenge, new signature)
- Print a single message on disconnect, a single message on reconnect
- Do not print a message on every reconnect attempt — only when the state changes

---

## 4. Action Interception Flow

### 4.1 Normalised ActionProposal

The OpenClaw adapter extracts a normalised object from the raw event payload before calling into core. This is the only type that crosses the adapter/core boundary.

```typescript
interface ActionProposal {
  approvalId: string        // from gateway — required to resolve
  command: string           // the full shell command string
  workingDir: string        // cwd of the proposed command, or "" if unknown
  sessionId?: string        // for logging
  agentId?: string          // for logging
  raw: unknown              // the original gateway payload, for debugging
}
```

### 4.2 Extraction from Gateway Payload

The gateway payload for `exec.approval.requested` looks like:

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

Extraction priority for the command string:
1. `systemRunPlan.rawCommand` — use this if present
2. `systemRunPlan.argv.join(" ")` — fallback if rawCommand is missing
3. `"(unknown command)"` — last resort, should not happen in practice

Extraction priority for the working directory:
1. `systemRunPlan.cwd`
2. `""` — empty string if not present

### 4.3 Full Decision Flow

```
exec.approval.requested event received
        │
        ▼
Extract ActionProposal from payload
        │
        ▼
policy.evaluate(proposal)
        │
    ┌───┴───────────┬───────────────┐
  deny            allow            ask
    │               │               │
    ▼               ▼               ▼
resolve(deny)   resolve(allow)  prompt.ask(proposal)
    │               │               │
    │               │         ┌─────┴──────┐
    │               │       allow         deny
    │               │         │             │
    ▼               ▼         ▼             ▼
logger.log()   logger.log()  resolve(allow) resolve(deny)
                              │             │
                              └──────┬──────┘
                                     ▼
                                logger.log()
```

### 4.4 Pending Request Map

The adapter maintains a `Map<string, (res) => void>` of pending request callbacks keyed by request ID. When a response arrives from the gateway, the ID is looked up and the callback is called. This handles the async request/response pattern over a single WebSocket connection.

Request IDs are generated as: `aw-${Date.now()}-${randomHex(6)}`

---

## 5. Policy Engine

### 5.1 Rule Data Model

```typescript
interface PolicyRule {
  command?: string    // glob pattern matched against the command string
  path?: string       // glob pattern matched against workingDir, or "outside:workspace"
}

interface PolicyConfig {
  deny?:  PolicyRule[]
  ask?:   PolicyRule[]
  allow?: PolicyRule[]
}
```

### 5.2 Evaluation Algorithm

```
function evaluate(proposal):
  for each rule in deny:
    if ruleMatches(rule, proposal): return "deny"
  for each rule in allow:
    if ruleMatches(rule, proposal): return "allow"
  for each rule in ask:
    if ruleMatches(rule, proposal): return "ask"
  return "ask"   ← default: unknown actions are never silently allowed
```

### 5.3 Rule Matching

A rule matches a proposal if **either** of its defined fields matches. If a rule defines both `command` and `path`, **both** must match (AND logic).

**Command matching:**
- Expand `*` to match any characters except `/`
- Expand `**` to match any characters including `/`
- Match against the full command string
- Also match if the command starts with the pattern prefix (handles `sudo *` matching `sudo apt install foo`)

**Path matching:**
- Expand `~` to `os.homedir()`
- Expand `*` and `**` as above
- For `outside:workspace`: resolve the working directory and check if it starts with `process.cwd()`
- Match against `proposal.workingDir`

**Empty path in proposal:**
- If `proposal.workingDir` is `""` and a rule has a path pattern, the path pattern does not match
- This means path rules do not accidentally fire on actions with no working directory information

### 5.4 Validation on Load

On startup, the policy engine validates the loaded YAML against this schema:

- Top-level keys must be `deny`, `allow`, `ask` only — unknown keys are an error
- Each value must be an array
- Each array element must be an object with at least one of `command` or `path`
- Both `command` and `path` must be strings if present

If validation fails, AgentWall prints the error and exits with code 1. It does not start in a broken policy state.

### 5.5 Missing Policy File

If `~/.agentwall/policy.yaml` does not exist, AgentWall starts with the built-in default policy (same as what `agentwall init` writes) and prints a notice:

```
  notice: no policy.yaml found, using built-in defaults
  run "agentwall init" to create a customisable policy file
```

---

## 6. Approval Prompt

### 6.1 Session Memory

An in-process `Set<string>` stores base executables that the developer has approved with `always` this session. Before showing a prompt, the approval module checks:

```
baseExecutable = proposal.command.split(" ")[0]
if sessionMemory.has(baseExecutable): return "allow" without prompting
```

### 6.2 Prompt Rendering

The prompt is rendered to `process.stderr` (not stdout) so that it does not pollute any piped output. It uses `readline` from Node's standard library — no external terminal library needed.

**Prompt layout:**

```
  ⚠  AgentWall — approval required
  reason: no policy rule matched

  command:  rm -rf ./node_modules
  path:     /home/user/myproject

  allow?  [y] yes   [n] no   [a] always allow this  ›
```

**Colour codes (ANSI):**
- Yellow `\x1b[33m` for the warning header and ask prompt
- Green `\x1b[32m` for allow confirmations
- Red `\x1b[31m` for deny confirmations
- Dim `\x1b[2m` for secondary information
- Reset `\x1b[0m` after every coloured segment

**Input handling:**
- Read one line from `process.stdin`
- Accepted values: `y`, `yes` → allow; `n`, `no` → deny; `a`, `always` → allow + add to session memory
- Any other input → treat as deny and re-prompt once, then deny automatically
- Input is case-insensitive

### 6.3 Timeout

If the developer does not respond within 5 minutes, the prompt automatically resolves as `deny` and prints:

```
  ✗ DENY  (timeout — no response after 5 minutes)
```

This prevents the agent from hanging indefinitely if the developer steps away.

---

## 7. Event Logger

### 7.1 Log Entry Schema

Each line in the JSONL file is one JSON object with exactly these fields:

```typescript
interface LogEntry {
  ts:          string    // ISO 8601, e.g. "2026-03-19T10:42:07.341Z"
  decision:    "allow" | "deny" | "ask"
  resolvedBy:  "policy" | "user"
  command:     string    // full command string
  workingDir:  string    // empty string if unknown
  approvalId:  string    // from OpenClaw gateway
  sessionId:   string    // empty string if unknown
  agentId:     string    // empty string if unknown
}
```

No other fields. The schema is frozen for v0.1. Adding fields in future versions is additive and backward compatible with replay.

### 7.2 Write Strategy

- Open an append-only `fs.WriteStream` on construction
- Write each entry as `JSON.stringify(entry) + "\n"`
- Do not buffer — write immediately on every decision
- On write error, print a warning to stderr and continue — never crash on a log write failure

### 7.3 Replay Rendering

`EventLogger.replay(n)` is a static method that:

1. Reads `~/.agentwall/` and finds all files matching `session-*.jsonl`, sorted descending
2. Opens the most recent file
3. Reads the last `n` lines
4. Renders a fixed-width table to stdout

**Column widths:**

| Column | Width |
|---|---|
| Time (HH:MM:SS) | 10 chars |
| Decision | 8 chars (padded) |
| Resolved by | 12 chars (padded) |
| Command | remaining width, truncated at 50 chars |

**Example output:**

```
  AgentWall session log — session-2026-03-19.jsonl

  TIME       DECISION  RESOLVED BY  COMMAND
  ──────────────────────────────────────────────────────────────────────────
  10:42:01   ALLOW     policy       git status
  10:42:07   ASK       user         rm -rf ./node_modules
  10:42:15   DENY      policy       cat ~/.ssh/id_rsa
  10:43:02   ALLOW     policy       npm run build
```

---

## 8. Error Handling

### 8.1 Strategy

Every error falls into one of three categories:

| Category | Examples | Behaviour |
|---|---|---|
| **Fatal — exit** | Policy YAML parse error, device keypair corrupt | Print clear message with fix suggestion, exit code 1 |
| **Recoverable — warn and continue** | Log write failure, single approval resolve timeout | Print warning to stderr, keep running |
| **Transient — retry silently** | WebSocket disconnect, reconnect in progress | Reconnect automatically, print status once |

AgentWall never swallows an error silently. Every error produces at minimum one line of output to stderr.

### 8.2 Startup Error Messages

| Situation | Message |
|---|---|
| Policy YAML syntax error | `error: policy.yaml has a syntax error on line N: <detail>` |
| Policy YAML unknown key | `error: policy.yaml has unknown key "<key>". Valid keys are: deny, allow, ask` |
| Policy rule missing command and path | `error: policy.yaml rule at <deny/allow/ask>[N] must have at least "command" or "path"` |
| Device file corrupt | `error: ~/.agentwall/device.json is corrupt. Delete it and restart to regenerate.` |

### 8.3 Runtime Error Messages

| Situation | Message |
|---|---|
| Cannot connect to gateway | `✗ Cannot connect to OpenClaw gateway at <url>` followed by `  Is the OpenClaw gateway running? Try: openclaw gateway` |
| Auth token mismatch | `✗ Auth token mismatch. Set OPENCLAW_GATEWAY_TOKEN or pass --token <token>` |
| Gateway closed connection unexpectedly | `⚡ Gateway disconnected. Reconnecting in 2s...` |
| Reconnected successfully | `✓ Reconnected to OpenClaw gateway` |
| Log write failure | `warning: failed to write log entry: <detail>` |
| Approval resolve timeout | `warning: approval <id> timed out. Sending deny.` |
| exec approval mode not detected | `warning: no exec approval requests received in 30s. Is exec approval mode enabled in OpenClaw? Run "agentwall setup" for instructions.` |

---

## 9. Data Schemas

### 9.1 `~/.agentwall/device.json`

```json
{
  "id": "a3f9c1d2e4b50678",
  "publicKeyBase64": "<base64 DER-encoded Ed25519 public key>",
  "privateKeyBase64": "<base64 DER-encoded Ed25519 private key>",
  "deviceToken": "<token from last successful hello-ok, or null>"
}
```

This file is created on first run with permissions `600`. AgentWall exits with a clear error if it cannot write to `~/.agentwall/`.

### 9.2 `~/.agentwall/policy.yaml`

See Section 6 of the PRD for the default content. The internal TypeScript representation is `PolicyConfig` as defined in Section 5.1 of this document.

### 9.3 `~/.agentwall/session-YYYY-MM-DD.jsonl`

Each line is a `LogEntry` object as defined in Section 7.1. Files are never deleted by AgentWall. The developer is responsible for cleaning them up manually.

---

## 10. Dependencies

### 10.1 Runtime Dependencies

| Package | Version | Purpose |
|---|---|---|
| `ws` | ^8.18.0 | WebSocket client for OpenClaw gateway connection |
| `js-yaml` | ^4.1.0 | Parse `policy.yaml` |

No other runtime dependencies. Both are pure JavaScript with no native addons.

**Deliberately excluded:**
- No terminal UI library (chalk, ink, etc.) — ANSI codes are written directly. Fewer dependencies, no version conflicts.
- No CLI framework (commander, yargs, etc.) — argument parsing is simple enough to do manually for four commands.
- No crypto library — Node's built-in `crypto` module handles Ed25519 signing.
- No filesystem watching library — policy hot reload is out of scope for v0.1.

### 10.2 Dev Dependencies

| Package | Purpose |
|---|---|
| `typescript` | Compiler |
| `tsx` | Run TypeScript directly during development |
| `@types/node` | Node.js type definitions |
| `@types/ws` | Type definitions for `ws` |
| `@types/js-yaml` | Type definitions for `js-yaml` |

### 10.3 Node Built-ins Used

- `crypto` — Ed25519 keypair generation and signing
- `fs` — File I/O for device.json, policy.yaml, session logs
- `path` — Path manipulation for policy evaluation
- `os` — `os.homedir()` for `~` expansion
- `readline` — Terminal prompt input
- `process` — argv, env, stdin, stdout, stderr, signals

---

## 11. Open Risks

### Risk 1 — OpenClaw handshake implementation
**Severity: High**
The signing payload format and field ordering is inferred from the protocol documentation. If the exact JSON serialisation differs from what the gateway expects, the connection will fail. The signing payload format needs to be verified against OpenClaw's source code or by running a test connection before the rest of the implementation is written.

**Mitigation:** Build and test the handshake as the very first thing. If it fails, inspect the gateway's WebSocket traffic using `--verbose` mode and adjust the signing payload accordingly.

### Risk 2 — exec approval mode detection
**Severity: Medium**
There is no documented way to query whether OpenClaw has exec approval mode enabled. AgentWall can only infer it by waiting to see if `exec.approval.requested` events arrive. If they never arrive because the mode is off, the developer may think AgentWall is working when it is not.

**Mitigation:** Print the 30-second warning described in Section 8.3. Document the prerequisite prominently in the README. Potentially query `tools.catalog` on connect to check the exec policy, if that method returns enough information.

### Risk 3 — Multiple AgentWall instances
**Severity: Medium**
If two AgentWall instances connect to the same gateway, both will receive the same `exec.approval.requested` event and both will call `exec.approval.resolve`. The second resolve call may fail or produce unexpected behaviour in the gateway.

**Mitigation:** Write a lock file to `~/.agentwall/agentwall.lock` on start and check for it. If the lock exists and the PID in it is still running, exit with a clear message: `"AgentWall is already running (PID <N>). Stop it first."` Delete the lock file on clean exit and on SIGINT/SIGTERM.

### Risk 4 — Protocol version changes in OpenClaw
**Severity: Low**
OpenClaw's WebSocket protocol is versioned (`minProtocol: 3, maxProtocol: 3`). If OpenClaw ships a breaking protocol change, AgentWall will stop connecting. This is acceptable for v0.1 — the README will document the supported OpenClaw version range.

**Mitigation:** Pin the tested OpenClaw version in the README. Add a clear error message for protocol version mismatch. File an issue with OpenClaw for advance notice of protocol changes.

### Risk 5 — Terminal prompt blocks the event loop
**Severity: Low**
While waiting for user input on the approval prompt, the WebSocket event loop continues to run. If a second `exec.approval.requested` event arrives while the first prompt is open, AgentWall needs to queue it and handle it after the first prompt resolves.

**Mitigation:** Maintain a FIFO queue of pending approval requests. Process them one at a time. Print a notice if a second request is queued while the first prompt is open: `"(1 more approval pending)"`.
