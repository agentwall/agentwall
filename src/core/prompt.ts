import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";
import type { ActionProposal } from "./types.js";
import type { ApprovalQueue } from "../web/approval.js";

const AUTO_DENY_TIMEOUT_MS = 5 * 60 * 1000;

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

const sessionMemory = new Set<string>();

let inputMode: "stdin" | "tty" = "stdin";
let ttyAvailable: boolean | null = null;

let _webApprovalQueue: ApprovalQueue | null = null;

export function setWebApprovalQueue(queue: ApprovalQueue): void {
  _webApprovalQueue = queue;
}

/**
 * Switch prompt input to /dev/tty. Required in proxy mode where
 * process.stdin carries MCP JSON-RPC traffic.
 */
export function useTtyInput(): void {
  inputMode = "tty";
}

function isTtyAvailable(): boolean {
  if (ttyAvailable !== null) return ttyAvailable;
  ttyAvailable = process.stderr.isTTY === true;
  return ttyAvailable;
}

function openInput(): Readable {
  if (inputMode === "tty") {
    if (!isTtyAvailable()) {
      throw new Error("No TTY available for approval prompt");
    }
    const stream = createReadStream("/dev/tty");
    stream.on("error", () => stream.destroy());
    return stream;
  }
  return process.stdin;
}

interface QueueItem {
  proposal: ActionProposal;
  reason: string;
  resolve: (decision: "allow" | "deny") => void;
}

const queue: QueueItem[] = [];
let processing = false;

function getBaseExecutable(command: string): string {
  return command.trim().split(/\s+/)[0];
}

function showPrompt(
  proposal: ActionProposal,
  reason: string,
  pendingCount: number,
): Promise<"allow" | "deny"> {
  return new Promise((resolve) => {
    let input: Readable;
    try {
      input = openInput();
    } catch {
      process.stderr.write(
        `  ${RED}✗ DENY${RESET}  ${proposal.command}  ${DIM}(no TTY — blocked for safety)${RESET}\n`,
      );
      resolve("deny");
      return;
    }

    const rl = createInterface({ input, output: process.stderr });

    let resolved = false;
    const finish = (decision: "allow" | "deny") => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      rl.close();
      if (input !== process.stdin) input.destroy();
      resolve(decision);
    };

    const timeout = setTimeout(() => {
      process.stderr.write(
        `\n  ${YELLOW}⏱ Auto-denied after 5 minutes of no response.${RESET}\n\n`,
      );
      finish("deny");
    }, AUTO_DENY_TIMEOUT_MS);

    const pending =
      pendingCount > 0 ? `  ${DIM}(${pendingCount} more pending)${RESET}` : "";

    process.stderr.write(
      `\n  ${BOLD}${YELLOW}⚠  AgentWall — approval required${RESET}${pending}\n`,
    );
    process.stderr.write(`  runtime: ${proposal.runtime}\n`);
    process.stderr.write(`  reason:  ${reason}\n\n`);
    process.stderr.write(`  command:  ${BOLD}${proposal.command}${RESET}\n`);
    process.stderr.write(
      `  path:     ${proposal.workingDir || "(unknown)"}\n\n`,
    );
    process.stderr.write("  allow?  [y] yes   [n] no   [a] always allow this  › ");

    rl.on("line", (input) => {
      const answer = input.trim().toLowerCase();
      if (answer === "y" || answer === "yes") {
        finish("allow");
      } else if (answer === "a" || answer === "always") {
        sessionMemory.add(getBaseExecutable(proposal.command));
        finish("allow");
      } else {
        finish("deny");
      }
    });

    rl.on("close", () => finish("deny"));
  });
}

async function processQueue(): Promise<void> {
  processing = true;
  while (queue.length > 0) {
    const item = queue.shift()!;
    const decision = await showPrompt(item.proposal, item.reason, queue.length);
    item.resolve(decision);
  }
  processing = false;
}

export async function askUser(
  proposal: ActionProposal,
  reason: string,
): Promise<"allow" | "deny"> {
  const baseExec = getBaseExecutable(proposal.command);
  if (sessionMemory.has(baseExec)) {
    return "allow";
  }

  if (inputMode === "tty" && !isTtyAvailable() && _webApprovalQueue) {
    const decision = await _webApprovalQueue.request(
      proposal.toolName ?? proposal.command,
      proposal.args ?? {},
      proposal.runtime,
    );
    return decision;
  }

  return new Promise((resolve) => {
    queue.push({ proposal, reason, resolve });
    if (!processing) processQueue();
  });
}

export function printDecision(
  decision: "allow" | "deny",
  command: string,
  reason: string,
): void {
  if (decision === "allow") {
    process.stderr.write(`  ${GREEN}✓ ALLOW${RESET}  ${command}  ${DIM}(${reason})${RESET}\n`);
  } else {
    process.stderr.write(`  ${RED}✗ DENY${RESET}   ${command}  ${DIM}(${reason})${RESET}\n`);
  }
}
