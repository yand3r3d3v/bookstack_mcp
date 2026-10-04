#!/usr/bin/env node
// Interactive setup: asks for the BookStack URL and API token, checks them against the API and
// registers the server in Claude Code's user config (~/.claude.json). The Claude Code CLI and the
// Code tab of the Claude desktop app both read that file, so the server shows up in every project.

import { accessSync, constants, copyFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { delimiter, join, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { BookStackClient, type Item, type ListResponse } from "./bookstack.js";

const CONFIG_PATH = join(homedir(), ".claude.json");
const SERVER_NAME = "bookstack";

type ServerEntry = { type: "stdio"; command: string; args: string[]; env: Record<string, string> };

const config = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, "utf8")) : {};
const previous: Record<string, string> = config.mcpServers?.[SERVER_NAME]?.env ?? {};

// Pull lines from an iterator rather than rl.question(), which drops answers when stdin is piped.
const rl = createInterface({ input: process.stdin });
const lines = rl[Symbol.asyncIterator]();

async function ask(question: string, current?: string, shown = current): Promise<string> {
  process.stdout.write(current ? `${question} [${shown}]: ` : `${question}: `);
  const { value, done } = await lines.next();
  return (done ? "" : String(value).trim()) || current || "";
}

console.log(`BookStack MCP setup

You need a BookStack API token: open BookStack → your avatar → My Account → Access & Security
(older versions: Edit Profile) → API Tokens → Create Token. Your role needs the
"Access System API" permission (admins have it). Press Enter to keep a value in [brackets].
`);

const url = await ask("BookStack URL (e.g. https://wiki.example.com)", previous.BOOKSTACK_URL);
const tokenId = await ask("Token ID", previous.BOOKSTACK_TOKEN_ID);
const tokenSecret = await ask("Token Secret", previous.BOOKSTACK_TOKEN_SECRET, "keep current");
const readOnly = /^y/i.test(await ask("Read-only mode, i.e. no creating/editing? (y/N)", previous.BOOKSTACK_READ_ONLY ? "y" : "n"));
rl.close();

if (!url || !tokenId || !tokenSecret) {
  console.error("\nURL, Token ID and Token Secret are all required.");
  process.exit(1);
}

process.stdout.write("\nChecking connection… ");
const bookstack = new BookStackClient(url, tokenId, tokenSecret);
try {
  const [books, shelves] = await Promise.all([
    bookstack.get<ListResponse<Item>>("books", { count: 1 }),
    bookstack.get<ListResponse<Item>>("shelves", { count: 1 }),
  ]);
  const system = await bookstack.get<{ version?: string }>("system").catch(() => undefined);
  console.log(
    `OK${system?.version ? ` — BookStack ${system.version}` : ""}. ` +
      `Visible to the token: ${shelves.total} shelves, ${books.total} books.`,
  );
} catch (err) {
  console.log(`failed.\n\n${err instanceof Error ? err.message : err}`);
  process.exit(1);
}

// Run through npx, this file sits in npx's cache, which can be cleaned out at any time: register
// the server as an npx command too, rather than as a path into the cache.
const serverPath = fileURLToPath(new URL("./index.js", import.meta.url));
const viaNpx = serverPath.includes(`${sep}_npx${sep}`);
const { name: packageName } = createRequire(import.meta.url)("../package.json") as { name: string };

const entry: ServerEntry = {
  type: "stdio",
  command: stablePath(viaNpx ? "npx" : "node"),
  args: viaNpx ? ["-y", packageName] : [serverPath],
  env: {
    BOOKSTACK_URL: bookstack.baseUrl,
    BOOKSTACK_TOKEN_ID: tokenId,
    BOOKSTACK_TOKEN_SECRET: tokenSecret,
    ...(readOnly ? { BOOKSTACK_READ_ONLY: "true" } : {}),
  },
};
config.mcpServers = { ...config.mcpServers, [SERVER_NAME]: entry };

// Keep a copy of the original and replace the file atomically: it also holds Claude Code's own state.
if (existsSync(CONFIG_PATH)) copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.before-bookstack-mcp`);
const mode = existsSync(CONFIG_PATH) ? statSync(CONFIG_PATH).mode & 0o777 : 0o600;
const tmp = `${CONFIG_PATH}.${process.pid}.tmp`;
writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode });
renameSync(tmp, CONFIG_PATH);

console.log(`
Registered MCP server "${SERVER_NAME}" in ${CONFIG_PATH}${readOnly ? " (read-only)" : ""}.
Start a new Claude Code session (in the desktop app: a new session in the Code tab) —
the BookStack tools show up as mcp__bookstack__*. Check with /mcp if they don't.`);

/**
 * The absolute path of `node` / `npx` as found on PATH (e.g. /opt/homebrew/bin/node): absolute because
 * the desktop app doesn't always inherit the shell's PATH, and from PATH rather than process.execPath,
 * which on Homebrew resolves to a versioned Cellar path that disappears after `brew upgrade node`.
 */
function stablePath(command: "node" | "npx"): string {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return command === "node" ? process.execPath : command;
}
