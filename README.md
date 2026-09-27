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
- **No new infra.** For yourself it runs over stdio: no server, no database, no Docker. For a team there's
  an [optional HTTP mode](#shared-server-http) — one container, still no database, and everyone signs in
  with their own BookStack token.

## Install

**1. Get a BookStack API token.** Avatar → *My Account* → *Access & Security* → *API Tokens* →
*Create Token* (older versions: *Edit Profile* → *API Tokens*). Save the *Token ID* and *Token
Secret* — the secret is shown once. The user's role needs the **Access System API** permission
(admins have it by default).

**2. Add the server** — either from the Docker image (nothing to clone or build) or from source.

**Option A: Docker.** Add this to `~/.claude.json` under `mcpServers` (or to a project's own
`.mcp.json` if you only want it there):

```json
"bookstack": {
  "type": "stdio",
  "command": "docker",
  "args": [
    "run", "-i", "--rm", "--no-healthcheck",
    "-e", "BOOKSTACK_URL", "-e", "BOOKSTACK_TOKEN_ID", "-e", "BOOKSTACK_TOKEN_SECRET",
    "ghcr.io/yand3r3d3v/bookstack_mcp:latest", "node", "dist/index.js"
  ],
  "env": {
    "BOOKSTACK_URL": "https://wiki.example.com",
    "BOOKSTACK_TOKEN_ID": "...",
    "BOOKSTACK_TOKEN_SECRET": "..."
  }
}
```

This is the same image as the [shared server](#shared-server-http); `node dist/index.js` at the end
switches it to stdio. The bare `-e NAME` flags pass the values from `env` into the container, so the
secret doesn't end up in `args`. The image is multi-arch (amd64 / arm64); `:latest` follows `main`,
release tags like `:0.1.0` are pinned. To update: `docker pull ghcr.io/yand3r3d3v/bookstack_mcp:latest`.
If the desktop app can't find `docker`, use its absolute path (`which docker`).

**Option B: from source.** Clone, install and run setup:

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

## Shared server (HTTP)

Instead of everyone cloning the repo, you can run one server for the whole team and add it to Claude by
URL. It works behind a reverse proxy on a **sub-path** of an existing domain
(`https://tools.example.com/bookstack-mcp`), so no new domain or certificate is needed.

- **Each person signs in with their own BookStack API token** through a standard OAuth flow: Claude opens
  a sign-in page, you paste your Token ID and Secret, done. Everyone keeps exactly their own BookStack
  permissions.
- **The server stores nothing.** The tokens it hands to Claude are encrypted with `MCP_AUTH_SECRET` and
  carry the user's BookStack token inside. No database, no sessions — restart or scale it freely.
- **Revoking access** = deleting the API token in BookStack (takes effect within 5 minutes).

### Run it

The image is prebuilt on GHCR, so you only need two files, not the repo:

```bash
mkdir bookstack-mcp && cd bookstack-mcp
curl -fsSLO https://raw.githubusercontent.com/yand3r3d3v/bookstack_mcp/main/compose.yaml
curl -fsSL https://raw.githubusercontent.com/yand3r3d3v/bookstack_mcp/main/.env.example -o .env
# fill in BOOKSTACK_URL, MCP_PUBLIC_URL, MCP_AUTH_SECRET in .env
docker compose up -d
```

To update: `docker compose pull && docker compose up -d`. From a checkout of the repo,
`docker compose up -d --build` builds the image locally instead. Without Docker: `npm install &&
npm run build`, set the variables, `npm run serve`.

| Variable | |
|---|---|
| `BOOKSTACK_URL` | Your BookStack, e.g. `https://wiki.example.com` |
| `MCP_PUBLIC_URL` | This server's public address **including the sub-path**, e.g. `https://tools.example.com/bookstack-mcp`. The MCP endpoint is this + `/mcp` |
| `MCP_AUTH_SECRET` | Encrypts the tokens given to Claude: `openssl rand -base64 32`. Keep it secret; changing it signs everyone out |
| `MCP_ALLOWED_REDIRECT_HOSTS` | Where sign-in may redirect back to. Default `claude.ai,claude.com,localhost,127.0.0.1,[::1]` — enough for Claude; add hosts for other MCP clients, `*` allows any |
| `MCP_HOST`, `MCP_PORT` | Listen address, default `127.0.0.1:3000` (`0.0.0.0` in Docker) |
| `BOOKSTACK_READ_ONLY` | `true` — read tools only |

`BOOKSTACK_TOKEN_ID` / `BOOKSTACK_TOKEN_SECRET` aren't used in this mode.

### Reverse proxy on a sub-path

nginx, in the `server` block of the existing domain:

```nginx
location /bookstack-mcp/ {
    proxy_pass http://127.0.0.1:3000;
}

# OAuth discovery checks the root of the domain first (RFC 8414). Required if the main site answers
# unknown URLs with 200 (an SPA, a catch-all) — otherwise Claude fails to connect; harmless either way.
location = /.well-known/oauth-authorization-server/bookstack-mcp {
    proxy_pass http://127.0.0.1:3000;
}
location = /.well-known/oauth-protected-resource/bookstack-mcp/mcp {
    proxy_pass http://127.0.0.1:3000;
}
```

The sub-path may be passed through as-is (as above) or stripped (`proxy_pass http://127.0.0.1:3000/;`);
the server accepts both. Any other proxy works the same way. HTTPS is required for anything but
`localhost`.

### Connect Claude

**As a connector** (Claude desktop app, claude.ai — Chat, Cowork and the Code tab alike): *Settings →
Connectors → Add custom connector*, URL `https://tools.example.com/bookstack-mcp/mcp`, then *Connect* and
sign in with your BookStack token. On Team/Enterprise plans an owner adds it once for the organization.
Claude reaches custom connectors **from Anthropic's cloud**, so the server has to be reachable from the
internet, not just from your VPN.

**In Claude Code** (CLI; the desktop Code tab reads the same config) — the connection is made from your
machine, so an internal-only server is fine:

```bash
claude mcp add --transport http --scope user bookstack https://tools.example.com/bookstack-mcp/mcp
```

Then run `/mcp`, pick `bookstack` → *Authenticate*. Or skip OAuth and pass the BookStack token directly:

```bash
claude mcp add --transport http --scope user bookstack https://tools.example.com/bookstack-mcp/mcp --header "Authorization: Token TOKEN_ID:TOKEN_SECRET"
```

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

If you need any of these, they're reasonably contained additions to `src/tools.ts` and
`src/bookstack.ts` — issues and PRs welcome. See [Development](#development) below.

## Troubleshooting

Errors come back straight into the conversation, so Claude will show them. Common ones:

- **"isn't configured"** — environment variables aren't set. Run `npm run setup` (Docker: check both
  `env` and the `-e` flags in `args`).
- **401** — wrong Token ID / Secret, or the token expired.
- **403** — the role is missing *Access System API*, or lacks permission on that specific book/page.
- **"redirects to https://…"** — use `https://` in the URL.
- **Self-signed certificate** — add `NODE_EXTRA_CA_CERTS=/path/to/ca.pem` to the server's `env`.
  Docker: mount the file too — `"-v", "/path/to/ca.pem:/ca.pem:ro", "-e", "NODE_EXTRA_CA_CERTS=/ca.pem"`.
- **Docker: BookStack on `localhost`** — inside the container `localhost` is the container itself; use
  `http://host.docker.internal:PORT` instead (on Linux also add
  `"--add-host=host.docker.internal:host-gateway"` to `args`).
- **Moved the project folder** — run `npm run setup` again; the server's path is stored in the config.
- **Rate limited** — BookStack defaults to 180 requests/minute.

HTTP mode:

- **Connector fails right away / "Unexpected token '<'"** — the root `.well-known` URLs return the main
  site's HTML; add the two `location = /.well-known/…` blocks from the nginx example.
- **"Redirects to … aren't allowed"** — the client's callback host isn't in `MCP_ALLOWED_REDIRECT_HOSTS`.
- **Everyone has to reconnect after a restart** — `MCP_AUTH_SECRET` isn't set, so a random one is used.
- **Sign-in page says the token was refused** — same causes as 401/403 above, for that user's token.

## Development

```bash
npm run build
```

- [`src/bookstack.ts`](src/bookstack.ts) — HTTP client for the BookStack API and human-readable errors
- [`src/tools.ts`](src/tools.ts) — the MCP tools and the `document` prompt
- [`src/server.ts`](src/server.ts) — the MCP server and the model instructions, shared by both transports
- [`src/index.ts`](src/index.ts) — stdio entry point
- [`src/http.ts`](src/http.ts) — HTTP entry point: Streamable HTTP, routing under a sub-path
- [`src/oauth.ts`](src/oauth.ts) — OAuth sign-in with a BookStack API token, stateless encrypted tokens
- [`src/setup.ts`](src/setup.ts) — the setup wizard

## License

[MIT](LICENSE)
