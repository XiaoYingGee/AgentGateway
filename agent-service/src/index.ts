import "dotenv/config.js";

// Global outbound proxy (e.g. for Discord API calls)
const PROXY_URL = process.env["HTTPS_PROXY"] || process.env["HTTP_PROXY"];
if (PROXY_URL) {
  import("undici").then(({ ProxyAgent, setGlobalDispatcher }) => {
    setGlobalDispatcher(new ProxyAgent(PROXY_URL));
    console.log(`[agent-service] Global proxy set: ${PROXY_URL}`);
  });
}

// Ensure Node.js is in PATH for Claude Code SDK to spawn processes
import { dirname, delimiter, resolve } from "node:path";
const nodeDir = dirname(process.execPath);
if (!process.env.PATH?.includes(nodeDir)) {
  process.env.PATH = nodeDir + (process.env.PATH ? delimiter + process.env.PATH : "");
}

import { homedir } from "node:os";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { Server } from "node:http";

import type { AgentRequest, AgentAdapter, SessionContext } from "./types.js";
import { verifyMiddleware } from "./verify.js";
import { SessionManager } from "./session.js";
import { editDeferredResponse } from "./discord.js";
import { AdapterRegistry } from "./adapters/base.js";
import { ClaudeCodeAdapter, validateCwd } from "./adapters/claude-code.js";

// ---------------------------------------------------------------------------
// Configuration (environment variables)
// ---------------------------------------------------------------------------

const HMAC_SECRET = requireEnv("AGENT_HMAC_SECRET");
const DISCORD_APP_ID = requireEnv("DISCORD_APP_ID");
// DISCORD_BOT_TOKEN is no longer required — interaction webhooks are
// authenticated by the interaction token in the URL path.

const DEFAULT_CWD = process.env["DEFAULT_CWD"] ?? resolve(homedir(), "Workspace");
const MAX_SESSIONS = parseInt(process.env["MAX_SESSIONS"] ?? "5", 10);
const SESSION_TIMEOUT_MS = parseInt(
  process.env["SESSION_TIMEOUT_MS"] ?? String(30 * 60 * 1000),
  10,
);

const HOST = "127.0.0.1";
const PORT = 8860;

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
    const parsed = JSON.parse(rawBody);

    // Strict type + field validation
    const check = validateRequest(parsed);
    if (!check.valid) {
      return c.json({ error: check.error }, 400);
    }
    const req = check.data;

    // Normalise agent name to lowercase for lookup
    const adapter = registry.get(req.agentName.toLowerCase());
    if (!adapter) {
      return c.json({ error: `Unknown agent: ${req.agentName}` }, 400);
    }

    // Early cwd validation (expand ~ before checking)
    const cwd = (req.cwd ?? DEFAULT_CWD).replace(/^~(?=[/\\]|$)/, homedir());
    if (!validateCwd(cwd)) {
      return c.json({ error: `Working directory not allowed: ${req.cwd ?? DEFAULT_CWD}` }, 403);
    }

    // Get or create session (may throw if at capacity)
    let session;
    try {
      session = sessionManager.getOrCreate(req.threadId, cwd);
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
    console.log(`[process] invoking adapter for prompt: "${req.prompt.slice(0, 60)}..."`);
    const result = await adapter.invoke(req.prompt, session);
    console.log(`[process] adapter returned ${result.length} chars`);

    await editDeferredResponse(
      DISCORD_APP_ID,
      req.interactionToken,
      result,
    );
    console.log(`[process] Discord response sent`);
  } catch (err) {
    const errorMessage =
      err instanceof Error ? err.message : "Unknown error";
    console.error(`[process] adapter/discord error: ${errorMessage}`);

    // Best-effort: inform the user via Discord that something went wrong
    try {
      await editDeferredResponse(
        DISCORD_APP_ID,
        req.interactionToken,
        `Error: ${errorMessage}`,
      );
    } catch (discordErr) {
      const msg = discordErr instanceof Error ? discordErr.message : String(discordErr);
      console.error(`[process] Discord callback also failed: ${msg}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let server: Server | null = null;
let isShuttingDown = false;

function startServer(): void {
  server = serve(
    {
      fetch: app.fetch,
      hostname: HOST,
      port: PORT,
    },
    (info) => {
      console.log(`[agent-service] Listening on http://${HOST}:${info.port}`);
      console.log(`[agent-service] Stop: curl http://${HOST}:${info.port}/shutdown`);
    },
  ) as Server;

  // Reduce keep-alive timeout so idle connections don't block shutdown
  server.keepAliveTimeout = 5_000;
}

function shutdown(): void {
  if (isShuttingDown) return; // prevent re-entry
  isShuttingDown = true;

  console.log("[agent-service] Shutting down...");
  sessionManager.shutdown();

  if (server) {
    // Stop accepting new connections
    server.close(() => {
      console.log("[agent-service] Server closed.");
      process.exit(0);
    });

    // Force-close existing connections (Node 18.2+)
    if (typeof server.closeAllConnections === "function") {
      server.closeAllConnections();
    }

    // Force-exit after 3s if something still hangs
    setTimeout(() => {
      console.warn("[agent-service] Forcing exit.");
      process.exit(1);
    }, 3_000).unref();
  } else {
    process.exit(0);
  }
}

// Standard signal handlers
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Graceful shutdown endpoint (useful on Windows where signals are unreliable)
app.get("/shutdown", (c) => {
  console.log("[agent-service] Shutdown requested via HTTP");
  // Respond first, then shut down
  setTimeout(shutdown, 100);
  return c.text("Shutting down...");
});

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

/**
 * Validate and coerce the raw parsed JSON into a typed AgentRequest.
 * Returns an error string if validation fails.
 */
export function validateRequest(
  raw: unknown,
): { valid: true; data: AgentRequest } | { valid: false; error: string } {
  if (raw === null || typeof raw !== "object") {
    return { valid: false, error: "Request body must be a JSON object" };
  }

  const obj = raw as Record<string, unknown>;

  // Required string fields
  const required: (keyof AgentRequest)[] = ["prompt", "threadId", "agentName", "interactionToken"];
  for (const field of required) {
    const val = obj[field];
    if (typeof val !== "string" || val.length === 0) {
      return { valid: false, error: `Missing or invalid required field: ${field}` };
    }
  }

  // Optional string fields — must be string if present and non-null
  const optional: (keyof AgentRequest)[] = ["userId", "channelId", "cwd"];
  for (const field of optional) {
    const val = obj[field];
    if (val !== undefined && val !== null && typeof val !== "string") {
      return { valid: false, error: `Field ${field} must be a string` };
    }
  }

  return {
    valid: true,
    data: {
      prompt: obj.prompt as string,
      threadId: obj.threadId as string,
      agentName: obj.agentName as string,
      interactionToken: obj.interactionToken as string,
      userId: (obj.userId as string) ?? "",
      channelId: (obj.channelId as string) ?? "",
      cwd: (obj.cwd as string | undefined),
    },
  };
}
