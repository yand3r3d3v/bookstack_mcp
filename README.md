# bookstack-mcp

**A focused MCP server for [BookStack](https://www.bookstackapp.com/), built for [Claude Code](https://claude.com/claude-code).**
Search, read and write your wiki in Markdown, straight from a chat with Claude — no dashboards, no
config files to hand-edit, no 50-tool surface to learn. 11 tools, 3 environment variables, one setup
command.

🇷🇺 [Русская версия](README.ru.md)

## Why this one

There are already a few BookStack MCP servers out there. Most of them expose the whole BookStack API
1:1 — dozens of tools, image galleries, Letta-specific compatibility notes, permission and user
management — which is powerful but a lot to load into a model's context and a lot to configure for
what most people actually want: *read the wiki, write to the wiki, in Markdown*.

This one does less on purpose:

- **11 tools**, not 30–60. `search` / `list` / `get` cover every read; six tools cover every write.
- **Markdown-native.** Pages come back as Markdown; new pages are written as Markdown; a targeted
  `edit_page` tool does find-and-replace on a page's source instead of resending the whole thing.
- **One setup command.** `npm run setup` asks for your BookStack URL and API token, verifies them
  against your instance, and registers the server in Claude Code's config itself.
- **Errors you can act on.** A bad token, a wrong URL, a permission gap, a rate limit — each comes
  back as a plain-English message with what to do about it, not a raw HTTP status.
- **No new infra.** stdio only, no server to host, no database, no Docker.

## Install

**1. Get a BookStack API token.** Avatar → *My Account* → *Access & Security* → *API Tokens* →
*Create Token* (older versions: *Edit Profile* → *API Tokens*). Save the *Token ID* and *Token
Secret* — the secret is shown once. The user's role needs the **Access System API** permission
(admins have it by default).

**2. Clone, install and run setup:**

```bash
git clone https://github.com/yand3r3d3v/bookstack_mcp.git
cd bookstack_mcp
npm install
npm run setup
```

`setup` asks for the URL, Token ID and Token Secret, checks them against your BookStack instance,
and registers the server in Claude Code's user config (`~/.claude.json`, available in every
project — it keeps a backup at `~/.claude.json.before-bookstack-mcp`). Run it again any time to
change settings; pressing Enter keeps the current value.

**3. Start a new Claude Code session.** Run `/mcp` to confirm `bookstack` shows up connected.

<details>
<summary>Manual setup (no script)</summary>

Add this to `~/.claude.json` under `mcpServers` (or to a project's own `.mcp.json` if you only want
it there):

```json
"bookstack": {
  "type": "stdio",
  "command": "/opt/homebrew/bin/node",
  "args": ["/path/to/bookstack_mcp/dist/index.js"],
  "env": {
    "BOOKSTACK_URL": "https://wiki.example.com",
    "BOOKSTACK_TOKEN_ID": "...",
    "BOOKSTACK_TOKEN_SECRET": "..."
  }
}
```

Use an absolute path to `node` — the GUI app doesn't always inherit your shell's `PATH`. Run
`npm run build` first so `dist/index.js` exists.
</details>

## Usage

Just ask, in plain language:

- "search the wiki for how we configured nginx"
- "what's in the Infra book?"
- "write this up in the Infra book, Networking chapter"
- "add a section about the new cameras to the VLAN page"
- "create a Projects shelf with a Backend book on it"

For the common "write up what we just did" case, there's a ready-made prompt:

```text
/mcp__bookstack__document
```

Claude will find the right place for it, check whether a page on the topic already exists (and
extend it instead of creating a near-duplicate), write it for a colleague who wasn't in this
conversation, and hand you the link.

To stop Claude Code from asking permission for every read, add this to `~/.claude/settings.json`:

```json
{ "permissions": { "allow": ["mcp__bookstack__search", "mcp__bookstack__list", "mcp__bookstack__get"] } }
```

Write tools will still ask for confirmation.

## Tools

| Tool | What it does |
|---|---|
| `search` | Full-text search, with BookStack's own syntax: `"exact phrase"`, `[tag=value]`, `{in_name:...}` |
| `list` | List shelves / books / chapters / pages; filter by name or book, sort by last updated |
| `get` | Page → its content as Markdown; book → table of contents; chapter → its pages; shelf → its books |
| `create_page` | New page from Markdown, in a chapter or directly in a book |
| `update_page` | Replace content, append/prepend (`mode`), rename, retag, move |
| `edit_page` | Exact find-and-replace on a page's Markdown source — no need to resend the whole page |
| `create_book` | New book (optionally placed on a shelf) |
| `create_chapter` | New chapter in a book |
| `create_shelf` | New shelf with books on it |
| `update` | Rename / describe / tag a shelf, book or chapter; move a chapter; add or remove books on a shelf |
| `delete` | Move to BookStack's recycle bin (*Settings → Maintenance → Recycle Bin*) |

Every item in a response is shown as `[page:12] Name` — those ids are what you pass back to the
tools.

## Markdown vs. WYSIWYG

BookStack has two editors: **WYSIWYG** (visual, stores HTML) and **Markdown** (stores Markdown
source). This server works in Markdown and preserves each page's own editor:

| | Markdown page | WYSIWYG page |
|---|---|---|
| Read (`get`) | source as-is | converted to Markdown via BookStack's own export |
| `update_page` | writes Markdown | Markdown → HTML, page stays WYSIWYG; `append`/`prepend` leave the existing HTML alone |
| `edit_page` | exact match-and-replace on the source | unavailable (no Markdown source) — use `update_page` |

New pages are always created in Markdown. Beyond standard GFM (tables, task lists, fenced code),
BookStack understands callout blocks: `<p class="callout info">Text</p>` (`info`, `success`,
`warning`, `danger`).

## Configuration

| Variable | |
|---|---|
| `BOOKSTACK_URL` | Your BookStack address, e.g. `https://wiki.example.com` |
| `BOOKSTACK_TOKEN_ID` | Token ID |
| `BOOKSTACK_TOKEN_SECRET` | Token Secret |
| `BOOKSTACK_READ_ONLY` | `true` — read-only: write tools aren't registered at all |

Permissions are entirely the token owner's: the server sees and can change exactly what that user
can in the web UI — nothing more.

## What's here and what isn't

**Covers:** shelves, books, chapters and pages — reading, full-text search, creating, editing
(whole-page replace, append/prepend, and exact find-and-replace), renaming, tagging, moving between
books/chapters, adding/removing books on a shelf, and soft-delete to the recycle bin.

**Not (yet) covered**, because most people setting this up for Claude Code don't need it day one:

- Images, drawings and file attachments (BookStack's image gallery / attachments API)
- Comments on pages
- Users, roles and content permissions
- The recycle bin itself (restoring or permanently deleting) — only sending items *to* it
- Page templates
- Audit log
- Exporting to PDF / plain HTML (Markdown export is used internally for reading WYSIWYG pages)
- Talking to more than one BookStack instance from a single server process
- Any transport besides stdio (no HTTP/SSE server, no auth flow beyond the API token)

If you need any of these, they're reasonably contained additions to `src/tools.ts` and
`src/bookstack.ts` — issues and PRs welcome. See [Development](#development) below.

## Troubleshooting

Errors come back straight into the conversation, so Claude will show them. Common ones:

- **"isn't configured"** — environment variables aren't set. Run `npm run setup`.
- **401** — wrong Token ID / Secret, or the token expired.
- **403** — the role is missing *Access System API*, or lacks permission on that specific book/page.
- **"redirects to https://…"** — use `https://` in the URL.
- **Self-signed certificate** — add `NODE_EXTRA_CA_CERTS=/path/to/ca.pem` to the server's `env`.
- **Moved the project folder** — run `npm run setup` again; the server's path is stored in the config.
- **Rate limited** — BookStack defaults to 180 requests/minute.

## Development

```bash
npm run build
```

- [`src/bookstack.ts`](src/bookstack.ts) — HTTP client for the BookStack API and human-readable errors
- [`src/tools.ts`](src/tools.ts) — the MCP tools and the `document` prompt
- [`src/index.ts`](src/index.ts) — starts the MCP server (stdio) and sets the model instructions
- [`src/setup.ts`](src/setup.ts) — the setup wizard

## License

[MIT](LICENSE)
