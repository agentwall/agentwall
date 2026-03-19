import WebSocket from "ws";
import {
  randomUUID,
  generateKeyPairSync,
  createHash,
  sign,
  createPublicKey,
} from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ActionProposal } from "../../core/types.js";

const AGENTWALL_DIR = join(homedir(), ".agentwall");
const DEVICE_FILE = join(AGENTWALL_DIR, "device.json");

const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

interface DeviceIdentity {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
  deviceToken: string | null;
}

export interface OpenClawAdapterOptions {
  gatewayUrl: string;
  token: string;
  verbose: boolean;
}

type ProposalHandler = (proposal: ActionProposal) => Promise<void>;

export class OpenClawAdapter {
  readonly name = "openclaw" as const;

  private ws: WebSocket | null = null;
  private handler: ProposalHandler | null = null;
  private device: DeviceIdentity;
  private options: OpenClawAdapterOptions;
  private shouldReconnect = true;
  private reconnecting = false;
  private pendingRequests = new Map<
    string,
    { resolve: (data: unknown) => void; reject: (err: Error) => void }
  >();

  constructor(options: OpenClawAdapterOptions) {
    this.options = options;
    this.device = this.loadOrCreateDevice();
  }

  onProposal(handler: ProposalHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    await this.connect();
  }

  stop(): void {
    this.shouldReconnect = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  async resolve(approvalId: string, approved: boolean): Promise<void> {
    try {
      await this.sendRequest("exec.approval.resolve", { approvalId, approved });
    } catch (err) {
      process.stderr.write(
        `  ${YELLOW}warning:${RESET} failed to resolve approval ${approvalId}: ${(err as Error).message}\n`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Device identity
  // ---------------------------------------------------------------------------

  private loadOrCreateDevice(): DeviceIdentity {
    mkdirSync(AGENTWALL_DIR, { recursive: true });

    if (existsSync(DEVICE_FILE)) {
      return JSON.parse(readFileSync(DEVICE_FILE, "utf-8"));
    }

    const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    const spkiDer = createPublicKey(publicKey).export({
      type: "spki",
      format: "der",
    });
    const rawKeyBytes = spkiDer.subarray(12);
    const deviceId = createHash("sha256").update(rawKeyBytes).digest("hex");

    const device: DeviceIdentity = {
      deviceId,
      publicKeyPem: publicKey,
      privateKeyPem: privateKey,
      deviceToken: null,
    };

    writeFileSync(DEVICE_FILE, JSON.stringify(device, null, 2), { mode: 0o600 });
    return device;
  }

  // ---------------------------------------------------------------------------
  // WebSocket connection + handshake
  // ---------------------------------------------------------------------------

  private connect(): Promise<void> {
    return new Promise<void>((connectResolve, connectReject) => {
      let handshakeComplete = false;
      let errorHandled = false;

      const ws = new WebSocket(this.options.gatewayUrl);
      this.ws = ws;

      ws.on("error", (err: NodeJS.ErrnoException) => {
        if (handshakeComplete || errorHandled) return;
        errorHandled = true;

        if (err.code === "ECONNREFUSED") {
          connectReject(
            new Error(
              `Cannot connect to OpenClaw gateway at ${this.options.gatewayUrl}. Is the gateway running?`,
            ),
          );
        } else {
          connectReject(new Error(`WebSocket error: ${err.message}`));
        }
      });

      ws.on("close", () => {
        for (const [, pending] of this.pendingRequests) {
          pending.reject(new Error("WebSocket closed"));
        }
        this.pendingRequests.clear();

        if (!handshakeComplete) {
          if (!errorHandled) {
            errorHandled = true;
            connectReject(
              new Error("WebSocket closed before handshake completed"),
            );
          }
        } else if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      });

      ws.on("message", (data) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }

        if (this.options.verbose) {
          process.stderr.write(
            `  ${DIM}← ${JSON.stringify(msg).slice(0, 200)}${RESET}\n`,
          );
        }

        if (msg.type === "event" && msg.event === "connect.challenge") {
          const payload = msg.payload as Record<string, unknown>;
          const requestId = randomUUID();
          const params = this.buildConnectParams(payload.nonce as string);

          this.pendingRequests.set(requestId, {
            resolve: (resPayload) => {
              const hello = resPayload as Record<string, unknown> | undefined;
              const auth = hello?.auth as Record<string, unknown> | undefined;
              if (auth?.deviceToken) {
                this.device.deviceToken = auth.deviceToken as string;
                writeFileSync(
                  DEVICE_FILE,
                  JSON.stringify(this.device, null, 2),
                  { mode: 0o600 },
                );
              }
              handshakeComplete = true;
              connectResolve();
            },
            reject: (err) => {
              if (!errorHandled) {
                errorHandled = true;
                connectReject(err);
              }
            },
          });

          const outMsg = JSON.stringify({
            type: "req",
            id: requestId,
            method: "connect",
            params,
          });

          if (this.options.verbose) {
            process.stderr.write(
              `  ${DIM}→ ${outMsg.slice(0, 200)}${RESET}\n`,
            );
          }
          ws.send(outMsg);

        } else if (msg.type === "res") {
          const pending = this.pendingRequests.get(msg.id as string);
          if (!pending) return;
          this.pendingRequests.delete(msg.id as string);

          if (msg.ok) {
            pending.resolve(msg.payload);
          } else {
            const p = msg.payload as Record<string, unknown> | undefined;
            const errMsg =
              (p?.message as string) || (p?.error as string) || "Unknown error";
            const code = p?.code as string | undefined;

            if (code === "AUTH_TOKEN_MISMATCH" || errMsg.includes("AUTH_TOKEN_MISMATCH")) {
              pending.reject(
                new Error(
                  "Auth token mismatch. Set OPENCLAW_GATEWAY_TOKEN or pass --token.",
                ),
              );
            } else if (code === "PAIRING_REQUIRED" || errMsg.includes("PAIRING_REQUIRED")) {
              pending.reject(
                new Error(
                  "Pairing required. This should auto-resolve — try restarting agentwall.",
                ),
              );
            } else {
              pending.reject(new Error(`Gateway rejected connect: ${errMsg}`));
            }
          }

        } else if (
          msg.type === "event" &&
          msg.event === "exec.approval.requested"
        ) {
          this.handleApprovalRequest(msg.payload as Record<string, unknown>);
        }
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Handshake helpers
  // ---------------------------------------------------------------------------

  private buildConnectParams(nonce: string): object {
    const signedAtMs = Date.now();
    const token = this.options.token;

    const signingPayload = [
      "v2",
      this.device.deviceId,
      "cli",
      "cli",
      "operator",
      "operator.read,operator.approvals",
      String(signedAtMs),
      token,
      nonce,
    ].join("|");

    const signature = sign(
      null,
      Buffer.from(signingPayload),
      this.device.privateKeyPem,
    );

    return {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: "cli",
        version: "0.1.0",
        platform: process.platform,
        mode: "cli",
      },
      role: "operator",
      scopes: ["operator.read", "operator.approvals"],
      caps: [],
      commands: [],
      permissions: {},
      auth: { token },
      locale: "en-US",
      userAgent: "agentwall/0.1.0",
      device: {
        id: this.device.deviceId,
        publicKey: this.device.publicKeyPem,
        signature: signature.toString("base64"),
        signedAt: signedAtMs,
        nonce,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Exec approval
  // ---------------------------------------------------------------------------

  private async handleApprovalRequest(
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.handler) return;

    const plan = payload.systemRunPlan as Record<string, unknown> | undefined;
    const argv = plan?.argv as string[] | undefined;

    const proposal: ActionProposal = {
      approvalId: payload.approvalId as string,
      runtime: "openclaw",
      command: (plan?.rawCommand as string) || argv?.join(" ") || "",
      workingDir: (plan?.cwd as string) || "",
      toolInput: payload,
      sessionId: payload.sessionId as string | undefined,
      agentId: payload.agentId as string | undefined,
    };

    await this.handler(proposal);
  }

  // ---------------------------------------------------------------------------
  // Reconnection
  // ---------------------------------------------------------------------------

  private scheduleReconnect(): void {
    if (this.reconnecting) return;
    this.reconnecting = true;
    process.stderr.write(
      `  ${YELLOW}⚠ Disconnected from OpenClaw gateway. Reconnecting...${RESET}\n`,
    );

    const attempt = async (): Promise<void> => {
      while (this.shouldReconnect) {
        await new Promise<void>((r) => setTimeout(r, 2000));
        if (!this.shouldReconnect) break;
        try {
          await this.connect();
          this.reconnecting = false;
          process.stderr.write(
            `  ${GREEN}✓ Reconnected to OpenClaw gateway${RESET}\n`,
          );
          return;
        } catch {
          // silently retry
        }
      }
      this.reconnecting = false;
    };

    attempt();
  }

  // ---------------------------------------------------------------------------
  // Request helpers
  // ---------------------------------------------------------------------------

  private sendRequest(method: string, params: object): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("WebSocket not connected"));
        return;
      }

      const id = randomUUID();
      this.pendingRequests.set(id, { resolve, reject });

      const msg = JSON.stringify({ type: "req", id, method, params });
      if (this.options.verbose) {
        process.stderr.write(`  ${DIM}→ ${msg.slice(0, 200)}${RESET}\n`);
      }
      this.ws.send(msg);
    });
  }
}
