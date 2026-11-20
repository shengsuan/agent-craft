const fmt = a =>
  a?.length ? a.map(f => `${f.name}${f.version ? ` ${f.version}` : ""}${f.confidence < 0.8 ? "?" : ""}`).join(", ") : "";

const entries = o => Object.entries(o ?? {}).map(([k, v]) => `${k} ${v}`).join(", ");

function gitLines(g) {
  if (!g) return [];
  if (!g.available) return ["git: not a repository"];
  const L = [`git: ${g.branch ?? "?"}${g.base ? ` (base ${g.base})` : ""} — ${g.stats.files} changed, +${g.stats.additions} -${g.stats.deletions}`];
  if (g.affectedPackages?.length) L.push(`affected packages: ${g.affectedPackages.join(", ")}`);
  for (const f of g.changedFiles.slice(0, 40)) {
    const n = g.numstat[f];
    L.push(`  ${f}${n ? ` +${n[0]} -${n[1]}` : " (untracked)"}`);
  }
  if (g.changedFiles.length > 40) L.push(`  … ${g.changedFiles.length - 40} more`);
  return L;
}

function profile(p) {
  const L = [];
  const line = (label, v) => v && L.push(`${label}: ${v}`);
  L.push(`# ${p.project.name} [${p.project.layout}${p.project.workspace.length ? `: ${p.project.workspace.join(", ")}` : ""}]`);
  line("languages", p.languages?.map(l => `${l.name} ${l.files}`).join(", "));
  line("frameworks", fmt(p.frameworks));
  if (p.toolchain) {
    const t = p.toolchain;
    line("package managers", fmt(t.packageManagers));
    line("runtimes", entries(t.runtimes));
    line("build", fmt(t.buildTools));
    line("test", fmt(t.testTools));
    line("lint", fmt(t.lintTools));
  }
  if (p.infrastructure) {
    const i = p.infrastructure;
    line("databases", fmt(i.databases));
    line("containers", fmt(i.containers));
    line("ci", fmt(i.ci));
    line("deployment", fmt(i.deployment));
  }
  if (p.architecture) {
    const a = p.architecture;
    line("patterns", a.patterns.map(x => `${x.name} (${x.confidence})`).join(", "));
    line("modules", a.modules.join(", "));
    line("entrypoints", a.entrypoints.join(", "));
  }
  if (p.packages?.length) {
    L.push("packages:");
    for (const k of p.packages.slice(0, 40)) {
      L.push(`  ${k.path} [${k.ecosystem}] ${k.name ?? ""}${k.aux ? " (aux)" : ""}${k.frameworks ? ` — ${k.frameworks.join(", ")}` : ""}${k.tools ? ` | ${k.tools.join(", ")}` : ""}`);
    }
  }
  L.push(...gitLines(p.git));
  for (const [k, v] of Object.entries(p.deep ?? {})) L.push(`${k}: ${JSON.stringify(v)}`);
  const s = p.scan;
  L.push(`scan: ${s.depth}, ${s.files} files, ${s.excludedCount} excluded, ${s.durationMs}ms`);
  for (const w of s.warnings) L.push(`warning: ${w}`);
  return L;
}

function inspected(r) {
  const L = [`# inspect ${r.paths.join(", ")}`];
  for (const f of r.files) {
    L.push(`${f.path}${f.language ? ` (${f.language}, ${f.lines ?? "?"} lines)` : ""}${f.skipped ? " [skipped]" : ""}`);
    if (f.exports?.length) L.push(`  exports: ${f.exports.join(", ")}`);
    if (f.local?.length) L.push(`  local: ${f.local.join(", ")}`);
    if (f.external?.length) L.push(`  external: ${f.external.join(", ")}`);
    if (f.importedBy) L.push(`  imported by (${f.importedBy.count}): ${f.importedBy.files.join(", ")}`);
  }
  for (const w of r.warnings) L.push(`warning: ${w}`);
  return L;
}

export const render = (kind, data) =>
  (kind === "scan" ? profile(data) : kind === "inspect" ? inspected(data) : gitLines(data)).join("\n");
