# AgentWall

> AgentWall is the approval layer and audit trail between your AI agent and your machine.

AgentWall intercepts shell commands proposed by AI agents before they execute,
evaluates them against a configurable policy, and either allows them
automatically, blocks them, or asks you for approval. Every decision is logged
to a JSONL file for audit and replay.

## Install

```bash
npm install -g agentwall
```

Requires Node.js ≥ 22.

## Prerequisites

Enable exec approval mode in OpenClaw by adding this to
`~/.openclaw/openclaw.json`:

```json
{
  "tools": {
    "exec": {
      "security": "ask"
    }
  }
}
```

Then restart the gateway:

```bash
openclaw gateway stop
openclaw gateway
```

## Quick Start

```bash
# Create default policy at ~/.agentwall/policy.yaml
agentwall init

# Start listening (token from OpenClaw gateway)
agentwall start --token <your-gateway-token>

# View the session audit log
agentwall replay
```

## Policy

AgentWall evaluates rules in order: **deny → allow → ask**.
Unmatched actions default to **ask** (never silently allow unknowns).

Edit `~/.agentwall/policy.yaml`:

```yaml
# Evaluation order: deny → allow → ask
# Unmatched actions default to: ask

deny:
  - path: ~/.ssh/**            # never allow access to SSH keys
  - path: ~/.aws/**            # protect AWS credentials
  - command: "rm -rf /"        # prevent catastrophic deletions
  - command: "curl * | bash"   # block pipe-to-shell attacks

ask:
  - command: "rm -rf*"         # prompt before recursive force-delete
  - command: "sudo *"          # prompt before privilege escalation
  - path: "outside:workspace"  # prompt for actions outside project

allow:
  - path: "workspace/**"      # auto-allow within project directory
```

Rules support glob patterns (`*` matches any characters except `/`, `**`
matches anything including `/`) and the special `outside:workspace` path value.

## How It Works

AgentWall connects to the OpenClaw gateway's WebSocket exec approval protocol.
When an AI agent proposes a shell command, OpenClaw routes the approval request
to AgentWall, which evaluates it against your policy and either auto-resolves or
prompts you in the terminal. No changes to OpenClaw's source code are required —
AgentWall uses the standard operator approval API.

## Scope

Currently intercepts shell exec via OpenClaw. File/network interception and
additional runtime adapters (Claude Code, Cursor, MCP proxy) are planned.

## License

MIT
