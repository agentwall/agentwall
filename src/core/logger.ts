import { createWriteStream, mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { WriteStream } from "node:fs";
import type { LogEntry, Decision } from "./types.js";

const AGENTWALL_DIR = join(homedir(), ".agentwall");

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

const DECISION_COLORS: Record<Decision, string> = {
  allow: GREEN,
  deny: RED,
  ask: YELLOW,
};

export class EventLogger {
  private stream: WriteStream;
  readonly logPath: string;

  constructor() {
    mkdirSync(AGENTWALL_DIR, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    this.logPath = join(AGENTWALL_DIR, `session-${date}.jsonl`);
    this.stream = createWriteStream(this.logPath, { flags: "a" });
    this.stream.on("error", (err) => {
      process.stderr.write(`${YELLOW}warning:${RESET} failed to write log: ${err.message}\n`);
    });
  }

  log(entry: LogEntry): void {
    try {
      this.stream.write(JSON.stringify(entry) + "\n");
    } catch (err) {
      process.stderr.write(
        `${YELLOW}warning:${RESET} failed to write log: ${(err as Error).message}\n`
      );
    }
  }

  close(): void {
    this.stream.end();
  }

  static replay(n: number = 50): void {
    if (!existsSync(AGENTWALL_DIR)) {
      process.stdout.write("No AgentWall logs found. Run 'agentwall start' first.\n");
      return;
    }

    const files = readdirSync(AGENTWALL_DIR)
      .filter(f => f.startsWith("session-") && f.endsWith(".jsonl"))
      .sort();

    if (files.length === 0) {
      process.stdout.write("No session logs found. Run 'agentwall start' first.\n");
      return;
    }

    const latestFile = files[files.length - 1];
    const filePath = join(AGENTWALL_DIR, latestFile);
    const content = readFileSync(filePath, "utf-8").trim();

    if (!content) {
      process.stdout.write(`Session log ${latestFile} is empty.\n`);
      return;
    }

    const lines = content.split("\n");
    const entries: LogEntry[] = lines
      .slice(-n)
      .map(line => {
        try { return JSON.parse(line) as LogEntry; }
        catch { return null; }
      })
      .filter((e): e is LogEntry => e !== null);

    if (entries.length === 0) {
      process.stdout.write(`No valid entries in ${latestFile}.\n`);
      return;
    }

    process.stdout.write(`\n  AgentWall session log — ${latestFile}\n\n`);
    process.stdout.write("  TIME       RUNTIME      DECISION  BY       COMMAND\n");
    process.stdout.write(`  ${"─".repeat(74)}\n`);

    for (const entry of entries) {
      const d = new Date(entry.ts);
      const time = [d.getHours(), d.getMinutes(), d.getSeconds()]
        .map(v => String(v).padStart(2, "0"))
        .join(":");
      const runtime = entry.runtime.padEnd(13);
      const decision = entry.decision.toUpperCase().padEnd(10);
      const by = entry.resolvedBy.padEnd(9);
      const color = DECISION_COLORS[entry.decision] || "";

      process.stdout.write(
        `  ${time}   ${runtime}${color}${decision}${RESET}${by}${entry.command}\n`
      );
    }

    process.stdout.write("\n");
  }
}
