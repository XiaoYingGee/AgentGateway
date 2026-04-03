/**
 * Request payload forwarded from the CF Worker gateway.
 */
export interface AgentRequest {
  prompt: string;
  threadId: string;
  userId: string;
  channelId: string;
  interactionToken: string;
  agentName: string; // "claude-code" for now
  cwd?: string; // optional working directory override
}

/**
 * An in-memory session tied to a Discord thread.
 */
export interface SessionContext {
  sessionId: string;
  threadId: string;
  cwd: string;
  lastActivity: number;
  conversationHistory: Array<{ role: string; content: string }>;
}

/**
 * Every Agent backend must implement this interface.
 */
export interface AgentAdapter {
  name: string;
  invoke(prompt: string, session: SessionContext): Promise<string>;
  destroySession(sessionId: string): void;
}
