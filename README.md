<h1 align="center">agent-kit</h1>

<p align="center">
  <a href="https://github.com/FrostBy/agent-kit/actions/workflows/ci.yml"><img src="https://github.com/FrostBy/agent-kit/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/licence-MIT-blue" alt="Licence: MIT"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="Node >= 20">
  <img src="https://img.shields.io/badge/dependencies-0-success" alt="Zero dependencies">
  <img src="https://img.shields.io/badge/i18n-en%20%7C%20ru-informational" alt="English and Russian">
</p>

**A kit for [Claude Code](https://code.claude.com) statuslines, custom Codex native features and faster voice.** Context, quotas, git across umbrella repositories and runtime activity. A dependency-free Node renderer, a TUI editor, English and Russian.

Русская версия: [README.RU.md](README.RU.md)

```
Fable 5.1 high   ctx ▰▰▱▱▱ 42% 84k/200k   ⚙  Edit render.js   📋 3/7   agents 2
5h ▰▰▰▱▱ 63% ↻ 1h00m   7d ▰▰▱▱▱ 41% ↻ 3d0h   Fable 18%
#128 ✓ approved
▸ api  ⎇ feat/login 1 to push +120 −14 ?1
  web  ⎇ main       2 to pull +8 −2
  Σ +128 −16
```

## Prerequisites

- Node.js 20+. No npm dependencies.
- Codex native: Windows x64, Git, rustup (`winget install Rustlang.Rustup`), and MSVC C++ Build Tools with Windows SDK. Rust is selected and downloaded by the upstream `rust-toolchain.toml`.
- Install MSVC manually: `winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"`.
- Keep an official Codex 0.164.0 standalone package installed for its bundled resources. Allow roughly 30–60 GB free and 30–120 minutes for the first release build, depending on hardware/network; later builds reuse the Cargo cache. Binaries are built locally, never distributed here.

## Quick start

Clone this repository, then run:

```sh
node install.js
```

Use arrows, Space and Enter to choose Claude statusline, individual Codex features and faster voice. Required dependencies are checked automatically and marked `(required)`. Only Claude is checked initially. `install.cmd` or `sh install.sh` are thin Node launchers.

```sh
node install.js --list
node install.js --only claude
node install.js --only statusline,full-diff,interaction-modes,voice
node install.js --yes --skip voice
```

Without a TTY, pass `--yes`, `--only id,...` or `--skip id,...`. `--yes` selects all available items; `--skip` excludes items, and an explicitly skipped required dependency is an error. On macOS/Linux, Codex items are marked TODO and unavailable; Claude works. The installer prints a summary and checks build requirements before taking action. It never installs third-party tools automatically.

Claude uses the existing `--install` logic and respects `CLAUDE_CONFIG_DIR`. Voice respects `CODEX_HOME` and backs up `config.toml` before editing. An existing voice prompt requires confirmation; `--yes` skips it with a message. The bundled [voice template](templates/codex-voice-prompt.md) derives from OpenAI Codex 0.164.0's `codex-rs/prompts/templates/realtime/backend_prompt.md` ([Apache-2.0](patches/LICENSE.Apache-2.0)), with a neutral name instruction and faster speech. Faster-voice idea: [booxter/nix](https://github.com/booxter/nix). Refresh the template when upgrading Codex.

## What it shows

- **Context**: used tokens out of the window (`84k/200k`, `170k/1M`), with a bar coloured by threshold.
- **Limits**: the 5-hour and weekly windows with time to reset, plus per-model weekly limits such as Fable. When you burn faster than the window runs, the numbers turn red and `out in 1d9h` says when the limit runs out at this pace.
- **Git in umbrella folders**: launched in a folder that holds several repos, it lists every repo with uncommitted or unpushed work on its own line, aligned in columns, marks the one Claude is in with `▸` and adds up the lines (`Σ`). Inside a single repo it shows that repo.
- **Activity**: the running tool and its argument, todo progress, running subagents, the PR of the branch with its review state.
- **Money only when it is money**: session cost and today's spend across all sessions appear on API billing, or on a subscription once extra usage starts being spent in the current session. Within the subscription limits they stay hidden.
- **Subagent rows**: a line per subagent in the agents panel with model, effort, tokens, share of context and a sparkline.

## Codex

### Native footer in the custom CLI

Build locally on Windows x64: Node.js 20+, Git, rustup and MSVC C++ Build Tools with Windows SDK are required. Codex pins Rust 1.99.1. We distribute source patches, not binaries. macOS/Linux build and installation are TODOs with explicit errors.

```sh
npm run codex:prepare
npm run codex:build -- --features statusline,full-diff,exec-timing,capacity-retry,interaction-modes,restricted-subagents
npm run codex:install
npm run codex:sync-footer
npm run codex:restore
```

Omit `--features` to select all; dependencies are automatic. `--dev` builds debug instead of release. Installation copies an existing official standalone package into `<version>-agent-kit`, retains rollback state and respects `CODEX_HOME` / `--standalone`; it does not edit config or auth. Reinstallation updates the same custom release in place, renaming a locked executable. Manual custom installations are migrated by finding the official stock release; the old custom directory is retained for manual removal. See [prerequisites, paths and limitations](patches/README.md#prerequisites--требования) and the [feature manifest](patches/codex-0.164.0/manifest.json). After JS changes, `codex:sync-footer` updates the packaged renderer.

The native build is stamped with the upstream 0.164.0 commit, so Codex's bundled voice input keeps working.

The patch also adds full compact diffs, command timing and live-output counts, overload retries, Plan/Auto switching and restricted subagent modes. See [what the patch adds](patches/README.md#what-the-patch-adds) for the full list and attribution.

```sh
npm run codex:build -- --dev
node scripts/native-codex.js
```

This starts a separate Codex CLI with our footer inside its interface. Pass a project directory as the second argument if needed. The launcher uses `.native/test-home` and an unauthenticated loopback test provider; it does not edit the installed Codex or user config. Model requests and live account quotas are unavailable in this profile. If Windows offers sandbox setup, press Esc to inspect the footer without installing anything.

Layout and styling follow the original Claude version. Model, effort, context, quotas, active tools, todos, subagents and already-cached PR metadata come from native CLI JSON. Git uses the shared scanner. Unavailable blocks are omitted; the row budget follows terminal height, and Git totals include hidden repositories. See [patches/README.md](patches/README.md) for the patch and limitations.

The native footer ends with a separated auto/plan/read-only mode line; `maxLines` in the Codex footer config (default `4`, also available in `--codex --configure`) limits content only, while terminal height and Codex's explicit `max_lines` remain outer caps; `gapAfter` adds one final blank braille row only when it fits.

### Standalone log inspector (legacy mode)

From this checkout, in a separate terminal or Windows Terminal pane:

```sh
node statusline.js --codex --watch
```

Exit with `q` or `Ctrl+C`. Omit `--watch` for one snapshot. Preview a three-repository umbrella:

```sh
node statusline.js --codex --preview
```

```text
gpt-6.1-sol high   ctx ▰▰▱▱▱ 42% 200k/475k   ⚙  exec npm test   📋 3/7   agents 2
5h ▰▰▰▱▱ 63% ↻ 1h42m   7d ▰▰▱▱▱ 41% ↻ 3d8h
▸ api    ⎇ master     2 to push +120 −34 ?3
  web    ⎇ feat/login 1 to pull +48 −12 ?1
  infra  ⎇ master     +3 −1
  Σ +171 −47
```

`+/−` counts line changes against HEAD in tracked files; `?` counts individual untracked files. Untracked contents are excluded from line counts. Totals include repositories hidden by `git.max`.

Use `--root="Z:/work"` for an umbrella directory. Pin a session with `--session=UUID` or `--session="C:/path/session.jsonl"`. Otherwise the panel uses `CODEX_THREAD_ID` if it belongs to that root, or the newest session started in the root or its descendants. Automatic selection excludes unrelated projects.

The log inspector reads `~/.codex/sessions` (or `$CODEX_HOME/sessions`), then only appended bytes. It refreshes every two seconds; the header shows the last usage snapshot time. Quota percentages show usage consumed. `ctx` compares the last request against this session's effective window (`model_context_window` in the log), which may be smaller than the model's API maximum. Only reported quota windows are displayed.

This is a separate panel, rather than an extension of Codex's built-in `/statusline`. It can run alongside CLI, desktop or IDE sessions with local logs. The log format is internal and may change. Tool activity, plans and subagents require their corresponding log events; nested code-mode commands are not parsed. Codex mode does not read Claude OAuth credentials or make network requests. Dollar costs and cache-expiry estimates are not computed.

Configure with `node statusline.js --codex --configure`. Codex has its own `~/.codex/statusline.json`. `AGENT_STATUSLINE_CONFIG` overrides the file for either mode; `CLAUDE_STATUSLINE_CONFIG` still works for Claude.

## Install

Install it globally from GitHub, then point Claude Code at it:

```sh
npm install -g github:FrostBy/agent-kit
agent-kit --install
```

`--install` writes `statusLine` and `subagentStatusLine` into `~/.claude/settings.json` as `node "<install path>/statusline.js"`, so each render runs the installed copy and fetches nothing. The previous values are saved and `--uninstall` puts them back. The settings file is left untouched if it does not parse.

To update, run the `npm install -g` line again.

## Configure

```sh
agent-kit --configure
```

The editor shows a live preview on sample data. Keys: `↑↓` select, `a` add a widget, `d` delete, `K`/`J` move, `|` separator, `Enter` widget options, `n` new line, `g` global settings, `s` save, `q` quit. In mintty or Git Bash run it through `winpty`.

The Claude config lives in `~/.claude/statusline.json` (override with `AGENT_STATUSLINE_CONFIG` or `CLAUDE_STATUSLINE_CONFIG`). Missing values come from the defaults, and `--init` writes them out. The package name and command are `agent-kit`; `agent-statusline` and `claude-statusline-ultimate` remain aliases. Codex's internal `codex-resources/agent-statusline` directory and `agent-statusline-state.json` filename remain unchanged for compatibility.

```json
{
  "lines": [
    ["model", "effort", "fast", "|", "context", "|", "activity", "|", "todos", "|", "subagents"],
    ["limit-5h", "|", "limit-7d", "|", "limit-model"],
    ["cost", "|", "cost-today", "|", "cache", "|", "pr"],
    ["git", "|", "worktree"]
  ],
  "widgets": { "context": { "bar": 8 }, "git": { "max": 6, "branchMax": 30 } },
  "colors": { "model": "#c792ea", "branch": "magenta" }
}
```

| Key | Default | Meaning |
|---|---|---|
| `lines` | see above | Widgets per line. `"\|"` starts a new group. An item can be an object with options: `{ "id": "text", "value": "🔥" }` |
| `separator` | three spaces | Between groups |
| `gapAfter` | `true` | Empty line after the status line, above Claude Code's own mode line |
| `money` | `auto` | `auto`: money only on API billing or extra usage; `always`: always |
| `lang` | `auto` | `en`, `ru`, or `auto` from the system locale |
| `icons` | `unicode` | `unicode`, `ascii` for plain terminals, `nerd` for Nerd Fonts |
| `colors` | | ANSI names (`cyan`, `brightRed`, `gray`…) or `#rrggbb`. `NO_COLOR` turns colours off |
| `thresholds` | `50` / `80` | Percent where values turn yellow and red |
| `pricing` | | Override model prices, $ per 1M tokens: `{ "claude-opus-5-5": { "in": 4, "out": 20, "read": 0.2 } }` |
| `usageTtl`, `todayTtl` | `120`, `300` | How often the usage API and today's spend refresh, seconds |

Other commands: `--preview` renders sample data in the current folder, `--list [--md]` lists every widget with its options.

## Widgets

In Claude mode, add `codex` and `kimi` to `lines` manually. `exclude` lists paths separated by `;`, hiding the widget in those folders and descendants (case-insensitive on Windows). `idleAfter` hides sessions after inactivity in minutes (default 10); `maxAge` remains an additional age limit. Kimi logs above 16 MiB are hidden. Reads are local, without credentials.
The widgets first use agent-broker state files in `input.scratchpad_dir`, matching Codex by `threadId` and Kimi by `sessionId`: up to three active agents, otherwise the most recently finished agent if still fresh. Freshness and turn status come from the session log; done/error state files are ignored. Agent names appear in gray, with Codex account quotas once at the end. Without a matching fresh broker agent, selection falls back to cwd: only `codex exec` sessions for Codex, and local Kimi sessions for `kimi -p`.
Kimi shows `limit 5h` for 5 hours after a 5-hour quota error; `limit month` (monthly) and `limit` (unknown window) remain for 30 days after the event.

<!-- widgets:start -->
#### Model & session

| id | description | options |
|---|---|---|
| `codex` | External Codex: model, context, tokens, quotas | `exclude="", maxAge=120, idleAfter=10, tokens=false` |
| `kimi` | External Kimi: model, context, tokens, limit | `exclude="", maxAge=120, idleAfter=10, tokens=false` |
| `model` | Model |  |
| `effort` | Effort level |  |
| `thinking` | Extended thinking enabled |  |
| `fast` | Fast mode |  |
| `plan` | Plan: Pro / Max 5x / Max 20x / API |  |
| `session-name` | Session name | `max=24` |
| `duration` | Session duration |  |
| `api-time` | Share of time waiting for the API |  |
| `version` | Harness version |  |
| `style` | Output style, if not default |  |
| `vim` | Vim mode |  |
| `agent` | Agent name (--agent) |  |
| `permission-mode` | Permission mode, if not default (from transcript) |  |

#### Context

| id | description | options |
|---|---|---|
| `context` | Context: bar, %, used/window; accounts for Claude's `autoCompactWindow` | `label="ctx", bar=5, percent=true, used=true, left=false` |
| `context-breakdown` | Context by type: fresh input / cache read / cache write |  |

#### Limits

| id | description | options |
|---|---|---|
| `limits` | Codex quota windows, with their actual durations | `label="", bar=5, countdown=true, pace=true, paceMargin=10` |
| `limit-5h` | 5-hour limit | `label="5h", bar=5, countdown=true, pace=true, paceMargin=10` |
| `limit-7d` | Weekly limit | `label="7d", bar=5, countdown=true, pace=true, paceMargin=10` |
| `limit-model` | Per-model weekly limits (Fable etc.), usage API | `countdown=false, pace=true, paceMargin=10` |
| `limit-spend` | Gateway spend limit |  |
| `extra-usage` | Purchased credits (extra usage), usage API |  |
| `week-breakdown` | Where the week went: Claude Code / chats / Cowork, usage API | `min=1` |

#### Money & edits

| id | description | options |
|---|---|---|
| `cost` | Session cost |  |
| `burn-rate` | $ per hour, current session |  |
| `cost-today` | Today's spend across all sessions (from transcripts) | `sessions=false` |
| `session-lines` | Lines changed by Claude this session |  |

#### Prompt cache

| id | description | options |
|---|---|---|
| `cache` | Prompt cache: warm/cold, when it expires | `under=5` |
| `cache-hit` | Cache hit ratio and misses |  |

#### Git

| id | description | options |
|---|---|---|
| `git` | Git: branch, commits to push/pull, +/− lines, untracked; in an umbrella folder a row per changed repo and Σ | `depth=2, max=4, showClean=false, branchMax=24, rows=true, aheadBehind=true, lines=true, untracked=true, stash=false, budgetMs=400` |
| `worktree` | Worktree name |  |
| `repo` | Repository owner/name, clickable |  |
| `pr` | PR/MR: number and review state, clickable | `state=true` |

#### Folders

| id | description | options |
|---|---|---|
| `dir` | Current folder | `full=false` |
| `project-dir` | Launch folder, if different from current |  |
| `added-dirs` | Folders added via /add-dir |  |

#### Live activity

| id | description | options |
|---|---|---|
| `activity` | Tool running right now | `detail=true` |
| `todos` | Todo / task progress |  |
| `subagents` | Running subagents |  |

#### Misc

| id | description | options |
|---|---|---|
| `clock` | Clock | `seconds=false` |
| `text` | Custom text | `value="", color="muted"` |
| `cmd` | Output of your own command (cached) | `command="", ttl=30, color="muted"` |
<!-- widgets:end -->

## How it works

- Claude Code pipes session JSON to the command and shows what it prints. Only the sources the current layout needs are loaded.
- Git runs in parallel across repos with a 400 ms budget. Past it, the last known state is shown and the scan finishes in a detached process, so the render never waits.
- The usage API and today's spend refresh in detached processes on their TTL.
- Today's spend is priced per model from the `usage` of each response in today's transcripts, subagents included, with duplicate content blocks counted once. Files are read incrementally, gigabyte-sized ones in chunks.
- Git is read from the folder the session was launched in, so a `cd` into one repo does not hide the others.
- The cache lives in `agent-statusline` under the system temp folder.

## Windows Terminal

Cascadia Mono, the default font, lacks some symbols. Windows draws them from a fallback font, wider than a cell, and they overlap the next character. The default icons were checked by eye in Windows Terminal: missing glyphs are emoji or get an extra space. Claude Code also trims leading spaces on every line, so the indent of the git rows starts with U+2800, a blank braille cell.

## Privacy

Per-model limits, extra usage and money on a subscription need the account usage. For that the status line reads the Claude Code OAuth token from `~/.claude/.credentials.json` and calls `api.anthropic.com/api/oauth/usage`, the endpoint behind `/usage`. It is undocumented and may change. The token goes nowhere else. Leave `limit-model`, `extra-usage`, `week-breakdown` and the money widgets (`cost`, `burn-rate`, `cost-today`) out of the layout, and no request is made.

## Development

```sh
npm test
node statusline.js --preview
```

## Licence

[MIT](LICENSE) © Vladislav Romanovsky
