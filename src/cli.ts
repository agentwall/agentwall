#!/usr/bin/env node

import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PolicyEngine } from "./core/policy.js";
import { EventLogger } from "./core/logger.js";
import { askUser, printDecision } from "./core/prompt.js";
import { OpenClawAdapter } from "./adapters/openclaw/client.js";
import type { ActionProposal, Decision, LogEntry } from "./core/types.js";

const VERSION = "0.1.0";
const AGENTWALL_DIR = join(homedir(), ".agentwall");
const LOCK_FILE = join(AGENTWALL_DIR, "agentwall.lock");

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

// -----------------------------------------------------------------------------
// Argument parsing
// -----------------------------------------------------------------------------

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        flags[key] = args[i + 1];
        i++;
      } else {
        flags[key] = "true";
      }
    }
  }
  return flags;
}

// -----------------------------------------------------------------------------
// Lock file
// -----------------------------------------------------------------------------

function acquireLock(): void {
  mkdirSync(AGENTWALL_DIR, { recursive: true });

  if (existsSync(LOCK_FILE)) {
    const pid = parseInt(readFileSync(LOCK_FILE, "utf-8").trim(), 10);
    if (!isNaN(pid)) {
      try {
        process.kill(pid, 0);
        process.stderr.write(
          `${RED}error:${RESET} AgentWall is already running (PID ${pid}).\n` +
          `  Stop it first, or remove ${LOCK_FILE} if the process is stale.\n`,
        );
        process.exit(1);
      } catch {
        // PID not running — stale lock, safe to overwrite
      }
    }
  }

  writeFileSync(LOCK_FILE, String(process.pid));
}

function releaseLock(): void {
  try {
    if (existsSync(LOCK_FILE)) unlinkSync(LOCK_FILE);
  } catch {
    // best-effort cleanup
  }
}

// -----------------------------------------------------------------------------
// Log entry builder
// -----------------------------------------------------------------------------

function buildLogEntry(
  proposal: ActionProposal,
  decision: Decision,
  resolvedBy: "policy" | "user",
): LogEntry {
  return {
    ts: new Date().toISOString(),
    runtime: proposal.runtime,
    decision,
    resolvedBy,
    command: proposal.command,
    workingDir: proposal.workingDir || "",
    approvalId: proposal.approvalId,
    sessionId: proposal.sessionId || "",
    agentId: proposal.agentId || "",
  };
}

// -----------------------------------------------------------------------------
// Commands
// -----------------------------------------------------------------------------

async function startCommand(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const token = flags.token || process.env.OPENCLAW_GATEWAY_TOKEN || "";
  const gatewayUrl = flags.gateway || "ws://127.0.0.1:18789";
  const verbose = flags.verbose === "true";

  if (!token) {
    process.stderr.write(
      `${RED}error:${RESET} No gateway token provided.\n` +
      `  Pass --token <token> or set OPENCLAW_GATEWAY_TOKEN.\n`,
    );
    process.exit(1);
  }

  acquireLock();
  process.on("SIGINT", () => {
    releaseLock();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    releaseLock();
    process.exit(0);
  });

  const policy = new PolicyEngine();
  const logger = new EventLogger();

  process.stderr.write(
    `\n  agentwall v${VERSION} — runtime safety layer for local AI agents\n`,
  );
  process.stderr.write(
    `  policy: ${policy.policyPath}${policy.usingDefaults ? " (defaults)" : ""}\n`,
  );

  const adapter = new OpenClawAdapter({ gatewayUrl, token, verbose });

  adapter.onProposal(async (proposal: ActionProposal) => {
    const decision = policy.evaluate(proposal);

    if (decision === "deny") {
      printDecision("deny", proposal.command, "policy rule matched");
      logger.log(buildLogEntry(proposal, "deny", "policy"));
      await adapter.resolve(proposal.approvalId, false);
    } else if (decision === "allow") {
      printDecision("allow", proposal.command, "auto-allow");
      logger.log(buildLogEntry(proposal, "allow", "policy"));
      await adapter.resolve(proposal.approvalId, true);
    } else {
      const userDecision = await askUser(proposal, "flagged as sensitive");
      if (userDecision === "allow") {
        printDecision("allow", proposal.command, "user approved");
        logger.log(buildLogEntry(proposal, "ask", "user"));
        await adapter.resolve(proposal.approvalId, true);
      } else {
        printDecision("deny", proposal.command, "user denied");
        logger.log(buildLogEntry(proposal, "deny", "user"));
        await adapter.resolve(proposal.approvalId, false);
      }
    }
  });

  try {
    await adapter.start();
    process.stderr.write(`  ${GREEN}✓${RESET} Connected to OpenClaw gateway\n`);
    process.stderr.write(
      `  ${GREEN}✓${RESET} Listening for exec approvals...\n\n`,
    );
  } catch (err) {
    releaseLock();
    logger.close();
    process.stderr.write(`${RED}error:${RESET} ${(err as Error).message}\n`);
    process.exit(1);
  }
}

function initCommand(): void {
  mkdirSync(AGENTWALL_DIR, { recursive: true });
  const policyPath = join(AGENTWALL_DIR, "policy.yaml");

  if (existsSync(policyPath)) {
    process.stderr.write(`  Policy already exists at ${policyPath}\n`);
    return;
  }

  writeFileSync(policyPath, PolicyEngine.defaultYaml());
  process.stderr.write(`  ${GREEN}✓${RESET} Created ${policyPath}\n`);
}

function setupCommand(runtime: string | undefined): void {
  if (runtime !== "openclaw") {
    process.stderr.write(
      `${RED}error:${RESET} Unknown runtime "${runtime || ""}".\n` +
      `  Available: openclaw\n`,
    );
    process.exit(1);
  }

  process.stdout.write(`
  OpenClaw setup

  Add this to ~/.openclaw/openclaw.json:

    {
      "tools": {
        "exec": {
          "security": "ask"
        }
      }
    }

  Then restart the OpenClaw gateway:

    openclaw gateway stop
    openclaw gateway

  Then start AgentWall in a separate terminal:

    agentwall start

`);
}

function replayCommand(n?: number): void {
  EventLogger.replay(n);
}

function statusCommand(): void {
  process.stdout.write(`\n  agentwall v${VERSION}\n\n`);

  const policyPath = join(AGENTWALL_DIR, "policy.yaml");
  if (existsSync(policyPath)) {
    process.stdout.write(`  policy:  ${policyPath}\n`);
  } else {
    process.stdout.write(`  policy:  not configured (using defaults)\n`);
  }

  if (existsSync(LOCK_FILE)) {
    const pid = parseInt(readFileSync(LOCK_FILE, "utf-8").trim(), 10);
    let running = false;
    if (!isNaN(pid)) {
      try {
        process.kill(pid, 0);
        running = true;
      } catch {
        // not running
      }
    }
    process.stdout.write(
      `  status:  ${running ? `${GREEN}running${RESET} (PID ${pid})` : `${DIM}not running (stale lock)${RESET}`}\n`,
    );
  } else {
    process.stdout.write(`  status:  ${DIM}not running${RESET}\n`);
  }

  process.stdout.write("\n");
}

function helpCommand(): void {
  process.stdout.write(`
  agentwall v${VERSION} — runtime safety layer for local AI agents

  Usage:
    agentwall start [--token <token>] [--gateway <url>] [--verbose]
    agentwall init
    agentwall setup openclaw
    agentwall replay [N]
    agentwall status
    agentwall --help

  Commands:
    start            Start all configured adapters
    init             Create ~/.agentwall/policy.yaml with default rules
    setup <runtime>  Print setup instructions for a runtime
    replay [N]       Show last N log entries (default 50)
    status           Show version and status

  Flags:
    --token <token>  OpenClaw gateway token (or set OPENCLAW_GATEWAY_TOKEN)
    --gateway <url>  Gateway WebSocket URL (default: ws://127.0.0.1:18789)
    --verbose        Enable debug output

`);
}

// -----------------------------------------------------------------------------
// Entry point
// -----------------------------------------------------------------------------

const command = process.argv[2];
const remaining = process.argv.slice(3);

(async () => {
  switch (command) {
    case "start":
      await startCommand(remaining);
      break;
    case "init":
      initCommand();
      break;
    case "setup":
      setupCommand(remaining[0]);
      break;
    case "replay":
      replayCommand(remaining[0] ? parseInt(remaining[0], 10) : undefined);
      break;
    case "status":
      statusCommand();
      break;
    case "--help":
    case "-h":
    case undefined:
      helpCommand();
      break;
    default:
      process.stderr.write(
        `${RED}error:${RESET} Unknown command "${command}".\n` +
        `  Run 'agentwall --help' for usage.\n`,
      );
      process.exit(1);
  }
})().catch((err) => {
  process.stderr.write(`${RED}error:${RESET} ${(err as Error).message}\n`);
  releaseLock();
  process.exit(1);
});
