import { execFile } from "node:child_process";

export const run = (cwd, args) =>
  new Promise(done =>
    execFile(
      "git",
      ["-c", "core.fsmonitor=false", "-c", "core.quotepath=false", ...args],
      {
        cwd,
        maxBuffer: 1 << 27,
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      },
      (err, out) => done(err ? null : out),
    ),
  );

const REF = /^\w[\w./@~^-]*$/;
const lines = s => (s ?? "").split("\n").filter(Boolean);
const LIMIT = 1000;

export async function gitInfo(root, baseArg) {
  const top = await run(root, ["rev-parse", "--show-toplevel", "--show-prefix"]);
  if (top === null) return { available: false };
  const [toplevel, prefix = ""] = top.split("\n");

  const [branch, sha, log] = await Promise.all([
    run(root, ["symbolic-ref", "--short", "-q", "HEAD"]),
    run(root, ["rev-parse", "--short", "HEAD"]),
    run(root, ["log", "-n", "5", "--format=%h%x09%an%x09%ad%x09%s", "--date=short"]),
  ]);
  const head = sha?.trim();
  const current = branch?.trim() || (head ? `(detached ${head})` : undefined);

  let base = baseArg;
  if (base && !REF.test(base)) throw new Error(`invalid base ref: ${base}`);
  if (!base) {
    const origin = (await run(root, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]))?.trim();
    for (const c of [origin, "origin/main", "origin/master", "main", "master"]) {
      if (c && c !== current && (await run(root, ["rev-parse", "--verify", "-q", `${c}^{commit}`])) !== null) {
        base = c;
        break;
      }
    }
  }
  const mergeBase = base ? (await run(root, ["merge-base", base, "HEAD"]))?.trim() : undefined;

  const [num, status] = await Promise.all([
    run(root, ["diff", "--numstat", "--no-renames", "--no-ext-diff", "--no-textconv", "--relative", mergeBase || "HEAD", "--"]),
    run(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  ]);

  const numstat = {};
  let additions = 0;
  let deletions = 0;
  for (const l of lines(num)) {
    const [a, d, ...p] = l.split("\t");
    const v = [a === "-" ? 0 : +a, d === "-" ? 0 : +d];
    numstat[p.join("\t")] = v;
    additions += v[0];
    deletions += v[1];
  }

  const stagedFiles = [];
  const unstagedFiles = [];
  const untrackedFiles = [];
  const tok = (status ?? "").split("\0");
  for (let i = 0; i < tok.length; i++) {
    const e = tok[i];
    if (e.length < 4) continue;
    const [x, y] = e;
    let p = e.slice(3);
    if (x === "R" || x === "C") i++;
    if (prefix) {
      if (!p.startsWith(prefix)) continue;
      p = p.slice(prefix.length);
    }
    if (x === "?") untrackedFiles.push(p);
    else {
      if (x !== " ") stagedFiles.push(p);
      if (y !== " ") unstagedFiles.push(p);
    }
  }

  const all = [...new Set([...Object.keys(numstat), ...untrackedFiles])];
  const truncated = all.length > LIMIT;
  return {
    available: true,
    root: toplevel,
    branch: current,
    head,
    base: base ?? null,
    mergeBase: mergeBase?.slice(0, 10),
    recentCommits: lines(log).map(l => {
      const [hash, author, date, ...s] = l.split("\t");
      return { hash, author, date, subject: s.join("\t") };
    }),
    changedFiles: all.slice(0, LIMIT),
    stagedFiles: stagedFiles.slice(0, LIMIT),
    unstagedFiles: unstagedFiles.slice(0, LIMIT),
    untrackedFiles: untrackedFiles.slice(0, LIMIT),
    stats: { files: all.length, additions, deletions },
    numstat: truncated ? Object.fromEntries(Object.entries(numstat).slice(0, LIMIT)) : numstat,
    truncated,
  };
}
