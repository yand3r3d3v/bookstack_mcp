#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BookStackClient } from "./bookstack.js";
import { createServer } from "./server.js";

const REQUIRED = ["BOOKSTACK_URL", "BOOKSTACK_TOKEN_ID", "BOOKSTACK_TOKEN_SECRET"] as const;

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

await createServer(getClient).connect(new StdioServerTransport());
