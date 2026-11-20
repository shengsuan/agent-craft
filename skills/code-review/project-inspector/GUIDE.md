# Project Inspector 使用指南

本文件是工具的使用说明，由 `code-review` Skill 在需要时引用；它本身不是独立 Skill。

先运行工具获取画像，再决定自己读哪些文件。工具只收集事实，推理由审查者完成。

## Commands

```
node <skill-dir>/cli.mjs scan -f md                      # quick profile
node <skill-dir>/cli.mjs scan -p code-review -f md       # deep, scoped to changed packages
node <skill-dir>/cli.mjs inspect src/auth src/api -f md  # exports, imports, importers
node <skill-dir>/cli.mjs git -f md                       # changed files vs base branch
```

Use `-f md` for compact text, `-f json` (default) for programmatic use. Add `-r <dir>` to target another root.

## Workflow

1. `scan` (quick). Check `project.layout`, `frameworks`, `toolchain`, `packages`.
2. Pick a profile for the task: `code-review`, `bug-fixing`, `refactor`, `test-generation`, `documentation`. Profiles switch to deep scan and trim output to the sections the task needs. `code-review` and `bug-fixing` scope the deep scan to packages touched by the git diff.
3. Apply stack-specific rules only for technologies actually detected.
4. For specific questions use `inspect <paths>`: it lists exports, local and external imports, and which files import each target. Use `importedBy` for impact analysis instead of grepping.
5. Read source files yourself for anything semantic: business logic, architecture judgment, defect analysis.

## Reading the output

- Every finding has `confidence` and `evidence`. Dependency evidence (0.9+) is reliable; file-only evidence (0.7) means a config file exists, not that the tech is in use.
- `architecture.patterns` with confidence 0.5 are naming hints (e.g. `controllers/` + `services/`), not facts. Verify before asserting.
- `entrypoints` and `deep.routeFiles` are convention-based candidates.
- `packages[].aux: true` marks examples, docs and fixtures; they are excluded from aggregated detection.
- Never infer more than the evidence says: a Dockerfile does not imply Kubernetes.

## Guarantees

Never executes project scripts or package managers. Does not read `.env`, keys, certificates or credential files (`.env.example` variable names only). Script text is secret-redacted. Symlinks are not followed. Only git read commands are run, with fsmonitor disabled. stdout carries output only; diagnostics go to stderr.

## MCP

`node cli.mjs mcp` serves `project_scan`, `project_inspect` and `project_git` over stdio.
