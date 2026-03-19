export interface ActionProposal {
  approvalId: string;
  runtime:    Runtime;
  command:    string;
  workingDir: string;
  toolInput?: unknown;
  sessionId?: string;
  agentId?:   string;
}

export type Runtime = "openclaw" | "claude-code" | "cursor" | "mcp";

export type Decision = "allow" | "deny" | "ask";

export interface LogEntry {
  ts:         string;
  runtime:    Runtime;
  decision:   Decision;
  resolvedBy: "policy" | "user";
  command:    string;
  workingDir: string;
  approvalId: string;
  sessionId:  string;
  agentId:    string;
}
