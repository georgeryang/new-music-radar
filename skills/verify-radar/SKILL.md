---
name: verify-radar
description: Verify new-music-radar pipeline, editor, and frontend changes with isolated regression fixtures and browser checks.
---

# Verify New Music Radar

Run checks matching the change:

| Change | Checks |
|---|---|
| Pipeline | `npm test` |
| Editor | `npm test`, `npm run check-editor`, browser suite |
| Frontend | `npm test`, `npm run build`, browser suite |
| Skills or setup only | Check skill frontmatter and links; `node --test tests/setup-skills.test.mjs` |

- `npm test`: isolated temporary repositories, mocked Apple requests and git publishing. Covers locks, carryover, publishing guards, HTTP validation, pacing, staged builds, and feed validation.
- `npm run check-editor`: server syntax plus parsing the actual inline client script. Vite only scans the server as Tailwind text, so a successful build proves neither.
- `npm run build`: TypeScript and staged production build. Replaces tracked generated assets only after staging succeeds; keeps `docs/data`.
- `npm run test:browser`: editor races, keyboard controls, responsive layout, and built-site validation/link handling. Build first when artifacts are absent or frontend/editor utility classes changed. All browser requests are intercepted; refresh/publish never runs.

Use `npm ci` to install the pinned development dependencies, then `npm run test:browser:install` to install matching Chromium. The harness imports project-local Playwright and uses its browser. Missing tools must be reported, not counted as passing. Browser dependencies stay out of the production app.

## Safety and Coverage

Never run the live `scripts/update.sh` or click the live **Save & refresh** as a test: both publish. Never inject failures into live config/data or restore files with `git checkout`. Add fixtures to `tests/` instead. `tests/helpers.mjs` copies the necessary files into a temporary repo with its own HOME; publishing tests replace Apple fetching and git push.

For verification that should leave tracked assets untouched, build and run the browser suite in a disposable repo copy with its own dependencies. Do not copy live lock files or point the copy's `docs/` at the live repo.

A live Apple integration run is separate from these checks and needs an isolated copy. The fetcher writes data/history even when it exits 2. Fault-injection promises must keep Node alive and reject on the abort signal; otherwise a fake timeout can exit before being exercised. Verify failed source days stay `null`, never zero.

Chromium does not establish Safari/Firefox focus behavior. macOS browsers differ on focusing buttons at mousedown; dropdown tests must verify focus stays in the input through mousedown, rather than merely that a Chrome click succeeds.

For manual inspection, restart the editor after template changes. `PAGE` is built at import. `vite preview` serves the built project at `/new-music-radar/`; use the hostname it prints. Cards must use `music://music.apple.com/us/` without `target`. The local-editor ping may fail when the editor is stopped.

Report checks actually executed, failures, and browser/live-API coverage limits. Read only relevant source ranges and summarized results; generated bundles, full data files, and lockfile dumps rarely help a review.
