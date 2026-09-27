// OAuth 2.1 authorization server for the HTTP transport, so Claude can connect with a plain URL.
//
// Users sign in with their own BookStack API token (Token ID + Secret), so each person acts with
// exactly their BookStack permissions. Nothing is stored: client registrations, authorization codes
// and access/refresh tokens are AES-GCM-sealed blobs, readable only with MCP_AUTH_SECRET.
// Revoking access = deleting the API token in BookStack.

import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { BookStackClient, BookStackError } from "./bookstack.js";

export interface Credentials {
  id: string;
  secret: string;
}

export type Reply =
  | { status: number; json: unknown; headers?: Record<string, string> }
  | { status: number; html: string }
  | { redirect: string };

export interface OAuthOptions {
  /** Public base URL of this server, without a trailing slash, e.g. https://tools.example.com/bookstack-mcp */
  publicUrl: string;
  bookstackUrl: string;
  secret: string;
  /** Hosts allowed in redirect_uris, or "*" for any. */
  redirectHosts: string[] | "*";
}

type AuthMethod = "none" | "client_secret_post" | "client_secret_basic";
const AUTH_METHODS: AuthMethod[] = ["none", "client_secret_post", "client_secret_basic"];

interface Client {
  t: "client";
  r: string[]; // redirect_uris
  n?: string; // client_name
  a: AuthMethod;
}

interface Grant {
  t: "code" | "access" | "refresh";
  c: string; // hash of the client_id it was issued to
  k: [string, string]; // BookStack Token ID and Secret
  exp: number;
  j?: string; // code: unique id, for single use
  u?: string; // code: redirect_uri
  p?: string; // code: PKCE S256 challenge
}

const CODE_TTL = 5 * 60;
const ACCESS_TTL = 60 * 60;
// Refresh tokens rotate on every use, so an active user never has to sign in again.
const REFRESH_TTL = 90 * 24 * 60 * 60;
const VERIFIED_TTL = 5 * 60 * 1000;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

const now = () => Math.floor(Date.now() / 1000);
const b64url = (data: Buffer) => data.toString("base64url");
const sha256 = (text: string) => b64url(createHash("sha256").update(text).digest());

export class OAuth {
  readonly resource: string;
  private readonly key: Buffer;
  private readonly macKey: Buffer;
  private readonly usedCodes = new Map<string, number>();
  private readonly verified = new Map<string, number>();

  constructor(private readonly opts: OAuthOptions) {
    this.resource = `${opts.publicUrl}/mcp`;
    this.key = Buffer.from(hkdfSync("sha256", opts.secret, "bookstack-mcp", "seal", 32));
    this.macKey = Buffer.from(hkdfSync("sha256", opts.secret, "bookstack-mcp", "client-secret", 32));
  }

  // --- Discovery ---

  get resourceMetadataUrl(): string {
    return `${this.opts.publicUrl}/.well-known/oauth-protected-resource`;
  }

  /** RFC 9728 protected resource metadata. */
  resourceMetadata(): Reply {
    return {
      status: 200,
      json: {
        resource: this.resource,
        authorization_servers: [this.opts.publicUrl],
        bearer_methods_supported: ["header"],
        resource_name: "BookStack",
      },
    };
  }

  /** RFC 8414 authorization server metadata; also served as openid-configuration. */
  serverMetadata(): Reply {
    const base = this.opts.publicUrl;
    return {
      status: 200,
      json: {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ["code"],
        response_modes_supported: ["query"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: AUTH_METHODS,
        code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true,
        // Required by OpenID discovery, which is the one metadata URL under a sub-path that clients
        // try (${path}/.well-known/openid-configuration). No ID tokens are ever issued.
        jwks_uri: `${base}/.well-known/jwks.json`,
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
      },
    };
  }

  // --- Dynamic client registration (RFC 7591) ---

  register(body: unknown): Reply {
    const meta = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const fail = (error: string, description: string): Reply => ({
      status: 400,
      json: { error, error_description: description },
    });

    const uris = meta.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || !uris.every((u) => typeof u === "string")) {
      return fail("invalid_redirect_uri", "redirect_uris must be a non-empty array of URLs.");
    }
    for (const uri of uris) {
      const problem = this.redirectProblem(uri);
      if (problem) return fail("invalid_redirect_uri", problem);
    }
    const method = (meta.token_endpoint_auth_method ?? "client_secret_basic") as AuthMethod;
    if (!AUTH_METHODS.includes(method)) {
      return fail("invalid_client_metadata", `token_endpoint_auth_method must be one of: ${AUTH_METHODS.join(", ")}.`);
    }
    if (Array.isArray(meta.grant_types) && !meta.grant_types.includes("authorization_code")) {
      return fail("invalid_client_metadata", "Only the authorization_code grant (plus refresh_token) is supported.");
    }
    const name = typeof meta.client_name === "string" ? meta.client_name.slice(0, 100) : undefined;

    const clientId = this.seal({ t: "client", r: uris, n: name, a: method } satisfies Client);
    return {
      status: 201,
      json: {
        client_id: clientId,
        client_id_issued_at: now(),
        ...(method === "none" ? {} : { client_secret: this.clientSecret(clientId), client_secret_expires_at: 0 }),
        client_name: name,
        redirect_uris: uris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: method,
      },
    };
  }

  // --- Authorization endpoint: a sign-in page asking for the user's BookStack API token ---

  /** GET /authorize — shows the sign-in page. */
  authorizePage(params: URLSearchParams): Reply {
    const req = this.authRequest(params);
    return "reply" in req ? req.reply : this.loginPage(req);
  }

  /** POST /authorize — the sign-in form: checks the token against BookStack and redirects with a code. */
  async authorizeSubmit(form: URLSearchParams): Promise<Reply> {
    const req = this.authRequest(form);
    if ("reply" in req) return req.reply;

    const creds = { id: form.get("token_id")?.trim() ?? "", secret: form.get("token_secret")?.trim() ?? "" };
    if (!creds.id || !creds.secret) return this.loginPage(req, "Enter both the Token ID and the Token Secret.", creds.id);
    try {
      await this.check(creds);
    } catch (err) {
      return this.loginPage(req, loginError(err), creds.id);
    }

    const code = this.seal({
      t: "code",
      c: sha256(req.clientId),
      k: [creds.id, creds.secret],
      exp: now() + CODE_TTL,
      j: b64url(randomBytes(12)),
      u: req.redirectUri,
      p: req.challenge,
    } satisfies Grant);
    return { redirect: this.redirectTo(req.redirectUri, { code, state: req.state }) };
  }

  // --- Token endpoint ---

  token(form: URLSearchParams, authorization?: string): Reply {
    const fail = (error: string, description: string, status = 400): Reply => ({
      status,
      json: { error, error_description: description },
      headers: { "Cache-Control": "no-store" },
    });

    // Client authentication: HTTP Basic, or client_id (+ client_secret) in the body.
    let clientId = form.get("client_id") ?? "";
    let clientSecret = form.get("client_secret") ?? undefined;
    const basic = authorization?.match(/^Basic\s+(\S+)$/i);
    if (basic) {
      const [id = "", secret = ""] = Buffer.from(basic[1], "base64").toString().split(":");
      clientId = safeDecode(id);
      clientSecret = safeDecode(secret);
    }
    const client = this.open<Client>(clientId, "client");
    if (!client) return fail("invalid_client", "Unknown client_id. Remove and re-add the connector.", 401);
    if (client.a !== "none" && !this.secretMatches(clientId, clientSecret)) {
      return fail("invalid_client", "Wrong or missing client_secret.", 401);
    }
    const cid = sha256(clientId);

    let creds: [string, string];
    const grantType = form.get("grant_type");
    if (grantType === "authorization_code") {
      const code = this.open<Grant>(form.get("code") ?? "", "code");
      if (!code || code.c !== cid || this.usedCodes.has(code.j!)) {
        return fail("invalid_grant", "The authorization code is invalid, expired or already used.");
      }
      const redirectUri = form.get("redirect_uri");
      if (redirectUri && redirectUri !== code.u) return fail("invalid_grant", "redirect_uri doesn't match.");
      const verifier = form.get("code_verifier") ?? "";
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || sha256(verifier) !== code.p) {
        return fail("invalid_grant", "PKCE verification failed.");
      }
      this.useCode(code.j!, code.exp);
      creds = code.k;
    } else if (grantType === "refresh_token") {
      const refresh = this.open<Grant>(form.get("refresh_token") ?? "", "refresh");
      if (!refresh || refresh.c !== cid) return fail("invalid_grant", "The refresh token is invalid or expired.");
      creds = refresh.k;
    } else {
      return fail("unsupported_grant_type", "Use authorization_code or refresh_token.");
    }

    return {
      status: 200,
      json: {
        access_token: this.seal({ t: "access", c: cid, k: creds, exp: now() + ACCESS_TTL } satisfies Grant),
        token_type: "Bearer",
        expires_in: ACCESS_TTL,
        refresh_token: this.seal({ t: "refresh", c: cid, k: creds, exp: now() + REFRESH_TTL } satisfies Grant),
      },
      headers: { "Cache-Control": "no-store" },
    };
  }

  // --- Protecting the MCP endpoint ---

  /**
   * Resolves the BookStack credentials of a request to the MCP endpoint. Accepts an OAuth access token
   * (`Authorization: Bearer …`) or a BookStack API token as-is (`Authorization: Token <id>:<secret>`),
   * for clients configured with a static header instead of OAuth.
   */
  async authenticate(authorization: string | undefined): Promise<{ creds: Credentials } | { reply: Reply }> {
    let creds: Credentials | undefined;
    const [scheme = "", value = ""] = (authorization ?? "").trim().split(/\s+/, 2);
    if (/^bearer$/i.test(scheme)) {
      const grant = this.open<Grant>(value, "access");
      if (!grant) return { reply: this.unauthorized("The access token is invalid or expired.") };
      creds = { id: grant.k[0], secret: grant.k[1] };
    } else if (/^token$/i.test(scheme) && value.includes(":")) {
      const i = value.indexOf(":");
      creds = { id: value.slice(0, i), secret: value.slice(i + 1) };
    } else {
      return { reply: this.unauthorized() };
    }

    // The BookStack token may have been deleted or expired since sign-in: answer 401 so the client
    // signs in again, instead of every tool call failing.
    try {
      await this.check(creds);
    } catch (err) {
      if (err instanceof BookStackError && (err.status === 401 || err.status === 403)) {
        return { reply: this.unauthorized("BookStack no longer accepts this API token. Sign in again.") };
      }
      // BookStack unreachable etc.: let the request through, the tools will report it.
    }
    return { creds };
  }

  // --- Internals ---

  /** Checks an API token against BookStack; successful checks are cached for a few minutes. */
  private async check(creds: Credentials): Promise<void> {
    const key = sha256(`${creds.id}:${creds.secret}`);
    if ((this.verified.get(key) ?? 0) > Date.now()) return;
    await new BookStackClient(this.opts.bookstackUrl, creds.id, creds.secret).get("books", { count: 1 });
    prune(this.verified, Date.now());
    this.verified.set(key, Date.now() + VERIFIED_TTL);
  }

  private unauthorized(description?: string): Reply {
    const params = [`resource_metadata="${this.resourceMetadataUrl}"`];
    if (description) params.push(`error="invalid_token"`, `error_description="${description}"`);
    return {
      status: 401,
      json: { jsonrpc: "2.0", error: { code: -32001, message: description ?? "Authentication required." }, id: null },
      headers: { "WWW-Authenticate": `Bearer ${params.join(", ")}` },
    };
  }

  /** Validates an authorization request; errors before the redirect_uri is trusted are shown as a page. */
  private authRequest(params: URLSearchParams): AuthRequest | { reply: Reply } {
    const clientId = params.get("client_id") ?? "";
    const client = this.open<Client>(clientId, "client");
    if (!client) return { reply: errorPage("Unknown client_id. Remove the connector in Claude and add it again.") };

    const requested = params.get("redirect_uri");
    const redirectUri = requested ?? (client.r.length === 1 ? client.r[0] : undefined);
    if (!redirectUri || !client.r.some((uri) => sameRedirect(uri, redirectUri))) {
      return { reply: errorPage("redirect_uri doesn't match the registered one.") };
    }

    const state = params.get("state") ?? undefined;
    const fail = (error: string, description: string) => ({
      reply: { redirect: this.redirectTo(redirectUri, { error, error_description: description, state }) },
    });
    if (params.get("response_type") !== "code") return fail("unsupported_response_type", "Only response_type=code is supported.");
    const challenge = params.get("code_challenge");
    if (!challenge || params.get("code_challenge_method") !== "S256") {
      return fail("invalid_request", "PKCE with code_challenge_method=S256 is required.");
    }
    const resource = params.get("resource");
    if (resource && !resource.startsWith(this.opts.publicUrl)) return fail("invalid_target", `Unknown resource ${resource}.`);

    return { clientId, clientName: client.n, redirectUri, state, challenge, params };
  }

  private redirectTo(uri: string, params: Record<string, string | undefined>): string {
    const url = new URL(uri);
    for (const [key, value] of Object.entries({ ...params, iss: this.opts.publicUrl })) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    return url.href;
  }

  private redirectProblem(uri: string): string | undefined {
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      return `Not a URL: ${uri}`;
    }
    if (url.hash) return `redirect_uri must not have a fragment: ${uri}`;
    if (/^(javascript|data|vbscript|file):$/.test(url.protocol)) return `Unsupported redirect_uri scheme: ${uri}`;
    if (url.protocol === "http:" && !LOOPBACK.has(url.hostname)) return `redirect_uri must use https: ${uri}`;
    const hosts = this.opts.redirectHosts;
    if (hosts !== "*" && !hosts.includes(url.hostname)) {
      return `Redirects to ${url.hostname} aren't allowed on this server (MCP_ALLOWED_REDIRECT_HOSTS).`;
    }
  }

  private loginPage(req: AuthRequest, error?: string, tokenId = ""): Reply {
    const hidden = [...req.params]
      .filter(([name]) => name !== "token_id" && name !== "token_secret")
      .map(([name, value]) => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`)
      .join("\n      ");
    const client = req.clientName ? `<b>${esc(req.clientName)}</b>` : "An app";
    const bookstack = new URL(this.opts.bookstackUrl);
    return {
      status: error ? 400 : 200,
      html: page(
        "Connect to BookStack",
        `<h1>Connect to BookStack</h1>
    <p>${client} wants to use <a href="${esc(bookstack.href)}" target="_blank" rel="noopener">${esc(bookstack.host)}</a>
      on your behalf, with your permissions. You'll then be sent back to <b>${esc(new URL(req.redirectUri).host)}</b>.</p>
    <p class="hint">Sign in with a BookStack API token: in BookStack open your avatar → <i>My Account</i> →
      <i>Access &amp; Security</i> → <i>API Tokens</i> → <i>Create Token</i>. Deleting the token there revokes this access.</p>
    ${error ? `<p class="error">${esc(error)}</p>` : ""}
    <form method="post" action="${esc(this.opts.publicUrl)}/authorize">
      ${hidden}
      <label>Token ID <input name="token_id" value="${esc(tokenId)}" required autocomplete="off" spellcheck="false" autofocus></label>
      <label>Token Secret <input name="token_secret" type="password" required autocomplete="off"></label>
      <button type="submit">Connect</button>
    </form>`,
      ),
    };
  }

  private seal(payload: object): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
    return b64url(Buffer.concat([iv, data, cipher.getAuthTag()]));
  }

  private open<T extends { t: string; exp?: number }>(token: string, type: T["t"]): T | undefined {
    try {
      const raw = Buffer.from(token, "base64url");
      if (raw.length < 12 + 16 + 2) return undefined;
      const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(-16));
      const payload = JSON.parse(Buffer.concat([decipher.update(raw.subarray(12, -16)), decipher.final()]).toString()) as T;
      if (payload.t !== type || (payload.exp !== undefined && payload.exp < now())) return undefined;
      return payload;
    } catch {
      return undefined; // tampered, sealed with another secret, or not ours at all
    }
  }

  private clientSecret(clientId: string): string {
    return b64url(createHmac("sha256", this.macKey).update(clientId).digest());
  }

  private secretMatches(clientId: string, secret: string | undefined): boolean {
    const expected = Buffer.from(this.clientSecret(clientId));
    const given = Buffer.from(secret ?? "");
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  private useCode(id: string, exp: number): void {
    prune(this.usedCodes, now());
    this.usedCodes.set(id, exp);
  }
}

interface AuthRequest {
  clientId: string;
  clientName?: string;
  redirectUri: string;
  state?: string;
  challenge: string;
  params: URLSearchParams;
}

/** Loopback redirect URIs match on any port (RFC 8252 §7.3): native apps pick a free port each time. */
function sameRedirect(registered: string, given: string): boolean {
  if (registered === given) return true;
  try {
    const a = new URL(registered);
    const b = new URL(given);
    if (a.protocol !== "http:" || !LOOPBACK.has(a.hostname)) return false;
    a.port = b.port = "";
    return a.href === b.href;
  } catch {
    return false;
  }
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function prune(map: Map<string, number>, before: number): void {
  if (map.size < 1000) return;
  for (const [key, exp] of map) if (exp < before) map.delete(key);
}

function loginError(err: unknown): string {
  if (err instanceof BookStackError && err.status === 401) {
    return "BookStack didn't accept this token. Check the Token ID and Token Secret.";
  }
  if (err instanceof BookStackError && err.status === 403) {
    return 'BookStack refused this token: it has expired, or your role lacks the "Access System API" permission.';
  }
  return err instanceof Error ? err.message.split("\n")[0] : String(err);
}

function errorPage(message: string): Reply {
  return { status: 400, html: page("Can't connect", `<h1>Can't connect</h1>\n    <p class="error">${esc(message)}</p>`) };
}

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <style>
    :root { color-scheme: light dark; --bg: #f4f5f7; --card: #fff; --text: #1d2125; --muted: #5e6c84; --accent: #206ea7; --on-accent: #fff; --err: #b3261e; --line: #d0d5dd; }
    @media (prefers-color-scheme: dark) { :root { --bg: #16181c; --card: #22252a; --text: #e6e8eb; --muted: #9aa4b2; --accent: #6cb4ee; --on-accent: #0b1f33; --err: #f2b8b5; --line: #3a3f47; } }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, sans-serif; }
    main { width: min(420px, calc(100vw - 32px)); background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 28px; box-sizing: border-box; }
    h1 { font-size: 20px; margin: 0 0 12px; }
    a { color: var(--accent); }
    .hint { color: var(--muted); font-size: 13px; }
    .error { color: var(--err); font-weight: 500; }
    label { display: block; margin: 14px 0 0; font-weight: 500; font-size: 13px; }
    input { display: block; width: 100%; box-sizing: border-box; margin-top: 4px; padding: 9px 10px; font: inherit; color: inherit; background: transparent; border: 1px solid var(--line); border-radius: 6px; }
    button { margin-top: 20px; width: 100%; padding: 10px; font: inherit; font-weight: 600; color: var(--on-accent); background: var(--accent); border: 0; border-radius: 6px; cursor: pointer; }
  </style>
</head>
<body>
  <main>
    ${body}
  </main>
</body>
</html>
`;
}
