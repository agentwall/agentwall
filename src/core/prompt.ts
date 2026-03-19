import { createInterface } from "node:readline";
import type { ActionProposal } from "./types.js";

const AUTO_DENY_TIMEOUT_MS = 5 * 60 * 1000;

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

const sessionMemory = new Set<string>();

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
    const rl = createInterface({ input: process.stdin, output: process.stderr });

    let resolved = false;
    const finish = (decision: "allow" | "deny") => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      rl.close();
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
