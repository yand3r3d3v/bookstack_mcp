// The MCP server itself, shared by both transports: stdio (index.ts) and HTTP (http.ts).

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BookStackClient } from "./bookstack.js";
import { registerPrompts, registerReadTools, registerWriteTools } from "./tools.js";

export const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

export const readOnly = /^(1|true|yes|on)$/i.test(process.env.BOOKSTACK_READ_ONLY ?? "");

const READ_INSTRUCTIONS = `BookStack wiki. Hierarchy: shelf → book → chapter → page. Pages can also sit directly in a book; chapters can't nest.
Items are shown as [type:id] — pass those ids back to the tools.
To find things: search (full text, tags) or list; get a book for its table of contents; get a page to read it as Markdown.`;

const WRITE_INSTRUCTIONS = `

Writing:
- Content is Markdown: GFM tables, task lists, fenced code. Callouts are HTML: <p class="callout info">…</p> (info, success, warning, danger).
- BookStack shows the page name as its title, so don't start the body with it as a # heading; use ## and below.
- Before creating a page, check (search / get book) whether one on the topic exists and update it instead of creating a near-duplicate.
- For small changes use edit_page instead of resending the whole page.
- If it's unclear where something belongs, suggest a location and ask the user.
- Never put secrets (passwords, tokens, keys) into pages.
- After writing, give the user the page URL.`;

export function createServer(getClient: () => BookStackClient): McpServer {
  const server = new McpServer(
    { name: "bookstack", version },
    { instructions: readOnly ? READ_INSTRUCTIONS : READ_INSTRUCTIONS + WRITE_INSTRUCTIONS },
  );
  registerReadTools(server, getClient);
  if (!readOnly) {
    registerWriteTools(server, getClient);
    registerPrompts(server);
  }
  return server;
}
