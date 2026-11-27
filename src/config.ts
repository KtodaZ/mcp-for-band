import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

/** Everything the server keeps lives here, outside Git: browser profile, cache, journal, tokens. */
export const DATA_DIR = process.env.BAND_MCP_DIR ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local", "share"), "band-mcp");
export const PROFILE_DIR = path.join(DATA_DIR, "profile");
export const DB_PATH = path.join(DATA_DIR, "band.db");
export const MEDIA_DIR = path.join(DATA_DIR, "media");
export const SECRETS_PATH = path.join(DATA_DIR, "secrets.json");
export const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");

export const CDP_PORT = Number(process.env.BAND_MCP_CDP_PORT ?? 9333);
export const HTTP_PORT = Number(process.env.BAND_MCP_PORT ?? 47811);

/** Time zone for workout dates and notice times. Defaults to this machine's. */
export const TIME_ZONE = process.env.BAND_MCP_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

export const CHROME_PATHS = [
  process.env.BAND_MCP_CHROME,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/opt/google/chrome/chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
].filter((p): p is string => !!p);

export interface Settings {
  /** Bands kept current by background sync (serve mode). Empty by default. */
  backgroundBands: number[];
  /** Short names, e.g. { myregion: 12345 }. Band names also resolve by partial match. */
  aliases: Record<string, number>;
  allowDestructive: boolean;
  /** Optional tool sets to turn on, by name (src/plugins), e.g. ["f3"]. */
  plugins: string[];
}

const DEFAULT_SETTINGS: Settings = { backgroundBands: [], aliases: {}, allowDestructive: false, plugins: [] };

export function ensureDataDir() {
  // Owner-only on macOS and Linux (it holds the BAND session). On Windows the folder under
  // %LOCALAPPDATA% inherits a per-user ACL.
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(MEDIA_DIR, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(DATA_DIR, 0o700);
}

export function loadSettings(): Settings {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
    if (!s || typeof s !== "object" || Array.isArray(s)) return { ...DEFAULT_SETTINGS };
    const ints = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x)) : []);
    const aliases = s.aliases && typeof s.aliases === "object" && !Array.isArray(s.aliases) ? s.aliases : {};
    return {
      backgroundBands: ints(s.backgroundBands),
      aliases: Object.fromEntries(Object.entries(aliases).filter(([, v]) => Number.isInteger(v)).map(([k, v]) => [k.toLowerCase(), v as number])),
      allowDestructive: s.allowDestructive === true,
      plugins: Array.isArray(s.plugins) ? s.plugins.filter((x: unknown): x is string => typeof x === "string") : [],
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings) {
  ensureDataDir();
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2));
}

export interface Secrets {
  /** Bearer token for read tools over HTTP. */
  readToken: string;
  /** Bearer token that also allows prepare_* write tools over HTTP. */
  writeToken: string;
}

export function loadSecrets(): Secrets {
  ensureDataDir();
  try {
    const s = JSON.parse(fs.readFileSync(SECRETS_PATH, "utf8"));
    const ok = (t: unknown) => typeof t === "string" && t.length >= 32;
    if (ok(s?.readToken) && ok(s?.writeToken) && s.readToken !== s.writeToken) return { readToken: s.readToken, writeToken: s.writeToken };
    throw new Error("bad secrets");
  } catch {
    const s: Secrets = { readToken: token(), writeToken: token() };
    saveSecrets(s);
    return s;
  }
}

export function saveSecrets(s: Secrets) {
  ensureDataDir();
  fs.writeFileSync(SECRETS_PATH, JSON.stringify(s, null, 2), { mode: 0o600 });
}

export function token() {
  return crypto.randomBytes(24).toString("base64url");
}
