#!/usr/bin/env node
/**
 * BotsChat MCP Server — provides AI agents with tools to query chat history,
 * discover other agents, and access channel context.
 *
 * Runs as a stdio MCP server, designed to be embedded in bridge processes
 * or configured in .cursor/mcp.json for Cursor Agent.
 *
 * Usage:
 *   BOTSCHAT_URL=http://localhost:8788 BOTSCHAT_TOKEN=xxx botschat-mcp
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { BotsChatApiClient } from "./api-client.js";

const BOTSCHAT_URL = process.env.BOTSCHAT_URL ?? "http://localhost:8788";
const BOTSCHAT_TOKEN = process.env.BOTSCHAT_TOKEN ?? "";

if (!BOTSCHAT_TOKEN) {
  console.error("Error: BOTSCHAT_TOKEN environment variable is required");
  process.exit(1);
}

const api = new BotsChatApiClient({ baseUrl: BOTSCHAT_URL, token: BOTSCHAT_TOKEN });

const server = new Server(
  { name: "botschat", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

// ── Tool definitions ──

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "botschat_query_history",
      description:
        "Query chat message history from BotsChat with verbose-level filtering. " +
        "Level 1 = user inputs + agent conclusions. " +
        "Level 2 = + agent thinking/reasoning process. " +
        "Level 3 = + reference materials (file reads, command outputs, tool calls).",
      inputSchema: {
        type: "object" as const,
        properties: {
          sessionKey: { type: "string", description: "The BotsChat session key to query" },
          verboseLevel: {
            type: "number",
            description: "1=conclusions only, 2=+thinking, 3=+references (default: 1)",
            enum: [1, 2, 3],
          },
          limit: { type: "number", description: "Max messages to return (default: 50, max: 200)" },
          senderFilter: { type: "string", enum: ["user", "agent", "all"], description: "Filter by sender" },
          agentIdFilter: { type: "string", description: "Filter messages by a specific agent ID" },
          traceTypeFilter: {
            type: "string",
            description: "Filter traces by type: thinking, file_read, file_write, command_exec, etc.",
          },
          keyword: { type: "string", description: "Keyword search across message text" },
          beforeMessageId: { type: "string", description: "Pagination: fetch messages before this ID" },
        },
        required: ["sessionKey"],
      },
    },
    {
      name: "botschat_list_agents",
      description:
        "List all available agents in the user's BotsChat workspace. " +
        "Returns each agent's name, type (openclaw/cursor/claude), role, skills, capabilities, and connection status.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "botschat_get_channel_context",
      description:
        "Get the context for a channel: name, system prompt, project description, and default agent. " +
        "Useful for understanding the project background before starting work.",
      inputSchema: {
        type: "object" as const,
        properties: {
          sessionKey: { type: "string", description: "Session key (used to identify the channel)" },
        },
        required: ["sessionKey"],
      },
    },
    {
      name: "botschat_get_agent_skills",
      description: "Query the skill list of a specific agent. Useful for understanding what an agent can do before delegating tasks.",
      inputSchema: {
        type: "object" as const,
        properties: {
          agentId: { type: "string", description: "The agent ID to query skills for" },
        },
        required: ["agentId"],
      },
    },
    {
      name: "botschat_send_message",
      description:
        "Send a message as the current agent in a BotsChat session. " +
        "Optionally target another agent with @mention for task delegation.",
      inputSchema: {
        type: "object" as const,
        properties: {
          sessionKey: { type: "string", description: "The session to send the message in" },
          text: { type: "string", description: "Message text to send" },
          targetAgentId: { type: "string", description: "Optional: target agent ID for @mention delegation" },
        },
        required: ["sessionKey", "text"],
      },
    },
  ],
}));

// ── Tool implementations ──

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "botschat_query_history": {
        const a = args as {
          sessionKey: string;
          verboseLevel?: number;
          limit?: number;
          senderFilter?: string;
          agentIdFilter?: string;
          traceTypeFilter?: string;
          keyword?: string;
          beforeMessageId?: string;
        };
        const result = await api.queryHistory(a);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "botschat_list_agents": {
        const result = await api.listAgents();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result.agents, null, 2),
            },
          ],
        };
      }

      case "botschat_get_channel_context": {
        const a = args as { sessionKey: string };
        const channels = await api.getChannels();
        const channel = channels.channels[0];
        return {
          content: [
            {
              type: "text" as const,
              text: channel
                ? JSON.stringify({
                    channelName: channel.name,
                    systemPrompt: channel.systemPrompt,
                    description: channel.description,
                    defaultAgentId: channel.defaultAgentId,
                  }, null, 2)
                : JSON.stringify({ error: "No channel found for session", sessionKey: a.sessionKey }),
            },
          ],
        };
      }

      case "botschat_get_agent_skills": {
        const a = args as { agentId: string };
        const skills = await api.getAgentSkills(a.agentId);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(skills, null, 2),
            },
          ],
        };
      }

      case "botschat_send_message": {
        const a = args as { sessionKey: string; text: string; targetAgentId?: string };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "queued",
                note: "Message sending via MCP will be implemented when WebSocket bridge is available. For now, use the chat UI.",
                sessionKey: a.sessionKey,
                text: a.text,
                targetAgentId: a.targetAgentId,
              }, null, 2),
            },
          ],
        };
      }

      default:
        return {
          content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
});

// ── Start server ──

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("BotsChat MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal:", error);
  process.exit(1);
});
