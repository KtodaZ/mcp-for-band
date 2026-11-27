// Cuts a GitHub release: bumps the version, checks, builds the .mcpb, waits for CI, then tags and
// publishes with the notes you wrote.
//   node scripts/release.mjs <x.y.z> <notes.md>
// Run it on an up-to-date, clean main. It stops at the first failure, before anything is published.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const [version, notes] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version ?? "") || !notes || !fs.existsSync(notes)) {
  console.error("Usage: node scripts/release.mjs <x.y.z> <notes.md>");
  process.exit(1);
}
const tag = `v${version}`;
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, encoding: "utf8", stdio: opts.show ? "inherit" : "pipe", shell: process.platform === "win32" && cmd === "npm" });
const step = (s) => console.log(`\n== ${s}`);

step("Checking the tree");
if (sh("git", ["branch", "--show-current"]).trim() !== "main") throw new Error("Not on main");
if (sh("git", ["status", "--porcelain"]).trim()) throw new Error("Uncommitted changes; commit or stash them first");
sh("git", ["fetch", "-q", "origin", "main", "--tags"]);
if (sh("git", ["rev-parse", "HEAD"]).trim() !== sh("git", ["rev-parse", "origin/main"]).trim()) throw new Error("main isn't the same as origin/main");
if (sh("git", ["tag", "-l", tag]).trim()) throw new Error(`${tag} already exists`);

step(`Setting version ${version}`);
for (const f of ["package.json", "manifest.json"]) {
  const p = path.join(root, f);
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  j.version = version;
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
}
sh("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"]);

step("Typecheck, tests and the .mcpb");
sh("npm", ["run", "typecheck"], { show: true });
sh("npm", ["test"], { show: true });
sh("npm", ["run", "pack:mcpb"], { show: true });

step("Committing and pushing");
sh("git", ["commit", "-qam", `Release ${tag}`]);
sh("git", ["push", "-q", "origin", "main"]);
const sha = sh("git", ["rev-parse", "HEAD"]).trim();

step("Waiting for CI");
let run = "";
for (let i = 0; i < 30 && !run; i++) {
  run = sh("gh", ["run", "list", "--commit", sha, "--workflow", "ci.yml", "--json", "databaseId", "--jq", ".[0].databaseId"]).trim();
  if (!run) await new Promise((r) => setTimeout(r, 5000));
}
if (!run) throw new Error("CI didn't start; the version commit is pushed, but nothing is tagged");
sh("gh", ["run", "watch", run, "--exit-status"], { show: true });

step(`Publishing ${tag}`);
sh("git", ["tag", tag, sha]);
sh("git", ["push", "-q", "origin", tag]);
sh("gh", ["release", "create", tag, path.join(root, "dist", "mcp-for-band.mcpb"), "--title", tag, "--notes-file", path.resolve(notes), "--verify-tag"], { show: true });
console.log(`\nReleased ${tag}`);
