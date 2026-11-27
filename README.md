# mcp-for-band

An unofficial [MCP](https://modelcontextprotocol.io) server for [BAND](https://band.us). It lets Claude, or any MCP client, search your bands and post as you, through your own signed-in Chrome on your own computer.

> **Unofficial, use at your own risk.** This project is not affiliated with, endorsed by, or supported by BAND or NAVER. It uses BAND's undocumented web API through BAND's own web page, which may break at any time. Automated use may go against [BAND's terms of service](https://band.us/policy/terms), and BAND can restrict or close accounts for it. Read the terms and decide for yourself. Run it only for your own account, and never as a service for other people.

## What it does

- **Reads:** syncs posts, comments, events, event comments and members into a local SQLite cache, then searches it across bands (`sync`, `search`, `list_posts`, `get_item`, `get_notices`, `find_member`, `get_media`).
- **Writes, each approved by you:** new posts and comments, replies, mentions, photos and videos, post edits, notices and (when turned on) deletes. A `prepare_*` tool returns a preview; nothing reaches BAND until you approve that exact preview, in your MCP client or on a PIN-protected local page. The approval is bound to the text, the target and each attached file's SHA-256.
- **Plugins:** optional tool sets for one kind of band, turned on in `settings.json`. The first is `f3`: `list_workouts`, `workout_stats` and `who_qd` parse Q, PAX count and attendees from backblast posts and comments (heuristic: unknown counts stay unknown). Adding a plugin is one folder; see [docs/plugins.md](docs/plugins.md).

Not supported: sending chat messages, attachments on edits, deleting replies.

## How it works

The server starts its own Chrome with a separate profile and a DevTools port on `127.0.0.1`, kept off-screen. You sign in to BAND in that window once. Requests go through BAND's own web client in the page, so BAND signs them as it would for you. Requests are queued one at a time, at least 300 ms apart. Endpoint notes: [docs/band-web-api.md](docs/band-web-api.md).

Everything stays on your computer, in the data folder (`%LOCALAPPDATA%\band-mcp` on Windows, `~/.local/share/band-mcp` elsewhere, or `BAND_MCP_DIR`): the browser profile, the cache, the write journal and the tokens.

## Setup

Needs Node 24 or later and Google Chrome.

```sh
git clone https://github.com/KtodaZ/mcp-for-band && cd mcp-for-band
npm install
node bin/band-mcp.mjs signin    # sign in to BAND in the window that opens
node bin/band-mcp.mjs status
```

Add it to Claude Code over stdio:

```sh
claude mcp add band -- node /path/to/mcp-for-band/bin/band-mcp.mjs stdio
```

Over stdio, Claude Code asks you to approve each write itself. Then ask things like "sync my bands for the last two weeks", "who Q'd in November?" or "draft a comment on Saturday's event with this photo".

### HTTP mode (optional)

`band-mcp serve` runs the MCP over HTTP on `127.0.0.1:47811` with bearer tokens (`readToken`, or `writeToken` to allow writes, in `secrets.json` in the data folder). It also serves the approval page `/approve/<id>`, which needs a PIN: put 4–12 digits in a file and run `band-mcp set-pin <file>`. Set `BAND_MCP_TAILSCALE=1` to listen on your Tailscale addresses too. It never listens on other networks.

### Settings

`settings.json` in the data folder:

```json
{ "backgroundBands": [12345678], "aliases": { "myregion": 12345678 }, "plugins": ["f3"], "allowDestructive": false }
```

- `backgroundBands`: bands `serve` keeps synced (the last 14 days, every 30 minutes). Plugin tools such as the workout stats default to them.
- `plugins`: optional tool sets to turn on ([docs/plugins.md](docs/plugins.md)). None are on by default.
- `aliases`: short names for bands. Bands also match by part of their name.
- `allowDestructive`: deletes are off unless this is true (or `BAND_MCP_ALLOW_DESTRUCTIVE=1`).

Other environment variables: `BAND_MCP_CHROME` (Chrome path), `BAND_MCP_CDP_PORT` (default 9333), `BAND_MCP_PORT` (default 47811), `BAND_MCP_TZ` (time zone for workout dates; defaults to this machine's).

## Safety

- Text from BAND is member content. The server tells the model to treat it as data, never as instructions, and only you can approve a write.
- Write previews expire after 10 minutes. Edits are refused if the post changed since the preview.
- Keep the data folder private: it holds your BAND session. On macOS and Linux it is created owner-only (700).
- The approval page refuses PINs for 15 minutes after 5 wrong ones, can't be framed, and only takes approvals posted from itself.

## Development

```sh
npm test
npm run typecheck
```

`scripts/` has helpers for mapping new endpoints. Try writes only on a private band that only you are in: `BAND_MCP_TEST_BAND=<band_no> npx tsx scripts/try-write.ts post '{...}'`.

## Don't like it? Fork it

Issues and pull requests are welcome, but there are no promises on response time or features. If you want it to work differently, fork it and make it yours.

## License

MIT
