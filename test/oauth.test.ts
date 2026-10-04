import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { OAuth, type Reply } from "../dist/oauth.js";
import { fakeBookStack, type FakeBookStack, GOOD_TOKEN } from "./fake-bookstack.ts";

const PUBLIC_URL = "https://tools.example.com/bookstack-mcp";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "v".repeat(43);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

let fake: FakeBookStack;
let oauth: OAuth;

const newOAuth = (secret = "s".repeat(40)) =>
  new OAuth({ publicUrl: PUBLIC_URL, bookstackUrl: fake.url, secret, redirectHosts: ["claude.ai", "localhost"] });

before(async () => {
  fake = await fakeBookStack();
  oauth = newOAuth();
});
after(() => fake.close());

function json(reply: Reply): { status: number; body: Record<string, any>; headers: Record<string, string> } {
  assert.ok("json" in reply, `expected a JSON reply, got ${JSON.stringify(reply).slice(0, 200)}`);
  return { status: reply.status, body: reply.json as Record<string, any>, headers: reply.headers ?? {} };
}

/** The HTTP status authenticate() answers with when it turns a request down. */
function refusal(result: Awaited<ReturnType<OAuth["authenticate"]>>): number {
  assert.ok("reply" in result, "expected the request to be refused");
  return json(result.reply).status;
}

function register(meta: Record<string, unknown> = {}, server = oauth) {
  return json(server.register({ redirect_uris: [CALLBACK], token_endpoint_auth_method: "none", client_name: "Claude", ...meta }));
}

/** Submits the sign-in form and returns where the user is sent. */
async function signIn(clientId: string, overrides: Record<string, string> = {}, server = oauth): Promise<URL> {
  const reply = await server.authorizeSubmit(authParams(clientId, { token_id: GOOD_TOKEN.id, token_secret: GOOD_TOKEN.secret, ...overrides }));
  assert.ok("redirect" in reply, `expected a redirect, got ${JSON.stringify(reply).slice(0, 300)}`);
  return new URL(reply.redirect);
}

function authParams(clientId: string, extra: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams({
    client_id: clientId,
    redirect_uri: CALLBACK,
    response_type: "code",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    state: "xyz",
    ...extra,
  });
}

function exchange(clientId: string, code: string, extra: Record<string, string> = {}, server = oauth) {
  const form = new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: VERIFIER, redirect_uri: CALLBACK, ...extra });
  return json(server.token(form));
}

/** Registers a client and signs in: the state most tests start from. */
async function connected() {
  const clientId = register().body.client_id as string;
  const code = (await signIn(clientId)).searchParams.get("code")!;
  return { clientId, code, tokens: exchange(clientId, code).body };
}

test("metadata: every endpoint is under the public URL, sub-path included", () => {
  const server = json(oauth.serverMetadata()).body;
  assert.equal(server.issuer, PUBLIC_URL);
  for (const key of ["authorization_endpoint", "token_endpoint", "registration_endpoint"]) {
    assert.ok(server[key].startsWith(`${PUBLIC_URL}/`), key);
  }
  assert.deepEqual(server.code_challenge_methods_supported, ["S256"]);
  const resource = json(oauth.resourceMetadata()).body;
  assert.equal(resource.resource, `${PUBLIC_URL}/mcp`);
  assert.deepEqual(resource.authorization_servers, [PUBLIC_URL]);
});

test("register: public clients get no secret, confidential ones do", () => {
  const publicClient = register();
  assert.equal(publicClient.status, 201);
  assert.equal(publicClient.body.client_secret, undefined);
  assert.equal(typeof register({ token_endpoint_auth_method: "client_secret_post" }).body.client_secret, "string");
});

test("register: redirect URIs must be https (or loopback) on an allowed host", () => {
  const rejected = (uri: unknown) => register({ redirect_uris: uri }).body;
  assert.equal(rejected(["https://evil.example/cb"]).error, "invalid_redirect_uri");
  assert.match(rejected(["https://evil.example/cb"]).error_description, /MCP_ALLOWED_REDIRECT_HOSTS/);
  assert.match(rejected(["http://claude.ai/cb"]).error_description, /must use https/);
  assert.match(rejected(["javascript:alert(1)"]).error_description, /Unsupported redirect_uri scheme/);
  assert.match(rejected([`${CALLBACK}#frag`]).error_description, /fragment/);
  assert.equal(rejected([CALLBACK, "https://evil.example/cb"]).error, "invalid_redirect_uri");
  assert.equal(rejected([]).error, "invalid_redirect_uri");
  assert.equal(rejected("not-an-array").error, "invalid_redirect_uri");
  assert.equal(register({ redirect_uris: ["http://localhost:1234/cb"] }).status, 201);
  assert.equal(register({ token_endpoint_auth_method: "private_key_jwt" }).body.error, "invalid_client_metadata");
});

test("authorize page: shows who is asking and keeps the request in the form", () => {
  const reply = oauth.authorizePage(authParams(register({ client_name: "<b>Evil</b>" }).body.client_id));
  assert.ok("html" in reply);
  assert.equal(reply.status, 200);
  assert.ok(reply.html.includes("&#60;b&#62;Evil&#60;/b&#62;"), "client name is escaped");
  assert.ok(reply.html.includes(`name="code_challenge" value="${CHALLENGE}"`));
  assert.ok(reply.html.includes(`action="${PUBLIC_URL}/authorize"`));
});

test("authorize: an unknown client or unregistered redirect_uri shows an error instead of redirecting", () => {
  const clientId = register().body.client_id;
  for (const params of [authParams("made-up"), authParams(clientId, { redirect_uri: "https://claude.ai/other" })]) {
    const reply = oauth.authorizePage(params);
    assert.ok("html" in reply);
    assert.equal(reply.status, 400);
  }
});

test("authorize: protocol errors go back to the client, with state", () => {
  const clientId = register().body.client_id;
  const error = (extra: Record<string, string>) => {
    const reply = oauth.authorizePage(authParams(clientId, extra));
    assert.ok("redirect" in reply);
    const url = new URL(reply.redirect);
    assert.equal(url.origin + url.pathname, CALLBACK);
    assert.equal(url.searchParams.get("state"), "xyz");
    return url.searchParams.get("error");
  };
  assert.equal(error({ response_type: "token" }), "unsupported_response_type");
  assert.equal(error({ code_challenge_method: "plain" }), "invalid_request");
  assert.equal(error({ resource: "https://other.example/mcp" }), "invalid_target");
});

test("sign-in: a token BookStack rejects re-shows the form without echoing the secret", async () => {
  const clientId = register().body.client_id;
  const reply = await oauth.authorizeSubmit(authParams(clientId, { token_id: "nope", token_secret: "hunter2-secret" }));
  assert.ok("html" in reply);
  assert.equal(reply.status, 400);
  assert.ok(reply.html.includes("BookStack didn&#39;t accept this token"));
  assert.ok(reply.html.includes('name="token_id" value="nope"'));
  assert.ok(!reply.html.includes("hunter2-secret"));

  const empty = await oauth.authorizeSubmit(authParams(clientId, { token_id: "only-id" }));
  assert.ok("html" in empty && empty.html.includes("Enter both"));
});

test("full flow: sign in, exchange the code, call with the access token", async () => {
  const clientId = register().body.client_id;
  const back = await signIn(clientId);
  assert.equal(back.origin + back.pathname, CALLBACK);
  assert.equal(back.searchParams.get("state"), "xyz");
  assert.equal(back.searchParams.get("iss"), PUBLIC_URL);

  const { status, body, headers } = exchange(clientId, back.searchParams.get("code")!);
  assert.equal(status, 200);
  assert.equal(body.token_type, "Bearer");
  assert.equal(body.expires_in, 3600);
  assert.equal(headers["Cache-Control"], "no-store");
  for (const token of [body.access_token, body.refresh_token, back.searchParams.get("code")!]) {
    assert.ok(!Buffer.from(token, "base64url").toString("latin1").includes(GOOD_TOKEN.secret), "the BookStack secret isn't readable in tokens");
  }

  assert.deepEqual(await oauth.authenticate(`Bearer ${body.access_token}`), { creds: GOOD_TOKEN });
});

test("token: PKCE is enforced", async () => {
  const clientId = register().body.client_id;
  const code = (await signIn(clientId)).searchParams.get("code")!;
  assert.equal(exchange(clientId, code, { code_verifier: "w".repeat(43) }).body.error, "invalid_grant");
  assert.equal(exchange(clientId, code, { code_verifier: "" }).body.error, "invalid_grant");
  assert.equal(exchange(clientId, code).status, 200, "a failed attempt doesn't burn the code");
});

test("token: a code works once, only for its client and redirect_uri", async () => {
  const { clientId, code } = await connected();
  assert.equal(exchange(clientId, code).body.error, "invalid_grant");

  const fresh = (await signIn(clientId)).searchParams.get("code")!;
  assert.equal(exchange(register().body.client_id, fresh).body.error, "invalid_grant");
  assert.equal(exchange(clientId, fresh, { redirect_uri: "https://claude.ai/other" }).body.error, "invalid_grant");
  assert.equal(exchange(clientId, "garbage").body.error, "invalid_grant");
  assert.equal(json(oauth.token(new URLSearchParams({ grant_type: "password", client_id: clientId }))).body.error, "unsupported_grant_type");
});

test("token: confidential clients must present their secret, in the body or as Basic auth", async () => {
  const { client_id: clientId, client_secret: secret } = register({ token_endpoint_auth_method: "client_secret_basic" }).body;
  const form = async () =>
    new URLSearchParams({ grant_type: "authorization_code", code: (await signIn(clientId)).searchParams.get("code")!, code_verifier: VERIFIER });
  const basic = (password: string) => `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(password)}`).toString("base64")}`;

  const withoutSecret = await form();
  withoutSecret.set("client_id", clientId);
  assert.equal(json(oauth.token(withoutSecret)).status, 401);
  assert.equal(json(oauth.token(await form(), basic("wrong"))).body.error, "invalid_client");
  assert.equal(json(oauth.token(await form(), basic(secret))).status, 200);
  assert.equal(json(oauth.token(new URLSearchParams({ grant_type: "authorization_code", client_id: "made-up" }))).status, 401);
});

test("refresh: gives new tokens, and only a refresh token can be used for it", async () => {
  const { clientId, tokens } = await connected();
  const refresh = (token: string, client = clientId) =>
    json(oauth.token(new URLSearchParams({ grant_type: "refresh_token", client_id: client, refresh_token: token })));

  const renewed = refresh(tokens.refresh_token);
  assert.equal(renewed.status, 200);
  assert.deepEqual(await oauth.authenticate(`Bearer ${renewed.body.access_token}`), { creds: GOOD_TOKEN });

  assert.equal(refresh(tokens.access_token).body.error, "invalid_grant");
  assert.equal(refresh(tokens.refresh_token, register().body.client_id).body.error, "invalid_grant");
  const asAccess = await oauth.authenticate(`Bearer ${tokens.refresh_token}`);
  assert.equal(refusal(asAccess), 401);
});

test("tokens expire: the access token after an hour, the refresh token after 90 days", async (t) => {
  const { clientId, tokens } = await connected();
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const refresh = () => json(oauth.token(new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh_token })));

  t.mock.timers.tick(59 * 60 * 1000);
  assert.ok("creds" in (await oauth.authenticate(`Bearer ${tokens.access_token}`)));
  t.mock.timers.tick(2 * 60 * 1000);
  assert.ok("reply" in (await oauth.authenticate(`Bearer ${tokens.access_token}`)));
  assert.equal(refresh().status, 200);
  t.mock.timers.tick(91 * 24 * 60 * 60 * 1000);
  assert.equal(refresh().body.error, "invalid_grant");
});

test("an authorization code expires after five minutes", async (t) => {
  const clientId = register().body.client_id;
  const code = (await signIn(clientId)).searchParams.get("code")!;
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  t.mock.timers.tick(5 * 60 * 1000 + 1000);
  assert.equal(exchange(clientId, code).body.error, "invalid_grant");
});

test("tokens are bound to MCP_AUTH_SECRET: another server can't read them, a tampered one is rejected", async () => {
  const { clientId, tokens } = await connected();
  const other = newOAuth("another-secret-another-secret-another");
  const elsewhere = await other.authenticate(`Bearer ${tokens.access_token}`);
  assert.equal(refusal(elsewhere), 401);
  assert.equal(json(other.token(new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh_token }))).status, 401);

  const bytes = Buffer.from(tokens.access_token, "base64url");
  bytes[20] ^= 1;
  const tampered = await oauth.authenticate(`Bearer ${bytes.toString("base64url")}`);
  assert.equal(refusal(tampered), 401);
});

test("authenticate: no credentials gets a 401 that points to the resource metadata", async () => {
  for (const header of [undefined, "", "Basic abc", "Token no-colon"]) {
    const result = await oauth.authenticate(header);
    assert.ok("reply" in result);
    const { status, headers } = json(result.reply);
    assert.equal(status, 401);
    assert.equal(headers["WWW-Authenticate"], `Bearer resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource"`);
  }
});

test("authenticate: a BookStack API token works as a static header", async () => {
  assert.deepEqual(await oauth.authenticate(`Token ${GOOD_TOKEN.id}:${GOOD_TOKEN.secret}`), { creds: GOOD_TOKEN });
  const wrong = await oauth.authenticate("Token wrong:creds");
  assert.equal(refusal(wrong), 401);
});

test("authenticate: a token deleted in BookStack stops working once the cached check runs out", async (t) => {
  const server = newOAuth();
  fake.tokens.add("temp:pass");
  const clientId = register({}, server).body.client_id;
  const code = (await signIn(clientId, { token_id: "temp", token_secret: "pass" }, server)).searchParams.get("code")!;
  const { access_token: token } = exchange(clientId, code, {}, server).body;
  fake.tokens.delete("temp:pass");

  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  assert.ok("creds" in (await server.authenticate(`Bearer ${token}`)), "still within the 5-minute cache");
  t.mock.timers.tick(6 * 60 * 1000);
  const result = await server.authenticate(`Bearer ${token}`);
  assert.ok("reply" in result);
  assert.match(json(result.reply).headers["WWW-Authenticate"], /error="invalid_token", error_description="BookStack no longer accepts this API token/);
});

test("authenticate: BookStack being down doesn't sign anyone out", async () => {
  const closed = await fakeBookStack();
  await closed.close();
  const offline = new OAuth({ publicUrl: PUBLIC_URL, bookstackUrl: closed.url, secret: "s".repeat(40), redirectHosts: "*" });
  assert.deepEqual(await offline.authenticate("Token any:thing"), { creds: { id: "any", secret: "thing" } });
});

test("loopback redirect URIs match on any port", async () => {
  const clientId = register({ redirect_uris: ["http://localhost:1111/callback"] }).body.client_id;
  const reply = await oauth.authorizeSubmit(
    authParams(clientId, { redirect_uri: "http://localhost:54321/callback", token_id: GOOD_TOKEN.id, token_secret: GOOD_TOKEN.secret }),
  );
  assert.ok("redirect" in reply && reply.redirect.startsWith("http://localhost:54321/callback?code="));
  const otherPath = oauth.authorizePage(authParams(clientId, { redirect_uri: "http://localhost:54321/elsewhere" }));
  assert.ok("html" in otherPath && otherPath.status === 400);
});
