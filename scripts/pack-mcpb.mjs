// Builds dist/mcp-for-band.mcpb, the one-click Claude Desktop extension: the server, its
// production dependencies and manifest.json, packed with Anthropic's mcpb CLI.
//   node scripts/pack-mcpb.mjs
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
if (manifest.version !== pkg.version) throw new Error(`manifest.json version ${manifest.version} != package.json ${pkg.version}`);

const stage = fs.mkdtempSync(path.join(os.tmpdir(), "mcpb-"));
const out = path.join(root, "dist", "mcp-for-band.mcpb");
try {
  for (const f of ["bin", "src", "docs", "README.md", "LICENSE", "manifest.json", "package.json", "package-lock.json"]) {
    fs.cpSync(path.join(root, f), path.join(stage, f), { recursive: true });
  }
  // npm and npx are .cmd files on Windows, so these run through the shell; every path is quoted.
  const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: "inherit" });
  run("npm ci --omit=dev --ignore-scripts --no-audit --no-fund", stage);
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  run(`npx -y @anthropic-ai/mcpb@2.1.2 pack "${stage}" "${out}"`, root);
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
console.log(`Built ${out}`);
