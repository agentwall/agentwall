import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import yaml from "js-yaml";
import type { ActionProposal, Decision } from "./types.js";

const AGENTWALL_DIR = join(homedir(), ".agentwall");
const POLICY_FILE = join(AGENTWALL_DIR, "policy.yaml");
const WORKSPACE_DIR = resolve(process.cwd());

interface PolicyRule {
  command?: string;
  path?: string;
}

interface PolicyConfig {
  deny?: PolicyRule[];
  allow?: PolicyRule[];
  ask?: PolicyRule[];
}

const VALID_TOP_KEYS = new Set(["deny", "allow", "ask"]);
const VALID_RULE_KEYS = new Set(["command", "path"]);

const DEFAULT_POLICY = `# AgentWall policy
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

function ruleMatches(rule: PolicyRule, proposal: ActionProposal): boolean {
  const hasCommand = rule.command !== undefined;
  const hasPath = rule.path !== undefined;

  if (hasCommand && hasPath) {
    return matchesCommand(proposal.command, rule.command!) &&
           matchesPath(proposal.workingDir, rule.path!);
  }
  if (hasCommand) return matchesCommand(proposal.command, rule.command!);
  if (hasPath) return matchesPath(proposal.workingDir, rule.path!);

  return false;
}

export class PolicyEngine {
  readonly policyPath: string;
  readonly usingDefaults: boolean;
  private config: PolicyConfig;

  constructor() {
    this.policyPath = POLICY_FILE;

    if (!existsSync(POLICY_FILE)) {
      this.usingDefaults = true;
      this.config = yaml.load(DEFAULT_POLICY) as PolicyConfig;
      return;
    }

    this.usingDefaults = false;
    const raw = readFileSync(POLICY_FILE, "utf-8");

    let parsed: unknown;
    try {
      parsed = yaml.load(raw);
    } catch (err) {
      process.stderr.write(
        `\x1b[31merror:\x1b[0m Failed to parse ${POLICY_FILE}: ${(err as Error).message}\n` +
        `  Fix the YAML syntax in your policy file and try again.\n`
      );
      process.exit(1);
    }

    if (parsed === null || parsed === undefined || typeof parsed !== "object") {
      this.config = { deny: [], allow: [], ask: [] };
      return;
    }

    const obj = parsed as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (!VALID_TOP_KEYS.has(key)) {
        process.stderr.write(
          `\x1b[31merror:\x1b[0m Unknown key "${key}" in ${POLICY_FILE}\n` +
          `  Valid keys are: deny, allow, ask. Remove or rename the unknown key.\n`
        );
        process.exit(1);
      }
    }

    this.config = obj as PolicyConfig;
    this.validateRules();
  }

  private validateRules(): void {
    for (const section of ["deny", "allow", "ask"] as const) {
      const rules = this.config[section];
      if (!rules) continue;

      if (!Array.isArray(rules)) {
        process.stderr.write(
          `\x1b[31merror:\x1b[0m "${section}" in ${this.policyPath} must be a list of rules.\n` +
          `  Each rule should have a "command" and/or "path" field.\n`
        );
        process.exit(1);
      }

      for (const rule of rules) {
        if (typeof rule !== "object" || rule === null) {
          process.stderr.write(
            `\x1b[31merror:\x1b[0m Invalid rule in "${section}" in ${this.policyPath}.\n` +
            `  Each rule must be an object with "command" and/or "path" fields.\n`
          );
          process.exit(1);
        }

        const ruleObj = rule as Record<string, unknown>;
        for (const key of Object.keys(ruleObj)) {
          if (!VALID_RULE_KEYS.has(key)) {
            process.stderr.write(
              `\x1b[31merror:\x1b[0m Unknown rule key "${key}" in "${section}" in ${this.policyPath}.\n` +
              `  Valid rule keys are: command, path.\n`
            );
            process.exit(1);
          }
        }

        if (ruleObj.command !== undefined && typeof ruleObj.command !== "string") {
          process.stderr.write(
            `\x1b[31merror:\x1b[0m Invalid "command" value in "${section}" — must be a string.\n` +
            `  Wrap the value in quotes in your policy file.\n`
          );
          process.exit(1);
        }

        if (ruleObj.path !== undefined && typeof ruleObj.path !== "string") {
          process.stderr.write(
            `\x1b[31merror:\x1b[0m Invalid "path" value in "${section}" — must be a string.\n` +
            `  Wrap the value in quotes in your policy file.\n`
          );
          process.exit(1);
        }
      }
    }
  }

  evaluate(proposal: ActionProposal): Decision {
    for (const rule of this.config.deny ?? []) {
      if (ruleMatches(rule, proposal)) return "deny";
    }
    for (const rule of this.config.allow ?? []) {
      if (ruleMatches(rule, proposal)) return "allow";
    }
    for (const rule of this.config.ask ?? []) {
      if (ruleMatches(rule, proposal)) return "ask";
    }
    return "ask";
  }

  static defaultYaml(): string {
    return DEFAULT_POLICY;
  }
}
