// This module runs the band-mcp CLI commands:
//   serve            Starts the HTTP server on 127.0.0.1, or Tailscale with BAND_MCP_TAILSCALE=1, and syncs configured bands.
//   stdio            Starts the server over stdio for Claude Code on this computer.
//   signin           Shows the server's Chrome on band.us so you can sign in, then hides it.
//   status           Reports sign-in state, cached bands, and cache coverage.
import fs from "node:fs";
import { serveHttp, serveStdio } from "./server";
import { loadSecrets, saveSecrets, loadSettings, ensureDataDir } from "./config";
import { syncPosts, syncEvents } from "./sync";
import { callTool } from "./tools";
import { localDate } from "./helpers";
import { context, disconnect, signIn } from "./chrome";
import { registerExecutors } from "./executors";

const [cmd, arg] = process.argv.slice(2);
ensureDataDir();

async function backgroundSync() {
  const since = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
  for (const b of loadSettings().backgroundBands) {
    try {
      await syncPosts(b, since(14));
      await syncEvents(b, localDate(since(14)), localDate(new Date().toISOString()));
      console.error(`[band-mcp] synced ${b}`);
    } catch (e) {
      console.error(`[band-mcp] background sync of ${b} stopped: ${(e as Error).message}`);
    }
  }
}

if (cmd === "serve" || cmd === "stdio") registerExecutors();

if (cmd === "serve") {
  const { hosts } = serveHttp();
  console.error(`[band-mcp] listening on ${hosts.join(", ")}`);
  if (!process.argv.includes("--no-sync")) {
    setTimeout(() => void backgroundSync(), 30_000);
    setInterval(() => void backgroundSync(), 30 * 60_000);
  }
} else if (cmd === "stdio") {
  serveStdio();
} else if (cmd === "signin") {
  console.log("Sign in to BAND in the Chrome window that just opened. Waiting up to 10 minutes...");
  const ok = await signIn();
  console.log(ok ? "Signed in. The MCP's Chrome keeps the session." : "Didn't see a sign-in; run signin again.");
  await disconnect();
  process.exit(ok ? 0 : 1);
} else if (cmd === "status") {
  const out = await callTool("status", {}, { canWrite: false });
  console.log(JSON.stringify(out, null, 1));
  await disconnect();
} else if (cmd === "tool") {
  // Dev: band-mcp tool <name> '<json args>'
  const out = await callTool(arg!, JSON.parse(process.argv[4] ?? "{}"), { canWrite: false });
  console.log(JSON.stringify(out, null, 1));
  await disconnect();
} else {
  console.error("usage: band-mcp serve|stdio|signin|status|tool <name> <json>");
  process.exit(1);
}
