import { createBeforeToolCallHandler } from './src/hook.js';
import { setWebApprovalQueue } from './dist/core/prompt.js';
import { EventLogger } from './dist/core/logger.js';
import { PolicyEngine } from './dist/core/policy.js';
import * as net from 'node:net';
import * as http from 'node:http';

const REMOTE_PORT = parseInt(process.env.AGENTWALL_PORT ?? '', 10) || 7823;

function isPortReachable(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.connect(port, '127.0.0.1');
  });
}

function remoteApprovalRequest(toolName, params, runtime) {
  return new Promise((resolve) => {
    const data = JSON.stringify({ toolName, params, runtime });
    const req = http.request({
      hostname: '127.0.0.1',
      port: REMOTE_PORT,
      path: '/api/request-approval',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: 35000,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(body);
          resolve(result.decision || 'deny');
        } catch {
          resolve('deny');
        }
      });
    });
    req.on('error', () => resolve('deny'));
    req.on('timeout', () => { req.destroy(); resolve('deny'); });
    req.write(data);
    req.end();
  });
}

export default {
  id: 'agentwall',
  name: 'AgentWall',
  description: 'Intercepts all tool calls and prompts for user approval',
  version: '0.8.1',

  activate(api) {
    api.logger.info('[AgentWall] v0.8 activated — intercepting all tool calls');

    const policy = new PolicyEngine();

    const eventLogger = new EventLogger({});

    const handler = createBeforeToolCallHandler(api.logger, { eventLogger });
    api.on('before_tool_call', handler);

    // Never start a web server inside OpenClaw — it conflicts with the gateway.
    // If `agentwall ui` is already running, forward approval requests to it.
    // Otherwise, fall back to terminal y/n/a prompts (the default in prompt.ts).
    isPortReachable(REMOTE_PORT).then((running) => {
      if (running) {
        process.stderr.write(`[AgentWall] Forwarding approvals to web UI at http://localhost:${REMOTE_PORT}\n`);
        setWebApprovalQueue({
          request: (toolName, params, runtime) =>
            remoteApprovalRequest(toolName, params, runtime),
        });
      } else {
        process.stderr.write(`[AgentWall] No web UI detected — using terminal prompts\n`);
      }
    });
  }
};
