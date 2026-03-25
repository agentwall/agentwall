import { readFileSync, existsSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import yaml from "js-yaml";
import type { ActionProposal, Decision, LimitRule } from "./types.js";

const AGENTWALL_DIR = join(homedir(), ".agentwall");
const POLICY_FILE = join(AGENTWALL_DIR, "policy.yaml");
const WORKSPACE_DIR = resolve(process.cwd());

interface PolicyRule {
  command?: string;
  path?: string;
  tool?: string;
  match?: Record<string, string>;
  url?: string;
}

interface PolicyConfig {
  deny?: PolicyRule[];
  allow?: PolicyRule[];
  ask?: PolicyRule[];
  limits?: LimitRule[];
  allowed_hosts?: string[];
}

const VALID_TOP_KEYS = new Set(["deny", "allow", "ask", "limits", "allowed_hosts"]);
const VALID_RULE_KEYS = new Set(["command", "path", "tool", "match", "url"]);

const DEFAULT_POLICY = `# AgentWall Policy
# Rules are evaluated in order: deny → allow → ask
# Glob patterns: * matches anything except /, ** matches everything including /
# Documentation: https://github.com/yourusername/agentwall

deny:
  # ── Filesystem: never touch credentials or system files ──────────────────
  - path: ~/.ssh/**
  - path: ~/.aws/**
  - path: ~/.gnupg/**
  - path: ~/.npmrc
  - path: ~/.netrc
  - path: /etc/**
  - path: /System/**

  # ── Shell: never pipe from the internet ──────────────────────────────────
  - command: "curl * | *"
  - command: "curl *|*"
  - command: "wget * | *"
  - command: "wget *|*"

  # ── Shell: never wipe root or home ───────────────────────────────────────
  - command: "rm -rf /"
  - command: "rm -rf ~"
  - command: "rm -rf /home"

  # ── Database: never drop, truncate, or wipe ──────────────────────────────
  - tool: "*"
    match:
      sql: "drop *"
  - tool: "*"
    match:
      sql: "truncate *"
  - tool: "*"
    match:
      query: "drop *"
  - tool: "*"
    match:
      query: "truncate *"
  - tool: "*"
    match:
      statement: "drop *"
  - tool: "*"
    match:
      statement: "truncate *"

ask:
  # ── Database: always confirm destructive writes ───────────────────────────
  - tool: "*"
    match:
      sql: "delete *"
  - tool: "*"
    match:
      sql: "alter *"
  - tool: "*"
    match:
      sql: "update *"
  - tool: "*"
    match:
      query: "delete *"
  - tool: "*"
    match:
      query: "alter *"
  - tool: "*"
    match:
      query: "update *"

  # ── Shell: confirm destructive commands ──────────────────────────────────
  - command: "rm -rf *"
  - command: "rm -r *"
  - command: "sudo *"
  - command: "chmod -R *"
  - command: "dd *"

  # ── Filesystem: confirm writes outside workspace ──────────────────────────
  - tool: "write_file"
    path: outside:workspace
  - tool: "edit"
    path: outside:workspace

allow:
  # ── Everything inside your workspace is trusted ───────────────────────────
  - path: workspace/**

# ── Rate limits ─────────────────────────────────────────────────────────────
# Auto-deny if an agent calls a tool too frequently.
# Catches runaway loops before they cause damage.
limits:
  - tool: exec
    max: 30
    window: 60      # max 30 shell commands per minute
  - tool: write
    max: 50
    window: 60      # max 50 file writes per minute
  - tool: "*"
    max: 200
    window: 300     # max 200 total tool calls per 5 minutes

# ── Allowed hosts for taint tracking ────────────────────────────────────────
# When a session is tainted (credential access detected), outbound network
# calls are blocked unless the destination is in this list.
allowed_hosts:
  - api.anthropic.com
  - api.openai.com
  - github.com
  - registry.npmjs.org
  - pypi.org
`;

function escapeRegex(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegex(pattern: string): RegExp {
  let regex = "";
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "*" && pattern[i + 1] === "*") {
      regex += ".*";
      i++;
    } else if (pattern[i] === "*") {
      regex += "[^/]*";
    } else if (pattern[i] === "?") {
      regex += "[^/]";
    } else {
      regex += escapeRegex(pattern[i]);
    }
  }
  return new RegExp(`^${regex}$`);
}

function getNonWildcardPrefix(pattern: string): string {
  const idx = pattern.indexOf("*");
  return idx === -1 ? pattern : pattern.slice(0, idx);
}

function expandPath(pattern: string): string {
  if (pattern.startsWith("~/") || pattern === "~") {
    return homedir() + pattern.slice(1);
  }
  if (pattern.startsWith("workspace/") || pattern === "workspace") {
    return WORKSPACE_DIR + pattern.slice("workspace".length);
  }
  return pattern;
}

function matchesCommand(command: string, pattern: string): boolean {
  if (globToRegex(pattern).test(command)) return true;

  const prefix = getNonWildcardPrefix(pattern);
  if (prefix.length > 0 && command.startsWith(prefix)) return true;

  return false;
}

function matchesPath(workingDir: string, pattern: string): boolean {
  if (workingDir === "") return false;

  if (pattern === "outside:workspace") {
    const normalized = resolve(workingDir);
    return normalized !== WORKSPACE_DIR && !normalized.startsWith(WORKSPACE_DIR + "/");
  }

  const expanded = expandPath(pattern);
  if (globToRegex(expanded).test(workingDir)) return true;

  if (expanded.endsWith("/**")) {
    const base = expanded.slice(0, -3);
    if (workingDir === base || workingDir.startsWith(base + "/")) return true;
  }

  return false;
}

function matchesTool(proposal: ActionProposal, pattern: string): boolean {
  const name = proposal.toolName ?? proposal.command;
  return globToRegex(pattern).test(name);
}

function matchesArgContent(proposal: ActionProposal, matchRules: Record<string, string>): boolean {
  const args = proposal.args;
  if (!args) return false;

  for (const [argName, pattern] of Object.entries(matchRules)) {
    const argValue = args[argName];
    if (argValue === undefined) return false;
    const valueStr = typeof argValue === "string" ? argValue : JSON.stringify(argValue);
    if (!globToRegex(pattern.toLowerCase()).test(valueStr.toLowerCase())) return false;
  }
  return true;
}

function matchesUrl(proposal: ActionProposal, pattern: string): boolean {
  const urlValue = proposal.args?.url ?? proposal.args?.uri;
  if (!urlValue) return false;
  return globToRegex(pattern).test(String(urlValue));
}

function ruleMatches(rule: PolicyRule, proposal: ActionProposal): boolean {
  const conditions: boolean[] = [];

  if (rule.command !== undefined) {
    conditions.push(matchesCommand(proposal.command, rule.command));
  }
  if (rule.path !== undefined) {
    conditions.push(matchesPath(proposal.workingDir, rule.path));
  }
  if (rule.tool !== undefined) {
    conditions.push(matchesTool(proposal, rule.tool));
  }
  if (rule.match !== undefined) {
    conditions.push(matchesArgContent(proposal, rule.match));
  }
  if (rule.url !== undefined) {
    conditions.push(matchesUrl(proposal, rule.url));
  }

  if (conditions.length === 0) return false;
  return conditions.every(Boolean);
}

// ---------------------------------------------------------------------------
// Rate limiter — internal, not exported
// ---------------------------------------------------------------------------

type CallRecord = {
  toolName: string;
  timestamp: number;
};

class RateLimiter {
  private sessions = new Map<string, CallRecord[]>();
  private cleanupInterval: NodeJS.Timeout;

  constructor() {
    this.cleanupInterval = setInterval(() => this.cleanup(), 600_000);
    this.cleanupInterval.unref();
  }

  check(
    toolName: string,
    sessionKey: string,
    limits: LimitRule[],
  ): { limited: false } | { limited: true; retryAfterMs: number; rule: LimitRule } {
    if (limits.length === 0) return { limited: false };

    const now = Date.now();
    const history = this.sessions.get(sessionKey) ?? [];

    for (const rule of limits) {
      if (!globToRegex(rule.tool).test(toolName)) continue;

      const windowMs = rule.window * 1000;
      const windowStart = now - windowMs;

      const callsInWindow = history.filter(
        (r) => r.timestamp >= windowStart && globToRegex(rule.tool).test(r.toolName),
      );

      if (callsInWindow.length >= rule.max) {
        const oldest = Math.min(...callsInWindow.map((r) => r.timestamp));
        const retryAfterMs = oldest + windowMs - now;
        return { limited: true, retryAfterMs: Math.max(0, retryAfterMs), rule };
      }
    }

    return { limited: false };
  }

  record(toolName: string, sessionKey: string, limits: LimitRule[]): void {
    if (limits.length === 0) return;

    const now = Date.now();
    if (!this.sessions.has(sessionKey)) {
      this.sessions.set(sessionKey, []);
    }
    const history = this.sessions.get(sessionKey)!;
    history.push({ toolName, timestamp: now });

    const maxWindowMs = Math.max(...limits.map((l) => l.window)) * 1000;
    const cutoff = now - maxWindowMs;
    this.sessions.set(
      sessionKey,
      history.filter((r) => r.timestamp >= cutoff),
    );
  }

  private cleanup(): void {
    const cutoff = Date.now() - 3_600_000;
    for (const [key, history] of this.sessions.entries()) {
      if (history.length === 0 || history.every((r) => r.timestamp < cutoff)) {
        this.sessions.delete(key);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Policy engine
// ---------------------------------------------------------------------------

export class PolicyEngine {
  readonly policyPath: string;
  readonly usingDefaults: boolean;
  private config: PolicyConfig;
  private rateLimiter = new RateLimiter();
  private watcher?: FSWatcher;
  private dirWatcher?: FSWatcher;

  constructor() {
    this.policyPath = POLICY_FILE;

    if (!existsSync(POLICY_FILE)) {
      this.usingDefaults = true;
      this.config = yaml.load(DEFAULT_POLICY) as PolicyConfig;
      return;
    }

    this.usingDefaults = false;
    try {
      this.config = this.load();
    } catch (err) {
      process.stderr.write(
        `\x1b[31merror:\x1b[0m ${(err as Error).message}\n`,
      );
      process.exit(1);
    }
  }

  private load(): PolicyConfig {
    const raw = readFileSync(this.policyPath, "utf-8");

    let parsed: unknown;
    try {
      parsed = yaml.load(raw);
    } catch (err) {
      throw new Error(
        `Failed to parse ${this.policyPath}: ${(err as Error).message}\n` +
        `  Fix the YAML syntax in your policy file and try again.`,
      );
    }

    if (parsed === null || parsed === undefined || typeof parsed !== "object") {
      return { deny: [], allow: [], ask: [], limits: [] };
    }

    const obj = parsed as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (!VALID_TOP_KEYS.has(key)) {
        throw new Error(
          `Unknown key "${key}" in ${this.policyPath}\n` +
          `  Valid keys are: deny, allow, ask, limits. Remove or rename the unknown key.`,
        );
      }
    }

    const config = obj as PolicyConfig;
    this.validatePolicyRules(config);
    this.validateLimitRules(config);
    return config;
  }

  private validatePolicyRules(config: PolicyConfig): void {
    for (const section of ["deny", "allow", "ask"] as const) {
      const rules = config[section];
      if (!rules) continue;

      if (!Array.isArray(rules)) {
        throw new Error(
          `"${section}" in ${this.policyPath} must be a list of rules.\n` +
          `  Each rule should have a "command" and/or "path" field.`,
        );
      }

      for (const rule of rules) {
        if (typeof rule !== "object" || rule === null) {
          throw new Error(
            `Invalid rule in "${section}" in ${this.policyPath}.\n` +
            `  Each rule must be an object with "command", "path", "tool", "match", and/or "url" fields.`,
          );
        }

        const ruleObj = rule as Record<string, unknown>;
        for (const key of Object.keys(ruleObj)) {
          if (!VALID_RULE_KEYS.has(key)) {
            throw new Error(
              `Unknown rule key "${key}" in "${section}" in ${this.policyPath}.\n` +
              `  Valid rule keys are: command, path, tool, match, url.`,
            );
          }
        }

        for (const key of ["command", "path", "tool", "url"] as const) {
          if (ruleObj[key] !== undefined && typeof ruleObj[key] !== "string") {
            throw new Error(
              `Invalid "${key}" value in "${section}" — must be a string.\n` +
              `  Wrap the value in quotes in your policy file.`,
            );
          }
        }

        if (ruleObj.match !== undefined) {
          if (typeof ruleObj.match !== "object" || ruleObj.match === null || Array.isArray(ruleObj.match)) {
            throw new Error(
              `Invalid "match" value in "${section}" — must be an object mapping argument names to glob patterns.`,
            );
          }
          for (const [k, v] of Object.entries(ruleObj.match as Record<string, unknown>)) {
            if (typeof v !== "string") {
              throw new Error(
                `Invalid match pattern for "${k}" in "${section}" — must be a string.`,
              );
            }
          }
        }
      }
    }
  }

  private validateLimitRules(config: PolicyConfig): void {
    const limits = config.limits;
    if (!limits) return;

    if (!Array.isArray(limits)) {
      throw new Error(
        `"limits" in ${this.policyPath} must be a list of limit rules.`,
      );
    }

    for (const rule of limits) {
      if (typeof rule !== "object" || rule === null) {
        throw new Error(
          `Invalid limit rule in ${this.policyPath}. Each rule needs tool, max, and window.`,
        );
      }
      const r = rule as Record<string, unknown>;
      if (typeof r.tool !== "string") {
        throw new Error(`Limit rule missing "tool" (string) in ${this.policyPath}.`);
      }
      if (typeof r.max !== "number" || r.max <= 0) {
        throw new Error(`Limit rule "max" must be a positive number in ${this.policyPath}.`);
      }
      if (typeof r.window !== "number" || r.window <= 0) {
        throw new Error(`Limit rule "window" must be a positive number in ${this.policyPath}.`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Hot-reload
  // ---------------------------------------------------------------------------

  /**
   * Watch the policy file for changes and reload rules in place.
   * Safe to call multiple times — only one watcher is active at a time.
   * On reload failure (e.g. bad YAML), keeps existing rules and logs to stderr.
   */
  watch(onReload?: (filePath: string) => void): void {
    if (this.watcher) return;

    let debounce: NodeJS.Timeout | undefined;

    this.watcher = fsWatch(this.policyPath, (eventType) => {
      if (eventType !== "change") return;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        try {
          this.config = this.load();
          onReload?.(this.policyPath);
        } catch (err) {
          process.stderr.write(`[AgentWall] Policy reload failed: ${err}\n`);
          process.stderr.write(`[AgentWall] Keeping previous rules.\n`);
        }
      }, 200);
    });

    // Some editors replace the file rather than modifying it (Emacs, some IDEs).
    // Watch the directory for rename events so we can restart the file watcher.
    const dir = dirname(this.policyPath);
    const filename = basename(this.policyPath);

    this.dirWatcher = fsWatch(dir, (eventType, changedFile) => {
      if (changedFile !== filename || eventType !== "rename") return;
      this.watcher?.close();
      this.watcher = undefined;
      try {
        this.config = this.load();
        onReload?.(this.policyPath);
      } catch {
        // next save will retry
      }
      this.watch(onReload);
    });
  }

  stopWatch(): void {
    this.watcher?.close();
    this.dirWatcher?.close();
    this.watcher = undefined;
    this.dirWatcher = undefined;
  }

  // ---------------------------------------------------------------------------
  // Evaluation
  // ---------------------------------------------------------------------------

  evaluate(proposal: ActionProposal): Decision {
    const sessionKey = proposal.sessionId ?? "global";
    const toolName = proposal.toolName ?? proposal.command ?? "";
    const limits = this.config.limits ?? [];

    if (limits.length > 0) {
      const result = this.rateLimiter.check(toolName, sessionKey, limits);
      if (result.limited) {
        const waitSecs = Math.ceil(result.retryAfterMs / 1000);
        const message =
          `AgentWall: ${toolName} rate limit reached ` +
          `(${result.rule.max}/${result.rule.window}s). ` +
          `Wait ${waitSecs} second${waitSecs === 1 ? "" : "s"}.`;
        return { decision: "deny", reason: "rate-limit", message };
      }
      this.rateLimiter.record(toolName, sessionKey, limits);
    }

    for (const rule of this.config.deny ?? []) {
      if (ruleMatches(rule, proposal)) return { decision: "deny", reason: "policy" };
    }

    // Non-path ask rules fire before path-based allow rules.
    // Prevents workspace/** allow from silently permitting rm -rf, sudo, DROP, etc.
    for (const rule of this.config.ask ?? []) {
      const hasPathCondition = rule.path !== undefined;
      if (!hasPathCondition && ruleMatches(rule, proposal)) {
        return { decision: "ask", reason: "policy" };
      }
    }

    for (const rule of this.config.allow ?? []) {
      if (ruleMatches(rule, proposal)) return { decision: "allow", reason: "policy" };
    }

    // Remaining ask rules (path-based)
    for (const rule of this.config.ask ?? []) {
      const hasPathCondition = rule.path !== undefined;
      if (hasPathCondition && ruleMatches(rule, proposal)) {
        return { decision: "ask", reason: "policy" };
      }
    }

    return { decision: "ask", reason: "policy" };
  }

  getAllowedHosts(): string[] {
    return this.config.allowed_hosts ?? [];
  }

  static defaultYaml(): string {
    return DEFAULT_POLICY;
  }
}
