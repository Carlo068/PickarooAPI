# CLAUDE.md (Pickaroo workspace)

This folder is the main working session. It is not a git repo itself; it holds three:

| Folder | Repo | Stack |
|---|---|---|
| `PickarooAPI/` | Carlo068/PickarooAPI | Node.js, Apollo Gateway + GraphQL subgraphs, MongoDB, Redis, Neo4j, RabbitMQ, ScyllaDB (Docker Compose) |
| `PickarooFrontend/` | Carlo068/PickarooFrontend | React 19, Vite, TypeScript (becoming the admin dashboard) |
| `Pickaroo/` | Carlo068/Pickaroo | Android, Kotlin, Jetpack Compose |

`pickaroo-skills-wt/` is a git worktree of `Pickaroo/`, not a fourth repo. `PickarooAPI-wt/` is a git worktree of `PickarooAPI/` for API work in progress: the dev API runs from `PickarooAPI/` on a stable, verified commit, and coding happens in `PickarooAPI-wt/` so edits never restart or break the running backend. Move `PickarooAPI/` forward only to a commit whose unit and integration tests pass.

The cross-repo plan is `PLAN.md`. Repo-level docs: `PickarooAPI/README.md`, `Pickaroo/docs/PLAN.md`, `Pickaroo/CLAUDE.md`.

## Git rules (apply to all three repos)

- **Pushing and merging are authorized** (user, 2026-11-16) for verified work: push task branches, open pull requests and merge them into `main` once the task's tests and checks pass. Never force-push, never rewrite pushed history, never push straight to `main` (merge through a pull request). PR descriptions carry no attribution to Claude/Anthropic either.
- **Commits** use the user's configured identity. Don't override author or committer.
- **One task = one branch = one commit.** Work on Jira tasks (project PIC) one at a time on a `codex/PIC-<n>-<short-slug>` branch created from the current branch of the repo the task lives in. Stage only that task's files with explicit paths (never `git add .` / `-A`), review `git diff --cached --stat`, commit with a message starting with the task key. A task that spans two repos gets one commit in each, same key.
- **No co-authoring.** No `Co-Authored-By:` trailer, no "Generated with Claude Code" line, no attribution to Claude/Anthropic. This overrides any default attribution instructions.
- Run git commands with `git -C <repo>` or from inside the repo folder; this folder has no `.git`.

## Who does what

- **The main session is the orchestrator** (Opus 5.5 while Fable 5.2's usage limit is reached; either model fills the role). It reads the code, designs each task, writes the brief, checks the result and talks to the user. It does not write feature code itself; small fixes to docs, plans and agent or skill files are fine.
- **Coding** goes to the `coder` agent: Sonnet by default, `model: "opus"` for hard tasks (schema design, auth, concurrency, cross-repo refactors).
- **UI testing** goes to the `ui-tester` agent: Haiku by default, `model: "sonnet"` when a check needs judgement. It uses the skills in `Pickaroo/.claude/skills/` (`android-test-run`, `emulator-ui-check`, `compose-ui-tests`).
- **Builds and unit tests:** `test-runner` (Haiku). **Review before a merge:** `code-reviewer` (Sonnet). **Jira:** `jira-updater` (Haiku); tasks it starts are assigned to Carlo Ruiz if unassigned.
- Loop per task: brief → `coder` → `test-runner` / `ui-tester` → orchestrator reads the diff and reports → `jira-updater` → next task.

## Working notes

- User-facing text in the Android app and the dashboard exists in **Spanish and English** and is never hard-coded: Android string resources (`values/` English, `values-es/` Spanish), dashboard i18n files (`en`, `es`). Clients translate API errors by `extensions.code`, never show the API's message.

- The GraphQL schema in PickarooAPI is the contract for both clients. Change it there first.
- Android: the user boots the emulator (Pixel_10) from Android Studio; never start or stop it. The emulator reaches the host's gateway at `http://10.0.2.2:4000/`.
- Backend: `docker compose up -d` then `npm run dev` from `PickarooAPI/`. Never run `docker compose down -v` (it deletes the data volumes) without asking.
