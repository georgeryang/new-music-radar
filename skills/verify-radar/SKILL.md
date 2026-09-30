---
name: verify-radar
description: Verify new-music-radar pipeline, editor, and frontend changes with isolated regression fixtures and browser checks.
---

# Verify New Music Radar

Run the checks for the change once after final edits. Combine matching rows; a full `npm test` replaces focused Node tests.

| Change | Checks |
|---|---|
| Docs only | Check changed commands and links |
| Skills or setup | `node --test tests/setup-skills.test.mjs`; check host links |
| Pipeline or shared scripts | `npm test` |
| Editor (`prefs-server.mjs`, including Tailwind classes) | `node --test tests/prefs-server.test.mjs`, `npm run check-editor`, `npm run test:browser` |
| Frontend (`src/`) | `node --test tests/feed-data.test.ts`, `npm run check-types`, `npm run test:browser` |

`check-editor` parses the server and actual inline client script; Vite only scans the server as Tailwind text. The browser suite builds fresh assets into a temporary directory, intercepts requests, and checks races, keyboard controls, responsive layout, and card links. No production build is needed. `npm run build` installs output into tracked `docs/`; use it when updating the built site is part of the task.

Run `npm ci` only when required dependencies are missing or the lockfile changed. Run `npm run test:browser:install` if Chromium is missing. Missing tools are failures, not passing checks. Docs and skill checks need neither installation.

## Safety and Coverage

Never run the live updater or click live **Save & refresh** as a test. Never inject failures into live config/data or restore files with `git checkout`. Add fixtures in `tests/`; `tests/helpers.mjs` isolates HOME and Git configuration, and publishing fixtures mock fetching and push.

A live Apple integration run needs a disposable copy with its own HOME and lock files. Fetching writes data/history even on exit 2. Fault-injection promises must keep Node alive and reject on the abort signal. Failed source days stay `null`, never zero.

Chromium covers dropdown focus through mousedown but does not establish Safari/Firefox behavior. Card links must use `music://music.apple.com/us/` without `target`.

For manual inspection, restart the editor after template changes. Preview serves `/new-music-radar/` at its printed hostname; the editor ping may fail when the editor is stopped. Report executed checks, failures, and coverage limits. Read relevant source ranges and summarized results, not generated bundles or full data/lockfiles.
