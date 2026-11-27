# mcp-for-band

mcp-for-band is an unofficial [MCP](https://modelcontextprotocol.io) server for [BAND](https://band.us). Claude or any MCP client uses your signed-in Chrome on your computer to search your bands and post as you.

> **Unofficial, use at your own risk.** BAND and NAVER do not endorse or support this project. The server calls BAND's undocumented web API through BAND's web page, which may break at any time. Automated use may violate [BAND's terms of service](https://band.us/policy/terms), and BAND can restrict or close accounts for it. Read the terms first. Run it for your own account only, never as a service for others.

## What it does

- **Local cache reads.** The server syncs posts, comments, events, event comments, and members into SQLite and searches across bands with `sync`, `search`, `list_posts`, `get_item`, `get_notices`, `find_member`, and `get_media`.
- **Approved writes.** Create posts, comments, replies, mentions, photos, videos, post edits, notices, and, when enabled, deletes. A `prepare_*` tool returns a preview, and the server sends nothing to BAND until you approve it in your client or on the PIN-protected approval page. The server binds each approval to the text, target, and each file's SHA-256.
- **Optional plugins.** Turn on band-specific tool sets in `settings.json`. The `f3` plugin adds `list_workouts`, `workout_stats`, and `who_qd` to parse Q, PAX count, and attendees from backblasts with heuristics and leaves unknown counts unknown. One folder adds a plugin; see [docs/plugins.md](docs/plugins.md).

The server does not send chat messages, attach files on edits, or delete replies.

## How it works

The server starts off-screen Chrome with its own profile and a DevTools port on `127.0.0.1`. Sign in to BAND there once. Requests run through BAND's web client in the page, so BAND signs them as it would for you. The server queues requests one at a time, at least 300 milliseconds apart. See [docs/band-web-api.md](docs/band-web-api.md).

All data stays on your computer in the data folder: the browser profile, cache, write journal, and tokens. It lives at `%LOCALAPPDATA%\band-mcp` on Windows, `~/.local/share/band-mcp` elsewhere, or `BAND_MCP_DIR`.

## Setup

This server needs Node 24 or later and Google Chrome.

```sh
git clone https://github.com/KtodaZ/mcp-for-band && cd mcp-for-band
npm install
node bin/band-mcp.mjs signin    # sign in to BAND in the window that opens
node bin/band-mcp.mjs status
```

Add the server to Claude Code over stdio:

```sh
claude mcp add band -- node /path/to/mcp-for-band/bin/band-mcp.mjs stdio
```

Over stdio, Claude Code asks you to approve each write. You can then ask "sync my bands for the last two weeks", "who Q'd in November?", or "draft a comment on Saturday's event with this photo".

### Optional HTTP mode

`band-mcp serve` runs HTTP on `127.0.0.1:47811` with bearer tokens in `secrets.json` in the data folder. Use `readToken` for reads or `writeToken` to allow writes. It also serves `/approve/<id>`, which needs a PIN. Put 4–12 digits in a file and run `band-mcp set-pin <file>`. Set `BAND_MCP_TAILSCALE=1` to listen on Tailscale addresses too. The server never listens on other networks.

### Settings

Edit `settings.json` in the data folder:

```json
{ "backgroundBands": [12345678], "aliases": { "myregion": 12345678 }, "plugins": ["f3"], "allowDestructive": false }
```

- `backgroundBands` lists bands that `serve` syncs every 30 minutes for the last 14 days. Plugin tools such as workout stats default to them.
- `plugins` lists optional tool sets to turn on; see [docs/plugins.md](docs/plugins.md). None are on by default.
- `aliases` sets short names for bands. Lookups also match partial band names.
- `allowDestructive` enables deletes when `true`, as does `BAND_MCP_ALLOW_DESTRUCTIVE=1`.

Other environment variables set paths and defaults: `BAND_MCP_CHROME` sets Chrome's path, `BAND_MCP_CDP_PORT` defaults to 9333, `BAND_MCP_PORT` defaults to 47811, and `BAND_MCP_TZ` sets the workout time zone or uses this machine's.

## Safety

- Text from BAND is member content. The server instructs the model to treat it as data, not instructions, and only you can approve writes.
- Write previews expire after 10 minutes. The server refuses an edit if the post changed after the preview.
- Keep the data folder private because it holds your BAND session. On macOS and Linux, the server creates it with mode 700.
- The approval page locks out PINs for 15 minutes after 5 wrong tries, blocks framing, and accepts approvals only from its own origin.

## Development

```sh
npm test
npm run typecheck
```

`scripts/` has helpers for mapping endpoints. Test writes only on a private band where only you are a member: `BAND_MCP_TEST_BAND=<band_no> npx tsx scripts/try-write.ts post '{...}'`.

## Don't like it? Fork it

Issues and pull requests are welcome, with no promises on response time or features. If you want it to work differently, fork it and make it yours.

## License

This project uses the MIT license.
