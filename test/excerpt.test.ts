import assert from "node:assert/strict";
import { test } from "node:test";
import { excerpt, headings } from "../dist/excerpt.js";

const PAGE = [
  "Intro line.",
  "",
  "## Install",
  "Run the installer.",
  "",
  "### Linux",
  "apt install thing",
  "",
  "```bash",
  "# not a heading",
  "```",
  "",
  "## Usage ##",
  "Use it.",
].join("\n");

test("headings: finds ATX headings and ignores fenced code", () => {
  assert.deepEqual(
    headings(PAGE).map((h) => `${h.level} ${h.text}`),
    ["2 Install", "3 Linux", "2 Usage"],
  );
  assert.equal(PAGE.slice(headings(PAGE)[2].offset).split("\n")[0], "## Usage ##");
});

test("headings: a fence only closes on the same kind of marker", () => {
  const text = "~~~\n```\n# still code\n~~~\n# real";
  assert.deepEqual(headings(text).map((h) => h.text), ["real"]);
});

test("excerpt: a page that fits comes back unchanged, with no notes", () => {
  assert.equal(excerpt(PAGE, { offset: 0, maxChars: 30_000 }), PAGE);
});

test("excerpt: a long page is cut at a line break, with the offset to continue and the outline", () => {
  const text = excerpt(PAGE, { offset: 0, maxChars: 45 });
  const [body, note] = text.split("\n\n[");
  assert.equal(body, "Intro line.\n\n## Install\nRun the installer.");
  assert.match(note, /^Characters 0–44 of \d+ in the page\. Continue with offset=44\.\]/);
  assert.match(note, /- Install\n {2}- Linux\n- Usage$/);
});

test("excerpt: reading on from the offset reaches the end, and the parts add up to the page", () => {
  const rest = excerpt(PAGE, { offset: 44, maxChars: 30_000 });
  assert.ok(rest.startsWith("### Linux"));
  assert.match(rest, /\[Characters 44–\d+ of \d+ in the page\.\]$/);
  assert.ok(!rest.includes("Continue with"));

  let offset = 0;
  let joined = "";
  for (let i = 0; i < 100; i++) {
    const part = excerpt(PAGE, { offset, maxChars: 25 });
    joined += part.split("\n\n[")[0].trim();
    const next = part.match(/Continue with offset=(\d+)/);
    if (!next) break;
    offset = Number(next[1]);
  }
  assert.equal(joined.replace(/\s/g, ""), PAGE.replace(/\s/g, ""));
});

test("excerpt: a line longer than max_chars is cut mid-line rather than returned empty", () => {
  const text = excerpt("x".repeat(100), { offset: 0, maxChars: 30 });
  assert.ok(text.startsWith(`${"x".repeat(30)}\n\n[Characters 0–30 of 100`));
});

test("excerpt: section returns the heading with its subsections, up to the next heading of that level", () => {
  const section = excerpt(PAGE, { section: "Install", offset: 0, maxChars: 30_000 });
  assert.ok(section.startsWith("## Install"));
  assert.ok(section.includes("### Linux"));
  assert.ok(!section.includes("Usage"));

  assert.equal(excerpt(PAGE, { section: "## usage", offset: 0, maxChars: 30_000 }), "## Usage ##\nUse it.");
  assert.ok(excerpt(PAGE, { section: "linu", offset: 0, maxChars: 30_000 }).startsWith("### Linux"));
});

test("excerpt: a long section continues by offset within the section", () => {
  const first = excerpt(PAGE, { section: "Install", offset: 0, maxChars: 30 });
  assert.match(first, /in this section\. Continue with offset=30 and the same section\.\]$/);
  assert.ok(excerpt(PAGE, { section: "Install", offset: 30, maxChars: 30_000 }).startsWith("### Linux"));
});

test("excerpt: unknown or ambiguous section lists the headings", () => {
  assert.throws(() => excerpt(PAGE, { section: "Nope", offset: 0, maxChars: 100 }), /No heading matches "Nope".*\n- Install/s);
  assert.throws(() => excerpt(PAGE, { section: "s", offset: 0, maxChars: 100 }), /2 headings match "s"/);
  assert.throws(() => excerpt("plain", { section: "x", offset: 0, maxChars: 100 }), /no headings/);
});

test("excerpt: offset past the end is an error, an empty page is not", () => {
  assert.throws(() => excerpt(PAGE, { offset: 9999, maxChars: 100 }), /past the end: the page is \d+ characters/);
  assert.equal(excerpt("", { offset: 0, maxChars: 100 }), "");
});
