<h1 align="center">agent-kit</h1>

<p align="center">
  <a href="https://github.com/FrostBy/agent-kit/actions/workflows/ci.yml"><img src="https://github.com/FrostBy/agent-kit/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/licence-MIT-blue" alt="Licence: MIT"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="Node >= 20">
  <img src="https://img.shields.io/badge/dependencies-0-success" alt="Zero dependencies">
  <img src="https://img.shields.io/badge/i18n-en%20%7C%20ru-informational" alt="English and Russian">
</p>

**Agent kit for [Claude Code](https://code.claude.com) and [Codex CLI](https://github.com/openai/codex): one statusline for both, Codex patches, an agent broker and two-way session sync.**

- **Statusline for Claude Code and Codex** (Codex: native footer or a log panel): context, quotas, git across umbrella repositories, runtime activity, Codex/Kimi executor widgets. Dependency-free Node, TUI editor, English and Russian.
- **Codex patches**: a native footer driven by the same renderer, full diffs, command timing, capacity retries, Shift+Tab Plan/Auto, restricted subagents via a `readonly-`/`plan-` task name prefix. You build Codex yourself from the patched sources; no binaries are shipped.
- **Faster Codex voice**: a realtime prompt for quicker speech (configuration only).
- **Agent broker**: Claude runs Codex/Kimi as background executors; finished Codex threads are archived so they do not clutter session lists.
- **Session sync (experimental)**: a Claude Code session and a Codex session in the same project mirror each other both ways, with native history, titles and tool calls; continue in Codex when Claude tokens run out and back.

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

- **Claude Code statusline**: Node.js 20+. Nothing else.
- **Codex patches** (Windows x64 for now, macOS/Linux TODO):
  - Git;
  - [rustup](https://rustup.rs) (`winget install Rustlang.Rustup`); the Rust version comes from Codex's `rust-toolchain.toml`;
  - MSVC C++ Build Tools: `winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"`;
  - the official standalone Codex matching [manifest](patches/codex/manifest.json) installed (its package is copied as the base);
  - a short `CARGO_HOME` (a manual junction works) or Windows `LongPathsEnabled`; the build prints remediation commands if the rusty_v8 checkout would exceed MAX_PATH;
  - tens of GB of disk and 20+ minutes for the first release build.

The installer only checks these and prints the commands; it never installs tools for you.

## Quick start

```sh
git clone https://github.com/FrostBy/agent-kit && cd agent-kit
node install.js          # or install.cmd / sh install.sh
```

Pick items with arrows, Space and Enter: Claude statusline, each Codex patch separately, faster voice. Dependencies are added automatically. Non-interactive:

```sh
node install.js --list
node install.js --only claude
node install.js --only statusline,full-diff,interaction-modes,voice
node install.js --yes --skip voice
```

Settings and `config.toml` are backed up before changes; `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are respected. The [voice template](templates/codex-voice-prompt.md) is based on Codex's realtime backend prompt ([Apache-2.0](patches/LICENSE.Apache-2.0)).

Full diff, capacity retries and faster voice are based on [booxter](https://github.com/booxter)'s patches, see [Credits](#credits).

## Codex

### Native footer (patched CLI)

Build on Windows x64 (see [Prerequisites](#prerequisites)); macOS/Linux stop with an explicit error for now. Only source patches are shipped.

```sh
npm run codex:build -- --dev     # omit --dev for release; --features a,b selects patches, default all
npm run codex:install            # activates <version>-agent-kit next to the official release
npm run codex:sync-footer        # after JS changes: update the packaged renderer
npm run codex:restore            # back to the official release
```

Install copies the official standalone package into `<version>-agent-kit`, keeps rollback state and never edits config or auth. To upgrade Codex: `codex:restore`, `codex update` to the [manifest](patches/codex/manifest.json) version (from PowerShell or cmd, not Git Bash), build, `codex:install`.

The footer uses the Claude layout with data from native CLI JSON and ends with an auto/plan/read-only mode line; `maxLines` in `--codex --configure` limits its content rows. `node scripts/native-codex.js [project]` runs a dev build in an isolated home with a loopback provider, without touching your Codex.

Details in [patches/README.md](patches/README.md): what each patch adds, build/install internals, paths and limitations.

<details>
<summary><b>Standalone log inspector (legacy mode)</b></summary>

A separate panel for a terminal pane, reading local Codex session logs (no network, no Claude credentials):

```sh
node statusline.js --codex --watch      # q / Ctrl+C to exit; omit --watch for one snapshot
node statusline.js --codex --preview    # sample umbrella with three repositories
```

`--root="Z:/work"` sets an umbrella directory, `--session=UUID` or `--session="C:/path/session.jsonl"` pins a session; otherwise `CODEX_THREAD_ID` or the newest session under the root is used. `ctx` is measured against the session's effective `model_context_window`; quotas show usage consumed. The log format is internal and may change. Configure with `node statusline.js --codex --configure` (`~/.codex/statusline.json`).

</details>

## Agent broker and session sync (experimental)

**Broker.** Claude runs Codex (through `codex app-server proxy`) or Kimi as background executors, with an inbox for follow-ups, steering and interruption. Point `--state` at the scratchpad the statusline reads. `node install.js --only broker` prints the command; npm also exposes `agent-broker`. Executables come from PATH or `AGENT_BROKER_CODEX` / `AGENT_BROKER_KIMI`. Finished Codex threads are archived and unarchived on resume. For orchestrators and background commands: `broker.js send --name X --state DIR (--message FILE | --text "...")` drops a message into the inbox and waits for the turn to finish, `broker.js wait --name X --state DIR` waits for the current or next turn to finish; both print `<name>.out.md` and exit 0 (1 if the broker cannot resume or `--timeout-min` expires).

```sh
node scripts/agents/broker.js --agent codex --name reviewer --state /tmp/scratchpad --prompt /tmp/prompt.md --cwd /path/to/project
```

Brokers exit after 15 idle minutes (`--idle-min` overrides); `send` revives a dead broker using saved settings and its Codex/Kimi session, without replaying the initial prompt. Mesh hooks ignore normal/idle exits; the synchronous SessionEnd hook closes session brokers, and a detected owner PID also binds their lifetime.

**Interactive mesh (iterations 1–2).** Codex questions and approvals stay open for `broker.js answer|approve|deny --name X --state DIR --request ID`; typed `interrupt`/`exit` also work during a turn. `--approval-policy` defaults to `never`. `events --state DIR --next` waits for one event and advances a cursor so it is not delivered twice. The optional Claude `mesh-hook.js` uses `asyncRewake` on SessionStart/Stop; install it explicitly with `node scripts/agents/mesh-hook.js install` (remove with `uninstall`). See [setup, settings JSON and live acceptance checks](docs/agent-mesh.md#подключение-итераций-1–2). Live idle wake still needs acceptance on your Claude version.

**Session sync** is off by default, including with `--yes`:

```sh
node install.js --only sync
node scripts/agents/sync.js uninstall
```

It adds global hooks to `CLAUDE_CONFIG_DIR/settings.json` and `CODEX_HOME/config.toml` and activates per project only after both clients have been used in that directory. Each source session gets a mirror in the other client, titled `<source title> · Claude/Codex`: resume it there and continue. The mirror carries the latest compacted context (about 50k tokens, `SESSION_SYNC_CONTEXT_TOKENS`) with native history and tool calls; later turns arrive as hook context. Broker agents, subagents and noninteractive sessions are excluded. Nothing is executed and no credentials are read, but transferred text can contain private data.

Internals, limits, state layout and manual checks: [docs/sync.md](docs/sync.md).

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

## Credits

- [booxter](https://github.com/booxter): the original Codex patches for full diffs in compact mode, capacity retries and the stream retry limit, and the faster-voice idea ([booxter/nix](https://github.com/booxter/nix)). The target Codex version is defined in the manifest.
- [GordonBeeming/codex-statusline](https://github.com/GordonBeeming/codex-statusline) (Apache-2.0): the base of the native footer patch.
- [OpenAI Codex](https://github.com/openai/codex) (Apache-2.0): patched sources and the voice prompt template. See [patches/NOTICE](patches/NOTICE).

## Licence

[MIT](LICENSE) © Vladislav Romanovsky
