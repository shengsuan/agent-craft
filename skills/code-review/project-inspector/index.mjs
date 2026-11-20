import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import { listFiles } from "./lib/fsx.mjs";
import { gitInfo } from "./lib/git.mjs";
import { analyze } from "./lib/detect.mjs";
import { deepScan } from "./lib/deep.mjs";
import { inspectPaths } from "./lib/targeted.mjs";
import { render } from "./lib/render.mjs";

export const SCHEMA_VERSION = "2.0";

const BASE = ["languages", "frameworks", "toolchain", "packages", "architecture"];

export const PROFILES = {
  default: { depth: "quick", git: true, sections: null },
  "code-review": { depth: "deep", git: true, affected: true, sections: [...BASE, "git", "deep"] },
  "bug-fixing": { depth: "deep", git: true, affected: true, sections: [...BASE, "git", "deep"] },
  refactor: { depth: "deep", git: false, sections: [...BASE, "deep"] },
  "test-generation": { depth: "deep", git: false, sections: ["languages", "frameworks", "toolchain", "packages", "deep"] },
  documentation: { depth: "deep", git: false, sections: ["languages", "frameworks", "architecture", "packages", "deep"] },
};

const KEEP = ["schemaVersion", "project", "scan"];

async function resolveRoot(r) {
  const root = resolve(r ?? process.cwd());
  const s = await stat(root).catch(() => null);
  if (!s?.isDirectory()) throw new Error(`not a directory: ${root}`);
  return root;
}

export async function scan(o = {}) {
  const t0 = Date.now();
  const root = await resolveRoot(o.root);
  const prof = PROFILES[o.profile ?? "default"];
  if (!prof) throw new Error(`unknown profile: ${o.profile} (available: ${Object.keys(PROFILES).join(", ")})`);
  const depth = o.depth ?? prof.depth;
  if (depth !== "quick" && depth !== "deep") throw new Error(`invalid depth: ${depth}`);

  const listing = await listFiles(root, o.maxFiles);
  const [ctx, git] = await Promise.all([
    analyze(root, listing.files),
    (o.git ?? prof.git) ? gitInfo(root, o.base) : undefined,
  ]);

  if (git?.available) git.affectedPackages = [...new Set(git.changedFiles.map(ctx.owner))].sort();

  let scope = o.scope ?? null;
  if (!scope && prof.affected && git?.available && git.changedFiles.length) scope = [...git.affectedPackages, "."];

  const deep = depth === "deep" ? await deepScan({ root, files: listing.files, ctx, scope }) : undefined;
  const r = ctx.report();

  const full = {
    schemaVersion: SCHEMA_VERSION,
    project: ctx.project,
    languages: ctx.languages,
    packages: ctx.packages,
    frameworks: r.frameworks,
    toolchain: r.toolchain,
    architecture: ctx.architecture,
    infrastructure: r.infrastructure,
    git,
    deep,
    scan: {
      depth,
      profile: o.profile ?? "default",
      scope: scope ?? undefined,
      completed: true,
      files: listing.files.length,
      excludedCount: listing.excluded,
      warnings: [...listing.warnings, ...ctx.warnings],
      durationMs: Date.now() - t0,
    },
  };

  const sections = o.sections ?? prof.sections;
  if (!sections) return full;
  const keep = new Set([...KEEP, ...sections]);
  return Object.fromEntries(Object.entries(full).filter(([k]) => keep.has(k)));
}

export async function inspect(o = {}) {
  const root = await resolveRoot(o.root);
  if (!o.paths?.length) throw new Error("inspect requires at least one path");
  const { files } = await listFiles(root, o.maxFiles);
  return { schemaVersion: SCHEMA_VERSION, root, ...(await inspectPaths(root, files, o.paths, { refs: o.refs, maxFiles: o.limit })) };
}

export async function git(o = {}) {
  return gitInfo(await resolveRoot(o.root), o.base);
}

export { render };
