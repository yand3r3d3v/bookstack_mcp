// An in-memory stand-in for the BookStack REST API, enough of it for the tools to run against:
// the four item types, list filters, search, Markdown export, API-token auth and rate limiting.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

type Kind = "shelves" | "books" | "chapters" | "pages";
// Loose on purpose: these are JSON bodies, and tests poke at whatever field they need.
type Row = Record<string, any>;

export const GOOD_TOKEN = { id: "good", secret: "secret" };

export interface FakeBookStack {
  url: string;
  /** Every API request received, as "METHOD path". */
  requests: string[];
  /** API tokens ("id:secret") the fake accepts; delete one to simulate a revoked token. */
  tokens: Set<string>;
  add(kind: Kind, fields: Row): Row;
  row(kind: Kind, id: number): Row;
  /** Answer the next `times` requests with 429. */
  rateLimit(times: number, retryAfter?: string): void;
  close(): Promise<void>;
}

export async function fakeBookStack(): Promise<FakeBookStack> {
  const rows: Record<Kind, Row[]> = { shelves: [], books: [], chapters: [], pages: [] };
  const requests: string[] = [];
  const tokens = new Set([`${GOOD_TOKEN.id}:${GOOD_TOKEN.secret}`]);
  let nextId = 1;
  let limited = 0;
  let retryAfter: string | undefined;

  const find = (kind: Kind, id: number) => rows[kind].find((row) => row.id === id);

  function add(kind: Kind, fields: Row): Row {
    const name = String(fields.name);
    const row: Row = { id: nextId++, slug: name.toLowerCase().replace(/\W+/g, "-"), updated_at: "2026-01-01T10:00:00.000000Z", ...fields };
    if (kind === "pages") {
      row.chapter_id ??= null;
      if (row.chapter_id) row.book_id = find("chapters", row.chapter_id)?.book_id;
      row.revision_count = 1;
      row.updated_by = { id: 1, name: "Tester" };
      setContent(row, fields);
    }
    rows[kind].push(row);
    return row;
  }

  /** Mirrors BookStack: saving Markdown keeps the source, saving HTML leaves `markdown` empty (a WYSIWYG page). */
  function setContent(row: Row, body: Row): void {
    if (body.markdown !== undefined) {
      row.markdown = body.markdown;
      row.html = `<p>${body.markdown}</p>`;
      row.editor = "markdown";
    } else if (body.html !== undefined) {
      row.markdown = "";
      row.html = body.html;
      row.editor = "wysiwyg";
    }
  }

  /** Single-item responses carry the item's children, as the real API does. */
  function detail(kind: Kind, row: Row): Row {
    const brief = ({ id, name, slug }: Row) => ({ id, name, slug });
    switch (kind) {
      case "shelves":
        return {
          ...row,
          books: (row.books ?? []).flatMap((id: number) => {
            const book = find("books", id);
            return book ? [{ ...brief(book), description: book.description }] : [];
          }),
        };
      case "books": {
        const chapters = rows.chapters
          .filter((c) => c.book_id === row.id)
          .map((c) => ({ ...brief(c), type: "chapter", pages: rows.pages.filter((p) => p.chapter_id === c.id).map(brief) }));
        const pages = rows.pages.filter((p) => p.book_id === row.id && !p.chapter_id).map((p) => ({ ...brief(p), type: "page" }));
        return { ...row, contents: [...chapters, ...pages], shelves: rows.shelves.filter((s) => s.books?.includes(row.id)).map(brief) };
      }
      case "chapters":
        return { ...row, pages: rows.pages.filter((p) => p.chapter_id === row.id).map(brief) };
      case "pages":
        return { ...row, raw_html: row.html };
    }
  }

  function list(kind: Kind, query: URLSearchParams): Row {
    let found = rows[kind];
    const idFilter = query.get("filter[id]");
    const bookFilter = query.get("filter[book_id]");
    const nameFilter = query.get("filter[name:like]")?.replaceAll("%", "").toLowerCase();
    if (idFilter) found = found.filter((row) => row.id === Number(idFilter));
    if (bookFilter) found = found.filter((row) => row.book_id === Number(bookFilter));
    if (nameFilter) found = found.filter((row) => row.name.toLowerCase().includes(nameFilter));
    const offset = Number(query.get("offset") ?? 0);
    const count = Number(query.get("count") ?? 100);
    // List endpoints give a bare user id, unlike single-item ones.
    const data = found.slice(offset, offset + count).map(({ markdown, html, ...row }) => ({ ...row, updated_by: 1 }));
    return { data, total: found.length };
  }

  function search(query: URLSearchParams): Row {
    const term = (query.get("query") ?? "").replace(/\{[^}]*\}/g, "").trim().toLowerCase();
    const type = query.get("query")?.match(/\{type:(\w+)\}/)?.[1];
    const data = rows.pages
      .filter((page) => (!type || type === "page") && `${page.name} ${page.markdown}`.toLowerCase().includes(term))
      .map((page) => ({
        id: page.id,
        name: page.name,
        slug: page.slug,
        type: "page",
        book: find("books", page.book_id),
        preview_html: { content: `<strong>${page.name}</strong> &amp; more` },
      }));
    return { data, total: data.length };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://fake");
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      res.writeHead(status, { "Content-Type": "application/json", ...headers }).end(JSON.stringify(body));
    const fail = (status: number, message: string, headers?: Record<string, string>) =>
      json(status, { error: { code: status, message } }, headers);

    if (!url.pathname.startsWith("/api/")) {
      // What a web app answers for anything that isn't its API.
      res.writeHead(url.pathname === "/moved/api/books" ? 302 : 200, { "Content-Type": "text/html", Location: "https://elsewhere.example/api/books" });
      res.end("<html>Not the API</html>");
      return;
    }
    const path = url.pathname.slice("/api/".length);
    requests.push(`${req.method} ${path}`);

    if (limited > 0) {
      limited--;
      return void fail(429, "Too Many Attempts.", retryAfter === undefined ? {} : { "Retry-After": retryAfter });
    }
    const token = req.headers.authorization?.match(/^Token (.+)$/)?.[1];
    if (!token || !tokens.has(token)) return void fail(401, "No authorization token found on the request");

    let body: Row = {};
    if (req.method === "POST" || req.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    }

    if (path === "search") return void json(200, search(url.searchParams));
    const [kind, idText, ...rest] = path.split("/") as [Kind, string | undefined, ...string[]];
    if (!(kind in rows)) return void fail(404, "Not found");

    if (idText === undefined) {
      if (req.method === "GET") return void json(200, list(kind, url.searchParams));
      if (!body.name) return void json(422, { error: { code: 422, message: "The given data was invalid.", validation: { name: ["The name field is required."] } } });
      return void json(200, detail(kind, add(kind, body)));
    }

    const row = find(kind, Number(idText));
    if (!row) return void fail(404, "Entity not found");
    if (rest.join("/") === "export/markdown") {
      return void res.writeHead(200, { "Content-Type": "text/markdown" }).end(`# ${row.name}\n\n${row.html.replace(/<[^>]+>/g, "")}`);
    }
    if (req.method === "PUT") {
      const { markdown, html, ...fields } = body;
      Object.assign(row, fields);
      if (kind === "pages") {
        setContent(row, body);
        row.revision_count++;
        row.updated_at = "2026-02-02T10:00:00.000000Z";
      }
    } else if (req.method === "DELETE") {
      rows[kind].splice(rows[kind].indexOf(row), 1);
      return void res.writeHead(204).end();
    }
    json(200, detail(kind, row));
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => res.writeHead(500).end(String(err)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    tokens,
    add,
    row: (kind, id) => find(kind, id)!,
    rateLimit(times, after) {
      limited = times;
      retryAfter = after;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
