#!/usr/bin/env node

import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  copyFileSync,
  readdirSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { join, basename, dirname } from "node:path";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline";
import yaml from "js-yaml";
import { PolicyEngine } from "./core/policy.js";
import { EventLogger } from "./core/logger.js";
import { askUser, printDecision } from "./core/prompt.js";
import { OpenClawAdapter } from "./adapters/openclaw/client.js";
import { startProxy } from "./adapters/mcp/proxy.js";
import { ApprovalQueue } from "./web/approval.js";
import { AgentWallWebServer } from "./web/server.js";
import { getTaintState, resetTaint } from "./taint/taint.js";
import type { ActionProposal, DecisionVerdict, DecisionReason, LogEntry } from "./core/types.js";
import {
  getSupportedClients,
  detectConfigs,
  isAlreadyWrapped,
  isHttpTransport,
  wrapServerEntry,
  backupFile,
  shortPath,
  countProtection,
  type DetectedConfig,
} from "./core/clients.js";

const VERSION = "0.9.0";
const AGENTWALL_DIR = join(homedir(), ".agentwall");
const LOCK_FILE = join(AGENTWALL_DIR, "agentwall.lock");

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
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
  decision: DecisionVerdict,
  resolvedBy: DecisionReason,
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
    taint: getTaintState(),
  };
}

// MCP config detection is now in src/core/clients.ts

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
  resetTaint();

  const policy = new PolicyEngine();
  const logger = new EventLogger();

  policy.watch((filePath) => {
    process.stderr.write(`[AgentWall] Policy reloaded: ${filePath}\n`);
  });

  const shutdown = () => {
    policy.stopWatch();
    releaseLock();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  process.stderr.write(
    `\n  agentwall v${VERSION} — runtime safety layer for local AI agents\n`,
  );
  process.stderr.write(
    `  policy: ${policy.policyPath}${policy.usingDefaults ? " (defaults)" : ""}\n`,
  );

  const adapter = new OpenClawAdapter({ gatewayUrl, token, verbose });

  adapter.onProposal(async (proposal: ActionProposal) => {
    const result = policy.evaluate(proposal);

    if (result.decision === "deny") {
      const label = result.reason === "rate-limit" ? "rate limited" : "policy rule matched";
      printDecision("deny", proposal.command, label);
      logger.log(buildLogEntry(proposal, "deny", result.reason));
      await adapter.resolve(proposal.approvalId, false);
    } else if (result.decision === "allow") {
      printDecision("allow", proposal.command, "auto-allow");
      logger.log(buildLogEntry(proposal, "allow", "auto-allow"));
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

async function proxyCommand(args: string[]): Promise<void> {
  const separatorIndex = args.indexOf("--");
  if (separatorIndex === -1 || separatorIndex === args.length - 1) {
    process.stderr.write(
      `${RED}error:${RESET} Missing server command.\n` +
      `  Usage: agentwall proxy -- <command> [args...]\n\n` +
      `  Example:\n` +
      `    agentwall proxy -- npx -y @modelcontextprotocol/server-filesystem ~\n`,
    );
    process.exit(1);
  }

  const serverArgs = args.slice(separatorIndex + 1);
  const serverCommand = serverArgs[0];
  const serverCommandArgs = serverArgs.slice(1);

  await startProxy({
    serverCommand,
    serverArgs: serverCommandArgs,
  });
}

function setupLegacyCommand(runtime: string): void {
  if (runtime === "mcp") {
    process.stdout.write(`
  MCP proxy setup

  Replace your MCP server command with agentwall proxy:

  Before (in ~/.cursor/mcp.json or claude_desktop_config.json):

    {
      "mcpServers": {
        "filesystem": {
          "command": "npx",
          "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user"]
        }
      }
    }

  After:

    {
      "mcpServers": {
        "filesystem": {
          "command": "agentwall",
          "args": ["proxy", "--", "npx", "-y", "@modelcontextprotocol/server-filesystem", "/home/user"]
        }
      }
    }

  AgentWall wraps the real server. The client never knows it is there.

`);
    return;
  }

  if (runtime === "openclaw") {
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
    return;
  }

  process.stderr.write(
    `${RED}error:${RESET} Unknown runtime "${runtime}".\n` +
    `  Available: openclaw, mcp\n` +
    `  Or run 'agentwall setup' without arguments for automatic setup.\n`,
  );
  process.exit(1);
}

async function setupAutoCommand(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const dryRun = flags["dry-run"] === "true";

  // Verify agentwall is on PATH
  try {
    execSync("agentwall --version", { stdio: "ignore" });
  } catch {
    process.stderr.write(
      `${RED}error:${RESET} agentwall is not on your PATH.\n` +
      `  Install it first: npm install -g agentwall\n`,
    );
    process.exit(1);
  }

  process.stdout.write(
    dryRun
      ? `\n  AgentWall Setup — Dry Run (no files will be changed)\n\n`
      : `\n  AgentWall v${VERSION} — Setup\n\n  Scanning for MCP configurations...\n\n`,
  );

  const allClients = getSupportedClients().filter((c) => c.kind === "mcp");
  const detected = detectConfigs();

  if (!dryRun) {
    process.stdout.write("  Found:\n");
    for (const client of allClients) {
      const config = detected.find((d) => d.label === client.name);
      if (config) {
        const count = Object.keys(config.servers).length;
        process.stdout.write(
          `    ${GREEN}✓${RESET} ${config.label} — ${count} server${count !== 1 ? "s" : ""} (${shortPath(config.path)})\n`,
        );
      } else {
        process.stdout.write(`    ${DIM}✗ ${client.name} — not installed${RESET}\n`);
      }
    }
    process.stdout.write("\n");
  }

  if (detected.length === 0) {
    process.stdout.write("  No MCP configurations found. Nothing to do.\n\n");
    return;
  }

  // Compute transforms
  interface ServerTransform {
    name: string;
    original: string;
    transformed: string;
    skipped: boolean;
    skipReason?: string;
  }
  interface ConfigTransform {
    config: DetectedConfig;
    transforms: ServerTransform[];
    hasChanges: boolean;
  }

  const configTransforms: ConfigTransform[] = [];

  for (const config of detected) {
    const transforms: ServerTransform[] = [];
    let hasChanges = false;

    for (const [name, entry] of Object.entries(config.servers)) {
      if (isAlreadyWrapped(entry)) {
        transforms.push({
          name,
          original: "",
          transformed: "",
          skipped: true,
          skipReason: "already protected",
        });
        continue;
      }

      if (isHttpTransport(entry)) {
        transforms.push({
          name,
          original: "",
          transformed: "",
          skipped: true,
          skipReason: "HTTP transport not yet supported",
        });
        continue;
      }

      if (typeof entry.command !== "string") {
        transforms.push({
          name,
          original: "",
          transformed: "",
          skipped: true,
          skipReason: "no command field",
        });
        continue;
      }

      const origArgs = (entry.args ?? []) as string[];
      const origStr = `${entry.command} ${origArgs.join(" ")}`.trim();
      const newStr = `agentwall proxy -- ${origStr}`;
      transforms.push({ name, original: origStr, transformed: newStr, skipped: false });
      hasChanges = true;
    }

    configTransforms.push({ config, transforms, hasChanges });
  }

  // Print transforms
  for (const ct of configTransforms) {
    process.stdout.write(
      dryRun
        ? `  ${ct.config.label} (${shortPath(ct.config.path)})\n`
        : `  ${ct.config.label}:\n`,
    );

    for (const t of ct.transforms) {
      if (t.skipped) {
        if (t.skipReason === "already protected") {
          process.stdout.write(`    ${GREEN}✓${RESET} Already protected: ${t.name}\n`);
        } else {
          process.stdout.write(`    ⚠ ${t.name}: ${t.skipReason}, skipping\n`);
        }
      } else {
        process.stdout.write(`    • ${t.name}    ${t.original}\n`);
        if (dryRun) {
          process.stdout.write(`      → ${t.transformed}\n`);
        }
      }
    }
    process.stdout.write("\n");
  }

  const totalChanges = configTransforms.reduce(
    (sum, ct) => sum + ct.transforms.filter((t) => !t.skipped).length, 0,
  );

  if (totalChanges === 0) {
    process.stdout.write("  All servers are already protected. Nothing to do.\n\n");
    return;
  }

  if (dryRun) {
    process.stdout.write("  Run without --dry-run to apply these changes.\n\n");
    return;
  }

  // Prompt for confirmation
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question("  Wrap all servers with AgentWall? [Y/n] ", (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });

  if (answer.toLowerCase() === "n" || answer.toLowerCase() === "no") {
    process.stdout.write("\n  Aborted.\n\n");
    return;
  }

  process.stdout.write("\n  Backing up configs...\n");

  // Backup and write
  for (const ct of configTransforms) {
    if (!ct.hasChanges) continue;

    const bakPath = backupFile(ct.config.path);
    process.stdout.write(`    ${GREEN}✓${RESET} Backed up ${basename(ct.config.path)} → ${basename(bakPath)}\n`);

    const raw = readFileSync(ct.config.path, "utf-8");
    const parsed = JSON.parse(raw);

    for (const t of ct.transforms) {
      if (t.skipped) continue;
      parsed.mcpServers[t.name] = wrapServerEntry(parsed.mcpServers[t.name]);
    }

    writeFileSync(ct.config.path, JSON.stringify(parsed, null, 2) + "\n");
  }

  process.stdout.write("\n  Wrapping servers...\n");
  for (const ct of configTransforms) {
    for (const t of ct.transforms) {
      if (t.skipped) continue;
      process.stdout.write(`    ${GREEN}✓${RESET} ${t.name}\n`);
    }
  }

  const clientNames = configTransforms
    .filter((ct) => ct.hasChanges)
    .map((ct) => ct.config.label)
    .join(" and ");

  process.stdout.write(`
  Done. Restart ${clientNames} to activate AgentWall.

  Note: In GUI clients (Cursor, Claude Desktop), AgentWall runs in policy-only
  mode. Interactive approval prompts are available in Claude Code and terminal
  contexts. Run \`agentwall init\` to configure your policy rules.

  Run \`agentwall status\` to verify protection.
  Run \`agentwall undo\` to remove AgentWall from all configs.

`);
}

function undoCommand(): void {
  const configs = getSupportedClients().filter((c) => c.kind === "mcp");
  const restored: string[] = [];

  for (const client of configs) {
    for (const configPath of client.configPaths) {
      // Find the most recent .bak file
      const dir = dirname(configPath);
      const base = basename(configPath);

      if (!existsSync(dir)) continue;

      let files: string[];
      try {
        files = readdirSync(dir);
      } catch {
        continue;
      }

      // Collect all backup files for this config, sorted by specificity (highest number first)
      const bakFiles = files
        .filter((f) => f === base + ".bak" || f.startsWith(base + ".bak."))
        .sort((a, b) => {
          const numA = a === base + ".bak" ? 1 : parseInt(a.split(".bak.")[1], 10);
          const numB = b === base + ".bak" ? 1 : parseInt(b.split(".bak.")[1], 10);
          return numA - numB;
        });

      if (bakFiles.length === 0) continue;

      // Restore the original .bak (the first backup ever made)
      const bakPath = join(dir, bakFiles[0]);
      copyFileSync(bakPath, configPath);

      // Remove all backup files
      for (const bf of bakFiles) {
        try {
          unlinkSync(join(dir, bf));
        } catch {
          // best-effort
        }
      }

      restored.push(configPath);
      process.stdout.write(`  ${GREEN}✓${RESET} Restored ${shortPath(configPath)}\n`);
    }
  }

  if (restored.length === 0) {
    process.stdout.write("  No AgentWall backups found. Nothing to undo.\n");
  }

  process.stdout.write("\n");
}

function replayCommand(n?: number): void {
  EventLogger.replay(n);
}

function clearLogsCommand(): void {
  const logFiles = readdirSync(AGENTWALL_DIR).filter(
    (f) => f.endsWith(".jsonl") || f.endsWith(".jsonl.bak"),
  );

  if (logFiles.length === 0) {
    process.stdout.write("  No log files found.\n\n");
    return;
  }

  for (const file of logFiles) {
    try {
      unlinkSync(join(AGENTWALL_DIR, file));
      process.stdout.write(`  ${GREEN}✓${RESET} Removed ${file}\n`);
    } catch {
      process.stdout.write(`  ${RED}✗${RESET} Failed to remove ${file}\n`);
    }
  }

  process.stdout.write(`\n  Cleared ${logFiles.length} log file${logFiles.length !== 1 ? "s" : ""}.\n`);
  process.stdout.write(`  Restart agentwall ui for a fresh session.\n\n`);
}

function statusCommand(): void {
  process.stdout.write(`\n  AgentWall v${VERSION}\n\n`);

  // Protection status
  process.stdout.write("  Protection:\n");
  const allClients = getSupportedClients().filter((c) => c.kind === "mcp");
  const detected = detectConfigs();

  for (const client of allClients) {
    const config = detected.find((d) => d.label === client.name);
    if (config) {
      const { total, protected: prot } = countProtection(config.servers);
      const allProtected = prot === total;
      const icon = allProtected ? `${GREEN}✓${RESET}` : `${YELLOW}⚠${RESET}`;
      process.stdout.write(`    ${icon} ${config.label} — ${prot}/${total} servers protected\n`);
    } else {
      process.stdout.write(`    ${DIM}✗ ${client.name} — not installed${RESET}\n`);
    }
  }
  process.stdout.write("\n");

  // Policy stats
  const policyPath = join(AGENTWALL_DIR, "policy.yaml");
  if (existsSync(policyPath)) {
    process.stdout.write(`  Policy: ${shortPath(policyPath)}\n`);
    try {
      const raw = readFileSync(policyPath, "utf-8");
      const parsed = yaml.load(raw) as Record<string, unknown[]> | null;
      if (parsed) {
        const denyCount = Array.isArray(parsed.deny) ? parsed.deny.length : 0;
        const askCount = Array.isArray(parsed.ask) ? parsed.ask.length : 0;
        const allowCount = Array.isArray(parsed.allow) ? parsed.allow.length : 0;
        const limitCount = Array.isArray(parsed.limits) ? parsed.limits.length : 0;
        process.stdout.write(`    • ${denyCount} deny rules\n`);
        process.stdout.write(`    • ${askCount} ask rules\n`);
        process.stdout.write(`    • ${allowCount} allow rules\n`);
        process.stdout.write(`    • ${limitCount} rate limit rules\n`);
        process.stdout.write(`    • Default: ask\n`);
      }
    } catch {
      // skip if can't parse
    }
  } else {
    process.stdout.write(`  Policy: not configured (using defaults)\n`);
  }
  process.stdout.write("\n");

  // Session log
  const today = new Date().toISOString().slice(0, 10);
  const logPath = join(AGENTWALL_DIR, `session-${today}.jsonl`);
  if (existsSync(logPath)) {
    process.stdout.write(`  Session log: ${shortPath(logPath)}\n`);
    try {
      const lines = readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean);
      let allowed = 0, approved = 0, blocked = 0;
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as LogEntry;
          if (entry.decision === "allow" && entry.resolvedBy === "policy") allowed++;
          else if (entry.decision === "allow" && entry.resolvedBy === "user") approved++;
          else if (entry.decision === "deny") blocked++;
        } catch {
          // skip malformed lines
        }
      }
      const total = allowed + approved + blocked;
      process.stdout.write(`    • ${total} decisions today (${allowed} allowed, ${approved} approved, ${blocked} blocked)\n`);
    } catch {
      // skip
    }
  }
  process.stdout.write("\n");

  // Taint state
  const taint = getTaintState();
  if (taint.tainted) {
    process.stdout.write(`  ${YELLOW}⚠ Taint:${RESET} session is tainted\n`);
    process.stdout.write(`    • Reason: ${taint.reason}\n`);
    process.stdout.write(`    • Source: ${taint.sourcePath}\n`);
    process.stdout.write(`    • Since: ${taint.taintedAt}\n`);
    process.stdout.write(`    • Outbound network calls to unknown hosts will be blocked\n`);
  } else {
    process.stdout.write(`  Taint: ${GREEN}clean${RESET} (no credential access detected)\n`);
  }
  process.stdout.write("\n");

  process.stdout.write(`  Run \`agentwall replay\` to view recent decisions.\n`);
  process.stdout.write(`  Run \`agentwall undo\` to remove AgentWall from all configs.\n\n`);
}

async function uiCommand(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const port = flags.port ? parseInt(flags.port, 10) : 7823;

  const approvalQueue = new ApprovalQueue();
  const policy = new PolicyEngine();
  const logger = new EventLogger();

  const webServer = new AgentWallWebServer({
    port,
    policyPath: policy.policyPath,
    logDir: logger.logDir,
    approvalQueue,
  });

  policy.watch((filePath) => {
    process.stderr.write(`[AgentWall] Policy reloaded: ${filePath}\n`);
    webServer.notifyPolicyReloaded();
  });

  await webServer.start();

  const url = `http://localhost:${port}`;
  process.stderr.write(`\n  agentwall v${VERSION} — web UI\n`);
  process.stderr.write(`  ${GREEN}✓${RESET} Web UI available at ${url}\n\n`);

  const os = platform();
  try {
    if (os === "darwin") {
      execSync(`open ${url}`, { stdio: "ignore" });
    } else if (os === "win32") {
      execSync(`start ${url}`, { stdio: "ignore" });
    } else {
      execSync(`xdg-open ${url}`, { stdio: "ignore" });
    }
  } catch {
    // browser open is best-effort
  }

  const shutdown = () => {
    policy.stopWatch();
    webServer.stop();
    logger.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function helpCommand(): void {
  process.stdout.write(`
  agentwall v${VERSION} — policy-enforcing MCP proxy for AI agents

  Usage:
    agentwall setup [--dry-run]          Auto-detect and wrap all MCP configs
    agentwall setup <runtime>            Print manual setup instructions (openclaw, mcp)
    agentwall undo                       Restore all original MCP configs
    agentwall proxy -- <command> [args]  Wrap a single MCP server
    agentwall ui [--port 7823]           Start the web UI (policy editor, log viewer)
    agentwall init                       Create ~/.agentwall/policy.yaml with default rules
    agentwall status                     Show protection status
    agentwall replay [N]                 Show last N log entries (default 50)
    agentwall clear-logs                 Remove all log files
    agentwall start [--token <token>]    Start OpenClaw gateway adapter
    agentwall --version                  Print version
    agentwall --help                     Show this help

  Version history:
    v0.1  Shell commands via OpenClaw WebSocket adapter
    v0.2  All tool calls via native OpenClaw plugin
    v0.3  Everything MCP-speaking via protocol-level proxy
    v0.4  Policy engine v2 (database rules) + zero-friction setup
    v0.5  Hot-reload + rate limiting
    v0.6  Web UI — approval, policy editor, log viewer
    v0.7  Client visibility — Clients tab, see and manage everything
    v0.8  npm package (@agentwall/agentwall)

`);
}

// -----------------------------------------------------------------------------
// Entry point
// -----------------------------------------------------------------------------

const command = process.argv[2];
const remaining = process.argv.slice(3);

(async () => {
  switch (command) {
    case "proxy":
      await proxyCommand(remaining);
      break;
    case "start":
      await startCommand(remaining);
      break;
    case "init":
      initCommand();
      break;
    case "setup": {
      const firstArg = remaining[0];
      if (firstArg === "openclaw" || firstArg === "mcp") {
        setupLegacyCommand(firstArg);
      } else {
        await setupAutoCommand(remaining);
      }
      break;
    }
    case "undo":
      undoCommand();
      break;
    case "replay":
      replayCommand(remaining[0] ? parseInt(remaining[0], 10) : undefined);
      break;
    case "clear-logs":
      clearLogsCommand();
      break;
    case "status":
      statusCommand();
      break;
    case "ui":
      await uiCommand(remaining);
      break;
    case "--version":
    case "-v":
      process.stdout.write(`agentwall v${VERSION}\n`);
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
