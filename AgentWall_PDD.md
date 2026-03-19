# AgentWall — Product Requirements Document

**Version:** 0.2 (updated — cross-runtime scope)
**Status:** Draft
**Date:** March 2026
**Tech Stack:** TypeScript · Node ≥ 22 · npm package

---

## Table of Contents

1. [Product Overview](#1-product-overview)
2. [Competitive Landscape](#2-competitive-landscape)
3. [Architecture](#3-architecture)
4. [Functional Requirements](#4-functional-requirements)
5. [Non-Functional Requirements](#5-non-functional-requirements)
6. [CLI Reference](#6-cli-reference)
7. [Default Policy](#7-default-policy)
8. [Out of Scope for v0.1](#8-out-of-scope-for-v01)
9. [Success Metrics](#9-success-metrics)
10. [Open Questions](#10-open-questions)
11. [Glossary](#11-glossary)

---

## 1. Product Overview

AgentWall is a developer tool that sits between local AI agents and the host machine. When an agent proposes an action — running a shell command, deleting a file, calling an external API — AgentWall intercepts it, checks it against a set of rules, and decides whether to allow it automatically, block it outright, or pause and ask the developer for approval. Every decision is logged so the developer can review exactly what the agent did and why it was permitted or blocked.

AgentWall works across multiple agent runtimes — OpenClaw, Claude Code, Cursor, and others — from a single policy file and a single audit trail. This cross-runtime unification is the primary value proposition.

> **One-line description:** AgentWall is the unified approval layer and audit trail across all your local AI agents.

### 1.1 The Problem

AI agents that can use tools are genuinely useful. They are also genuinely risky. A single bad decision — from a vague prompt, poor model reasoning, or a hostile instruction injected into external content — can cause real damage before the developer notices:

- An agent asked to clean up a project deletes configuration files the developer meant to keep.
- An agent running tests issues shell commands that reach outside the project directory.
- An agent browsing the web reads a page with hidden instructions and attempts to read SSH keys.
- After a long run, the developer has no record of what the agent actually tried to do or why.

Each agent runtime has its own partial solution to this problem. But none of them solve it completely, and none of them work across runtimes. Developers who use Claude Code and Cursor on the same machine today maintain two separate, incompatible permission systems with no shared policy and no unified audit trail.

### 1.2 What Existing Tools Already Do

Understanding what is already built is essential for understanding where AgentWall adds value and where it does not.

**Claude Code** has allow/deny rules in `settings.json`, PreToolUse hooks that can approve or deny tool calls programmatically via exit code, and four permission modes (normal, auto-accept, plan, bypass). It also ships OS-level sandboxing built on Linux bubblewrap and macOS Seatbelt that enforces filesystem and network isolation at the kernel level and reduces permission prompts by 84% in Anthropic's internal usage.

**Cursor** requires explicit user approval for every terminal command by default, requires explicit approval for every external MCP tool call, and supports `beforeMCPExecution` hooks in `~/.cursor/hooks.json` for custom interception logic. Cursor explicitly documents that its allowlist feature is not a security control — bypasses are possible.

**OpenClaw** has a tool policy system with allow/deny/ask rules per tool type, a Docker sandbox for non-main sessions, and a built-in exec approval protocol over WebSocket that external clients can participate in without modifying OpenClaw's source code.

### 1.3 The Three Gaps AgentWall Fills

**Gap 1 — No cross-runtime unified policy.** Claude Code's `settings.json` only works for Claude Code. Cursor's allowlist only works in Cursor. OpenClaw's tool policy only works in OpenClaw. Developers who use multiple agents maintain multiple separate, incompatible policy systems. AgentWall provides one policy file that enforces the same rules across every connected runtime simultaneously.

**Gap 2 — No structured cross-runtime audit trail.** Cursor explicitly documents that it provides limited visibility into what an agent has executed during a session. Claude Code's hooks produce whatever logging the developer writes manually. OpenClaw has session transcripts but they are per-agent and not structured for audit replay. No runtime provides a unified, structured, replayable log covering all agent activity across all runtimes. AgentWall does.

**Gap 3 — Known reliability problems in existing systems.** Claude Code's deny rules for Read and Write operations have documented bugs as of February 2026, with regressions reported in v2.0.56 and still unresolved. Cursor's allowlist is explicitly not a security control. AgentWall's policy evaluation is implemented once, tested independently, and applies consistently regardless of which runtime is in use.

### 1.4 What AgentWall Does Not Try to Replace

AgentWall does not try to out-sandbox Anthropic's bubblewrap/Seatbelt implementation or OpenClaw's Docker isolation. OS-level sandboxing enforces rules at the kernel level — AgentWall cannot match that. Developers should use both: runtime-native sandboxing for hard OS-level enforcement, and AgentWall for unified policy, structured logging, and cross-runtime consistency.

### 1.5 Target Users

**Primary:** A developer who uses one or more local AI agents — Claude Code, Cursor, OpenClaw, or any MCP-compatible agent — and wants a single place to define what those agents are allowed to do, with a replayable record of everything that happened. They are comfortable with the terminal, familiar with YAML, and willing to install an npm package.

**Secondary:** A team that wants consistent agent safety policies enforced across all developers' machines, with a shared policy file checked into source control.

### 1.6 Goals for v0.1

1. A developer can install AgentWall with a single npm command and have it running in under five minutes.
2. AgentWall intercepts exec tool calls from OpenClaw using its native WebSocket exec approval protocol.
3. AgentWall intercepts tool calls from Claude Code using PreToolUse hooks.
4. Developers define allow, deny, and ask rules in a single plain YAML file that applies across all connected runtimes.
5. When an action requires approval, the developer sees a clear terminal prompt and can approve or block with a single keypress.
6. Every action and every decision — regardless of which runtime produced it — is written to a single log file. The developer can replay the session at any time.
7. AgentWall adds no measurable latency to low-risk actions that pass policy automatically.

### 1.7 Non-Goals for v0.1

- AgentWall does not intercept file read or write operations in v0.1. Only shell exec calls are covered.
- AgentWall does not replace runtime-native OS-level sandboxing.
- AgentWall does not support Cursor in v0.1. Cursor's hook system is targeted for v0.2.
- AgentWall does not provide a web or graphical interface.
- AgentWall does not provide team-level shared policy management in v0.1.
- AgentWall does not support hot reload of the policy file.

---

## 2. Competitive Landscape

| Capability | Claude Code | Cursor | OpenClaw | AgentWall |
|---|---|---|---|---|
| Per-action approval prompt | Yes (built-in) | Yes (built-in) | Yes (built-in) | Yes — unified across runtimes |
| Allow/deny rules | Yes (settings.json) | Partial (not a security control) | Yes (tool policy) | Yes — single YAML for all runtimes |
| OS-level sandbox | Yes (bubblewrap/Seatbelt) | No | Yes (Docker) | No — out of scope, use native |
| PreToolUse / hook support | Yes | Yes | No | Implements the hook |
| Structured audit log | No | No | Partial (transcripts) | Yes — primary feature |
| Cross-runtime unified policy | No | No | No | Yes — primary feature |
| Replayable session log | No | No | No | Yes — primary feature |
| Known reliability issues | Deny rules buggy (Feb 2026) | Allowlist not a security control | None documented | None yet |

---

## 3. Architecture

### 3.1 Layered Design

AgentWall is designed in three layers so that runtime-specific adapters can be added without changing the core logic.

| Layer | Responsibility |
|---|---|
| **Core** | Policy engine, approval UI, event logger. Runtime-agnostic. Contains all business logic. |
| **Adapter** | Connects a specific agent runtime to the core. Each runtime gets its own adapter. |
| **Runtime** | The agent itself. AgentWall does not modify the runtime. |

The core has zero knowledge of any runtime. It receives a normalised `ActionProposal` object and returns a `Decision`. Every adapter translates between its runtime's native format and this common type.

### 3.2 Adapter Strategy Per Runtime

Different runtimes have fundamentally different integration points. AgentWall uses the right mechanism for each.

| Runtime | Mechanism | How it works | Version |
|---|---|---|---|
| **OpenClaw** | WebSocket exec approval protocol | AgentWall connects as an operator client, listens for `exec.approval.requested`, resolves via `exec.approval.resolve` | v0.1 |
| **Claude Code** | PreToolUse hook script | AgentWall registers a hook that Claude Code calls before every tool use. Hook exits 0 (allow) or non-zero (deny) | v0.1 |
| **Cursor** | `beforeMCPExecution` hook | AgentWall registers in `~/.cursor/hooks.json`. Same hook pattern as Claude Code | v0.2 |
| **Any MCP agent** | MCP proxy server | AgentWall runs as an MCP server, proxies all tool calls through the policy engine before forwarding to real MCP servers | v0.2 |
| **Aider / non-MCP** | Shell shim (Rust) | AgentWall replaces bash/sh with a shim binary that intercepts all subprocess calls | v0.3 |

### 3.3 Versioned Roadmap

| Version | Adapters shipped | What is covered |
|---|---|---|
| **v0.1** | OpenClaw (WebSocket) · Claude Code (PreToolUse hook) | Shell exec from OpenClaw and Claude Code |
| **v0.2** | + Cursor (hook) · + MCP proxy | All MCP tool calls from any MCP-compatible agent |
| **v0.3** | + Shell shim (Rust) | Direct subprocess calls from any agent that does not use MCP |

---

## 4. Functional Requirements

### 4.1 Installation and Setup

**FR-01** The developer installs AgentWall globally with a single command: `npm install -g agentwall`. No other dependencies need to be installed manually.

**FR-02** Running `agentwall init` creates a default policy file at `~/.agentwall/policy.yaml` and a log directory at `~/.agentwall/`. If they already exist, the command does not overwrite them.

**FR-03** Running `agentwall setup openclaw` prints step-by-step instructions for enabling exec approval mode in OpenClaw, including the exact JSON to add to `~/.openclaw/openclaw.json`.

**FR-04** Running `agentwall setup claude-code` prints step-by-step instructions for registering AgentWall as a PreToolUse hook in Claude Code, including the exact JSON to add to `.claude/settings.json`.

**FR-05** Running `agentwall start` starts all adapters that have been configured and prints a status line for each one showing whether it connected successfully.

**FR-06** Each adapter reconnects automatically if its runtime connection drops, with a short delay between attempts. The developer is notified when a connection drops and when it is restored.

### 4.2 Action Interception

**FR-07** AgentWall intercepts every exec approval request from OpenClaw before it executes. No exec action proposed by OpenClaw proceeds without passing through AgentWall's policy evaluation.

**FR-08** AgentWall intercepts every tool call that Claude Code proposes via the PreToolUse hook. Claude Code waits for the hook to exit before executing the tool. The hook exits 0 to allow and non-zero to deny.

**FR-09** Each intercepted action is evaluated against the policy before any response is returned to the runtime.

**FR-10** If the policy produces deny, AgentWall responds with deny immediately. The action does not execute. No prompt is shown.

**FR-11** If the policy produces allow, AgentWall responds with allow immediately. No prompt is shown.

**FR-12** If the policy produces ask, AgentWall shows an approval prompt. The action does not execute until the developer responds.

**FR-13** If the developer does not respond within the timeout period (default 5 minutes), the action is automatically denied. The runtime is notified and the timeout is logged.

### 4.3 Policy Engine

**FR-14** The policy is defined in a single YAML file at `~/.agentwall/policy.yaml`. The same policy applies to all connected runtimes simultaneously.

**FR-15** The policy supports three rule types: `deny`, `allow`, and `ask`. Evaluation order: deny first, then allow, then ask. Unmatched actions default to ask.

**FR-16** Each rule can match on a command pattern, a path pattern, or a tool name. Any combination can appear in a single rule. If multiple fields are specified in one rule, all must match (AND logic).

**FR-17** Command and path patterns support `~` home directory expansion and `*` / `**` glob wildcards.

**FR-18** The special path value `outside:workspace` matches any action whose working directory is outside the directory where AgentWall was started.

**FR-19** The default policy created by `agentwall init` must deny access to `~/.ssh`, `~/.aws`, and `~/.openclaw/credentials` without any editing required.

**FR-20** The policy is validated at startup. If it contains a syntax error or unknown keys, AgentWall prints a clear message identifying the problem and exits with code 1.

**FR-21** The policy is loaded once at startup. Changes take effect on the next AgentWall start.

### 4.4 Approval Prompt

**FR-22** The approval prompt shows: the full command or tool name, the runtime that proposed it, the working directory if available, and the reason it was flagged.

**FR-23** The prompt offers three choices: `y` (allow once), `n` (deny), `a` (always allow this command type for the session).

**FR-24** The `always` option is session-only and is not written to the policy file.

**FR-25** The prompt uses colour: green for allow, red for deny, yellow for ask. All output must also be readable without colour.

### 4.5 Event Logging

**FR-26** AgentWall writes one log entry per intercepted action to `~/.agentwall/session-YYYY-MM-DD.jsonl`.

**FR-27** Each entry contains: timestamp, runtime name, command or tool name, working directory, policy decision, how it was resolved (policy or user), and any runtime-specific IDs.

**FR-28** Log files are append-only. AgentWall never deletes or overwrites log entries.

**FR-29** The log directory and files are created automatically on first run.

### 4.6 Replay Command

**FR-30** Running `agentwall replay` prints the last 50 entries from the most recent session log in a human-readable table.

**FR-31** Running `agentwall replay N` shows the last N entries.

**FR-32** Each row shows: time, runtime, decision (ALLOW / DENY / ASK), resolved by (policy or user), command or tool name (truncated if long).

**FR-33** The replay output uses the same colour scheme as the approval prompt.

---

## 5. Non-Functional Requirements

### 5.1 Performance

**NFR-01** Policy evaluation must complete in under 10 milliseconds for any action from any runtime.

**NFR-02** Auto-allow and auto-deny decisions must be returned to the runtime in under 50 milliseconds end-to-end.

**NFR-03** The Claude Code PreToolUse hook — including Node.js process startup and policy evaluation — must complete in under 20 milliseconds for auto-allow actions. If this target cannot be met with a full Node process per hook call, a lightweight daemon + IPC architecture must be used instead.

### 5.2 Reliability

**NFR-04** If AgentWall loses its connection to OpenClaw, it reconnects automatically and notifies the developer.

**NFR-05** If the Claude Code hook process fails or exits with an error, Claude Code falls back to its native permission behaviour. AgentWall's hook must never crash in a way that blocks Claude Code from operating.

**NFR-06** If AgentWall is stopped, all runtimes continue with their own native permission systems. AgentWall is not a required dependency of any runtime.

**NFR-07** Log write failures must not crash AgentWall. A warning is printed and operation continues.

### 5.3 Usability

**NFR-08** All terminal output must be readable without colour support.

**NFR-09** All error messages must suggest a concrete next step.

**NFR-10** The `agentwall setup <runtime>` output must be fully self-contained — the developer should not need to visit external documentation to complete the setup.

### 5.4 Distribution

**NFR-11** Published as the npm package `agentwall`. Installs cleanly on Node 22+ on macOS and Linux.

**NFR-12** Exposes a single CLI binary named `agentwall`.

**NFR-13** No native compiled dependencies. All runtime dependencies are pure JavaScript or TypeScript.

---

## 6. CLI Reference

### Commands

| Command | Description |
|---|---|
| `agentwall start` | Start all configured adapters. Runs in the foreground. Ctrl-C stops cleanly. |
| `agentwall init` | Write the default policy.yaml and create the log directory. |
| `agentwall setup openclaw` | Print OpenClaw setup instructions. |
| `agentwall setup claude-code` | Print Claude Code PreToolUse hook setup instructions. |
| `agentwall setup cursor` | Print Cursor hook setup instructions (v0.2). |
| `agentwall replay [N]` | Print the last N entries from the most recent session log. Default 50. |
| `agentwall status` | Show which adapters are currently connected and active. |
| `agentwall --help` | Print usage information. |

### Flags for `agentwall start`

| Flag | Description |
|---|---|
| `--token <token>` | OpenClaw gateway auth token. Can also be set via `OPENCLAW_GATEWAY_TOKEN`. |
| `--gateway <url>` | OpenClaw gateway WebSocket URL. Defaults to `ws://127.0.0.1:18789`. |
| `--only <runtime>` | Start only the named adapter. Useful for debugging. |
| `--verbose` | Print debug-level output. |

---

## 7. Default Policy

```yaml
# AgentWall policy
# Applies to all connected runtimes (OpenClaw, Claude Code, Cursor, MCP agents)
# Evaluation order: deny → allow → ask
# Unmatched actions default to: ask

deny:
  - path: ~/.ssh/**
  - path: ~/.aws/**
  - path: ~/.openclaw/credentials/**
  - path: ~/.gnupg/**
  - command: "rm -rf /"
  - command: "curl * | bash"
  - command: "wget * | bash"

ask:
  - command: "rm -rf*"
  - command: "rm -r *"
  - command: "sudo *"
  - command: "chmod -R *"
  - command: "dd *"
  - path: "outside:workspace"

allow:
  - path: "workspace/**"
```

---

## 8. Out of Scope for v0.1

- File read and write interception (requires MCP proxy — v0.2).
- Network and browser action interception (v0.2).
- Cursor adapter (v0.2).
- MCP proxy adapter (v0.2).
- Shell shim for non-MCP agents such as Aider (v0.3, written in Rust).
- Web or graphical UI.
- Hot reload of the policy file.
- Persisting the session `always` choice across restarts.
- Team-level shared policy management.
- Multi-machine or remote agent support.

---

## 9. Success Metrics

| Metric | Target |
|---|---|
| GitHub stars in first 30 days | 500+ |
| npm downloads in first 30 days | 1,000+ |
| Time from install to first interception | Under 5 minutes |
| Policy evaluation latency | Under 10ms |
| Claude Code hook latency (auto-allow) | Under 20ms |
| End-to-end latency for auto decisions | Under 50ms |
| Runtimes supported at launch | 2 (OpenClaw + Claude Code) |

---

## 10. Open Questions

1. **Claude Code hook startup latency.** The PreToolUse hook is a process Claude Code spawns per tool call. If Node.js module loading makes this too slow, AgentWall may need a daemon-plus-IPC architecture where a long-running daemon handles policy evaluation and the hook script is a lightweight IPC client. This needs to be measured before committing to the architecture.

2. **Claude Code hook JSON protocol.** The exact stdin/stdout format Claude Code uses for PreToolUse hooks needs to be confirmed against Claude Code's documentation before implementation. The hook must parse this correctly or it will silently mis-parse tool call details and make wrong decisions.

3. **Multiple AgentWall instances.** If a developer runs `agentwall start` in two terminals, both instances receive the same events. A lock file prevents this for the common case, but the correct UX for intentional multi-runtime setups needs to be defined.

4. **Unconfigured runtime detection.** If a runtime is running but AgentWall has not been configured as its hook, AgentWall cannot detect this. The `agentwall status` command should surface unconfigured runtimes clearly, but the detection mechanism needs to be designed.

5. **Log rotation.** For v0.1 logs accumulate indefinitely. A simple rotation or pruning policy should be added before shipping — the question is whether it is automatic or documented as a manual step.

---

## 11. Glossary

| Term | Definition |
|---|---|
| **Adapter** | A runtime-specific module that connects a particular agent (OpenClaw, Claude Code, etc.) to AgentWall's core. |
| **ActionProposal** | The normalised type that every adapter produces and passes to the core. Contains command or tool name, working directory, runtime name, and runtime-specific IDs. |
| **Exec approval protocol** | OpenClaw's built-in WebSocket mechanism for pausing a shell command and asking a connected client to allow or deny it. |
| **MCP (Model Context Protocol)** | An open standard for connecting AI agents to tools. The basis for the v0.2 generic proxy adapter. |
| **Policy engine** | The component that evaluates an ActionProposal against policy.yaml and returns allow, deny, or ask. |
| **PreToolUse hook** | A Claude Code feature that runs a script before every tool call. The script's exit code determines whether the tool call proceeds. |
| **Shell shim** | A replacement binary for bash or sh that intercepts subprocess calls. Planned for v0.3 in Rust. |
| **Workspace** | The directory from which AgentWall is started. The reference point for the `outside:workspace` path rule. |