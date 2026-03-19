# AgentWall — Product Requirements Document

**Version:** 0.1 — MVP (OpenClaw adapter)
**Status:** Draft
**Date:** March 2026
**Tech Stack:** TypeScript · Node ≥ 22 · npm package

---

## Table of Contents

1. [Product Overview](#1-product-overview)
2. [Architecture](#2-architecture)
3. [Functional Requirements](#3-functional-requirements)
4. [Non-Functional Requirements](#4-non-functional-requirements)
5. [CLI Reference](#5-cli-reference)
6. [Default Policy](#6-default-policy)
7. [Out of Scope for v0.1](#7-out-of-scope-for-v01)
8. [Success Metrics](#8-success-metrics)
9. [Open Questions](#9-open-questions)
10. [Glossary](#10-glossary)

---

## 1. Product Overview

AgentWall is a developer tool that sits between a local AI agent and the host machine. When the agent proposes an action — running a shell command, deleting a file, calling an external API — AgentWall intercepts it, checks it against a set of rules, and decides whether to allow it automatically, block it outright, or pause and ask the developer for approval. Every decision is logged so the developer can review exactly what the agent did and why it was permitted or blocked.

> **One-line description:** AgentWall is the approval layer and audit trail between your AI agent and your machine.

### 1.1 The Problem

AI agents that can use tools are genuinely useful. They are also genuinely risky. A single bad decision — from a vague prompt, poor model reasoning, or a hostile instruction injected into external content — can cause real damage before the developer notices:

- An agent asked to clean up a project deletes configuration files the developer meant to keep.
- An agent running tests issues shell commands that reach outside the project directory.
- An agent browsing the web reads a page with hidden instructions and attempts to read SSH keys.
- After a long run, the developer has no record of what the agent actually tried to do.

Existing mitigations do not fully solve this. Docker containers restrict the environment but do not reason about individual commands. Model alignment reduces bad behaviour in general but does not prevent poor decisions in specific local contexts. OpenClaw's built-in tool policy is config-driven and static — it cannot ask the developer a question mid-run or log a structured audit trail.

> **The gap AgentWall fills:** There is no developer-friendly layer that intercepts individual agent actions at runtime, applies explicit rules, asks for approval when needed, and keeps a full record. AgentWall is that layer.

### 1.2 Target Users

**Primary (v0.1):** A developer who runs OpenClaw on their own machine and wants more confidence that the agent will not do something unintended. They are comfortable with the terminal, familiar with YAML, and willing to install an npm package.

**Secondary (v0.2+):** Any developer running a local AI agent — Claude Code, Aider, or a custom agent — who wants the same interception and audit capability regardless of which runtime they use.

### 1.3 Goals for v0.1

1. A developer can install AgentWall with a single npm command and have it running in under five minutes.
2. AgentWall intercepts every exec tool call that OpenClaw's agent proposes before it executes.
3. Developers can define allow, deny, and ask rules in a plain YAML file with no programming required.
4. When an action requires approval, the developer sees a clear terminal prompt and can approve or block with a single keypress.
5. Every action and every decision is written to a log file. The developer can replay the session at any time.
6. AgentWall introduces no measurable friction for low-risk actions that pass policy automatically.

### 1.4 Non-Goals for v0.1

- AgentWall does not intercept file read or write operations. Only shell exec calls are covered.
- AgentWall does not provide a web or graphical interface. Everything is terminal-based.
- AgentWall does not replace OpenClaw's sandbox or Docker isolation. It complements them.
- AgentWall does not guarantee that all agent actions are intercepted if OpenClaw's exec approval mode is not enabled.
- AgentWall does not support runtimes other than OpenClaw in v0.1.

---

## 2. Architecture

### 2.1 Layered Design

AgentWall is designed in three layers so that runtime-specific adapters can be added without changing the core logic. This is the foundation for the v0.2 MCP proxy adapter and the v0.3 shell shim.

| Layer | Responsibility |
|---|---|
| **Core** | Policy engine, approval UI, event logger. Runtime-agnostic. Contains all business logic. |
| **Adapter** | Connects a specific agent runtime to the core. v0.1 ships one adapter: OpenClaw. |
| **Runtime** | The agent itself (OpenClaw, Claude Code, Aider, etc.). AgentWall does not modify the runtime. |

### 2.2 How it Works with OpenClaw (v0.1)

OpenClaw's gateway exposes a WebSocket API on localhost port 18789. When the agent proposes a shell command and exec approval mode is enabled in OpenClaw's config, the gateway broadcasts an `exec.approval.requested` event. Any connected client with the `operator.approvals` scope can respond by calling `exec.approval.resolve` to allow or deny the command.

AgentWall connects to this WebSocket as a standard operator client. It requires no changes to OpenClaw's source code and uses a documented, public protocol.

> **Important prerequisite:** The developer must enable exec approval mode in OpenClaw before starting AgentWall. This requires adding one setting to `~/.openclaw/openclaw.json` and restarting the gateway. AgentWall detects if this is not set and prints a clear warning.

### 2.3 Scope of Interception in v0.1

| Action type | Intercepted in v0.1 | Planned version |
|---|---|---|
| Shell exec (bash, run, process tools) | Yes | v0.1 |
| File read / write | No | v0.2 (MCP adapter) |
| Network / browser | No | v0.2 (MCP adapter) |
| Non-MCP custom tools | No | v0.3 (shell shim) |

### 2.4 Roadmap

| Version | Adapter | What it adds |
|---|---|---|
| **v0.1** | OpenClaw (WebSocket) | Exec interception, policy engine, approval prompt, session log, replay command. |
| **v0.2** | MCP proxy | Intercepts any tool call from any MCP-compatible agent (Claude Code, Cursor, etc.). Covers file, network, and custom tools. |
| **v0.3** | Shell shim | Compiled binary that replaces bash/sh. Intercepts subprocess calls for agents that do not use MCP. Written in Rust for this component only. |

The MCP adapter in v0.2 is the primary generic story. MCP is becoming the standard tool interface across agent runtimes. An AgentWall MCP proxy server sits between the agent's MCP client and any MCP tool server, intercepting every tool call regardless of which agent runtime is in use.

---

## 3. Functional Requirements

### 3.1 Installation and Setup

**FR-01** The developer installs AgentWall globally with a single command: `npm install -g agentwall`. No other dependencies need to be installed manually.

**FR-02** Running `agentwall init` creates a default policy file at `~/.agentwall/policy.yaml` and a log directory at `~/.agentwall/`. If the directory or file already exists, the command does not overwrite them.

**FR-03** Running `agentwall setup` prints step-by-step instructions for enabling exec approval mode in OpenClaw, including the exact JSON to add to the OpenClaw config file.

**FR-04** Running `agentwall start` connects to the OpenClaw gateway and prints a clear status message confirming the connection. If the connection fails, it prints a helpful error message that diagnoses the most likely cause (gateway not running, token mismatch, exec approval mode not enabled).

**FR-05** AgentWall automatically reconnects if the gateway connection drops, with a short delay between attempts. It prints a message each time it reconnects.

### 3.2 Action Interception

**FR-06** AgentWall intercepts every exec approval request that OpenClaw's gateway broadcasts. No exec action proposed by the agent executes without first passing through AgentWall's policy evaluation.

**FR-07** Each intercepted action is evaluated against the loaded policy before any response is sent to the gateway. The evaluation completes before the approval or denial is returned.

**FR-08** If the policy produces a deny decision, AgentWall immediately resolves the approval as denied. The action does not execute. No user prompt is shown.

**FR-09** If the policy produces an allow decision, AgentWall immediately resolves the approval as allowed. The action executes. No user prompt is shown.

**FR-10** If the policy produces an ask decision, AgentWall pauses and shows an approval prompt in the terminal. The action does not execute until the developer responds.

**FR-11** The approval response is sent to the gateway within a reasonable timeout even if the developer does not respond. The default timeout behaviour is to deny the action. This prevents the agent from hanging indefinitely.

### 3.3 Policy Engine

**FR-12** The policy is defined in a YAML file at `~/.agentwall/policy.yaml`. The file uses plain English-style keys and does not require any programming knowledge to edit.

**FR-13** The policy file supports three rule types: `deny` (always blocked), `allow` (always permitted without prompting), and `ask` (developer is prompted). Rules are evaluated in the order: deny first, then allow, then ask.

**FR-14** Each rule can match on a command pattern (the shell command string) or a path pattern (the working directory or file path of the action). Both can be specified in the same rule.

**FR-15** Command patterns support wildcard matching. For example, `rm -rf*` matches any command starting with `rm -rf`.

**FR-16** Path patterns support home directory expansion (`~` resolves to the user's home directory) and glob wildcards. For example, `~/.ssh/**` matches any path inside the `.ssh` directory.

**FR-17** A special path value `outside:workspace` matches any action whose working directory is outside the directory where AgentWall was started.

**FR-18** If an action does not match any rule, the default behaviour is `ask`. Unknown actions are never silently allowed.

**FR-19** The default policy file created by `agentwall init` must include sensible defaults that protect the most sensitive locations on a developer machine without any editing. At minimum, defaults must deny access to `~/.ssh`, `~/.aws`, and `~/.openclaw/credentials`.

**FR-20** The policy file is loaded once when AgentWall starts. Changes to the file take effect on the next AgentWall start. There is no hot reload in v0.1.

### 3.4 Approval Prompt

**FR-21** When an action requires approval, AgentWall displays a prompt in the terminal showing the full command string, the working directory if available, and the reason the action was flagged.

**FR-22** The prompt offers three choices: `y` to allow this action once, `n` to deny this action, and `a` to always allow this command type for the rest of the session without prompting again.

**FR-23** The `always` option applies to the command's base executable for the remainder of the session. For example, selecting `always` for `git status` means subsequent `git` commands in the same session are automatically allowed. This setting is not persisted to the policy file — it only lasts until AgentWall is stopped.

**FR-24** The prompt uses colour to make the decision visually clear: allow decisions are shown in green, deny decisions in red, and ask prompts in yellow.

**FR-25** The prompt must not interfere with other terminal output. It renders cleanly whether the developer is watching the terminal or returns to it later.

### 3.5 Event Logging

**FR-26** AgentWall writes a log entry for every intercepted action to `~/.agentwall/session-YYYY-MM-DD.jsonl`. A new file is created each day.

**FR-27** Each log entry is a single JSON object on one line containing: timestamp, full command string, working directory (if available), policy decision (allow / deny / ask), how it was resolved (policy or user), the approval ID from the gateway, and the session ID if available.

**FR-28** Log files are append-only. AgentWall never overwrites or deletes existing log entries.

**FR-29** The log directory and files are created automatically on first run. No manual setup is needed.

### 3.6 Replay Command

**FR-30** Running `agentwall replay` prints the most recent session log in a human-readable table in the terminal. The default view shows the last 50 entries.

**FR-31** Running `agentwall replay N` (where N is a number) shows the last N entries.

**FR-32** Each row in the replay output shows: time of the action, decision (ALLOW / DENY / ASK), how it was resolved (policy or user), and the command string. Long commands are truncated with an ellipsis.

**FR-33** The replay output uses colour consistent with the approval prompt: green for allow, red for deny, yellow for ask.

---

## 4. Non-Functional Requirements

### 4.1 Performance

**NFR-01** Policy evaluation must complete in under 10 milliseconds for any action. The policy engine must never be the bottleneck.

**NFR-02** Automatically allowed or denied actions (no user prompt required) must be resolved and sent back to the gateway in under 50 milliseconds end-to-end. This ensures AgentWall adds no perceptible delay to low-risk actions.

### 4.2 Reliability

**NFR-03** If AgentWall loses its connection to the OpenClaw gateway, it must attempt to reconnect automatically. During the reconnection window, the developer must be clearly informed that AgentWall is not intercepting actions.

**NFR-04** If AgentWall crashes or is stopped, OpenClaw continues to operate normally. AgentWall is not a required dependency of OpenClaw — its absence does not break the agent.

**NFR-05** Log writes must not fail silently. If a log entry cannot be written, AgentWall prints a warning to the terminal but continues operating.

### 4.3 Usability

**NFR-06** All terminal output must be readable without colour. Colour is additive, not structural.

**NFR-07** All error messages must suggest a concrete next step. AgentWall never prints a bare error code without an explanation.

**NFR-08** The policy YAML syntax must be validated at startup. If the file contains a syntax error, AgentWall prints a clear message identifying the problem and exits rather than running with a broken policy.

### 4.4 Distribution

**NFR-09** AgentWall is published as an npm package under the name `agentwall`. It must install cleanly with `npm install -g agentwall` on Node 22 or later on macOS and Linux.

**NFR-10** The installed package exposes a single CLI binary named `agentwall`. No other global binaries are installed.

**NFR-11** The package must have no native compiled dependencies. All dependencies must be pure JavaScript or TypeScript so that installation does not require a C/C++ build toolchain.

---

## 5. CLI Reference

### Commands

| Command | Description |
|---|---|
| `agentwall start` | Connect to the OpenClaw gateway and begin intercepting exec approvals. Runs in the foreground. Ctrl-C stops it cleanly. |
| `agentwall init` | Write the default policy.yaml to `~/.agentwall/` and create the log directory. Safe to run multiple times. |
| `agentwall setup` | Print instructions for enabling exec approval mode in OpenClaw. |
| `agentwall replay [N]` | Print the last N entries from the most recent session log. Default N is 50. |
| `agentwall --help` | Print usage information. |

### Flags for `agentwall start`

| Flag | Description |
|---|---|
| `--token <token>` | Gateway auth token. Can also be set via the `OPENCLAW_GATEWAY_TOKEN` environment variable. |
| `--gateway <url>` | WebSocket URL for the OpenClaw gateway. Defaults to `ws://127.0.0.1:18789`. |
| `--verbose` | Print debug-level information including raw WebSocket messages. |

---

## 6. Default Policy

The following rules are written to `policy.yaml` when the developer runs `agentwall init`. They are designed to be safe and useful out of the box without any editing.

```yaml
# AgentWall policy — allow / ask / deny rules
# Rules are evaluated: deny → allow → ask
# Unmatched exec actions default to: ask

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

## 7. Out of Scope for v0.1

The following are explicitly deferred to future versions:

- File read and write interception. Requires the MCP proxy adapter (v0.2) or changes to OpenClaw's tool approval protocol.
- Network and browser action interception.
- A web UI or graphical dashboard.
- Hot reload of the policy file without restarting AgentWall.
- Policy rules that persist the `always` choice across sessions.
- Support for agent runtimes other than OpenClaw.
- Multi-machine or remote agent support.
- Enterprise policy management, shared policies, or team policy packs.

---

## 8. Success Metrics

| Metric | Target |
|---|---|
| GitHub stars in first 30 days | 500+ |
| npm downloads in first 30 days | 1,000+ |
| Time from install to first interception | Under 5 minutes |
| Policy evaluation latency | Under 10ms |
| End-to-end latency for auto decisions | Under 50ms |

---

## 9. Open Questions

1. **Multiple instances:** What happens if multiple AgentWall instances are connected to the same OpenClaw gateway simultaneously? Only one should respond to each approval request. The behaviour needs to be defined.

2. **Foreground vs daemon:** Should `agentwall start` daemonise and run in the background, or always run in the foreground? Foreground is simpler and more transparent for v0.1 but may be less convenient in practice.

3. **Policy comments:** YAML supports comments natively so the policy file should support them, but this should be confirmed with a test during implementation.

4. **Detection of missing exec approval mode:** What is the correct behaviour when OpenClaw is running but exec approval mode is not enabled? AgentWall should detect this and warn clearly, but the detection mechanism needs to be confirmed against the OpenClaw protocol.

5. **Log rotation:** Should the session log be pruned or rotated automatically? For v0.1 it may be simplest to let logs accumulate and document manual cleanup, but this should be decided before shipping.

---

## 10. Glossary

| Term | Definition |
|---|---|
| **Agent runtime** | The software that runs the AI agent and calls tools on its behalf. In v0.1 this is OpenClaw. |
| **Exec approval protocol** | OpenClaw's built-in mechanism for pausing a shell command and asking a connected client to allow or deny it before it executes. |
| **MCP (Model Context Protocol)** | An open standard for connecting AI agents to tools. Used by Claude Code, Cursor, and others. The basis for the v0.2 generic adapter. |
| **Policy engine** | The component that evaluates an intercepted action against the rules in `policy.yaml` and produces an allow, deny, or ask decision. |
| **Shell shim** | A replacement binary for bash or sh that intercepts subprocess calls. Planned for v0.3 to cover agents that do not use MCP. Written in Rust. |
| **Workspace** | The directory from which AgentWall is started. Used as the reference point for the `outside:workspace` path rule. |