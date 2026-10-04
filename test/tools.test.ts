// The tools as a client sees them: a real MCP client talking to the server, against the fake BookStack.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BookStackClient } from "../dist/bookstack.js";
import { createServer } from "../dist/server.js";
import { fakeBookStack, type FakeBookStack, GOOD_TOKEN } from "./fake-bookstack.ts";

let fake: FakeBookStack;
let mcp: Client;
let shelf: number, book: number, chapter: number, guide: number, wysiwyg: number;

/** Calls a tool and returns its text; fails the test if the tool reported an error. */
async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const { text, isError } = await raw(name, args);
  assert.ok(!isError, `${name} failed: ${text}`);
  return text;
}

/** Calls a tool that is expected to fail and returns its error text. */
async function callError(name: string, args: Record<string, unknown>): Promise<string> {
  const { text, isError } = await raw(name, args);
  assert.ok(isError, `${name} should have failed, but returned: ${text}`);
  return text;
}

async function raw(name: string, args: Record<string, unknown>) {
  const result = await mcp.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  return { text: content.map((c) => c.text).join("\n"), isError: result.isError === true };
}

const idOf = (text: string, type: string) => Number(text.match(new RegExp(`\\[${type}:(\\d+)\\]`))![1]);

before(async () => {
  fake = await fakeBookStack();
  book = fake.add("books", { name: "Handbook", description: "How we work" }).id;
  shelf = fake.add("shelves", { name: "Engineering", books: [book] }).id;
  chapter = fake.add("chapters", { name: "Onboarding", book_id: book }).id;
  guide = fake.add("pages", { name: "Setup guide", chapter_id: chapter, markdown: "## Install\r\nRun `make`.\r\n\r\n## Verify\r\nRun `make test`.", tags: [{ name: "team", value: "infra" }] }).id;
  wysiwyg = fake.add("pages", { name: "Old notes", book_id: book, html: "<p>Written in the visual editor</p>" }).id;

  const server = createServer(() => new BookStackClient(fake.url, GOOD_TOKEN.id, GOOD_TOKEN.secret));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  mcp = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverSide), mcp.connect(clientSide)]);
});
after(async () => {
  await mcp.close();
  await fake.close();
});

test("the server offers its tools, the document prompt and instructions", async () => {
  const { tools } = await mcp.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ["create_book", "create_chapter", "create_page", "create_shelf", "delete", "edit_page", "get", "list", "search", "update", "update_page"],
  );
  assert.equal(tools.find((t) => t.name === "search")?.annotations?.readOnlyHint, true);
  assert.equal(tools.find((t) => t.name === "delete")?.annotations?.destructiveHint, true);
  assert.deepEqual((await mcp.listPrompts()).prompts.map((p) => p.name), ["document"]);
  assert.match(mcp.getInstructions() ?? "", /shelf → book → chapter → page/);
});

test("search: results carry refs, location and a plain-text snippet", async () => {
  const text = await call("search", { query: "setup" });
  assert.match(text, /^1 result for "setup" \(showing 1–1\):/);
  assert.ok(text.includes(`- [page:${guide}] Setup guide — in "Handbook"`));
  assert.ok(text.includes("Setup guide & more"));
  assert.equal(await call("search", { query: "zzz" }), 'No results for "zzz".');
});

test("search: the type filter is sent in BookStack's syntax", async () => {
  fake.requests.length = 0;
  assert.equal(await call("search", { query: "setup", type: "shelf" }), 'No results for "setup".');
  assert.deepEqual(fake.requests, ["GET search"]);
});

test("list: shows parents, filters by name and book", async () => {
  const pages = await call("list", { type: "page", book_id: book });
  assert.match(pages, /^Pages 1–2 of 2:/);
  assert.ok(pages.includes(`- [page:${guide}] Setup guide (book:${book}, chapter:${chapter})`));
  assert.ok((await call("list", { type: "book", name_contains: "hand" })).includes(`[book:${book}] Handbook — How we work`));
  assert.equal(await call("list", { type: "book", name_contains: "nope" }), "No books found.");
  assert.match(await callError("list", { type: "book", book_id: book }), /book_id only applies/);
});

test("list: paging says where to continue", async () => {
  const text = await call("list", { type: "page", count: 1 });
  assert.match(text, /^Pages 1–1 of 2:/);
  assert.match(text, /More: offset=1$/);
});

test("get book / chapter / shelf: show what's inside", async () => {
  const bookText = await call("get", { type: "book", id: book });
  assert.ok(bookText.includes(`On shelves: [shelf:${shelf}] Engineering`));
  assert.ok(bookText.includes(`- [chapter:${chapter}] Onboarding\n  - [page:${guide}] Setup guide`));
  assert.ok(bookText.includes(`- [page:${wysiwyg}] Old notes`));

  const chapterText = await call("get", { type: "chapter", id: chapter });
  assert.ok(chapterText.includes(`Book: [book:${book}] Handbook`));
  assert.ok(chapterText.includes(`- [page:${guide}] Setup guide`));

  assert.ok((await call("get", { type: "shelf", id: shelf })).includes(`- [book:${book}] Handbook — How we work`));
});

test("get page: header, then the Markdown source with LF line endings", async () => {
  const text = await call("get", { type: "page", id: guide });
  const [header, body] = text.split("\n---\n");
  assert.ok(header.includes(`Page: [page:${guide}] Setup guide`));
  assert.ok(header.includes(`URL: ${fake.url}/books/handbook/page/setup-guide`));
  assert.ok(header.includes(`Location: [book:${book}] Handbook › [chapter:${chapter}] Onboarding`));
  assert.ok(header.includes("Editor: markdown · updated 2026-01-01 by Tester · revisions: 1"));
  assert.ok(header.includes("Tags: team=infra"));
  assert.equal(body, "## Install\nRun `make`.\n\n## Verify\nRun `make test`.");
});

test("get page: section and max_chars limit what comes back", async () => {
  const section = await call("get", { type: "page", id: guide, section: "Verify" });
  assert.equal(section.split("\n---\n")[1], "## Verify\nRun `make test`.");

  const long = fake.add("pages", { name: "Long", book_id: book, markdown: `## A\n${"line of text\n".repeat(200)}## B\nend` }).id;
  const text = await call("get", { type: "page", id: long, max_chars: 1000 });
  assert.match(text, /\[Characters 0–\d+ of \d+ in the page\. Continue with offset=\d+\.\]\nPage outline/);
  assert.ok(text.length < 1600);
  assert.match(await callError("get", { type: "page", id: guide, section: "Missing" }), /No heading matches "Missing"/);
});

test("get page: a WYSIWYG page is read through the Markdown export, without its title heading", async () => {
  const text = await call("get", { type: "page", id: wysiwyg });
  assert.ok(text.includes("Editor: WYSIWYG"));
  assert.ok(text.endsWith("---\nWritten in the visual editor"));
});

test("get: a missing item gives BookStack's error with a hint", async () => {
  const text = await callError("get", { type: "page", id: 99999 });
  assert.match(text, /^BookStack 404: Entity not found\nIt doesn't exist, or the token owner can't see it\./);
});

test("create_page: goes into a chapter or a book, and needs one of them", async () => {
  const text = await call("create_page", { name: "Runbook", markdown: "Steps.", chapter_id: chapter, tags: [{ name: "ops" }] });
  const created = fake.row("pages", idOf(text, "page"));
  assert.equal(created.book_id, book);
  assert.equal(created.markdown, "Steps.");
  assert.match(text, /^Created page\.\nPage: \[page:\d+\] Runbook/);
  assert.ok(!text.includes("---"), "the content isn't echoed back");

  const inBook = fake.row("pages", idOf(await call("create_page", { name: "Loose", markdown: "x", book_id: book }), "page"));
  assert.equal(inBook.chapter_id, null);
  assert.match(await callError("create_page", { name: "Nowhere", markdown: "x" }), /chapter_id or book_id/);
});

test("update_page: replace, append and prepend on a Markdown page", async () => {
  const id = fake.add("pages", { name: "Log", book_id: book, markdown: "middle\r\n" }).id;
  await call("update_page", { id, markdown: "last", mode: "append" });
  await call("update_page", { id, markdown: "first", mode: "prepend" });
  assert.equal(fake.row("pages", id).markdown, "first\n\nmiddle\n\nlast\n");
  await call("update_page", { id, markdown: "fresh" });
  assert.equal(fake.row("pages", id).markdown, "fresh");
});

test("update_page: a WYSIWYG page stays WYSIWYG, with the Markdown converted to HTML", async () => {
  const id = fake.add("pages", { name: "Visual", book_id: book, html: "<p>Old</p>" }).id;
  const text = await call("update_page", { id, markdown: "**New** line", mode: "append" });
  const page = fake.row("pages", id);
  assert.equal(page.markdown, "");
  assert.match(page.html, /^<p>Old<\/p>\n\n<p><strong>New<\/strong> line<\/p>/);
  assert.ok(text.includes("Editor: WYSIWYG"));
});

test("update_page: rename, retag and move without touching the content", async () => {
  const id = fake.add("pages", { name: "Draft", book_id: book, markdown: "body" }).id;
  fake.requests.length = 0;
  await call("update_page", { id, name: "Final", tags: [{ name: "done" }], move_to_chapter_id: chapter });
  const page = fake.row("pages", id);
  assert.deepEqual([page.name, page.chapter_id, page.markdown, page.tags], ["Final", chapter, "body", [{ name: "done" }]]);
  assert.equal(fake.requests[0], `PUT pages/${id}`, "no need to read the page first");

  assert.match(await callError("update_page", { id }), /Nothing to update/);
  assert.match(await callError("update_page", { id, move_to_chapter_id: chapter, move_to_book_id: book }), /not both/);
});

test("update_page: expected_revision refuses to overwrite a page saved in the meantime", async () => {
  const id = fake.add("pages", { name: "Shared", book_id: book, markdown: "v1" }).id;
  await call("update_page", { id, markdown: "v2", expected_revision: 1 });
  assert.equal(fake.row("pages", id).markdown, "v2");

  const refused = await callError("update_page", { id, markdown: "stale rewrite", expected_revision: 1 });
  assert.match(refused, /has been saved since you read it: it's at revision 2 \(updated 2026-02-02 by Tester\), not 1\. Nothing was changed\./);
  assert.equal(fake.row("pages", id).markdown, "v2");

  assert.match(await callError("update_page", { id, name: "Renamed", expected_revision: 1 }), /has been saved since/);
  assert.equal(fake.row("pages", id).name, "Shared");
});

test("edit_page: replaces exactly one occurrence, matching across CRLF", async () => {
  const text = await call("edit_page", { id: guide, old_text: "Run `make`.\n\n## Verify", new_text: "Run `make all`.\n\n## Verify" });
  assert.match(text, /^Replaced 1 occurrence\(s\)\./);
  assert.equal(fake.row("pages", guide).markdown, "## Install\nRun `make all`.\n\n## Verify\nRun `make test`.");
});

test("edit_page: missing or repeated text changes nothing", async () => {
  const id = fake.add("pages", { name: "Repeats", book_id: book, markdown: "a $& b\na $& b" }).id;
  assert.match(await callError("edit_page", { id, old_text: "zzz", new_text: "y" }), /old_text not found/);
  assert.match(await callError("edit_page", { id, old_text: "a", new_text: "y" }), /occurs 2 times/);
  assert.equal(fake.row("pages", id).revision_count, 1);

  await call("edit_page", { id, old_text: "a", new_text: "$1", replace_all: true });
  assert.equal(fake.row("pages", id).markdown, "$1 $& b\n$1 $& b", "replacement text is literal, not a pattern");
});

test("edit_page: refuses WYSIWYG pages and points to update_page", async () => {
  assert.match(await callError("edit_page", { id: wysiwyg, old_text: "Written", new_text: "x" }), /uses the WYSIWYG editor.*Use update_page/s);
});

test("create_book: can be put on a shelf, keeping the books already there", async () => {
  const text = await call("create_book", { name: "Runbooks", shelf_id: shelf });
  const created = idOf(text, "book");
  assert.ok(text.includes(`Added to [shelf:${shelf}] Engineering`));
  assert.deepEqual(fake.row("shelves", shelf).books, [book, created]);

  const orphan = await call("create_book", { name: "Orphan", shelf_id: 99999 });
  assert.match(orphan, /^Created book\./);
  assert.match(orphan, /Warning: the book was created, but adding it to shelf:99999 failed/);
});

test("create_chapter and create_shelf", async () => {
  const chapterText = await call("create_chapter", { book_id: book, name: "Reference", description: "Lookups" });
  assert.equal(fake.row("chapters", idOf(chapterText, "chapter")).book_id, book);
  assert.ok(chapterText.includes("Description: Lookups"));

  const shelfText = await call("create_shelf", { name: "Archive", book_ids: [book] });
  assert.deepEqual(fake.row("shelves", idOf(shelfText, "shelf")).books, [book]);
});

test("update: renames, moves chapters and edits a shelf's books", async () => {
  const other = fake.add("books", { name: "Other" }).id;
  const moving = fake.add("chapters", { name: "Movable", book_id: book }).id;
  await call("update", { type: "chapter", id: moving, name: "Moved", move_to_book_id: other });
  assert.deepEqual([fake.row("chapters", moving).name, fake.row("chapters", moving).book_id], ["Moved", other]);

  const target = fake.add("shelves", { name: "Mixed", books: [book] }).id;
  await call("update", { type: "shelf", id: target, add_book_ids: [other], remove_book_ids: [book] });
  assert.deepEqual(fake.row("shelves", target).books, [other]);

  assert.match(await callError("update", { type: "book", id: other, move_to_book_id: book }), /only applies to chapters/);
  assert.match(await callError("update", { type: "book", id: other, add_book_ids: [book] }), /only apply to shelves/);
  assert.match(await callError("update", { type: "book", id: other }), /Nothing to update/);
});

test("delete: names what was deleted", async () => {
  const id = fake.add("pages", { name: "Doomed", book_id: book, markdown: "x" }).id;
  assert.match(await call("delete", { type: "page", id }), new RegExp(`^Deleted \\[page:${id}\\] Doomed — it's in the recycle bin`));
  assert.equal(fake.row("pages", id), undefined);
});

test("invalid arguments are rejected before BookStack is called", async () => {
  fake.requests.length = 0;
  const { isError, text } = await raw("get", { type: "page", id: -1 }).catch((err) => ({ isError: true, text: String(err) }));
  assert.ok(isError, text);
  assert.deepEqual(fake.requests, []);
});
