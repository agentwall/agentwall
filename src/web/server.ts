import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import yaml from "js-yaml";
import type { ApprovalQueue } from "./approval.js";
import {
  getClients,
  protectServer,
  ignoreServer,
  unignoreServer,
  type ClientEntry,
} from "../core/clients.js";

const VERSION = "0.8.1";
const DEFAULT_PORT = 7823;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const APP_NAMES: Record<string, string> = {
  "claude-desktop": "Claude",
  "cursor": "Cursor",
  "windsurf": "Windsurf",
};

const PENDING_RESTART_CLEAR_DELAY_MS = 5000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveUiDir(): string {
  const adjacent = path.join(__dirname, "ui");
  if (fs.existsSync(adjacent)) return adjacent;
  const fromDist = path.resolve(__dirname, "../../src/web/ui");
  if (fs.existsSync(fromDist)) return fromDist;
  return adjacent;
}

const UI_DIR = resolveUiDir();

export type WebServerOptions = {
  port?: number;
  policyPath: string;
  logDir: string;
  approvalQueue: ApprovalQueue;
};

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

export class AgentWallWebServer {
  private server: http.Server;
  private wss: WebSocketServer;
  private options: WebServerOptions;

  private startError: Error | null = null;

  private pendingRestarts = new Map<string, number>();
  private lastSeen = new Map<string, number>();

  constructor(options: WebServerOptions) {
    this.options = options;
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
    this.server.on("error", (err) => { this.startError = err; });
    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on("error", (err) => { this.startError = err; });
    this.wss.on("connection", (ws) => this.handleWebSocket(ws));

    options.approvalQueue.onNewApproval((approval) => {
      this.broadcast({
        type: "approval_request",
        id: approval.id,
        toolName: approval.toolName,
        params: approval.params,
        runtime: approval.runtime,
        timestamp: approval.timestamp.toISOString(),
      });
    });

    options.approvalQueue.onApprovalResolved((id, decision) => {
      this.broadcast({ type: "approval_resolved", id, decision });
    });
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const port = this.options.port ?? DEFAULT_PORT;
      const onError = (err: Error) => reject(err);
      this.server.once("error", onError);
      this.server.listen(port, "127.0.0.1", () => {
        this.server.removeListener("error", onError);
        resolve();
      });
    });
  }

  stop(): void {
    this.wss.close();
    this.server.close();
  }

  get port(): number {
    return this.options.port ?? DEFAULT_PORT;
  }

  notifyPolicyReloaded(): void {
    this.broadcast({ type: "policy_reloaded" });
  }

  notifyLogEntry(entry: unknown): void {
    this.broadcast({ type: "log_entry", entry });
  }

  notifyClientActive(runtime: string): void {
    const prev = this.lastSeen.get(runtime);
    const now = Date.now();
    this.lastSeen.set(runtime, now);

    if (prev && this.pendingRestarts.has(runtime)) {
      const wrappedAt = this.pendingRestarts.get(runtime)!;
      if (wrappedAt < now - PENDING_RESTART_CLEAR_DELAY_MS) {
        this.pendingRestarts.delete(runtime);
        this.broadcast({ type: "client_restarted", runtime });
      }
    }
  }

  private broadcast(message: unknown): void {
    const json = JSON.stringify(message);
    for (const client of this.wss.clients) {
      if (client.readyState === 1) {
        client.send(json);
      }
    }
  }

  private handleWebSocket(ws: WebSocket): void {
    const pending = this.options.approvalQueue.getPending();
    for (const approval of pending) {
      ws.send(
        JSON.stringify({
          type: "approval_request",
          id: approval.id,
          toolName: approval.toolName,
          params: approval.params,
          runtime: approval.runtime,
          timestamp: approval.timestamp.toISOString(),
        }),
      );
    }
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost`);
    const pathname = url.pathname;

    try {
      if (req.method === "GET" && pathname === "/") {
        this.serveStatic(res, "index.html");
      } else if (req.method === "GET" && (pathname === "/logo.png" || pathname === "/favicon.ico")) {
        this.serveStatic(res, "logo.png");
      } else if (req.method === "GET" && pathname === "/policy") {
        this.serveStatic(res, "policy.html");
      } else if (req.method === "GET" && pathname === "/log") {
        this.serveStatic(res, "log.html");
      } else if (req.method === "GET" && pathname === "/clients") {
        this.serveStatic(res, "clients.html");
      } else if (req.method === "GET" && pathname === "/api/status") {
        this.handleStatus(res);
      } else if (req.method === "GET" && pathname === "/api/policy") {
        this.handleGetPolicy(res);
      } else if (req.method === "POST" && pathname === "/api/policy") {
        await this.handlePostPolicy(req, res);
      } else if (req.method === "GET" && pathname === "/api/log") {
        this.handleGetLog(req, res);
      } else if (req.method === "GET" && pathname === "/api/clients") {
        this.handleGetClients(res);
      } else if (req.method === "POST" && pathname === "/api/clients/protect") {
        await this.handleProtect(req, res);
      } else if (req.method === "POST" && pathname === "/api/clients/ignore") {
        await this.handleIgnore(req, res);
      } else if (req.method === "POST" && pathname === "/api/clients/unignore") {
        await this.handleUnignore(req, res);
      } else if (req.method === "POST" && pathname === "/api/clients/restart") {
        await this.handleRestart(req, res);
      } else if (req.method === "POST" && pathname === "/api/request-approval") {
        await this.handleRemoteApprovalRequest(req, res);
      } else if (req.method === "POST" && pathname.startsWith("/api/approve/")) {
        await this.handleApprove(req, res, pathname);
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "Not found" }));
      }
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(err) }));
    }
  }

  private serveStatic(res: http.ServerResponse, filename: string): void {
    if (filename.includes("..")) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }

    const filePath = path.join(UI_DIR, filename);
    if (!filePath.startsWith(UI_DIR)) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }

    if (!fs.existsSync(filePath)) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath);
    res.setHeader("Content-Type", MIME_TYPES[ext] ?? "application/octet-stream");
    res.end(fs.readFileSync(filePath));
  }

  private handleStatus(res: http.ServerResponse): void {
    const pending = this.options.approvalQueue.getPending();
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        version: VERSION,
        policyPath: this.options.policyPath,
        logPath: this.options.logDir,
        pendingApprovals: pending.length,
      }),
    );
  }

  private handleGetPolicy(res: http.ServerResponse): void {
    res.setHeader("Content-Type", "application/json");
    if (!fs.existsSync(this.options.policyPath)) {
      res.end(JSON.stringify({ yaml: "", parsed: {} }));
      return;
    }
    const raw = fs.readFileSync(this.options.policyPath, "utf-8");
    let parsed: unknown = {};
    try {
      parsed = yaml.load(raw);
    } catch {
      // return raw even if parse fails
    }
    res.end(JSON.stringify({ yaml: raw, parsed }));
  }

  private async handlePostPolicy(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const body = await readBody(req);
    let payload: { yaml?: string };
    try {
      payload = JSON.parse(body);
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    if (typeof payload.yaml !== "string") {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Missing yaml field" }));
      return;
    }

    try {
      yaml.load(payload.yaml);
    } catch (err) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: `Invalid YAML: ${String(err)}` }));
      return;
    }

    fs.writeFileSync(this.options.policyPath, payload.yaml, "utf-8");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  }

  private handleGetLog(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    const date = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Invalid date format" }));
      return;
    }

    res.setHeader("Content-Type", "application/json");

    const entries: Record<string, unknown>[] = [];

    const sessionPath = path.join(this.options.logDir, `session-${date}.jsonl`);
    this.readJsonlInto(sessionPath, entries);

    if (entries.length === 0) {
      const decisionsPath = path.join(this.options.logDir, "decisions.jsonl");
      this.readJsonlInto(decisionsPath, entries, date);
    }

    entries.sort((a, b) => {
      const tsA = (a.ts as string) ?? (a.timestamp as string) ?? "";
      const tsB = (b.ts as string) ?? (b.timestamp as string) ?? "";
      return tsA.localeCompare(tsB);
    });

    res.end(JSON.stringify(entries));
  }

  private readJsonlInto(
    filePath: string,
    out: Record<string, unknown>[],
    filterDate?: string,
  ): void {
    if (!fs.existsSync(filePath)) return;

    const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (filterDate) {
          const ts = entry.ts ?? entry.timestamp ?? "";
          if (!ts.startsWith(filterDate)) continue;
        }
        if (entry.timestamp && !entry.ts) {
          entry.ts = entry.timestamp;
        }
        if (entry.toolName && !entry.command) {
          entry.command = entry.toolName;
        }
        if (entry.reason && !entry.resolvedBy) {
          entry.resolvedBy = entry.reason;
        }
        if (entry.decision === "blocked") {
          entry.decision = "deny";
        }
        if (entry.decision === "approved") {
          entry.decision = "allow";
          entry.resolvedBy = "user";
        }
        out.push(entry);
      } catch {
        // skip malformed lines
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Clients API
  // ---------------------------------------------------------------------------

  private handleGetClients(res: http.ServerResponse): void {
    const clients = this.getClientsWithState();
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ clients }));
  }

  private getClientsWithState(): ClientEntry[] {
    const clients = getClients();
    const now = Date.now();

    for (const client of clients) {
      const seenAt = this.lastSeen.get(client.id);
      if (seenAt && now - seenAt < 120_000) {
        client.active = true;
      }

      if (this.pendingRestarts.has(client.id)) {
        client.pendingRestart = true;
      }
    }

    return clients;
  }

  private async handleProtect(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const body = await readBody(req);
    let payload: { client?: string; server?: string };
    try {
      payload = JSON.parse(body);
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    if (!payload.client || !payload.server) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Missing client or server field" }));
      return;
    }

    const updated = protectServer(payload.client, payload.server);
    if (!updated) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "Client or server not found" }));
      return;
    }

    this.pendingRestarts.set(payload.client, Date.now());

    updated.pendingRestart = true;
    const seenAt = this.lastSeen.get(payload.client);
    if (seenAt && Date.now() - seenAt < 120_000) {
      updated.active = true;
    }

    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, client: updated }));
  }

  private async handleIgnore(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const body = await readBody(req);
    let payload: { client?: string; server?: string };
    try {
      payload = JSON.parse(body);
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    if (!payload.client || !payload.server) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Missing client or server field" }));
      return;
    }

    ignoreServer(payload.client, payload.server);

    const clients = this.getClientsWithState();
    const updated = clients.find((c) => c.id === payload.client);

    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, client: updated ?? null }));
  }

  private async handleUnignore(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const body = await readBody(req);
    let payload: { client?: string; server?: string };
    try {
      payload = JSON.parse(body);
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    if (!payload.client || !payload.server) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Missing client or server field" }));
      return;
    }

    unignoreServer(payload.client, payload.server);
    const updated = protectServer(payload.client, payload.server);

    if (updated) {
      this.pendingRestarts.set(payload.client, Date.now());
      updated.pendingRestart = true;
      const seenAt = this.lastSeen.get(payload.client);
      if (seenAt && Date.now() - seenAt < 120_000) {
        updated.active = true;
      }
    }

    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, client: updated ?? null }));
  }

  private async handleRestart(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const body = await readBody(req);
    let payload: { client?: string };
    try {
      payload = JSON.parse(body);
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    if (!payload.client) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Missing client field" }));
      return;
    }

    const appName = APP_NAMES[payload.client];
    if (!appName) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: `Restart not supported for "${payload.client}"` }));
      return;
    }

    const script = `
      sleep 1
      osascript -e 'quit app "${appName}"'
      sleep 3
      open -a "${appName}"
    `;

    spawn("bash", ["-c", script], {
      detached: true,
      stdio: "ignore",
    }).unref();

    const clientId = payload.client;
    const RESTART_CLEAR_DELAY_MS = 8000;
    setTimeout(() => {
      this.pendingRestarts.delete(clientId);
      this.broadcast({ type: "client_restarted", runtime: clientId });
    }, RESTART_CLEAR_DELAY_MS);

    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  }

  // ---------------------------------------------------------------------------
  // Approval endpoints
  // ---------------------------------------------------------------------------

  private async handleApprove(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
  ): Promise<void> {
    const id = pathname.split("/").at(-1)!;
    const body = await readBody(req);

    let payload: { decision?: string };
    try {
      payload = JSON.parse(body);
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    if (payload.decision !== "allow" && payload.decision !== "deny") {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "decision must be 'allow' or 'deny'" }));
      return;
    }

    const resolved = this.options.approvalQueue.decide(id, payload.decision);
    res.setHeader("Content-Type", "application/json");

    if (!resolved) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "Approval not found or already resolved" }));
      return;
    }

    res.end(JSON.stringify({ ok: true }));
  }

  private async handleRemoteApprovalRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const body = await readBody(req);

    let payload: { toolName?: string; params?: Record<string, unknown>; runtime?: string };
    try {
      payload = JSON.parse(body);
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    const toolName = payload.toolName ?? "unknown";
    const params = payload.params ?? {};
    const runtime = payload.runtime ?? "unknown";

    const decision = await this.options.approvalQueue.request(toolName, params, runtime);

    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ decision }));
  }
}
