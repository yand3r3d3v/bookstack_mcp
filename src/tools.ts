import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { marked } from "marked";
import { z } from "zod";
import {
  API_PATH,
  type Book,
  type BookStackClient,
  type Chapter,
  type Item,
  type ItemType,
  type ListResponse,
  type Page,
  type SearchResult,
  type Shelf,
} from "./bookstack.js";
import { day, flags, htmlToText, lf, normalizeType, oneLine, ref, tagsText } from "./format.js";

type GetClient = () => BookStackClient;

const id = z.number().int().positive();
const itemType = z.enum(["shelf", "book", "chapter", "page"]);
const containerType = z.enum(["shelf", "book", "chapter"]);
const tags = z
  .array(z.object({ name: z.string().min(1), value: z.string().optional() }))
  .describe("Tags as {name, value}. When updating, this replaces all existing tags.");

const LABEL: Record<ItemType, string> = { shelf: "Shelf", book: "Book", chapter: "Chapter", page: "Page" };
const PLURAL: Record<ItemType, string> = { shelf: "Shelves", book: "Books", chapter: "Chapters", page: "Pages" };

/** Turns a text-returning handler into an MCP tool callback; errors become readable tool errors. */
function run<A>(handler: (args: A) => Promise<string>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return { content: [{ type: "text", text: await handler(args) }] };
    } catch (err) {
      return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
    }
  };
}

export function registerReadTools(server: McpServer, client: GetClient): void {
  server.registerTool(
    "search",
    {
      title: "Search BookStack",
      description:
        "Full-text search across shelves, books, chapters and pages. Returns matches with [type:id] refs, " +
        "their location and a text snippet. BookStack search syntax works in `query`: " +
        '"exact phrase", [tag] or [tag=value], {in_name:word}, {updated_by:me}, {created_by:me}.',
      inputSchema: {
        query: z.string().min(1),
        type: itemType.optional().describe("Only return this kind of item"),
        page: z.number().int().min(1).default(1),
        count: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true },
    },
    run(async ({ query, type, page, count }) => {
      const filter = type ? ` {type:${type === "shelf" ? "bookshelf" : type}}` : "";
      const res = await client().get<ListResponse<SearchResult>>("search", { query: query + filter, page, count });
      if (!res.data.length) return `No results for ${JSON.stringify(query)}.`;

      const first = (page - 1) * count + 1;
      const last = first + res.data.length - 1;
      const noun = res.total === 1 ? "result" : "results";
      const lines = [`${res.total} ${noun} for ${JSON.stringify(query)} (showing ${first}–${last}):`];
      for (const r of res.data) {
        const where = [r.book && `in "${r.book.name}"`, r.chapter && `› "${r.chapter.name}"`].filter(Boolean).join(" ");
        lines.push(`- ${ref(normalizeType(r.type), r)}${flags(r)}${where ? ` — ${where}` : ""}`);
        const snippet = oneLine(htmlToText(r.preview_html?.content), 220);
        if (snippet) lines.push(`  ${snippet}`);
        if (r.tags?.length) lines.push(`  tags: ${tagsText(r.tags)}`);
      }
      if (last < res.total) lines.push(`More results: page=${page + 1}`);
      return lines.join("\n");
    }),
  );

  server.registerTool(
    "list",
    {
      title: "List BookStack items",
      description:
        "List shelves, books, chapters or pages. Use it to see what exists (e.g. all books) or to find " +
        "recently updated pages (sort=updated). To see what's inside a book, use get on the book instead.",
      inputSchema: {
        type: itemType,
        name_contains: z.string().optional().describe("Only items whose name contains this text"),
        book_id: id.optional().describe("Chapters/pages only: restrict to this book"),
        sort: z.enum(["name", "updated"]).default("name").describe("updated = most recently updated first"),
        count: z.number().int().min(1).max(500).default(100),
        offset: z.number().int().min(0).default(0),
      },
      annotations: { readOnlyHint: true },
    },
    run(async ({ type, name_contains, book_id, sort, count, offset }) => {
      if (book_id !== undefined && (type === "shelf" || type === "book")) {
        throw new Error("book_id only applies when listing chapters or pages.");
      }
      const res = await client().get<ListResponse<Item>>(API_PATH[type], {
        count,
        offset,
        sort: sort === "updated" ? "-updated_at" : "+name",
        "filter[name:like]": name_contains ? `%${name_contains}%` : undefined,
        "filter[book_id]": book_id,
      });
      if (!res.data.length) return `No ${PLURAL[type].toLowerCase()} found.`;

      const last = offset + res.data.length;
      const lines = [`${PLURAL[type]} ${offset + 1}–${last} of ${res.total}:`];
      for (const item of res.data) {
        const parent =
          type === "page" || type === "chapter"
            ? ` (book:${item.book_id}${item.chapter_id ? `, chapter:${item.chapter_id}` : ""})`
            : "";
        const updated = sort === "updated" ? ` · updated ${day(item.updated_at)}` : "";
        const description = item.description ? ` — ${oneLine(item.description, 120)}` : "";
        lines.push(`- ${ref(type, item)}${flags(item)}${parent}${updated}${description}`);
      }
      if (last < res.total) lines.push(`More: offset=${last}`);
      return lines.join("\n");
    }),
  );

  server.registerTool(
    "get",
    {
      title: "Get BookStack item",
      description:
        "Open one item by id. page → full content as Markdown plus its location. book → table of contents " +
        "(chapters and pages). chapter → its pages. shelf → its books.",
      inputSchema: { type: itemType, id },
      annotations: { readOnlyHint: true },
    },
    run(async ({ type, id }) => {
      const bs = client();
      switch (type) {
        case "page":
          return describePage(bs, await bs.get<Page>(`pages/${id}`), { withContent: true });
        case "book": {
          const book = await bs.get<Book>(`books/${id}`);
          const lines = header(bs, "book", book);
          if (book.shelves?.length) lines.push(`On shelves: ${book.shelves.map((s) => ref("shelf", s)).join(", ")}`);
          lines.push("", "Contents:");
          if (!book.contents) lines.push("(not returned by this BookStack version — use list with book_id)");
          else if (!book.contents.length) lines.push("(empty)");
          for (const entry of book.contents ?? []) {
            const entryType = entry.type === "chapter" ? "chapter" : "page";
            lines.push(`- ${ref(entryType, entry)}${flags(entry)}`);
            for (const page of entry.pages ?? []) lines.push(`  - ${ref("page", page)}${flags(page)}`);
          }
          return lines.join("\n");
        }
        case "chapter": {
          const chapter = await bs.get<Chapter>(`chapters/${id}`);
          const book = await findOne(bs, "book", chapter.book_id);
          const lines = header(bs, "chapter", chapter);
          lines.push(`Book: ${book ? ref("book", book) : `book:${chapter.book_id}`}`, "", "Pages:");
          if (!chapter.pages?.length) lines.push("(empty)");
          for (const page of chapter.pages ?? []) lines.push(`- ${ref("page", page)}${flags(page)}`);
          return lines.join("\n");
        }
        case "shelf": {
          const shelf = await bs.get<Shelf>(`shelves/${id}`);
          const lines = header(bs, "shelf", shelf);
          lines.push("", "Books:");
          if (!shelf.books?.length) lines.push("(empty)");
          for (const book of shelf.books ?? []) {
            lines.push(`- ${ref("book", book)}${book.description ? ` — ${oneLine(book.description, 120)}` : ""}`);
          }
          return lines.join("\n");
        }
      }
    }),
  );
}

export function registerWriteTools(server: McpServer, client: GetClient): void {
  server.registerTool(
    "create_page",
    {
      title: "Create page",
      description:
        "Create a page from Markdown, inside a chapter (chapter_id) or directly in a book (book_id). " +
        "Check first that a page on this topic doesn't already exist — updating beats duplicating.",
      inputSchema: {
        name: z.string().min(1).max(255),
        markdown: z
          .string()
          .min(1)
          .describe("Page body. Don't repeat the page name as a leading # heading — BookStack shows it as the title."),
        chapter_id: id.optional().describe("Put the page in this chapter"),
        book_id: id.optional().describe("Put the page directly in this book (ignored if chapter_id is set)"),
        tags: tags.optional(),
      },
    },
    run(async ({ name, markdown, chapter_id, book_id, tags }) => {
      if (!chapter_id && !book_id) throw new Error("Say where the page goes: chapter_id or book_id.");
      const bs = client();
      const page = await bs.post<Page>("pages", {
        name,
        markdown,
        tags,
        ...(chapter_id ? { chapter_id } : { book_id }),
      });
      return `Created page.\n${await describePage(bs, page)}`;
    }),
  );

  server.registerTool(
    "update_page",
    {
      title: "Update page",
      description:
        "Replace a page's content, add to its end/start (mode), rename it, retag it or move it. " +
        "For a small change inside an existing page prefer edit_page. WYSIWYG pages stay WYSIWYG " +
        "(the Markdown is converted to HTML).",
      inputSchema: {
        id,
        markdown: z.string().optional().describe("New content, applied according to mode"),
        mode: z
          .enum(["replace", "append", "prepend"])
          .default("replace")
          .describe("replace = markdown becomes the whole body; append/prepend = add it to the end/start"),
        name: z.string().min(1).max(255).optional().describe("New page name"),
        tags: tags.optional(),
        move_to_chapter_id: id.optional().describe("Move the page into this chapter"),
        move_to_book_id: id.optional().describe("Move the page to the top level of this book"),
      },
    },
    run(async ({ id, markdown, mode, name, tags, move_to_chapter_id, move_to_book_id }) => {
      if (move_to_chapter_id && move_to_book_id) {
        throw new Error("Pass either move_to_chapter_id or move_to_book_id, not both.");
      }
      const bs = client();
      const body: Record<string, unknown> = { name, tags, chapter_id: move_to_chapter_id, book_id: move_to_book_id };
      if (markdown !== undefined) {
        const current = await bs.get<Page>(`pages/${id}`);
        if (isMarkdownPage(current)) {
          body.markdown = combine(lf(current.markdown ?? ""), markdown, mode);
        } else {
          body.html = combine(current.raw_html ?? current.html ?? "", await marked.parse(markdown), mode);
        }
      }
      if (Object.values(body).every((v) => v === undefined)) {
        throw new Error("Nothing to update: pass markdown, name, tags or a move target.");
      }
      const page = await bs.put<Page>(`pages/${id}`, body);
      return `Updated page.\n${await describePage(bs, page)}`;
    }),
  );

  server.registerTool(
    "edit_page",
    {
      title: "Edit page text",
      description:
        "Exact find-and-replace in a page's Markdown source — the cheap way to fix or extend part of a page " +
        "without resending all of it. old_text must match the source exactly (read the page with get first). " +
        "Only for Markdown-editor pages; for WYSIWYG pages use update_page.",
      inputSchema: {
        id,
        old_text: z.string().min(1).describe("Exact text to find, including whitespace and Markdown syntax"),
        new_text: z.string().describe("Replacement text (empty string deletes old_text)"),
        replace_all: z.boolean().default(false).describe("Replace every occurrence instead of requiring exactly one"),
      },
    },
    run(async ({ id, old_text, new_text, replace_all }) => {
      const bs = client();
      const current = await bs.get<Page>(`pages/${id}`);
      if (!isMarkdownPage(current)) {
        throw new Error(
          `${ref("page", current)} uses the WYSIWYG editor, so it has no Markdown source to patch. ` +
            `Use update_page instead (mode replace/append) — it keeps the page WYSIWYG.`,
        );
      }
      const source = lf(current.markdown ?? "");
      const find = lf(old_text);
      const occurrences = source.split(find).length - 1;
      if (occurrences === 0) {
        throw new Error(`old_text not found in ${ref("page", current)}. It must match the Markdown source exactly.`);
      }
      if (occurrences > 1 && !replace_all) {
        throw new Error(
          `old_text occurs ${occurrences} times in ${ref("page", current)}. ` +
            `Include more surrounding text to make it unique, or set replace_all.`,
        );
      }
      const replacement = lf(new_text);
      const markdown = replace_all ? source.split(find).join(replacement) : source.replace(find, () => replacement);
      const page = await bs.put<Page>(`pages/${id}`, { markdown });
      return `Replaced ${occurrences} occurrence(s).\n${await describePage(bs, page)}`;
    }),
  );

  server.registerTool(
    "create_book",
    {
      title: "Create book",
      description: "Create a book, optionally placing it on a shelf.",
      inputSchema: {
        name: z.string().min(1).max(255),
        description: z.string().optional().describe("Short plain-text description"),
        shelf_id: id.optional().describe("Also add the new book to this shelf"),
        tags: tags.optional(),
      },
    },
    run(async ({ name, description, shelf_id, tags }) => {
      const bs = client();
      const book = await bs.post<Book>("books", { name, description, tags });
      const lines = ["Created book.", ...header(bs, "book", book)];
      if (shelf_id) {
        try {
          const shelf = await changeShelfBooks(bs, shelf_id, [book.id], []);
          lines.push(`Added to ${ref("shelf", shelf)}`);
        } catch (err) {
          lines.push(`Warning: the book was created, but adding it to shelf:${shelf_id} failed: ${errorText(err)}`);
        }
      }
      return lines.join("\n");
    }),
  );

  server.registerTool(
    "create_chapter",
    {
      title: "Create chapter",
      description: "Create a chapter in a book. Chapters group pages and can't be nested.",
      inputSchema: {
        book_id: id,
        name: z.string().min(1).max(255),
        description: z.string().optional().describe("Short plain-text description"),
        tags: tags.optional(),
      },
    },
    run(async ({ book_id, name, description, tags }) => {
      const bs = client();
      const chapter = await bs.post<Chapter>("chapters", { book_id, name, description, tags });
      return ["Created chapter.", ...header(bs, "chapter", chapter)].join("\n");
    }),
  );

  server.registerTool(
    "create_shelf",
    {
      title: "Create shelf",
      description: "Create a shelf (a group of books), optionally with books on it.",
      inputSchema: {
        name: z.string().min(1).max(255),
        description: z.string().optional().describe("Short plain-text description"),
        book_ids: z.array(id).optional().describe("Books to put on the shelf, in order"),
        tags: tags.optional(),
      },
    },
    run(async ({ name, description, book_ids, tags }) => {
      const bs = client();
      const shelf = await bs.post<Shelf>("shelves", { name, description, books: book_ids, tags });
      return ["Created shelf.", ...header(bs, "shelf", shelf)].join("\n");
    }),
  );

  server.registerTool(
    "update",
    {
      title: "Update shelf, book or chapter",
      description:
        "Rename a shelf/book/chapter or change its description or tags; move a chapter (with its pages) " +
        "to another book; add or remove books on a shelf. For pages use update_page / edit_page.",
      inputSchema: {
        type: containerType,
        id,
        name: z.string().min(1).max(255).optional(),
        description: z.string().optional().describe("New plain-text description"),
        tags: tags.optional(),
        move_to_book_id: id.optional().describe("Chapters only: move the chapter into this book"),
        add_book_ids: z.array(id).optional().describe("Shelves only: books to add"),
        remove_book_ids: z.array(id).optional().describe("Shelves only: books to take off the shelf"),
      },
    },
    run(async ({ type, id, name, description, tags, move_to_book_id, add_book_ids, remove_book_ids }) => {
      if (move_to_book_id && type !== "chapter") throw new Error("move_to_book_id only applies to chapters.");
      if ((add_book_ids || remove_book_ids) && type !== "shelf") {
        throw new Error("add_book_ids / remove_book_ids only apply to shelves.");
      }
      const bs = client();
      const body: Record<string, unknown> = { name, description, tags, book_id: move_to_book_id };
      if (add_book_ids || remove_book_ids) {
        const shelf = await bs.get<Shelf>(`shelves/${id}`);
        body.books = mergeIds(shelf.books ?? [], add_book_ids ?? [], remove_book_ids ?? []);
      }
      if (Object.values(body).every((v) => v === undefined)) throw new Error("Nothing to update.");
      const item = await bs.put<Item>(`${API_PATH[type]}/${id}`, body);
      return ["Updated.", ...header(bs, type, item)].join("\n");
    }),
  );

  server.registerTool(
    "delete",
    {
      title: "Delete item",
      description:
        "Move a page, chapter, book or shelf to the BookStack recycle bin (restorable by an admin). " +
        "Deleting a book or chapter deletes everything inside it; deleting a shelf keeps its books. " +
        "Only delete when the user explicitly asked for it.",
      inputSchema: { type: itemType, id },
      annotations: { destructiveHint: true },
    },
    run(async ({ type, id }) => {
      const bs = client();
      const item = await bs.get<Item>(`${API_PATH[type]}/${id}`);
      await bs.delete(`${API_PATH[type]}/${id}`);
      return `Deleted ${ref(type, item)} — it's in the recycle bin (Settings › Maintenance › Recycle Bin).`;
    }),
  );
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "document",
    {
      title: "Document this in BookStack",
      description: "Write up what we discussed or did in this conversation as BookStack documentation",
      argsSchema: {
        topic: z.string().optional().describe("What to document and/or where to put it"),
      },
    },
    ({ topic }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Document ${topic ? `"${topic}"` : "what we discussed and did in this conversation"} in BookStack.`,
              "",
              "1. Find where it belongs: search for related pages and look at the likely book's contents. If I named a place, use it.",
              "2. If a page already covers this, update it (edit_page for targeted changes, update_page with mode=append for a new section) instead of creating a duplicate. Otherwise create a page in the best-fitting book/chapter. If nothing fits, propose a location and ask me before creating new books or shelves.",
              "3. Write for a colleague who hasn't seen this conversation: context and purpose, the concrete steps, commands and config in code blocks, decisions with their reasons, and gotchas. Leave out chat back-and-forth and dead ends (unless they're worth a warning). Never include secrets — use placeholders.",
              "4. Write in the language of our conversation, in Markdown, without repeating the page title as a # heading.",
              "5. Finish by giving me the link to the page.",
            ].join("\n"),
          },
        },
      ],
    }),
  );
}

// ---------- helpers ----------

/**
 * A page is edited as Markdown if it has Markdown source. Pages saved from the WYSIWYG editor
 * have an empty `markdown` field, so for them we work with HTML instead.
 */
function isMarkdownPage(page: Page): boolean {
  if (page.markdown) return true;
  return page.editor === "markdown" && !htmlToText(page.html).trim();
}

function combine(current: string, addition: string, mode: "replace" | "append" | "prepend"): string {
  if (mode === "replace" || !current.trim()) return addition;
  return mode === "append"
    ? `${current.trimEnd()}\n\n${addition.trim()}\n`
    : `${addition.trim()}\n\n${current.trimStart()}`;
}

function mergeIds(current: Item[], add: number[], remove: number[]): number[] {
  const ids = new Set(current.map((b) => b.id));
  for (const bookId of add) ids.add(bookId);
  for (const bookId of remove) ids.delete(bookId);
  return [...ids];
}

async function changeShelfBooks(bs: BookStackClient, shelfId: number, add: number[], remove: number[]) {
  const shelf = await bs.get<Shelf>(`shelves/${shelfId}`);
  return bs.put<Shelf>(`shelves/${shelfId}`, { books: mergeIds(shelf.books ?? [], add, remove) });
}

/** Cheap lookup of a book/chapter's name and slug (a filtered list call, unlike GET which returns contents). */
async function findOne(bs: BookStackClient, type: "book" | "chapter", itemId: number): Promise<Item | undefined> {
  const res = await bs.get<ListResponse<Item>>(API_PATH[type], { "filter[id]": itemId, count: 1 });
  return res.data[0];
}

function itemUrl(bs: BookStackClient, type: ItemType, item: Item): string | undefined {
  if (item.url) return item.url;
  switch (type) {
    case "shelf":
      return `${bs.baseUrl}/shelves/${item.slug}`;
    case "book":
      return `${bs.baseUrl}/books/${item.slug}`;
    case "chapter":
      return item.book_slug && `${bs.baseUrl}/books/${item.book_slug}/chapter/${item.slug}`;
    case "page":
      // /link/{id} is BookStack's permalink; it redirects to the page's current URL.
      return item.book_slug ? `${bs.baseUrl}/books/${item.book_slug}/page/${item.slug}` : `${bs.baseUrl}/link/${item.id}`;
  }
}

function header(bs: BookStackClient, type: ItemType, item: Item): string[] {
  const url = itemUrl(bs, type, item);
  const lines = [`${LABEL[type]}: ${ref(type, item)}`, ...(url ? [`URL: ${url}`] : [])];
  if (item.tags?.length) lines.push(`Tags: ${tagsText(item.tags)}`);
  if (item.description) lines.push(`Description: ${item.description}`);
  return lines;
}

async function describePage(bs: BookStackClient, page: Page, opts: { withContent?: boolean } = {}): Promise<string> {
  const [book, chapter, content] = await Promise.all([
    findOne(bs, "book", page.book_id),
    page.chapter_id ? findOne(bs, "chapter", page.chapter_id) : undefined,
    opts.withContent ? pageMarkdown(bs, page) : undefined,
  ]);
  const location = [book ? ref("book", book) : `book:${page.book_id}`, chapter && ref("chapter", chapter)]
    .filter(Boolean)
    .join(" › ");
  const editor = isMarkdownPage(page) ? "markdown" : "WYSIWYG";
  const updatedBy = typeof page.updated_by === "object" ? ` by ${page.updated_by.name}` : "";

  const lines = [
    `Page: ${ref("page", page)}${flags(page)}`,
    `URL: ${itemUrl(bs, "page", { ...page, book_slug: book?.slug })}`,
    `Location: ${location}`,
    `Editor: ${editor} · updated ${day(page.updated_at)}${updatedBy} · revisions: ${page.revision_count ?? "?"}`,
  ];
  if (page.tags?.length) lines.push(`Tags: ${tagsText(page.tags)}`);
  if (content !== undefined) {
    if (editor === "WYSIWYG") lines.push("(WYSIWYG page: content converted to Markdown for reading; edit it with update_page)");
    lines.push("---", content.trim() || "(empty page)");
  }
  return lines.join("\n");
}

async function pageMarkdown(bs: BookStackClient, page: Page): Promise<string> {
  if (isMarkdownPage(page)) return lf(page.markdown ?? "");
  const exported = lf(await bs.text(`pages/${page.id}/export/markdown`));
  // The export starts with the page name as an H1, which the header already shows.
  return exported.replace(/^# [^\n]*\n+/, "");
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
