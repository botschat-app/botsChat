/**
 * BotsChat v2 Multi-Agent Protocol
 *
 * Core Protocol: all agent bridges MUST implement these message types.
 * Provider Extensions: optional, provider-specific messages (OpenClaw cron, etc.)
 *
 * Agent = Type (engine) × Role (persona). Each agent connects via a separate
 * WebSocket and authenticates with its own agentId.
 */

// ── Agent metadata shared across protocol ──

export type AgentType = "openclaw" | "cursor_cli" | "cursor_cloud" | "claude_code" | "mock";

export type AgentInfo = {
  id: string;
  name: string;
  type: AgentType;
  role: string;
  capabilities: string[];
  status: "connected" | "disconnected";
};

// ── Core Protocol: Agent → Cloud (outbound) ──

export type CoreOutbound =
  | {
      type: "auth";
      token: string;
      agentId?: string;
      agentType?: AgentType;
      agents?: string[];
      model?: string;
    }
  | {
      type: "agent.text";
      agentId?: string;
      sessionKey: string;
      text: string;
      requestId?: string;
      replyToId?: string;
      threadId?: string;
      encrypted?: boolean;
      messageId?: string;
      notifyPreview?: string;
    }
  | {
      type: "agent.media";
      agentId?: string;
      sessionKey: string;
      mediaUrl: string;
      caption?: string;
      replyToId?: string;
      threadId?: string;
      encrypted?: boolean;
      mediaEncrypted?: boolean;
      messageId?: string;
      notifyPreview?: string;
    }
  | { type: "agent.stream.start"; agentId?: string; sessionKey: string; runId: string }
  | { type: "agent.stream.chunk"; agentId?: string; sessionKey: string; runId: string; text: string }
  | { type: "agent.stream.end"; agentId?: string; sessionKey: string; runId: string }
  | { type: "status"; connected: boolean; agents?: string[]; model?: string }
  | { type: "pong" };

// ── Core Protocol: Cloud → Agent (inbound) ──

export type CoreInbound =
  | {
      type: "auth.ok";
      userId: string;
      agentId?: string;
      availableAgents?: AgentInfo[];
    }
  | { type: "auth.fail"; reason: string }
  | {
      type: "user.message";
      sessionKey: string;
      text: string;
      userId: string;
      messageId: string;
      targetAgentId?: string;
      mediaUrl?: string;
      parentMessageId?: string;
      parentText?: string;
      parentSender?: string;
      parentEncrypted?: number;
    }
  | { type: "user.media"; sessionKey: string; mediaUrl: string; userId: string }
  | { type: "user.action"; sessionKey: string; action: string; params: Record<string, unknown> }
  | { type: "user.command"; sessionKey: string; command: string; args?: string }
  | { type: "ping" };

// ── Agent-to-Agent Delegation ──

export type AgentRequestMessage = {
  type: "agent.request";
  agentId: string;
  targetAgentId: string;
  sessionKey: string;
  text: string;
  requestId: string;
  depth: number;
  context?: {
    summary: string;
    constraints?: string[];
    expectedOutput?: string;
  };
  ephemeral?: boolean;
};

export type AgentResponseMessage = {
  type: "agent.response";
  requestId: string;
  fromAgentId: string;
  text: string;
  sessionKey: string;
  error?: string;
};

// ── Verbose Trace (lv2/lv3 execution traces) ──

export type AgentTraceMessage = {
  type: "agent.trace";
  agentId: string;
  sessionKey: string;
  messageId: string;
  verboseLevel: 2 | 3;
  traceType: string;
  // lv2: "thinking" | "planning" | "reasoning" | "decision"
  // lv3: "file_read" | "file_write" | "command_exec" | "search_result" | "tool_call" | "reference"
  content: string;
  metadata?: Record<string, unknown>;
  encrypted?: boolean;
};

// ── Combined v2 Protocol Types ──

export type V2Outbound = CoreOutbound | AgentRequestMessage | AgentTraceMessage;
export type V2Inbound = CoreInbound | AgentResponseMessage;

// ── Delegation safety constants ──

export const MAX_DELEGATION_DEPTH = 5;
export const DELEGATION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ── Pending request tracking (used by ConnectionDO) ──

export type PendingRequest = {
  fromAgentId: string;
  sessionKey: string;
  depth: number;
  createdAt: number;
};
