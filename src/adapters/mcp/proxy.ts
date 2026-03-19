import { randomUUID } from "node:crypto";
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
import type {
  ActionProposal,
  DecisionVerdict,
  DecisionReason,
  LogEntry,
  McpProxyOptions,
} from "../../core/types.js";

const VERSION = "0.6.0";

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
  };
}

function checkTtyAvailable(): boolean {
  return process.stderr.isTTY === true;
}

export async function startProxy(options: McpProxyOptions): Promise<void> {
  useTtyInput();

  const hasTty = checkTtyAvailable();
  let webServer: AgentWallWebServer | null = null;
  let approvalQueue: ApprovalQueue | null = null;

  if (!hasTty) {
    approvalQueue = new ApprovalQueue();
    setWebApprovalQueue(approvalQueue);
  }

  const logger = new EventLogger(
    approvalQueue
      ? {
          onEntry: (entry) => {
            webServer?.notifyLogEntry(entry);
          },
        }
      : undefined,
  );

  const policy = new PolicyEngine();

  policy.watch((filePath) => {
    process.stderr.write(`[AgentWall] Policy reloaded: ${filePath}\n`);
    webServer?.notifyPolicyReloaded();
  });

  if (!hasTty && approvalQueue) {
    const envPort = parseInt(process.env.AGENTWALL_PORT ?? "", 10) || 7823;
    const port = options.port ?? envPort;
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

    const proposal: ActionProposal = {
      approvalId: randomUUID(),
      runtime: "mcp",
      command,
      workingDir,
      toolName: toolName,
      args: toolArgs,
      toolInput: toolArgs,
      sessionId: "",
      agentId: client.getServerVersion()?.name ?? "",
    };

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
      logger.log(buildLogEntry(proposal, "ask", "user"));
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

  process.stderr.write(
    `  ${GREEN}✓${RESET} Proxy ready — intercepting tool calls\n`,
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
