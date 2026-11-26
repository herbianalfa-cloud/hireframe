#!/usr/bin/env node
// Kit SessionStart hook: prints a short orientation that Claude sees as context.
// Never fails the session: any error just prints less.
import { readFileSync, existsSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_ROOT = join(HERE, "..", "..");
const root = existsSync(join(SCRIPT_ROOT, ".claude", "kit.config.json")) ? SCRIPT_ROOT : process.env.CLAUDE_PROJECT_DIR || process.cwd();
const read = (p) => { try { return readFileSync(join(root, p), "utf8"); } catch { return null; } };
const json = (p) => { try { return JSON.parse(read(p)); } catch { return null; } };
const sh = (c) => { try { return execSync(c, { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return ""; } };

const out = [];
const ver = json(".claude/kit/VERSION.json") || {};
const cfg = json(".claude/kit.config.json") || {};
const branch = sh("git rev-parse --abbrev-ref HEAD") || sh("git symbolic-ref --short -q HEAD") || "?";
const dirty = sh("git status --porcelain").split("\n").filter(Boolean).length;
const where = process.env.CLAUDE_CODE_REMOTE === "true" ? "cloud" : "local";

out.push(`[kit ${ver.version || "?"}] ${where} · branch ${branch}${dirty ? ` (${dirty} uncommitted)` : ""} · tier ${cfg.tier || "unset"}`);

// Guard self-test: a push to main must be denied.
try {
  const r = spawnSync(process.execPath, [join(HERE, "guard.mjs")], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command: `git push origin ${(cfg.protectedBranches || ["main"])[0]}` }, cwd: root }), encoding: "utf8", timeout: 10000,
  });
  if (!/"permissionDecision":"deny"/.test(r.stdout || "")) out.push("GUARD NOT ACTIVE: tell Beeb before any git work (check node and .claude/kit/guard.mjs).");
} catch { out.push("GUARD NOT ACTIVE: tell Beeb before any git work."); }

const protectedBranches = cfg.protectedBranches || ["main", "master"];
if (protectedBranches.includes(branch)) out.push(`On protected branch ${branch}: create a feature branch before any commit. Run git fetch first.`);
if (!existsSync(join(root, "docs", "PROJECT.md"))) out.push("No docs/PROJECT.md: kickoff not imported. Only /scope is allowed until it exists.");
if (!Array.isArray(cfg.gate) || cfg.gate.length === 0) out.push('Gate is empty (.claude/kit.config.json): docs-only changes only until the first plan step adds real gate commands.');
if (existsSync(join(root, "package.json")) && !existsSync(join(root, "node_modules"))) out.push("node_modules missing (new worktree or clone): run npm ci before building.");

const today = new Date().toISOString().slice(0, 10);
if (ver.reviewBy && today > ver.reviewBy) out.push(`KIT REVIEW DUE since ${ver.reviewBy}: tell Beeb once, in one line: "Kit review due — run /kit-review."`);

const status = read("STATUS.md");
if (status) {
  const pick = (name) => {
    const m = status.match(new RegExp(`^##\\s*${name}[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, "mi"));
    return m ? m[1].trim().split("\n").filter((l) => l.trim() && !/^-\s*$/.test(l.trim()) && !/^\d+\.\s*$/.test(l.trim())).slice(0, 5) : [];
  };
  for (const s of ["In progress", "Next", "Pending"]) {
    const lines = pick(s);
    if (lines.length) out.push(`STATUS ${s}:`, ...lines.map((l) => `  ${l.trim()}`));
  }
} else out.push("No STATUS.md yet.");

const plans = sh("git ls-files -co --exclude-standard docs/plans").split("\n").filter((f) => f.endsWith(".md"));
const drafts = plans.filter((f) => /^Status:\s*Draft/im.test(read(f) || "")).slice(0, 3);
if (drafts.length) out.push(`Draft plans awaiting Beeb: ${drafts.join(", ")}`);

process.stdout.write(out.join("\n") + "\n");
