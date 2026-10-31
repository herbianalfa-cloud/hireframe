#!/usr/bin/env node
// Kit PreToolUse guard. Hard stops what CLAUDE.md alone can't enforce:
//  - commits, pushes, merges, reverts, cherry-picks, rebases on protected branches
//  - force / delete / tag / mirror / all-branch pushes
//  - secrets or secret files in commits and in files Claude writes
//  - reading or writing real .env / key files; dumping or printing secret env vars
// Decisions: deny (hard stop; Claude must tell Beeb) or ask (Beeb approves).
// Fails open on internal errors so a guard bug never bricks a session; the
// SessionStart self-test reports "GUARD NOT ACTIVE" if the guard stops working.
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const root = existsSync(join(SCRIPT_ROOT, ".claude", "kit.config.json")) ? SCRIPT_ROOT : process.env.CLAUDE_PROJECT_DIR || process.cwd();

function decide(kind, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: kind, permissionDecisionReason: `[kit guard] ${reason}` },
  }));
  process.exit(0);
}
const deny = (r) => decide("deny", r);
const ask = (r) => decide("ask", r);

let cfg = {};
try { cfg = JSON.parse(readFileSync(join(root, ".claude", "kit.config.json"), "utf8")); } catch {}
const PROTECTED = cfg.protectedBranches || ["main", "master"];
const globToRe = (g) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, ".").replace(/\u0000/g, ".*") + "$", "i");
const ALLOW = (cfg.secretScanAllow || []).map((e) => (typeof e === "string" ? { id: e, paths: null } : { id: e.id, paths: (e.paths || []).map(globToRe) }));
const allowed = (id, file = "") => ALLOW.some((a) => a.id === id && (!a.paths || a.paths.some((re) => re.test(file.replace(/\\/g, "/")) || re.test(basename(file)))));

// ---------- secret files ----------
const SENSITIVE_FILE = [/^\.env(\..+)?$/i, /\.pem$/i, /\.p12$/i, /\.pfx$/i, /\.keystore$/i, /\.jks$/i, /^id_(rsa|ed25519|ecdsa|dsa)$/i,
  /service[-_]?account.*\.json$/i, /credentials.*\.json$/i, /^\.secret/i, /^\.runtimeconfig\.json$/i, /\.tfvars$/i];
// Files that are only secret when they contain credentials (e.g. .npmrc with legacy-peer-deps is fine).
const MAYBE_SECRET = /^\.(npmrc|netrc|pypirc)$/i;
const CRED_LINE = /(_authToken|_auth|_password)\s*=\s*[^\s$]|^\s*password\s+\S|^\s*password\s*=/im;
function secretInFile(p, cwd) {
  if (!MAYBE_SECRET.test(basename(String(p)))) return false;
  try { return CRED_LINE.test(readFileSync(isAbs(p) ? p : join(cwd || root, p), "utf8")); } catch { return false; }
}
const isAbs = (p) => /^([A-Za-z]:)?[\\/]/.test(p);
const SAFE_SUFFIX = /\.(example|sample|template|dist|ts|js|mjs|cjs)$/i;
const DOT_PROBES = [".env", ".env.local", ".env.production"];
const PLAIN_PROBES = ["id_rsa", "key.pem", "cert.p12", "release.keystore"];
const HARMLESS = ["README.md", "index.ts", "package.json", "main.py", ".gitignore", "src"];
function isSensitiveFile(p) {
  const b = basename(String(p).replace(/\\/g, "/"));
  if (!b || SAFE_SUFFIX.test(b)) return false;
  if (SENSITIVE_FILE.some((r) => r.test(b))) return true;
  if (/[*?[]/.test(b)) {
    try {
      const re = globToRe(b);
      if (HARMLESS.some((x) => re.test(x))) return false; // too broad to be targeting secrets (e.g. "*", "src/*")
      const probes = b.startsWith(".") ? DOT_PROBES : PLAIN_PROBES; // shell globs don't match dotfiles unless they start with "."
      return probes.some((x) => re.test(x));
    } catch { return false; }
  }
  return false;
}

// ---------- secret content ----------
const HARD = [
  ["provider API key (sk-…)", /\bsk-(?:ant-|proj-|svcacct-|admin-)?[A-Za-z0-9_-]{24,}/],
  ["Stripe live key", /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["Meta access token", /\bEAA[A-Za-z0-9]{80,}/],
  ["npm/registry auth token", /_authToken\s*=\s*[^\s$]{8,}/],
];
const GOOGLE = /\bAIza[0-9A-Za-z_-]{35}\b/;
const GENERIC = /(?:api[_-]?key|secret|token|passw(?:or)?d|auth)["']?\s*[:=]\s*["']([^"'\s]{20,})["']/gi;

function scanText(text, file) {
  if (!text) return;
  const where = file ? basename(file) : "the change";
  for (const [name, re] of HARD) if (re.test(text)) deny(`${name} found in ${where}. Never put secrets in code or commits: use env vars (Beeb fills .env). Use obvious fakes like "sk-test" in tests.`);
  if (GOOGLE.test(text) && !allowed("google-api-key", file)) ask(`Google API key in ${where}. Approve only if it is a public Firebase web config key. (To allow it for this file: add {"id":"google-api-key","paths":["${file ? basename(file) : "<file>"}"]} to secretScanAllow in .claude/kit.config.json.)`);
  if (!allowed("generic-assignment", file) && [...text.matchAll(GENERIC)].some((m) => !/^AIza/.test(m[1])))
    ask(`hard-coded secret-looking value in ${where}. Approve only if it is not a secret. (Allow: add {"id":"generic-assignment","paths":["<glob>"]} to secretScanAllow.)`);
}
// Scan a unified diff per file, so per-file allowlists work.
function scanDiff(diff) {
  let file = "";
  const byFile = new Map();
  for (const l of diff.split("\n")) {
    if (l.startsWith("+++ ")) { file = l.slice(4).replace(/^b\//, ""); continue; }
    if (l.startsWith("+") && !l.startsWith("+++")) byFile.set(file, (byFile.get(file) || "") + l.slice(1) + "\n");
  }
  for (const [f, t] of byFile) scanText(t, f);
}

const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }).toString();
const ok = (cmd, cwd) => { try { sh(cmd, cwd); return true; } catch { return false; } };

// Remove quoted strings and heredoc bodies so commit messages can't trigger or hide rules.
const stripQuoted = (s) => s
  .replace(/<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n\s*\2\b/g, " Q ")
  .replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, " Q ");
// Remove commit/tag message values and heredoc bodies, but keep other quoting (so `cat ".env"` is still caught).
const stripMessages = (s) => s
  .replace(/<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n\s*\2\b/g, " Q ")
  .replace(/(\s(?:-m|-F|--message|--file)(?:\s+|=))("(?:\\.|[^"\\])*"|'[^']*'|\S+)/g, "$1Q");
const words = (s) => s.trim().split(/\s+/).filter(Boolean);
const expandFlags = (args) => args.flatMap((a) => (/^-[a-zA-Z]{2,}$/.test(a) ? a.slice(1).split("").map((c) => "-" + c) : [a]));

function checkBash(raw, cwd) {
  const cmd = stripQuoted(raw);

  // 1. Secret files, env dumps, printing secret variables.
  const plain = stripMessages(raw);
  const gitignoreAppend = /^\s*(echo|printf)\b[^;&|]*>>?\s*\.gitignore\s*$/.test(raw);
  if (!gitignoreAppend) {
    const toks = plain.split(/[\s;&|<>()=]+/).map((t) => t.replace(/^["']|["']$/g, "")).filter(Boolean);
    const bad = toks.find(isSensitiveFile);
    if (bad) deny(`command touches ${bad}. Beeb creates and edits secret files himself; use .env.example for names.`);
    const cred = toks.find((t) => secretInFile(t, cwd));
    if (cred) deny(`${cred} contains registry credentials. Beeb edits it himself.`);
  }
  if (/(^|[;&|(]\s*)(printenv|env|export\s+-p|set|declare\s+-x)\s*($|[;&|)])/m.test(cmd) || /\bprintenv\b/.test(cmd))
    deny("printing environment variables can expose secrets. Read the specific non-secret value from config instead.");
  if (/\$\{?[A-Za-z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL)[A-Za-z0-9_]*\}?/i.test(plain))
    deny("the command references a secret environment variable. Tests must mock paid/external calls; Beeb runs live smoke tests himself (`! <command>`).");
  if (/\bnode\b[^;&|]*\s-(?:e|p|-eval|-print)\b/.test(raw) && /process\.env(?!\s*\.\s*(?:NODE_ENV|CI|PORT)\b)/.test(raw))
    deny("reading process.env from a one-liner can expose secrets.");

  // 2. git commands, in order, tracking the branch through switch/checkout.
  const GIT = /\bgit((?:\s+(?:-C|-c)\s+\S+|\s+--[\w-]+(?:=\S+)?)*)\s+(push|commit|switch|checkout|revert|cherry-pick|am|merge|rebase|add)(?![\w-])([^;&|\n]*)/g;
  const cmds = [...cmd.matchAll(GIT)];
  if (!cmds.length) return;
  const hasHead = ok("git rev-parse --verify -q HEAD", cwd);
  let branch = "";
  try { branch = hasHead ? sh("git rev-parse --abbrev-ref HEAD", cwd).trim() : sh("git symbolic-ref --short -q HEAD", cwd).trim(); } catch {}
  let sawAdd = false;
  const onProtected = () => hasHead && PROTECTED.includes(branch);

  for (const m of cmds) {
    const sub = m[2];
    const args = expandFlags(words(m[3]));
    const pos = args.filter((a) => !a.startsWith("-") && a !== "Q");

    if (sub === "switch" || sub === "checkout") {
      const ci = args.findIndex((a) => ["-c", "-C", "--create", "-b", "-B", "--orphan"].includes(a));
      if (ci >= 0 && args[ci + 1]) branch = args[ci + 1];
      else if (!args.includes("--") && pos[0] && (sub === "switch" || PROTECTED.includes(pos[0]) || ok(`git show-ref --verify -q refs/heads/${pos[0]}`, cwd))) branch = pos[0];
      continue;
    }
    if (sub === "add") { sawAdd = true; continue; }

    if (sub === "commit") {
      if (sawAdd) deny("run `git add` and `git commit` as separate commands, so the guard scans exactly what gets committed.");
      if (onProtected()) deny(`commit on protected branch "${branch}". Create a feature branch first: git switch -c <type>/<slug>.`);
      const withVal = new Set(["-m", "-F", "-C", "-c", "--author", "--date", "--fixup", "--squash", "-t", "--template", "--cleanup", "--trailer"]);
      const paths = args.filter((a, i) => !a.startsWith("-") && a !== "Q" && !withVal.has(args[i - 1]));
      const all = args.includes("-a") || args.includes("--all") || paths.length > 0;
      const names = sh("git diff --cached --name-only", cwd) + (all && hasHead ? sh("git diff HEAD --name-only", cwd) : "");
      const badFile = names.split("\n").filter(Boolean).find(isSensitiveFile);
      if (badFile) deny(`${badFile} would be committed and looks like a secret file. Unstage it (git restore --staged ${badFile}) and check .gitignore covers it.`);
      scanDiff(sh("git diff --cached -U0", cwd) + (all && hasHead ? sh("git diff HEAD -U0", cwd) : ""));
      continue;
    }

    if (["revert", "cherry-pick", "am", "merge", "rebase"].includes(sub)) {
      if (sub === "merge" && args.includes("--ff-only")) continue; // fast-forwarding local main to origin is safe
      if (onProtected()) deny(`git ${sub} on protected branch "${branch}" is Beeb-only. Work on a feature branch and open a PR.`);
      continue;
    }

    if (sub === "push") {
      if (args.some((a) => /^(-f|-d|--force|--force-if-includes|--mirror|--delete|--prune)$/.test(a)))
        deny("force, delete, mirror or prune pushes are Beeb-only.");
      const lease = args.some((a) => /^--force-with-lease/.test(a));
      if (args.some((a) => /^--(tags|all|follow-tags)$/.test(a))) deny("tag and all-branch pushes are Beeb-only (tag in daytime after a verified run).");
      const valFlags = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);
      const p = args.filter((a, i) => !a.startsWith("-") && !valFlags.has(args[i - 1]));
      const refspecs = p.slice(1);
      for (const r of refspecs) {
        if (r.startsWith("+")) deny("+refspec is a force push. Beeb-only.");
        if (r.startsWith(":")) deny("pushing an empty source deletes a remote branch. Beeb-only.");
      }
      const targets = refspecs.length ? refspecs.map((r) => (r.includes(":") ? r.split(":")[1] : r)) : [""];
      for (let t of targets) {
        if (/^refs\/tags\//.test(t)) deny("tag pushes are Beeb-only.");
        t = t.replace(/^refs\/heads\//, "");
        if (t === "" || t === "HEAD" || t === "@") t = branch;
        if (PROTECTED.includes(t)) deny(`push to protected branch "${t}" is blocked. Push a feature branch and open a PR (/ship). Beeb merges.`);
        if (t && ok(`git show-ref --verify -q refs/tags/${t}`, cwd) && !ok(`git show-ref --verify -q refs/heads/${t}`, cwd)) deny(`"${t}" is a tag. Tag pushes are Beeb-only.`);
      }
      if (lease) ask(`--force-with-lease rewrites the remote branch ${targets.map((t) => t || branch).join(", ")} (needed after rebasing a stacked PR). Approve only for a feature branch you expect to rewrite.`);
    }
  }
}

function checkFileTool(tool, input) {
  const path = input.file_path || input.notebook_path || input.path || "";
  if (path && isSensitiveFile(path)) deny(`${tool} on ${basename(path)} is blocked: secret files are Beeb-only. Use .env.example for variable names.`);
  if (path && tool !== "Write" && secretInFile(path)) deny(`${basename(path)} contains registry credentials. Beeb edits it himself.`);
  if (tool === "Grep" && input.glob && isSensitiveFile(input.glob)) deny(`Grep over ${input.glob} is blocked: secret files are Beeb-only.`);
  let text = "";
  if (tool === "Write") text = input.content;
  else if (tool === "Edit") text = input.new_string;
  else if (tool === "MultiEdit") text = (input.edits || []).map((e) => e.new_string).join("\n");
  else if (tool === "NotebookEdit") text = input.new_source;
  scanText(text, path);
}

try {
  const input = JSON.parse(readFileSync(0, "utf8") || "{}");
  const tool = input.tool_name || "";
  const ti = input.tool_input || {};
  const cwd = input.cwd || root;
  if (tool === "Bash") checkBash(String(ti.command || ""), cwd);
  else if (["Write", "Edit", "MultiEdit", "NotebookEdit", "Read", "Grep"].includes(tool)) checkFileTool(tool, ti);
} catch (e) {
  process.stderr.write(`[kit guard] skipped: ${e.message}\n`);
}
process.exit(0);
