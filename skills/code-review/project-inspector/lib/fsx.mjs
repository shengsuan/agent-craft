import { readdir, readFile, lstat } from "node:fs/promises";
import { join, resolve, relative, isAbsolute, sep } from "node:path";
import { run } from "./git.mjs";

export const IGNORED_DIRS = new Set([
  ".git", "node_modules", "vendor", "dist", "build", "out", "coverage", ".next", ".nuxt", ".svelte-kit",
  ".turbo", ".nx", ".cache", ".parcel-cache", "target", ".venv", "venv", "__pycache__", ".mypy_cache",
  ".pytest_cache", ".ruff_cache", ".tox", ".gradle", ".idea", "obj", "Pods",
]);

const SENSITIVE = /(^|\/)(\.env(\..+)?|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|[^/]+\.(pem|key|p12|pfx|jks|keystore|crt|cer)|\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials(\.json)?|secrets?\.(json|ya?ml|toml))$/i;
const ENV_TEMPLATE = /\.env\.(example|sample|template|dist)$/i;

export const isSensitive = p => SENSITIVE.test(p) && !ENV_TEMPLATE.test(p);

const ignoredPath = p => p.split("/").slice(0, -1).some(s => IGNORED_DIRS.has(s));

async function walk(root, onSkip) {
  const out = [];
  const stack = [""];
  while (stack.length) {
    const rel = stack.pop();
    let ents;
    try {
      ents = await readdir(join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name)) onSkip();
        else stack.push(p);
      } else if (e.isFile()) out.push(p);
    }
  }
  return out;
}

export async function listFiles(root, max = 50000) {
  let excluded = 0;
  const warnings = [];
  const out = await run(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  const raw = out !== null ? [...new Set(out.split("\0").filter(Boolean))] : await walk(root, () => excluded++);
  const files = [];
  for (const p of raw) {
    if (ignoredPath(p) || isSensitive(p)) excluded++;
    else files.push(p);
  }
  if (files.length > max) {
    warnings.push(`file list truncated at ${max} of ${files.length}`);
    files.length = max;
  }
  return { files, excluded, warnings, viaGit: out !== null };
}

export async function readText(root, rel, limit = 262144) {
  if (isSensitive(rel)) return null;
  try {
    const p = join(root, rel);
    const s = await lstat(p);
    if (!s.isFile() || s.size > limit) return null;
    return await readFile(p, "utf8");
  } catch {
    return null;
  }
}

export function safeRel(root, p) {
  const r = relative(root, resolve(root, p));
  if (r.startsWith("..") || isAbsolute(r)) return null;
  return r.split(sep).join("/") || ".";
}

export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k], k);
      }
    }),
  );
  return out;
}
