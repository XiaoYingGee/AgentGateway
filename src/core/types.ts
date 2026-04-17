/** Unified inbound message from any IM platform */
export interface InboundMessage {
  platform: string;
  sessionKey: string;
  chatId: string; // S3: explicit chatId — the channel to send replies to
  accountId: string;
  userId: string;
  userName?: string;
  text: string;
  threadId?: string;
  replyToId?: string;
  raw: unknown;
}

/** R2: sendMessage returns enough context for editMessage on any platform */
export interface SendResult {
  messageId: string;
  chatId: string;
  threadId?: string;
}

/** IM Adapter — bridges a chat platform to the gateway */
export interface IMAdapter {
  platform: string;
  accountId: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(params: {
    chatId: string;
    text: string;
    threadId?: string;
    replyToId?: string;
  }): Promise<SendResult>;
  sendTyping?(chatId: string): Promise<void>;
  /** R2: Edit an existing message — uses SendResult target for correct chatId */
  editMessage?(target: SendResult, text: string): Promise<void>;
  onMessage(handler: (msg: InboundMessage) => Promise<void>): void;
  capabilities?: { threads?: boolean; reactions?: boolean };
  /** P5: health check — returns false if adapter is in a degraded state */
  isHealthy?(): boolean;
}

/** AI Adapter — bridges an AI backend to the gateway */
export interface AIAdapter {
  name: string;
  supportsResume: boolean;
  invoke(params: {
    prompt: string;
    sessionId?: string;
    cwd?: string;
    onChunk?: (text: string) => void;
  }): Promise<{ text: string; sessionId?: string; exitCode: number }>;
  /** P3: kill all active child processes on shutdown */
  killAll?(): void;
}

/** Session state for an active conversation */
export interface Session {
  key: string;
  aiSessionId?: string;
  /** cwd used for this session's AI invocations */
  cwd?: string;
  busy: boolean;
  createdAt: number;
  lastActiveAt: number;
}
