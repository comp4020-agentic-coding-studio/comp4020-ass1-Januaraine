# CLAUDE.md — Agent Operating Rules

## Stack

- Static site: **Astro + TypeScript**, building to plain HTML/CSS/JS in `dist/`.
- Pages live in `src/pages/` (file-based routing); shared structure lives in `src/layouts/`; global CSS lives in `src/styles/global.css`.
- Deployed as a GitHub Pages project page. CI's link check (`linkinator ./dist`) crawls the flat `dist/` output directly, with no knowledge of the deployed subpath — so internal hrefs/asset paths must stay **relative** (no leading slash, no `import.meta.env.BASE_URL` prefix). This mirrors the previous Vite setup's `base: "./"` convention and is why `astro.config.mjs` does not set `base`.
- Any change must still satisfy — `pnpm build` emits into `dist/`, `package.json` scripts (`check`, `check:evidence`, `build`) keep working, and `dist/` still passes `spec/`.

## Key commands

| Command | Purpose |
|---|---|
| `pnpm dev` | Run the dev server while iterating. |
| `pnpm check` | Runs `typecheck && build && lint (oxlint + stylelint) && vitest run` (includes `spec/`). Must be green before any commit. |
| `pnpm check:evidence` | Validates process evidence (`PROCESS.md` citations, `reflections/`, this file). Run before shipping. |

## Guardrails (mandatory)

### Course base invariants

1. **Dual-viewport check.** Any change touching UI, layout, or CSS must be verified at **both** 1920×1080 (desktop) and 390×844 (phone). Both viewports count in full — do not ship a fix that only works at one size. Use a real rendered view (dev server + browser), not assumptions about the DOM/CSS.
2. **Never commit red.** Run `pnpm check` after every code change. If it fails, fix the failure before committing — do not commit with a failing typecheck, build, lint, or test.
3. **No unrequested API changes.** Keep code modular. Do not change the signature of an existing function/module/export unless explicitly instructed — extend or add new functions instead of altering existing contracts.
4. **Read the failure, don't guess.** When a check fails, the error message names the file/line/contract that's wrong. Fix that specific thing rather than making speculative changes.
5. **Secrets.** Never commit credentials, tokens, or keys to any tracked file.

### Dynamic / project-specific rules

1. **Execution status.** Before starting a non-trivial task, briefly state: (1) what has been completed, (2) what remains, (3) the immediate next action.
2. **Long tasks warning.** Before any action likely to take several minutes or require substantial tool use, briefly state the expected scope and warn the user before proceeding.
3. **English only.** Write all project artefacts in English unless explicitly instructed otherwise — including code comments, Markdown/docs, generated commit messages, and user-facing site content.
4. **Docs location.** Store newly generated documentation in `docs/` (create it if missing) unless told otherwise; reuse existing docs instead of duplicating them.
5. **Protected paths.** Never move, rename, or relocate files whose name or location is fixed by project/assignment requirements (e.g. `CLAUDE.md`, `PROCESS.md`, `reflections/`, required root-level files).
6. **Plan before large work.** Briefly state the plan before code changes or large documents. For multi-phase work, state the phases and proceed unless the task is ambiguous, risky, or requires a user decision.
7. **Resume, don't restart.** If interrupted by an API error, streaming error, timeout, or manual stop, never restart the whole task — inspect existing files/output first, resume from the last completed step, and regenerate only what's missing or incomplete.
8. **Check before creating.** Before creating a file or starting work, check whether a suitable file already exists and whether the work is already partially done; update/reuse it instead of duplicating or repeating work.
9. **No invented URLs.** Discover website pages from the site's actual navigation or sitemap when analysing an existing site — never guess or invent page URLs.
10. **Targeted verification.** For minor CSS, layout, or isolated UI changes, run the smallest relevant check (normally `pnpm check`). Do not automatically launch Playwright, screenshots, or broad manual verification. Use browser-based verification only when the user explicitly requests visual verification or when the change affects interactive behavior, responsive behavior, or is otherwise difficult to validate statically. Keep verification scoped to the changed feature.
11. **Stay in scope.** Modify only the files, components, and behaviors relevant to the requested task. Do not refactor, redesign, or fix unrelated issues unless they block the requested change.

## Growing this file

Add project-specific conventions here as they're discovered (recurring agent mistakes, stack quirks, new invariants) — keep entries short and actionable.
