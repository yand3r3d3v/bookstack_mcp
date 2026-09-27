#!/usr/bin/env node
// HTTP transport (MCP Streamable HTTP) for running one shared server, e.g. behind a reverse proxy
// under a sub-path such as https://tools.example.com/bookstack-mcp. Every user signs in with their
// own BookStack API token (see oauth.ts); the server itself holds no BookStack credentials.

import { randomBytes } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { BookStackClient } from "./bookstack.js";
import { OAuth, type Reply } from "./oauth.js";
import { createServer, readOnly, version } from "./server.js";

const env = process.env;
const DEFAULT_REDIRECT_HOSTS = "claude.ai,claude.com,localhost,127.0.0.1,[::1]";
const MAX_BODY = 64 * 1024;

const bookstackUrl = env.BOOKSTACK_URL?.trim();
if (!bookstackUrl) fatal("BOOKSTACK_URL is not set: the address of your BookStack, e.g. https://wiki.example.com");

const port = Number(env.MCP_PORT || 3000);
const host = env.MCP_HOST || "127.0.0.1";

// The public address is needed for the OAuth metadata: behind a proxy the server can't know its
// own external URL, and with a sub-path every endpoint has to include that path.
const publicUrl = (env.MCP_PUBLIC_URL?.trim() || `http://localhost:${port}`).replace(/\/+$/, "");
let basePath: string;
try {
  const url = new URL(publicUrl);
  if (!/^https?:$/.test(url.protocol) || url.search || url.hash) throw new Error();
  basePath = url.pathname.replace(/\/+$/, "");
} catch {
  fatal(`MCP_PUBLIC_URL must be an http(s) URL without query or fragment, e.g. https://tools.example.com/bookstack-mcp (got ${publicUrl})`);
}

let secret = env.MCP_AUTH_SECRET?.trim() ?? "";
if (!secret) {
  secret = randomBytes(32).toString("base64url");
  console.warn(
    "MCP_AUTH_SECRET is not set, using a random one: everyone will have to reconnect after a restart.\n" +
      "Set it to a long random string, e.g. the output of `openssl rand -base64 32`.",
  );
} else if (secret.length < 32) {
  console.warn("MCP_AUTH_SECRET is short; use at least 32 random characters (`openssl rand -base64 32`).");
}

const redirectHosts = (env.MCP_ALLOWED_REDIRECT_HOSTS?.trim() || DEFAULT_REDIRECT_HOSTS)
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

const oauth = new OAuth({
  publicUrl,
  bookstackUrl,
  secret,
  redirectHosts: redirectHosts.includes("*") ? "*" : redirectHosts,
});

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const server = createHttpServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  if (!path.endsWith("/health")) res.on("finish", () => console.log(`${req.method} ${path} ${res.statusCode}`));

  handle(req, res, path).catch((err) => {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) send(res, { status, json: { error: status === 500 ? "server_error" : "invalid_request", error_description: err.message } });
    else res.end();
  });
});

async function handle(req: IncomingMessage, res: ServerResponse, fullPath: string): Promise<void> {
  cors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  // Standard discovery URLs put .well-known at the root of the domain, before the sub-path
  // (RFC 8414 / RFC 9728). They only reach us if the proxy forwards them — see the README.
  if (fullPath === `/.well-known/oauth-authorization-server${basePath}` || fullPath === `/.well-known/openid-configuration${basePath}`) {
    return send(res, oauth.serverMetadata());
  }
  if (fullPath === `/.well-known/oauth-protected-resource${basePath}/mcp`) return send(res, oauth.resourceMetadata());

  // The proxy may pass the sub-path through or strip it; accept both.
  let path = fullPath;
  if (basePath && (path === basePath || path.startsWith(`${basePath}/`))) path = path.slice(basePath.length) || "/";
  const method = req.method ?? "GET";
  const allow = (...methods: string[]) => {
    if (methods.includes(method)) return;
    res.setHeader("Allow", methods.join(", "));
    throw new HttpError(405, `Use ${methods.join(" or ")}.`);
  };

  switch (path) {
    case "/mcp":
      return handleMcp(req, res);

    case "/.well-known/oauth-protected-resource":
    case "/.well-known/oauth-protected-resource/mcp":
      allow("GET");
      return send(res, oauth.resourceMetadata());

    case "/.well-known/oauth-authorization-server":
    case "/.well-known/openid-configuration":
      allow("GET");
      return send(res, oauth.serverMetadata());

    case "/.well-known/jwks.json":
      allow("GET");
      return send(res, { status: 200, json: { keys: [] } });

    case "/register":
      allow("POST");
      return send(res, oauth.register(parseJson(await readBody(req))));

    case "/authorize":
      allow("GET", "POST");
      if (method === "GET") return send(res, oauth.authorizePage(new URL(req.url!, "http://localhost").searchParams));
      return send(res, await oauth.authorizeSubmit(new URLSearchParams(await readBody(req))));

    case "/token":
      allow("POST");
      return send(res, oauth.token(parseForm(req, await readBody(req)), req.headers.authorization));

    case "/health":
      return send(res, { status: 200, json: { status: "ok" } });

    case "/":
      return send(res, { status: 200, json: { name: "bookstack-mcp", version, mcp: oauth.resource } });

    default:
      return send(res, { status: 404, json: { error: "not_found", error_description: `Nothing at ${fullPath}. The MCP endpoint is ${oauth.resource}` } });
  }
}

/**
 * Stateless Streamable HTTP: a fresh MCP server per request, bound to the caller's BookStack token.
 * No sessions to keep, so any number of instances can run behind a load balancer.
 */
async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    // No server-initiated messages, so no standalone SSE stream (GET) and no sessions (DELETE).
    res.setHeader("Allow", "POST");
    return send(res, { status: 405, json: { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null } });
  }

  const auth = await oauth.authenticate(req.headers.authorization);
  if ("reply" in auth) return send(res, auth.reply);

  const client = new BookStackClient(bookstackUrl!, auth.creds.id, auth.creds.secret);
  const mcp = createServer(() => client);
  // Plain JSON responses rather than SSE: nothing to stream, and no proxy buffering surprises.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void mcp.close();
  });
  await mcp.connect(transport);
  await transport.handleRequest(req, res);
}

function send(res: ServerResponse, reply: Reply): void {
  if ("redirect" in reply) {
    res.writeHead(302, { Location: reply.redirect, "Cache-Control": "no-store" }).end();
  } else if ("html" in reply) {
    res
      .writeHead(reply.status, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
      })
      .end(reply.html);
  } else {
    res.writeHead(reply.status, { "Content-Type": "application/json", ...reply.headers }).end(JSON.stringify(reply.json));
  }
}

/** API-style endpoints use tokens in headers, never cookies, so any origin may call them. */
function cors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID");
  res.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version");
  res.setHeader("Access-Control-Max-Age", "86400");
}

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "Request body too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new HttpError(400, "Expected a JSON body.");
  }
}

/** The token endpoint takes form-encoded bodies per the spec; accept JSON too. */
function parseForm(req: IncomingMessage, body: string): URLSearchParams {
  if (!(req.headers["content-type"] ?? "").includes("json")) return new URLSearchParams(body);
  const json = parseJson(body);
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(typeof json === "object" && json !== null ? json : {})) {
    if (typeof value === "string") form.set(key, value);
  }
  return form;
}

function fatal(message: string): never {
  console.error(message);
  process.exit(1);
}

server.listen(port, host, () => {
  console.log(`bookstack-mcp ${version} listening on http://${host.includes(":") ? `[${host}]` : host}:${port}${readOnly ? " (read-only)" : ""}`);
  console.log(`MCP endpoint: ${oauth.resource}`);
  console.log(`BookStack:    ${new BookStackClient(bookstackUrl, "", "").baseUrl}`);
  if (publicUrl.startsWith("http:") && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(`${publicUrl}/`)) {
    console.warn("MCP_PUBLIC_URL isn't https: Claude only connects to remote servers over https.");
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
