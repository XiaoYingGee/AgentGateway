import { homedir } from "node:os";
import { resolve } from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { Server } from "node:http";

import type { AgentRequest, AgentAdapter, SessionContext } from "./types.js";
import { verifyMiddleware } from "./verify.js";
import { SessionManager } from "./session.js";
import { editDeferredResponse } from "./discord.js";
import { AdapterRegistry } from "./adapters/base.js";
import { ClaudeCodeAdapter } from "./adapters/claude-code.js";

// ---------------------------------------------------------------------------
// Configuration (environment variables)
// ---------------------------------------------------------------------------

const HMAC_SECRET = requireEnv("AGENT_HMAC_SECRET");
const DISCORD_APP_ID = requireEnv("DISCORD_APP_ID");
const DISCORD_BOT_TOKEN = requireEnv("DISCORD_BOT_TOKEN");

const DEFAULT_CWD = process.env["DEFAULT_CWD"] ?? resolve(homedir(), "Workspace");
const MAX_SESSIONS = parseInt(process.env["MAX_SESSIONS"] ?? "5", 10);
const SESSION_TIMEOUT_MS = parseInt(
  process.env["SESSION_TIMEOUT_MS"] ?? String(30 * 60 * 1000),
  10,
);

const HOST = "127.0.0.1";
const PORT = 7860;

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const sessionManager = new SessionManager(MAX_SESSIONS, SESSION_TIMEOUT_MS);

const registry = new AdapterRegistry();
registry.register(new ClaudeCodeAdapter());

// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------

// Declare the custom variable so Hono's context typing is satisfied
type Env = {
  Variables: {
    rawBody: string;
  };
};

const app = new Hono<Env>();

// HMAC verification middleware (skips /health automatically)
app.use("*", verifyMiddleware(HMAC_SECRET));

// ---- Health check (no auth) ------------------------------------------------

app.get("/health", (c) => {
  return c.json({
    status: "ok",
    activeSessions: sessionManager.getActiveCount(),
    adapters: registry.list(),
  });
});

// ---- Invoke endpoint --------------------------------------------------------

app.post("/invoke", async (c) => {
  try {
    const rawBody = c.get("rawBody");
    const req: AgentRequest = JSON.parse(rawBody);

    // Validate required fields
    if (!req.prompt || !req.threadId || !req.agentName) {
      return c.json({ error: "Missing required fields" }, 400);
    }

    // Look up adapter
    const adapter = registry.get(req.agentName);
    if (!adapter) {
      return c.json({ error: `Unknown agent: ${req.agentName}` }, 400);
    }

    // Get or create session (may throw if at capacity)
    let session;
    try {
      session = sessionManager.getOrCreate(req.threadId, req.cwd ?? DEFAULT_CWD);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Session limit reached";
      return c.json({ error: message }, 429);
    }

    // Respond immediately to the gateway so it knows we accepted the job.
    // The actual work happens asynchronously and results are pushed back
    // via the Discord REST API.
    //
    // We deliberately do NOT await the processing promise here so the
    // HTTP response is sent without blocking on Claude Code.
    processInBackground(adapter, req, session).catch((err) => {
      console.error(`[invoke] background processing error: ${err}`);
    });

    return c.json({ status: "accepted", sessionId: session.sessionId });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    console.error(`[invoke] ${message}`);
    return c.json({ error: message }, 500);
  }
});

// ---------------------------------------------------------------------------
// Background processing
// ---------------------------------------------------------------------------

async function processInBackground(
  adapter: AgentAdapter,
  req: AgentRequest,
  session: SessionContext,
): Promise<void> {
  try {
    const result = await adapter.invoke(req.prompt, session);

    await editDeferredResponse(
      DISCORD_APP_ID,
      req.interactionToken,
      result,
      DISCORD_BOT_TOKEN,
    );
  } catch (err) {
    const errorMessage =
      err instanceof Error ? err.message : "Unknown error";
    console.error(`[process] ${errorMessage}`);

    // Best-effort: inform the user via Discord that something went wrong
    try {
      await editDeferredResponse(
        DISCORD_APP_ID,
        req.interactionToken,
        `Error: ${errorMessage}`,
        DISCORD_BOT_TOKEN,
      );
    } catch (discordErr) {
      console.error(`[process] Failed to send error to Discord: ${discordErr}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let server: Server | null = null;

function startServer(): void {
  server = serve(
    {
      fetch: app.fetch,
      hostname: HOST,
      port: PORT,
    },
    (info) => {
      console.log(`[agent-service] Listening on http://${HOST}:${info.port}`);
    },
  ) as Server;
}

function shutdown(): void {
  console.log("[agent-service] Shutting down...");
  sessionManager.shutdown();

  if (server) {
    server.close(() => {
      console.log("[agent-service] Server closed.");
      process.exit(0);
    });

    // Force-exit after 10 s if connections linger
    setTimeout(() => {
      console.warn("[agent-service] Forcing exit after timeout.");
      process.exit(1);
    }, 10_000).unref();
  } else {
    process.exit(0);
  }
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

startServer();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[agent-service] Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}
