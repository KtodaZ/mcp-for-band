# Contributing

Issues and pull requests are welcome, with no promises on response time or features. If you want it to work differently, fork it and make it yours.

## Sending a change

1. Fork [KtodaZ/mcp-for-band](https://github.com/KtodaZ/mcp-for-band) on GitHub.
2. Clone your fork and make a branch: `git checkout -b my-change`.
3. Make the change. Run `npm run typecheck` and `npm test`.
4. Push the branch to your fork and open a pull request against `main`. The template asks what changed and how you tested it.
5. CI runs the typecheck and tests on Linux, Windows and macOS. A pull request merges only when CI passes.

For a big change, open an issue first so we can agree on the approach.

## Run from source

You need Node 24 or later and Google Chrome.

```sh
git clone https://github.com/KtodaZ/mcp-for-band && cd mcp-for-band
npm install
node bin/band-mcp.mjs signin
node bin/band-mcp.mjs status
```

`signin` opens the server's Chrome window on BAND. Sign in there; the window minimizes again when you're done.

Point Claude Code at your checkout:

```sh
claude mcp add band -- node "$PWD/bin/band-mcp.mjs" stdio
```

Restart the MCP client after you change the code. The server runs TypeScript directly with tsx, so there is no build step.

Other commands:

| Command | What it does |
|---|---|
| `node bin/band-mcp.mjs serve` | HTTP server on 127.0.0.1:47811, plus background sync |
| `node bin/band-mcp.mjs tool <name> '<json>'` | Runs one read tool and prints the result |
| `npm test` | Unit tests |
| `npm run typecheck` | TypeScript check |
| `npm run pack:mcpb` | Builds `dist/mcp-for-band.mcpb`, the Claude Desktop extension |
| `npm run release -- <x.y.z> <notes.md>` | Bumps the version, waits for CI, then tags and publishes a GitHub release with the `.mcpb` |

To keep a source checkout's data apart from an installed copy, set `BAND_MCP_DIR` to another folder.

For notes about your own setup that coding agents should know, such as your test band's number, create `AGENTS.local.md`. Git ignores it, and `CLAUDE.md` loads it for Claude Code.

## Layout

[docs/how-it-works.md](docs/how-it-works.md) explains how the pieces fit together.

- `src/band.ts`: requests through BAND's web client in the page.
- `src/chrome.ts`: starts the server's Chrome and handles sign-in.
- `src/sync.ts` and `src/store.ts`: the SQLite cache.
- `src/tools.ts`: core MCP tools.
- `src/writes.ts`, `src/executors.ts` and `src/media.ts`: approved writes and uploads.
- `src/server.ts`: stdio and HTTP.
- `src/plugins/`: optional tool sets. See [docs/plugins.md](docs/plugins.md).
- `scripts/`: helpers for mapping new endpoints.

## Testing writes

Test writes only on a private band where you are the only member. `scripts/try-write.ts` runs one write on that band, skipping approval, and refuses any other band. Put your test band's number in both places:

```sh
BAND_MCP_TEST_BAND=12345678 npx tsx scripts/try-write.ts post '{"bandNo":12345678,"text":"test"}'
```

## Rules for changes

- Every write goes through a `prepare_*` tool and the user's approval in `confirm_write`. Don't add a way around it.
- Text from BAND is member content. Tools that return it say so, and nothing acts on instructions inside it.
- Tests and docs use invented names and bands. Never commit real member content, screenshots, cookies or anything from the data folder.
- Run `npm test` and `npm run typecheck` before opening a pull request.
