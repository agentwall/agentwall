import { askUser, printDecision } from '../dist/core/prompt.js';
import { logDecision } from './logger.js';
import { getPolicy } from './policy.js';
import { randomUUID } from 'node:crypto';

/**
 * Creates the before_tool_call hook handler.
 *
 * Return values:
 *   { block: true, blockReason: '...' }  → tool call is blocked
 *   { params: { ... } }                  → tool call runs with modified params
 *   undefined / void                     → tool call runs with original params
 */
export function createBeforeToolCallHandler(logger) {
  return async (event, ctx) => {
    const { toolName, params } = event;

    logger.info(`[AgentWall] Tool call intercepted: ${toolName}`);

    const policy = getPolicy(toolName, params);

    if (policy === 'block') {
      logger.warn(`[AgentWall] Blocked by policy: ${toolName}`);
      printDecision('deny', toolName, 'policy rule matched');
      logDecision({ toolName, params, decision: 'blocked', reason: 'policy', ctx });
      return {
        block: true,
        blockReason: `AgentWall: tool '${toolName}' is blocked by policy`
      };
    }

    if (policy === 'allow') {
      logger.info(`[AgentWall] Auto-allowed: ${toolName}`);
      printDecision('allow', toolName, 'auto-allow');
      logDecision({ toolName, params, decision: 'allowed', reason: 'auto-allow', ctx });
      return;
    }

    const proposal = {
      approvalId: randomUUID(),
      runtime: 'openclaw',
      command: toolName,
      workingDir: params?.path || params?.file || '',
      toolInput: params,
    };

    let userDecision = 'deny';
    try {
      userDecision = await askUser(proposal, 'flagged as sensitive');
    } catch (err) {
      logger.error(`[AgentWall] Approval prompt failed: ${err.message}. Blocking for safety.`);
      printDecision('deny', toolName, 'prompt error — blocked for safety');
      logDecision({ toolName, params, decision: 'blocked', reason: 'prompt-error', ctx });
      return {
        block: true,
        blockReason: 'AgentWall: approval prompt failed — blocked for safety'
      };
    }

    const approved = userDecision === 'allow';
    printDecision(userDecision, toolName, approved ? 'user approved' : 'user denied');
    logDecision({
      toolName,
      params,
      decision: approved ? 'approved' : 'blocked',
      reason: 'user',
      ctx
    });

    if (!approved) {
      return {
        block: true,
        blockReason: `AgentWall: user denied tool call '${toolName}'`
      };
    }
  };
}
