import { homedir } from "node:os";

export interface TaintState {
  tainted: boolean;
  reason: string;
  taintedAt: string | null;
  sourcePath: string;
}

const state: TaintState = {
  tainted: false,
  reason: "",
  taintedAt: null,
  sourcePath: "",
};

const SENSITIVE_PATHS = [
  /\.ssh\//,
  /\.aws\/credentials/,
  /\.aws\/config/,
  /\.kube\/config/,
  /\.gnupg\//,
  /\.env$/,
  /\.envrc$/,
  /id_rsa/,
  /id_ed25519/,
];

const SENSITIVE_ENV_PATTERNS = [
  /AWS_/,
  /GITHUB_TOKEN/,
  /NPM_TOKEN/,
  /OPENAI_API_KEY/,
  /ANTHROPIC_API_KEY/,
  /DATABASE_URL/,
  /SECRET/,
  /PASSWORD/,
  /PRIVATE_KEY/,
];

const NETWORK_TOOLS = new Set([
  "exec",
  "run_command",
  "shell",
  "bash",
  "fetch",
  "http_request",
  "web_fetch",
  "execute_command",
  "run_terminal_command",
  "terminal",
]);

const NETWORK_COMMAND_PATTERNS = [
  /\bcurl\b/,
  /\bwget\b/,
  /\bnc\b/,
  /\bncat\b/,
  /\bpython.*requests\b/,
  /\bnode.*fetch\b/,
  /\baxios\b/,
];

/**
 * Inspect a tool call for access to sensitive data and mark the session
 * as tainted if it touches credentials, SSH keys, env vars, etc.
 */
export function checkAndMarkTaint(toolName: string, args: Record<string, unknown>): void {
  const filePath = args?.path || args?.file || args?.filename || "";
  if (typeof filePath === "string" && filePath.length > 0) {
    const home = homedir();
    const expanded = filePath.replace(/^~/, home);
    for (const pattern of SENSITIVE_PATHS) {
      if (pattern.test(expanded) || pattern.test(filePath)) {
        markTainted(`sensitive file read: ${filePath}`, filePath);
        return;
      }
    }
  }

  const sql = args?.sql || args?.query || "";
  if (typeof sql === "string" && /information_schema|pg_catalog|mysql\.user/i.test(sql)) {
    markTainted("sensitive DB query", String(sql));
    return;
  }

  const command = args?.command || args?.cmd || args?.input || "";
  if (typeof command === "string") {
    if (/process\.env|os\.environ|\$ENV|\$HOME\/.ssh|\$HOME\/.aws/i.test(command)) {
      markTainted("command accesses sensitive env/paths", String(command));
      return;
    }

    for (const pattern of SENSITIVE_ENV_PATTERNS) {
      if (pattern.test(command)) {
        markTainted(`command references sensitive env var`, String(command));
        return;
      }
    }
  }
}

/**
 * If the session is tainted, check whether this tool call is making an
 * outbound network request to a host not in the allowlist.
 */
export function checkTaintViolation(
  toolName: string,
  args: Record<string, unknown>,
  allowedHosts: string[],
): { blocked: boolean; reason: string } {
  if (!state.tainted) return { blocked: false, reason: "" };

  const isNetworkTool = NETWORK_TOOLS.has(toolName.toLowerCase());
  const command = args?.command || args?.cmd || args?.input || args?.url || "";

  const hasNetworkCommand =
    typeof command === "string" &&
    NETWORK_COMMAND_PATTERNS.some((p) => p.test(command));

  const hasUrl = typeof args?.url === "string";

  if (!isNetworkTool && !hasNetworkCommand && !hasUrl) {
    return { blocked: false, reason: "" };
  }

  const target = typeof command === "string" ? command : String(args?.url ?? "");
  const host = extractHost(target);

  if (host && allowedHosts.some((h) => host.endsWith(h))) {
    return { blocked: false, reason: "" };
  }

  return {
    blocked: true,
    reason: `taint violation — session tainted by "${state.sourcePath}", outbound network call to "${host || "unknown host"}" blocked`,
  };
}

export function markTainted(reason: string, sourcePath: string): void {
  if (state.tainted) return;
  state.tainted = true;
  state.reason = reason;
  state.taintedAt = new Date().toISOString();
  state.sourcePath = sourcePath;
  process.stderr.write(`[AgentWall] TAINT: session marked tainted — ${reason}\n`);
}

export function getTaintState(): TaintState {
  return { ...state };
}

export function resetTaint(): void {
  state.tainted = false;
  state.reason = "";
  state.taintedAt = null;
  state.sourcePath = "";
}

function extractHost(text: string): string {
  try {
    const urlMatch = text.match(/https?:\/\/([^/\s"']+)/);
    if (urlMatch) return urlMatch[1];
    const hostMatch = text.match(/\s([a-z0-9][a-z0-9.-]+\.[a-z]{2,})/);
    if (hostMatch) return hostMatch[1];
  } catch {
    // extraction is best-effort
  }
  return "";
}
