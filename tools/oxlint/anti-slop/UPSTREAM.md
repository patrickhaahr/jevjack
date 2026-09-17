# Provenance

Installed from the `install-anti-slop` agent skill's bundled pristine snapshot
(`assets/anti-slop`, skill base directory
`/home/ph/.agents/skills/install-anti-slop/scripts/install.mjs`), 2026-09-18.

- Source repository: https://github.com/eslint-stylistic/eslint-stylistic (vendored `require-readable-spacing` port; see `vendor/eslint-stylistic/UPSTREAM.md`, upstream commit `435c3ea0fd26a5fef9042c4b36b6e165fbbf8d08`).
- Exact upstream commit for the anti-slop plugin itself: unknown. The skill ships a bundled snapshot without an upstream revision identifier; no recoverable pristine hash was available at install time.
- Installed plugin paths: `tools/oxlint/anti-slop/index.ts` (entry point), `rules/`, `shared/`, `effect/` (not registered), `vendor/eslint-stylistic/`.
- Intentional deviations: none. Files copied verbatim from the bundled snapshot. The `effect/` plugin is present on disk but not registered in `oxlint.config.ts`, because this repository has no direct `effect` package dependency.

Configuration: `oxlint.config.ts` at the repository root, with `@oxlint/plugins@1.83.0` and `oxlint@1.83.0` pinned as dev dependencies.
