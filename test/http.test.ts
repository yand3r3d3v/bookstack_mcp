// The HTTP server as deployed: the real process, reached over the network, behind a sub-path.

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { fakeBookStack, type FakeBookStack, GOOD_TOKEN } from "./fake-bookstack.ts";

const ENTRY = fileURLToPath(new URL("../dist/http.js", import.meta.url));
const VERIFIER = "v".repeat(64);
const MCP_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

let fake: FakeBookStack;
const running: ChildProcess[] = [];

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** Starts dist/http.js and resolves with its local address and public URL once it's listening. */
async function start(env: Record<string, string> = {}): Promise<{ local: string; publicUrl: string }> {
  const port = await freePort();
  const local = `http://127.0.0.1:${port}`;
  const publicUrl = `http://localhost:${port}/bookstack-mcp`;
  const child = spawn(process.execPath, [ENTRY], {
    env: { ...process.env, BOOKSTACK_URL: fake.url, MCP_PORT: String(port), MCP_PUBLIC_URL: publicUrl, MCP_AUTH_SECRET: "s".repeat(40), BOOKSTACK_READ_ONLY: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  running.push(child);
  let output = "";
  await new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      output += chunk;
      if (output.includes("listening on")) resolve();
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    child.on("exit", (code) => reject(new Error(`http.js exited with ${code}:\n${output}`)));
  });
  return { local, publicUrl };
}

function rpc(url: string, authorization: string | undefined, method: string, params: object = {}): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { ...MCP_HEADERS, ...(authorization ? { Authorization: authorization } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

before(async () => {
  fake = await fakeBookStack();
  const book = fake.add("books", { name: "Handbook" }).id;
  fake.add("pages", { name: "Setup guide", book_id: book, markdown: "Run make." });
});
after(async () => {
  for (const child of running) child.kill();
  await fake.close();
});

test("a client can discover the server, sign in through OAuth and call a tool", async () => {
  const { local, publicUrl } = await start();
  const mcpUrl = `${local}/bookstack-mcp/mcp`;

  // 1. An unauthenticated call is told where the resource metadata is.
  const anonymous = await rpc(mcpUrl, undefined, "tools/list");
  assert.equal(anonymous.status, 401);
  const metadataUrl = anonymous.headers.get("www-authenticate")!.match(/resource_metadata="([^"]+)"/)![1];
  assert.equal(metadataUrl, `${publicUrl}/.well-known/oauth-protected-resource`);

  // 2. Discovery, at the sub-path and at the domain root (RFC 8414 / 9728 put .well-known first).
  const resource = await (await fetch(metadataUrl)).json();
  assert.equal(resource.resource, `${publicUrl}/mcp`);
  const rootResource = await (await fetch(`${local}/.well-known/oauth-protected-resource/bookstack-mcp/mcp`)).json();
  assert.deepEqual(rootResource, resource);
  const server = await (await fetch(`${local}/.well-known/oauth-authorization-server/bookstack-mcp`)).json();
  assert.equal(server.issuer, publicUrl);
  assert.deepEqual(await (await fetch(`${publicUrl}/.well-known/oauth-authorization-server`)).json(), server);

  // 3. Register, open the sign-in page, submit a BookStack token.
  const registration = await fetch(server.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["http://localhost:9/callback"], token_endpoint_auth_method: "none", client_name: "Test client" }),
  });
  assert.equal(registration.status, 201);
  const { client_id: clientId } = await registration.json();

  const request = new URLSearchParams({
    client_id: clientId,
    redirect_uri: "http://localhost:9/callback",
    response_type: "code",
    code_challenge: createHash("sha256").update(VERIFIER).digest("base64url"),
    code_challenge_method: "S256",
    state: "abc",
  });
  const page = await fetch(`${server.authorization_endpoint}?${request}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.ok((await page.text()).includes("Test client"));

  const submitted = await fetch(server.authorization_endpoint, {
    method: "POST",
    redirect: "manual",
    body: new URLSearchParams({ ...Object.fromEntries(request), token_id: GOOD_TOKEN.id, token_secret: GOOD_TOKEN.secret }),
  });
  assert.equal(submitted.status, 302);
  const callback = new URL(submitted.headers.get("location")!);
  assert.equal(callback.searchParams.get("state"), "abc");

  // 4. Exchange the code and use the access token.
  const exchanged = await fetch(server.token_endpoint, {
    method: "POST",
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code: callback.searchParams.get("code")!, code_verifier: VERIFIER }),
  });
  assert.equal(exchanged.status, 200);
  const { access_token: accessToken } = await exchanged.json();

  const listed = await rpc(mcpUrl, `Bearer ${accessToken}`, "tools/list");
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).result.tools.length, 11);

  const called = await rpc(mcpUrl, `Bearer ${accessToken}`, "tools/call", { name: "search", arguments: { query: "setup" } });
  const { result } = await called.json();
  assert.match(result.content[0].text, /^1 result for "setup"/);
});

test("routing: works with the sub-path stripped by the proxy, and rejects the rest", async () => {
  const { local } = await start();
  const token = `Token ${GOOD_TOKEN.id}:${GOOD_TOKEN.secret}`;

  assert.equal((await rpc(`${local}/mcp`, token, "tools/list")).status, 200);
  assert.deepEqual(await (await fetch(`${local}/health`)).json(), { status: "ok" });

  const get = await fetch(`${local}/mcp`, { headers: { Authorization: token } });
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");
  assert.equal((await fetch(`${local}/token`)).status, 405);
  assert.equal((await fetch(`${local}/nope`)).status, 404);

  const preflight = await fetch(`${local}/mcp`, { method: "OPTIONS" });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");

  const tooBig = await fetch(`${local}/register`, { method: "POST", body: "x".repeat(70_000) });
  assert.equal(tooBig.status, 413);
  const notJson = await fetch(`${local}/register`, { method: "POST", body: "{" });
  assert.equal(notJson.status, 400);

  const revoked = await rpc(`${local}/mcp`, "Token gone:gone", "tools/list");
  assert.equal(revoked.status, 401);
});

test("read-only mode leaves only the read tools", async () => {
  const { local } = await start({ BOOKSTACK_READ_ONLY: "true" });
  const res = await rpc(`${local}/mcp`, `Token ${GOOD_TOKEN.id}:${GOOD_TOKEN.secret}`, "tools/list");
  const names = (await res.json()).result.tools.map((tool: { name: string }) => tool.name);
  assert.deepEqual(names.sort(), ["get", "list", "search"]);
});

test("the server refuses to start without BOOKSTACK_URL", async () => {
  await assert.rejects(start({ BOOKSTACK_URL: "" }), /BOOKSTACK_URL is not set/);
});
