import { WebSocket } from "ws";
import fs from "fs";
import crypto from "crypto";

const GATEWAY_URL = "ws://127.0.0.1:18789";
const GATEWAY_TOKEN = "6e6e7f36f55da683664f3f83cf6b21147b2bdeab8aff0f9b";

const identity = JSON.parse(fs.readFileSync(`${process.env.HOME}/.openclaw/identity/device.json`, "utf8"));
const deviceId  = identity.deviceId;
const publicKey = identity.publicKeyPem;
const privateKey = identity.privateKeyPem;

console.log(`device id: ${deviceId}\n`);

const ws = new WebSocket(GATEWAY_URL);

ws.on("open", () => console.log("✓ open..."));

ws.on("message", (raw) => {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }

  if (msg.type === "event" && msg.event === "connect.challenge") {
    const nonce     = msg.payload.nonce;
    const signedAt  = Date.now();
    const clientId  = "cli";
    const clientMode = "cli";
    const role      = "operator";
    const scopes    = ["operator.read", "operator.approvals"].join(",");
    const token     = GATEWAY_TOKEN;

    // v2 pipe-delimited signing payload
    const signingPayload = [`v2`, deviceId, clientId, clientMode, role, scopes, String(signedAt), token, nonce].join("|");
    const signature = crypto.sign(null, Buffer.from(signingPayload), privateKey).toString("base64");

    console.log(`✓ challenge: ${nonce}`);
    console.log(`   payload:  ${signingPayload}`);

    ws.send(JSON.stringify({
      type: "req", id: "1", method: "connect",
      params: {
        minProtocol: 3, maxProtocol: 3,
        client: { id: clientId, version: "0.1.0", platform: "macos", mode: clientMode },
        role,
        scopes: ["operator.read", "operator.approvals"],
        caps: [], commands: [], permissions: {},
        auth: { token: GATEWAY_TOKEN },
        locale: "en-US",
        userAgent: "openclaw-cli/0.1.0",
        device: { id: deviceId, publicKey, signature, signedAt, nonce },
      },
    }));
    return;
  }

  if (msg.type === "res") {
    if (msg.ok) {
      console.log(`\n✓ HANDSHAKE SUCCEEDED`);
      console.log(`   device token: ${msg.payload?.auth?.deviceToken ?? "(none)"}`);
      console.log(`   scopes:       ${msg.payload?.auth?.scopes?.join(", ")}`);
      console.log(`\n✓ Risk 1 fully resolved — pipe-delimited v2 payload confirmed.\n`);
    } else {
      console.log(`\n✗ FAILED: ${JSON.stringify(msg.error, null, 2)}`);
    }
    ws.close();
    return;
  }
});

ws.on("error", (err) => { console.error(`✗ ${err.message}`); process.exit(1); });
ws.on("close", () => { console.log("── closed\n"); process.exit(0); });
setTimeout(() => { console.error("✗ timeout"); ws.close(); process.exit(1); }, 10000);
