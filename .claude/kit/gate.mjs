#!/usr/bin/env node
// Kit gate: runs every command in .claude/kit.config.json "gate", in order,
// prints each exit code, and fails if any command fails (Playbook Part 5 "Gate").
//   node .claude/kit/gate.mjs              summary: exit codes + tail of failures (saves context)
//   node .claude/kit/gate.mjs --verbose    full output (CI)
//   node .claude/kit/gate.mjs --if-changed reuse the last PASS if nothing changed since
import { spawnSync, execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const VERBOSE = args.includes("--verbose") || process.env.CI === "true";
const IF_CHANGED = args.includes("--if-changed");
const SCRIPT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const root = existsSync(join(SCRIPT_ROOT, ".claude", "kit.config.json")) ? SCRIPT_ROOT : process.env.CLAUDE_PROJECT_DIR || process.cwd();
const cfgPath = join(root, ".claude", "kit.config.json");

let cfg = {};
if (existsSync(cfgPath)) {
  try { cfg = JSON.parse(readFileSync(cfgPath, "utf8")); }
  catch (e) { console.error(`gate: ${cfgPath} is not valid JSON: ${e.message}`); process.exit(2); }
}
const gate = Array.isArray(cfg.gate) ? cfg.gate.filter((c) => typeof c === "string" && c.trim()) : [];
if (gate.length === 0) {
  console.log('GATE SKIPPED: no commands in .claude/kit.config.json "gate". Fine for docs-only changes; code changes need a real gate first.');
  process.exit(0);
}

const git = (c) => { try { return execSync(c, { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return ""; } };
const head = git("git rev-parse HEAD");
const hash = createHash("sha1").update(git("git status --porcelain") + git("git diff HEAD") + JSON.stringify(gate));
for (const f of git("git ls-files -o --exclude-standard").split("\n").filter(Boolean)) {
  try { const st = statSync(join(root, f)); if (st.isFile() && st.size < 5e6) hash.update(f).update(readFileSync(join(root, f))); } catch {}
}
const state = hash.digest("hex");
let gitDir = git("git rev-parse --git-dir");
if (gitDir && !isAbsolute(gitDir)) gitDir = join(root, gitDir);
const cachePath = gitDir ? join(gitDir, "kit-last-gate.json") : null;

if (IF_CHANGED && cachePath && existsSync(cachePath)) {
  try {
    const c = JSON.parse(readFileSync(cachePath, "utf8"));
    if (c.passed && c.head === head && c.state === state) {
      console.log(`GATE PASSED (cached from ${c.at}, nothing changed since)`);
      for (const r of c.results) console.log(`${r.cmd} exit=${r.code}`);
      process.exit(0);
    }
  } catch {}
}

const results = [];
for (const cmd of gate) {
  const t0 = Date.now();
  let code, out = "";
  if (VERBOSE) {
    console.log(`\n▶ ${cmd}`);
    const r = spawnSync(cmd, { cwd: root, stdio: "inherit", shell: true });
    code = r.status === null ? 1 : r.status;
  } else {
    const r = spawnSync(`${cmd} 2>&1`, { cwd: root, shell: true, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    code = r.status === null ? 1 : r.status;
    out = r.stdout || "";
  }
  results.push({ cmd, code, secs: ((Date.now() - t0) / 1000).toFixed(1), out });
}

console.log("\n=== GATE ===");
for (const r of results) console.log(`${r.cmd} exit=${r.code} (${r.secs}s)`);
const failed = results.filter((r) => r.code !== 0);
if (!VERBOSE) for (const r of failed) {
  const tail = r.out.trimEnd().split("\n").slice(-40).join("\n");
  console.log(`\n--- last 40 lines of: ${r.cmd} ---\n${tail}`);
}
console.log(failed.length ? `GATE FAILED (${failed.length}/${results.length})` : `GATE PASSED (${results.length}/${results.length})`);

if (cachePath) {
  try { writeFileSync(cachePath, JSON.stringify({ passed: !failed.length, head, state, at: new Date().toISOString(), results: results.map(({ cmd, code }) => ({ cmd, code })) })); } catch {}
}
process.exit(failed.length ? 1 : 0);
