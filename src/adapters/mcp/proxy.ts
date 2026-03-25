import { randomUUID } from "node:crypto";
import * as net from "node:net";
import * as http from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  CompleteRequestSchema,
  SetLevelRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";

import { PolicyEngine } from "../../core/policy.js";
import { EventLogger } from "../../core/logger.js";
import { askUser, printDecision, useTtyInput, setWebApprovalQueue } from "../../core/prompt.js";
import { ApprovalQueue } from "../../web/approval.js";
import { AgentWallWebServer } from "../../web/server.js";
import { checkAndMarkTaint, checkTaintViolation, getTaintState, resetTaint } from "../../taint/taint.js";
import type {
  ActionProposal,
  DecisionVerdict,
  DecisionReason,
  LogEntry,
  McpProxyOptions,
  Runtime,
} from "../../core/types.js";

const VERSION = "0.9.0";

const CLIENT_NAME_TO_RUNTIME: [string, Runtime][] = [
  ["claude desktop", "claude-desktop"],
  ["claude-desktop", "claude-desktop"],
  ["claude-ai", "claude-desktop"],
  ["anthropic", "claude-desktop"],
  ["cursor", "cursor"],
  ["windsurf", "windsurf"],
  ["codeium", "windsurf"],
  ["claude code", "claude-code"],
  ["claude-code", "claude-code"],
  ["claudecode", "claude-code"],
  ["claude", "claude-desktop"],
];

function detectRuntime(clientName?: string): Runtime {
  if (!clientName) return "mcp";
  const lower = clientName.toLowerCase();
  for (const [pattern, runtime] of CLIENT_NAME_TO_RUNTIME) {
    if (lower.includes(pattern)) return runtime;
  }
  process.stderr.write(`[AgentWall] Unknown MCP client: "${clientName}" — showing as "mcp"\n`);
  return "mcp";
}

function isPortReachable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => { socket.destroy(); resolve(false); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.connect(port, "127.0.0.1");
  });
}

function remoteApprovalRequest(
  port: number,
  toolName: string,
  params: Record<string, unknown>,
  runtime: string,
): Promise<"allow" | "deny"> {
  return new Promise((resolve) => {
    const data = JSON.stringify({ toolName, params, runtime });
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: "/api/request-approval",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
      timeout: 35000,
    }, (res) => {
      let body = "";
      res.on("data", (chunk: string) => body += chunk);
      res.on("end", () => {
        try {
          const result = JSON.parse(body);
          resolve(result.decision === "allow" ? "allow" : "deny");
        } catch {
          resolve("deny");
        }
      });
    });
    req.on("error", () => resolve("deny"));
    req.on("timeout", () => { req.destroy(); resolve("deny"); });
    req.write(data);
    req.end();
  });
}

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

const SHELL_TOOL_NAMES = new Set([
  "bash", "exec", "shell", "run_command", "execute_command",
  "run_terminal_command", "terminal",
]);

function extractCommand(toolName: string, args: Record<string, unknown>): string {
  if (SHELL_TOOL_NAMES.has(toolName)) {
    const cmd = args.command ?? args.cmd ?? args.script;
    if (typeof cmd === "string") return cmd;
  }
  return toolName;
}

function extractPath(args: Record<string, unknown>): string {
  const candidate = args.path ?? args.file ?? args.filename ?? args.directory ?? args.uri;
  if (typeof candidate === "string") return candidate;
  return "";
}

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

export async function startProxy(options: McpProxyOptions): Promise<void> {
  useTtyInput();
  resetTaint();

  let webServer: AgentWallWebServer | null = null;

  const approvalQueue = new ApprovalQueue();
  setWebApprovalQueue(approvalQueue);

  const logger = new EventLogger({
    onEntry: (entry) => {
      webServer?.notifyLogEntry(entry);
    },
  });

  const policy = new PolicyEngine();

  policy.watch((filePath) => {
    process.stderr.write(`[AgentWall] Policy reloaded: ${filePath}\n`);
    webServer?.notifyPolicyReloaded();
  });

  const envPort = parseInt(process.env.AGENTWALL_PORT ?? "", 10) || 7823;
  const port = options.port ?? envPort;
  const portInUse = await isPortReachable(port);

  if (portInUse) {
    process.stderr.write(`[AgentWall] Web UI already running at http://localhost:${port}\n`);
    const remoteQueue = {
      request: (toolName: string, params: Record<string, unknown>, runtime: string) =>
        remoteApprovalRequest(port, toolName, params, runtime),
    } as ApprovalQueue;
    setWebApprovalQueue(remoteQueue);
  } else {
    webServer = new AgentWallWebServer({
      port,
      policyPath: policy.policyPath,
      logDir: logger.logDir,
      approvalQueue,
    });
    await webServer.start();
    process.stderr.write(`[AgentWall] Web UI available at http://localhost:${port}\n`);
    process.stderr.write(`[AgentWall] Approval requests will appear in your browser.\n`);
  }

  process.stderr.write(
    `\n  agentwall v${VERSION} — MCP proxy mode\n`,
  );
  process.stderr.write(
    `  policy: ${policy.policyPath}${policy.usingDefaults ? " (defaults)" : ""}\n`,
  );
  process.stderr.write(
    `  wrapping: ${options.serverCommand} ${options.serverArgs.join(" ")}\n`,
  );

  // --- Phase 1: Connect to the real MCP server ---

  const realTransport = new StdioClientTransport({
    command: options.serverCommand,
    args: options.serverArgs,
    env: options.serverEnv,
    cwd: options.serverCwd,
    stderr: "inherit",
  });

  const client = new Client(
    { name: "agentwall-proxy", version: VERSION },
    { capabilities: {} },
  );

  try {
    await client.connect(realTransport);
  } catch (err) {
    process.stderr.write(
      `  ${RED}error:${RESET} Failed to connect to real MCP server: ${(err as Error).message}\n`,
    );
    logger.close();
    process.exit(1);
  }

  const serverCaps = client.getServerCapabilities() ?? {};
  process.stderr.write(`  ${GREEN}✓${RESET} Connected to real MCP server\n`);

  // --- Phase 2: Build matching capabilities for our proxy server ---

  const proxyCaps: ServerCapabilities = {};

  if (serverCaps.tools) {
    proxyCaps.tools = { ...serverCaps.tools };
  }
  if (serverCaps.resources) {
    proxyCaps.resources = { ...serverCaps.resources };
  }
  if (serverCaps.prompts) {
    proxyCaps.prompts = { ...serverCaps.prompts };
  }
  if (serverCaps.logging) {
    proxyCaps.logging = { ...serverCaps.logging };
  }
  if (serverCaps.completions) {
    proxyCaps.completions = {};
  }

  // Always advertise tools so we can intercept tools/call
  if (!proxyCaps.tools) {
    proxyCaps.tools = {};
  }

  const server = new Server(
    { name: "agentwall-proxy", version: VERSION },
    { capabilities: proxyCaps },
  );

  // --- Phase 3: Register forwarding handlers ---

  // tools/list — forward real server's tool list unchanged
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    return await client.listTools(request.params);
  });

  // tools/call — the interception point
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const toolArgs = (request.params.arguments ?? {}) as Record<string, unknown>;

    const command = extractCommand(toolName, toolArgs);
    const workingDir = extractPath(toolArgs);

    const clientName = server.getClientVersion()?.name;
    const runtime = detectRuntime(clientName);

    webServer?.notifyClientActive(runtime);

    const proposal: ActionProposal = {
      approvalId: randomUUID(),
      runtime,
      command,
      workingDir,
      toolName: toolName,
      args: toolArgs,
      toolInput: toolArgs,
      sessionId: "",
      agentId: client.getServerVersion()?.name ?? "",
    };

    // Taint step 1: check if this call touches sensitive data
    checkAndMarkTaint(toolName, toolArgs);

    // Taint step 2: block outbound network calls from tainted sessions
    const allowedHosts = policy.getAllowedHosts();
    const taintCheck = checkTaintViolation(toolName, toolArgs, allowedHosts);

    if (taintCheck.blocked) {
      printDecision("deny", `${toolName}(${command})`, "taint violation");
      logger.log(buildLogEntry(proposal, "deny", "taint-tracker"));
      webServer?.notifyTaintStateChanged(getTaintState());
      return {
        content: [{ type: "text" as const, text: `AgentWall: ${taintCheck.reason}` }],
        isError: true,
      };
    }

    const result = policy.evaluate(proposal);

    if (result.decision === "deny") {
      const blockText = result.message ?? `AgentWall: '${toolName}' blocked by policy`;
      const label = result.reason === "rate-limit" ? "rate limited" : "policy rule matched";
      printDecision("deny", `${toolName}(${command})`, label);
      logger.log(buildLogEntry(proposal, "deny", result.reason));
      return {
        content: [{ type: "text" as const, text: blockText }],
        isError: true,
      };
    }

    if (result.decision === "allow") {
      printDecision("allow", `${toolName}(${command})`, "auto-allow");
      logger.log(buildLogEntry(proposal, "allow", "auto-allow"));
      return await client.callTool(request.params);
    }

    // result.decision === "ask" — prompt the user
    let userDecision: "allow" | "deny";
    try {
      userDecision = await askUser(proposal, "flagged by policy");
    } catch {
      printDecision("deny", `${toolName}(${command})`, "no TTY — blocked for safety");
      logger.log(buildLogEntry(proposal, "deny", "user"));
      return {
        content: [{ type: "text" as const, text: `AgentWall: no TTY available — '${toolName}' blocked for safety` }],
        isError: true,
      };
    }

    if (userDecision === "allow") {
      printDecision("allow", `${toolName}(${command})`, "user approved");
      logger.log(buildLogEntry(proposal, "allow", "user"));
      return await client.callTool(request.params);
    }

    printDecision("deny", `${toolName}(${command})`, "user denied");
    logger.log(buildLogEntry(proposal, "deny", "user"));
    return {
      content: [{ type: "text" as const, text: `AgentWall: user denied tool call '${toolName}'` }],
      isError: true,
    };
  });

  // --- Transparent forwarding for non-tool methods ---

  if (serverCaps.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
      return await client.listResources(request.params);
    });

    server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => {
      return await client.listResourceTemplates(request.params);
    });

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      return await client.readResource(request.params);
    });

    server.setRequestHandler(SubscribeRequestSchema, async (request) => {
      return await client.subscribeResource(request.params);
    });

    server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
      return await client.unsubscribeResource(request.params);
    });
  }

  if (serverCaps.prompts) {
    server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
      return await client.listPrompts(request.params);
    });

    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      return await client.getPrompt(request.params);
    });
  }

  if (serverCaps.completions) {
    server.setRequestHandler(CompleteRequestSchema, async (request) => {
      return await client.complete(request.params);
    });
  }

  if (serverCaps.logging) {
    server.setRequestHandler(SetLevelRequestSchema, async (request) => {
      return await client.setLoggingLevel(request.params.level);
    });
  }

  // --- Phase 4: Handle real server crash ---

  realTransport.onclose = () => {
    process.stderr.write(
      `  ${RED}✗${RESET} Real MCP server disconnected\n`,
    );
    logger.close();
    process.exit(1);
  };

  // --- Phase 5: Connect proxy server to the MCP client via stdio ---

  const clientFacingTransport = new StdioServerTransport();
  await server.connect(clientFacingTransport);

  const detectedClient = server.getClientVersion()?.name ?? "unknown";
  const detectedRuntime = detectRuntime(detectedClient);
  process.stderr.write(
    `  ${GREEN}✓${RESET} Proxy ready — intercepting tool calls\n`,
  );
  process.stderr.write(
    `  ${DIM}client: ${detectedClient} (runtime: ${detectedRuntime})${RESET}\n`,
  );
  process.stderr.write(
    `  ${DIM}log: ${logger.logPath}${RESET}\n\n`,
  );

  // Graceful shutdown
  const shutdown = () => {
    process.stderr.write(`\n  ${DIM}shutting down...${RESET}\n`);
    policy.stopWatch();
    webServer?.stop();
    logger.close();
    client.close().catch(() => {});
    server.close().catch(() => {});
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
