import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { BookStackClient, BookStackError } from "../dist/bookstack.js";
import { fakeBookStack, type FakeBookStack, GOOD_TOKEN } from "./fake-bookstack.ts";

let fake: FakeBookStack;
let client: BookStackClient;

before(async () => {
  fake = await fakeBookStack();
  client = new BookStackClient(fake.url, GOOD_TOKEN.id, GOOD_TOKEN.secret);
  fake.add("books", { name: "Handbook" });
});
after(() => fake.close());
beforeEach(() => {
  fake.requests.length = 0;
});

test("base URL: trailing slashes and a pasted /api are dropped", () => {
  assert.equal(new BookStackClient("https://wiki.example.com/api/", "a", "b").baseUrl, "https://wiki.example.com");
  assert.equal(new BookStackClient(" https://wiki.example.com/docs// ", "a", "b").baseUrl, "https://wiki.example.com/docs");
});

test("get: sends the token and query, skipping undefined values", async () => {
  const res = await client.get<{ total: number }>("books", { count: 1, "filter[id]": undefined });
  assert.equal(res.total, 1);
  assert.deepEqual(fake.requests, ["GET books"]);
});

test("errors: a rejected token explains what to check", async () => {
  const bad = new BookStackClient(fake.url, "bad", "token");
  await assert.rejects(bad.get("books"), (err: BookStackError) => {
    assert.equal(err.status, 401);
    assert.match(err.message, /^BookStack 401: No authorization token found/);
    assert.match(err.message, /Token ID and Token Secret/);
    return true;
  });
});

test("errors: validation messages are listed per field", async () => {
  await assert.rejects(client.post("books", {}), /BookStack 422: The given data was invalid\.\n {2}name: The name field is required\./);
});

test("errors: a URL that isn't BookStack's API says so, with or without an error status", async () => {
  const wrong = new BookStackClient(`${fake.url}/not-bookstack`, "a", "b");
  await assert.rejects(wrong.get("books"), (err: BookStackError) => {
    assert.equal(err.status, undefined);
    assert.match(err.message, /Expected JSON .* Is BOOKSTACK_URL the base URL/);
    return true;
  });
});

test("errors: a redirect is reported instead of followed", async () => {
  const moved = new BookStackClient(`${fake.url}/moved`, GOOD_TOKEN.id, GOOD_TOKEN.secret);
  await assert.rejects(moved.get("books"), /redirects to https:\/\/elsewhere\.example\. Set BOOKSTACK_URL to the final address/);
});

test("errors: an unreachable server names the cause", async () => {
  const closed = await fakeBookStack();
  await closed.close();
  const down = new BookStackClient(closed.url, "a", "b");
  await assert.rejects(down.get("books"), /Can't reach BookStack at http:\/\/127\.0\.0\.1:\d+: ECONNREFUSED/);
});

test("rate limit: waits as asked and retries", async () => {
  fake.rateLimit(2, "0");
  const res = await client.get<{ total: number }>("books");
  assert.equal(res.total, 1);
  assert.equal(fake.requests.length, 3);
});

test("rate limit: gives up after the retries, saying when to try again", async () => {
  fake.rateLimit(5, "0");
  await assert.rejects(client.get("books"), (err: BookStackError) => {
    assert.equal(err.status, 429);
    assert.match(err.message, /rate limit hit .* Retry in 0s\./);
    return true;
  });
  assert.equal(fake.requests.length, 3);
  fake.rateLimit(0);
});

test("rate limit: a wait longer than the budget fails at once", async () => {
  fake.rateLimit(1, "55");
  const started = Date.now();
  await assert.rejects(client.get("books"), /Retry in 55s\./);
  assert.equal(fake.requests.length, 1);
  assert.ok(Date.now() - started < 1000);
});
