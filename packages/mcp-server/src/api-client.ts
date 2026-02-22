/**
 * Lightweight HTTP client for the BotsChat Cloud REST API.
 * Used by the MCP Server to fetch data on behalf of agents.
 */

export type BotsChatApiConfig = {
  baseUrl: string;   // e.g. "http://localhost:8788" or "https://botschat-v2.auxtenwpc.workers.dev"
  token: string;     // Bearer JWT token
};

export class BotsChatApiClient {
  constructor(private config: BotsChatApiConfig) {}

  private async request<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(path, this.config.baseUrl);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
      }
    }
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${this.config.token}` },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  async queryHistory(params: {
    sessionKey: string;
    verboseLevel?: number;
    limit?: number;
    senderFilter?: string;
    agentIdFilter?: string;
    traceTypeFilter?: string;
    keyword?: string;
    beforeMessageId?: string;
  }) {
    return this.request<{
      messages: Array<{
        id: string;
        sender: string;
        senderAgentId?: string;
        senderAgentName?: string;
        targetAgentId?: string;
        text: string;
        mediaUrl?: string;
        encrypted: boolean;
        timestamp: number;
        traces?: Array<{
          verboseLevel: number;
          traceType: string;
          content: string;
          metadata?: Record<string, unknown>;
        }>;
      }>;
      hasMore: boolean;
    }>("/api/v2/messages/query", {
      sessionKey: params.sessionKey,
      verboseLevel: String(params.verboseLevel ?? 1),
      limit: String(params.limit ?? 50),
      senderFilter: params.senderFilter ?? "",
      agentIdFilter: params.agentIdFilter ?? "",
      traceTypeFilter: params.traceTypeFilter ?? "",
      keyword: params.keyword ?? "",
      beforeMessageId: params.beforeMessageId ?? "",
    });
  }

  async listAgents() {
    return this.request<{
      agents: Array<{
        id: string;
        name: string;
        type: string;
        role: string;
        systemPrompt: string;
        skills: Array<{ name: string; description: string }>;
        capabilities: string[];
        status: string;
        lastConnectedAt: number | null;
      }>;
    }>("/api/v2/agents");
  }

  async getAgentSkills(agentId: string) {
    const data = await this.request<{
      id: string;
      skills: Array<{ name: string; description: string }>;
    }>(`/api/v2/agents/${agentId}`);
    return data.skills;
  }

  async getChannels() {
    return this.request<{
      channels: Array<{
        id: string;
        name: string;
        description: string;
        systemPrompt: string;
        defaultAgentId?: string;
      }>;
    }>("/api/channels");
  }
}
