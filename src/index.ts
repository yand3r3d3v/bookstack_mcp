#!/usr/bin/env node
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BookStackClient } from "./bookstack.js";
import { registerPrompts, registerReadTools, registerWriteTools } from "./tools.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const REQUIRED = ["BOOKSTACK_URL", "BOOKSTACK_TOKEN_ID", "BOOKSTACK_TOKEN_SECRET"] as const;
const readOnly = /^(1|true|yes|on)$/i.test(process.env.BOOKSTACK_READ_ONLY ?? "");

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

// Missing config shouldn't stop the server from starting: the tools report it instead,
// so the problem is visible in the conversation rather than hidden in MCP logs.
let client: BookStackClient | undefined;
function getClient(): BookStackClient {
  const missing = REQUIRED.filter((name) => !process.env[name]?.trim());
  if (missing.length) {
    throw new Error(`The BookStack MCP server isn't configured: ${missing.join(", ")} not set. Run \`npm run setup\` in the bookstack-mcp folder.`);
  }
  client ??= new BookStackClient(
    process.env.BOOKSTACK_URL!,
    process.env.BOOKSTACK_TOKEN_ID!,
    process.env.BOOKSTACK_TOKEN_SECRET!,
  );
  return client;
}

const server = new McpServer(
  { name: "bookstack", version },
  { instructions: readOnly ? READ_INSTRUCTIONS : READ_INSTRUCTIONS + WRITE_INSTRUCTIONS },
);

registerReadTools(server, getClient);
if (!readOnly) {
  registerWriteTools(server, getClient);
  registerPrompts(server);
}

await server.connect(new StdioServerTransport());
