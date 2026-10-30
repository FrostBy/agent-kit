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

### Native footer in the custom CLI

Build locally on Windows x64: Node.js 20+, Git, rustup and MSVC C++ Build Tools with Windows SDK are required. The source `rust-toolchain.toml` defines the required Rust version. We distribute source patches, not binaries. macOS/Linux build and installation are TODOs with explicit errors.

```sh
npm run codex:prepare
npm run codex:build -- --features statusline,full-diff,exec-timing,capacity-retry,interaction-modes,restricted-subagents
npm run codex:install
npm run codex:sync-footer
npm run codex:restore
```

Omit `--features` to select all; dependencies are automatic. `--dev` builds debug instead of release. Installation copies an existing official standalone package into `<version>-agent-kit`, retains rollback state and respects `CODEX_HOME` / `--standalone`; it does not edit config or auth. Reinstallation updates the same custom release in place, renaming a locked executable. Manual custom installations are migrated by finding the official stock release; the old custom directory is retained for manual removal. See [prerequisites, paths and limitations](patches/README.md#prerequisites--требования) and the [feature manifest](patches/codex/manifest.json). After JS changes, `codex:sync-footer` updates the packaged renderer.

To upgrade, run `npm run codex:restore`, then `codex update` to the version in the manifest, build the matching patched CLI and run `npm run codex:install`. Installation creates a new `<version>-agent-kit`, keeps the old custom release and prints its path; subsequent restore returns to the new official release. Run `codex update` from PowerShell or cmd: Git Bash puts GNU tar first in PATH, causing the internal install.ps1 to fail.

The native build is stamped with the upstream commit from the manifest, so Codex's bundled voice input keeps working.

The patch also adds full compact diffs, command timing and live-output counts, overload retries, Plan/Auto switching and restricted subagent modes via a `readonly-`/`plan-` task name prefix. See [what the patch adds](patches/README.md#what-the-patch-adds) for the full list and attribution.

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

## Agent broker and session sync (experimental)

Manual real-daemon/model smoke (not part of npm test): `node scripts/agents/smoke-live.js --live` requests exactly `pong`, sends `/exit`, and verifies `state.archived=true` plus SQLite `archived=1` using read-only access; artifacts are retained. Without `--live` it performs no actions. The manual SQLite check requires Node 22.13+; the broker still supports Node 20.

Sync/broker use `codex app-server proxy`: originator is process-global in Codex 0.166, so initialize cannot isolate it; sync registries/managed checkpoints protect mirrors from both archive paths across default/env/explicit Claude profiles (`--claude-config-dir DIR` is repeatable, corrupt registries fail closed). Proxy only connects to an existing socket; if needed, start the daemon with `codex app-server daemon start`.

Read-only audit: `node scripts/agents/audit-mirror.js --claude "<transcript.jsonl>" [--codex-home DIR] [--count 3] [--json]`. It exercises extraction and the actual presentation renderers, selects related interactive non-broker rollouts, and prints categories/counts/display examples without conversation bodies or tool arguments. RAW, service text as a user message, or insufficient Codex samples exits 1. All unknown/nonportable tools share a bounded assistant-summary fallback that never copies raw outputs. Todo/plan and web operations use native counterparts where sufficient data exists; foreign MCP/agent identities and live actions are never fabricated.

User-message/runtime markup handling:

| Record / marker | Handling |
| --- | --- |
| Claude bash-input → bash-stdout/bash-stderr | Pair by parent UUID across incremental hooks; emit native Codex CommandExecution with source `user_shell` (“You ran”). Preserve bounded stdout/stderr; do not invent exit codes. |
| Codex user_shell_command / shell.user_command | Import its command/result once, ignoring duplicate UI events; render linked native Claude bash-mode records. Codex's combined output is not guessed into separate streams. |
| Shell model-context archive/delivery | Bounded `User ran: … / Output: …`, without XML wrappers. Claude native resume uses its normal bash-mode representation. |
| Pending/orphan shell records | Hold input until output; discard orphan or mismatched-parent output. |
| command-name/message/args, local-command-stdout/caveat | Drop slash-command machinery, preserving neighboring genuine text. |
| user-memory-input | Drop local memory operations; never replay memory writes (not observed in the inspected transcript). |
| system-reminder, task-notification, agent-message | Drop nonhuman origins and nested/unfinished service blocks. |
| Codex environment_context, user_instructions, AGENTS.md instructions | Drop metadata-classified environment/project context. |
| hook_prompt/additional_context, turn_aborted, subagent_notification, codex_internal_context, goal_context | Drop service context by per-block metadata and markers. |
| Standalone Codex skill fragment | Drop injected skill instructions. |
| persisted-output inside shell output | Unwrap bounded preview; do not read referenced files. |
| Arbitrary HTML/XML/TypeScript in real user input | Preserve as data, rather than stripping all tags. |

Imported Claude records carry `session_sync_key` to prevent native tool/shell history from echoing back. Imports execute no commands; updates to open sessions still use additionalContext.

Imported tools render natively where their recorded data is sufficient: Claude Bash becomes Codex CommandExecution (Ran), edits become FileChange diffs, and Read/Grep/Glob/LS use exploration actions (Explored). Codex exec/shell becomes Claude Bash; apply_patch add/update operations become paired Write/Edit calls. Other tools, incomplete commands and unsupported delete/move patches remain short observations. Edit diff line numbers are relative to the supplied fragments; unknown exit codes/durations are omitted. These Codex UI events are ignored by model-history reconstruction, so injected context is not repeated. `demo-sync.js` includes Bash/Edit/Read and verifies native resume tool items without running a model.

Codex brokers archive their thread on `/exit`, idle timeout or graceful shutdown, unarchive before resume, and keep failed turns open; `node scripts/agents/archive-broker-sessions.js [--minutes 60] [--state DIR] [--apply]` defaults to a read-only list of old idle broker sessions.

`node install.js --only broker` shows the broker command; npm also exposes `agent-broker`. It runs Codex through `codex app-server proxy`, or Kimi through its CLI, with an inbox for follow-up messages, steering and interruption. Put `--state` in the scratchpad used by the statusline; existing `.state.json` consumers remain compatible. Executables come from PATH, or `AGENT_BROKER_CODEX` / `AGENT_BROKER_KIMI` (executable paths, not shell commands).

```sh
node scripts/agents/broker.js --agent codex --name reviewer --state /tmp/scratchpad --prompt /tmp/prompt.md --cwd /path/to/project
node install.js --only sync
node scripts/agents/sync.js uninstall
```

Sync is **off by default**, including with `--yes`; opt in using the experimental checkbox or `--only sync`. Installation adds global hooks to `CLAUDE_CONFIG_DIR/settings.json` and `CODEX_HOME/config.toml` (defaults: `~/.claude`, `~/.codex`). Global hooks let any project work without editing that project. Sync activates only after both clients have visited this cwd: its project table exists in Codex config and its Claude project directory exists. Each originating session gets its own pair, partitioned by cwd. Resume the generated `<source title> · Claude/Codex` session in the other client. Only the new archived Codex mirror receives UI presentation records; later model-context updates arrive through hooks without editing a loaded rollout.

Only `SessionStart`, `UserPromptSubmit`, and `Stop` are used: the first two deliver pending context, Stop captures completed work. There is no per-tool process scan. CLI eligibility is reused while its process identity is unchanged; the initial Windows CIM / Unix ps check can be slower. Broker agents (`SESSION_SYNC_BROKER`), `SESSION_SYNC_EXCLUDE`, noninteractive exec/print sessions and subagents/sidechains are excluded. Codex requires a CLI build supporting these experimental hooks and `additionalContext`.

Seeds and backlog replacements use the latest compact summary plus the bounded recent context; without compaction, omitted earlier history is labeled. The default budget is about 50k tokens (UTF-8 bytes / 4), configurable with `SESSION_SYNC_CONTEXT_TOKENS`; compaction or an oversized pending backlog replaces that backlog with current context.

Hook delivery is separate from the seed budget: Claude has a [10,000-character cap](https://code.claude.com/docs/en/hooks#json-output), so sync conservatively uses 10,000 UTF-8 bytes. Codex's `additionalContextLimit` is approximate tokens (`ceil(UTF-8 bytes / 4)`): our 16000 means 64000 bytes, default 2500, 0 unlimited; no explicit maximum beyond `usize` ([spill implementation](.native/codex/codex-rs/hooks/src/output_spill.rs), [estimator](.native/codex/codex-rs/utils/string/src/truncate.rs)). Snapshots and large events are sent in sequential acknowledged chunks, each marked at the start. Busy locks exit silently and expire after 30 seconds; unchanged checkpoints are not rewritten, event keys are bounded to 256, and denied decisions to 128 entries / seven days. CLI PID/start-time checks reuse eligibility across SessionStart; Windows uses local WSH/WMI for identity, falling back to full CIM if unavailable. Claude mirror versions use transcripts or a cached `--version` query; Codex writes its own metadata.

Sync transfers user/assistant text and completed tool inputs/results as attributed **plaintext observations**, never live tool calls. Thinking, images, attachments, encrypted compaction data and unfinished tool results are omitted. It reads no credentials itself and starts no model turn; Codex mirror creation uses the local app-server API, transferred text can still contain private data from conversations and tools. Rollbacks, invalid records, unknown mirrors and paths outside configured roots fail closed.

Archives live under `CLAUDE_CONFIG_DIR/agent-kit/sync/<cwd-hash>/`: append-only `.events` files plus per-pair checkpoints with byte offsets, keys and pending references; `pairs.json` contains IDs only. Keep state with its mirrors. Installation/removal is idempotent, backs up changed existing settings, and preserves unrelated hooks, subsequent configuration edits, session files and archives. Uninstall removes hooks only; it does not restore an old configuration over newer edits.

Manual offline timing on **copies** of an existing legacy pair (no authentication or client startup):

```sh
node scripts/agents/measure-sync.js /path/to/session-sync-state/pairs.json
```

This creates temporary isolated homes, copies only the paired transcripts, imports the old event ledger, reports initial rebuild and repeated CLI hook timings, then removes its temporary tree. Eligibility is prevalidated for offline copies, so the initial CIM/ps probe is excluded; Node startup is included in repeated timings.

Codex mirrors use `thread/start` (persistent, canonical cwd), `thread/inject_items` and `thread/name/set`; the server supplies the ID/path and owns SQLite/model-history writes. In 0.166, injection has no user event and metadata/update cannot set preview: a temporary **paused** goal, immediately cleared, publishes native preview without a turn or model-context duplication. The SQLite picker filters nonempty preview; `vscode` is interactive. Goals must be available; otherwise creation is deferred and logged, without enabling features or falling back to synthetic rollouts. Interrupted creation retries the same thread. To replace a legacy file mirror, close both clients and run `node scripts/agents/recreate-mirror.js "<pairs.json>" "<pair-id>" --apply` (omit `--apply` for a plan); originals are backed up and the next source hook creates the native mirror.

Mirror titles follow the source custom title/summary/first prompt (`<title> ? Claude/Codex`) and update only on changes. Creation has a 27-second deadline, injection up to 20 seconds, and generated hooks/leases allow 30 seconds (re-run the sync installer yourself to update already-installed timeouts). No sandbox, approval or permissions override is sent at thread/start. Existing saved read-only policies survive resume; `node scripts/agents/reset-mirror-settings.js <thread-id> --apply` restores project defaults through an ephemeral probe and thread/settings/update.

Visible imported history is separate from model history: the new Codex thread is archived/unloaded, its proxy closed, UI-only legacy events and canonical ItemCompleted entries appended atomically with paginated ordinals, then unarchived. Claude gets native completed tool_use/tool_result pairs with matching IDs and source model labels. Live arrivals still use additionalContext: there is no history-only visible insertion API; editing a loaded rollout is unsafe. A future visible-arrival mode should queue UI records until a confirmed unload/resume. Ctx and quotas are supplied by native model turns, never fabricated from the import.

Manual UI demo: `node scripts/agents/demo-sync.js`. It creates both directions in retained temporary homes, uses dedicated stdio app-servers and a loopback-only provider, copies no auth, verifies native Codex resume items, and prints launch commands for both clients. No real model replies or account quotas are available in this isolated demo.

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
