# Session sync and agent broker: internals

User-facing overview: [README](../README.md#agent-broker-and-session-sync-experimental). Русская версия: [sync.RU.md](sync.RU.md).

## App-server access

Sync and the broker use `codex app-server proxy`. Originator is process-global in Codex 0.166, so `initialize` cannot isolate it; sync registries and managed checkpoints protect mirrors from both archive paths across default/env/explicit Claude profiles (`--claude-config-dir DIR` is repeatable, corrupt registries fail closed). Proxy only connects to an existing socket; if needed, start the daemon with `codex app-server daemon start`.

## Hooks and eligibility

Only `SessionStart`, `UserPromptSubmit` and `Stop` are used: the first two deliver pending context, Stop captures completed work. There is no per-tool process scan. CLI eligibility is reused while its process identity is unchanged; the initial Windows CIM / Unix ps check can be slower. Broker agents (`SESSION_SYNC_BROKER`), `SESSION_SYNC_EXCLUDE`, noninteractive exec/print sessions and subagents/sidechains are excluded. Codex requires a CLI build supporting these experimental hooks and `additionalContext`.

Shared-daemon Codex CLI sessions can have `source=vscode` and an inherited `originator`; an explicit per-thread `thread_source=user` identifies user sessions without probing the daemon's process ancestry. New broker threads use `threadSource=agent-kit-broker` and remain excluded. Unmarked legacy CLI sessions still require the interactive process check.

## Context budget and delivery

A Claude session launched in an umbrella directory keeps the same pair while moving between child repositories. The hook resolves the launch directory from the Claude transcript's project folder.

If Codex compresses a managed mirror to `.jsonl.zst` and the plain transcript is gone, the next Claude hook creates a new Codex mirror from Claude's bounded current context and updates the pair. The old thread, compressed transcript and a checkpoint backup remain intact. Original Codex sessions are not replaced, and a missing transcript without a compressed copy still fails closed.

When exporting Codex to Claude, seeds and snapshots include all conversation messages from the latest compact, in order. Recent messages follow if they fit the remaining budget. If the compact alone exceeds the budget, the export contains the compact and marks the omitted tail. For Claude sources, sync keeps the latest compact summary and a bounded tail. The default budget is about 50k tokens (UTF-8 bytes / 4), configurable with `SESSION_SYNC_CONTEXT_TOKENS`.

Claude receives the export as one hook response and saves large responses to a file. Codex's `additionalContextLimit` is approximate tokens (`ceil(UTF-8 bytes / 4)`): our 16000 means 64000 bytes, default 2500, 0 unlimited; no explicit maximum beyond `usize`. Codex receives snapshots and large events in sequential acknowledged chunks, each marked at the start. Busy locks exit silently and expire after 30 seconds; unchanged checkpoints are not rewritten, event keys are bounded to 256, and denied decisions to 128 entries / seven days. CLI PID/start-time checks reuse eligibility across SessionStart; Windows uses local WSH/WMI for identity, falling back to full CIM if unavailable. Claude mirror versions use transcripts or a cached `--version` query; Codex writes its own metadata.

## What is transferred

User/assistant text and completed tool inputs/results, attributed to their source; nothing is executed. Thinking, images, attachments, encrypted compaction data and unfinished tool results are omitted. Sync reads no credentials and starts no model turn; Codex mirror creation uses the local app-server API. Transferred text can still contain private data from conversations and tools. Rollbacks, invalid records, unknown mirrors and paths outside configured roots fail closed.

Imported Claude records carry `session_sync_key` to prevent native tool/shell history from echoing back. Updates to open sessions use additionalContext.

Imported tools render natively where their recorded data is sufficient: Claude Bash becomes Codex CommandExecution (Ran), edits become FileChange diffs, and Read/Grep/Glob/LS use exploration actions (Explored). Codex exec/shell becomes Claude Bash; apply_patch add/update operations become paired Write/Edit calls. Other tools, incomplete commands and unsupported delete/move patches remain short observations. Edit diff line numbers are relative to the supplied fragments; unknown exit codes/durations are omitted. These Codex UI events are ignored by model-history reconstruction, so injected context is not repeated. All unknown/nonportable tools share a bounded assistant-summary fallback that never copies raw outputs. Todo/plan and web operations use native counterparts where sufficient data exists; foreign MCP/agent identities and live actions are never fabricated.

### User-message and runtime markup

| Record / marker | Handling |
| --- | --- |
| Claude bash-input → bash-stdout/bash-stderr | Pair by parent UUID across incremental hooks; emit native Codex CommandExecution with source `user_shell` (“You ran”). Preserve bounded stdout/stderr; do not invent exit codes. |
| Codex user_shell_command / shell.user_command | Import its command/result once, ignoring duplicate UI events; render linked native Claude bash-mode records. Codex's combined output is not guessed into separate streams. |
| Shell model-context archive/delivery | Bounded `User ran: … / Output: …`, without XML wrappers. Claude native resume uses its normal bash-mode representation. |
| Pending/orphan shell records | Hold input until output; discard orphan or mismatched-parent output. |
| command-name/message/args, local-command-stdout/caveat | Drop slash-command machinery, preserving neighboring genuine text. |
| user-memory-input | Drop local memory operations; never replay memory writes. |
| system-reminder, task-notification, agent-message | Drop nonhuman origins and nested/unfinished service blocks. |
| Codex environment_context, user_instructions, AGENTS.md instructions | Drop metadata-classified environment/project context. |
| hook_prompt/additional_context, turn_aborted, subagent_notification, codex_internal_context, goal_context | Drop service context by per-block metadata and markers. |
| Standalone Codex skill fragment | Drop injected skill instructions. |
| persisted-output inside shell output | Unwrap bounded preview; do not read referenced files. |
| Arbitrary HTML/XML/TypeScript in real user input | Preserve as data, rather than stripping all tags. |

## Codex mirrors

Codex mirrors use `thread/start` (persistent, canonical cwd), `thread/inject_items` and `thread/name/set`; the server supplies the ID/path and owns SQLite/model-history writes. In 0.166, injection has no user event and metadata/update cannot set preview: a temporary **paused** goal, immediately cleared, publishes native preview without a turn or model-context duplication. The SQLite picker filters nonempty preview; `vscode` is interactive. Goals must be available; otherwise creation is deferred and logged, without enabling features or falling back to synthetic rollouts. Interrupted creation retries the same thread.

Mirror titles follow the source custom title/summary/first prompt (`<title> · Claude/Codex`) and update only on changes. Creation has a 27-second deadline, injection up to 20 seconds, and generated hooks/leases allow 30 seconds (re-run the sync installer yourself to update already-installed timeouts). No sandbox, approval or permissions override is sent at thread/start. Existing saved read-only policies survive resume; `node scripts/agents/reset-mirror-settings.js <thread-id> --apply` restores project defaults through an ephemeral probe and thread/settings/update.

Visible imported history is separate from model history: the new Codex thread is archived/unloaded, its proxy closed, UI-only legacy events and canonical ItemCompleted entries appended atomically with paginated ordinals, then unarchived. Claude gets native completed tool_use/tool_result pairs with matching IDs and source model labels. Live arrivals still use additionalContext: there is no history-only visible insertion API, and editing a loaded rollout is unsafe. Ctx and quotas come from native model turns, never from the import.

To replace a mirror, close both clients and run `node scripts/agents/recreate-mirror.js "<pairs.json>" "<pair-id>" --apply` (omit `--apply` for a plan); originals are backed up and the next source hook creates a new mirror.

## State

Archives live under `CLAUDE_CONFIG_DIR/agent-kit/sync/<cwd-hash>/`: append-only `.events` files plus per-pair checkpoints with byte offsets, keys and pending references; `pairs.json` contains IDs only. Keep state with its mirrors. Installation/removal is idempotent, backs up changed existing settings, and preserves unrelated hooks, subsequent configuration edits, session files and archives. Uninstall removes hooks only; it does not restore an old configuration over newer edits.

If two Claude profiles share `projects` through a symlink or junction, a verified mirror can resume using the registry next to the physical `projects` directory. Pairs already registered in the current profile take priority.

## Broker archiving

Codex brokers archive their thread on `/exit`, idle timeout or graceful shutdown, unarchive before resume, and keep failed turns open. `node scripts/agents/archive-broker-sessions.js [--minutes 60] [--state DIR] [--apply]` defaults to a read-only list of old idle broker sessions.

## Manual checks

None of these are part of `npm test`.

- `node scripts/agents/demo-sync.js`: creates both directions in retained temporary homes, uses dedicated stdio app-servers and a loopback-only provider, copies no auth, verifies native Codex resume items and prints launch commands for both clients. No real model replies or quotas.
- `node scripts/agents/audit-mirror.js --claude "<transcript.jsonl>" [--codex-home DIR] [--count 3] [--json]`: read-only; exercises extraction and the presentation renderers on related interactive non-broker rollouts and prints categories/counts/display examples without conversation bodies or tool arguments. RAW, service text as a user message, or insufficient Codex samples exit 1.
- `node scripts/agents/measure-sync.js /path/to/session-sync-state/pairs.json`: offline timing on **copies** of a legacy pair in temporary isolated homes; reports initial rebuild and repeated hook timings, then removes its temporary tree.
- `node scripts/agents/smoke-live.js --live`: real daemon/model smoke; requests exactly `pong`, sends `/exit`, verifies `state.archived=true` and SQLite `archived=1` read-only; artifacts are retained. Without `--live` it does nothing. The SQLite check requires Node 22.13+; the broker itself supports Node 20.

## WSL and existing session pairs

Claude Code runs natively in WSL. Codex, the sync engine and broker workers run on Windows. The example below uses `Z:\example` and `/mnt/z/example` for the same project and `Z:\agent-kit` for the agent-kit checkout. Adjust the paths to match your installation.

### Check the path and interop

Run these checks from the shell that will launch Claude.

```bash
cd /mnt/z/example
python3 --version
wslpath -w "$PWD"
export AGENT_KIT_WINDOWS_NODE="$(wslpath -u 'C:\Program Files\nodejs\node.exe')"
"$AGENT_KIT_WINDOWS_NODE" --version
```

The project path should resolve to `Z:\example`. If Windows Node is installed elsewhere, get its path in PowerShell with `(Get-Command node.exe).Source`. If `node.exe` fails with `Exec format error`, check WSL interoperability before debugging the sync hook. Run the same checks inside `ganet-enter` if Claude will use GoodAccess.

### Keep the history and install the hooks

1. Keep the Windows Claude profile that owns the existing pair registry. Its `agent-kit/sync` directory contains the pair IDs and reading positions.
2. Point the Linux profile at the existing project transcript directory. Claude resolves that directory from its launch path, so the Linux directory name may differ from the Windows name. For a separate WSL profile, a link can look like this:

   ```bash
   export CLAUDE_CONFIG_DIR="$HOME/.claude-work"
   export SESSION_SYNC_WINDOWS_CLAUDE_DIR=/mnt/z/example/.claude-work
   export CLAUDE_CODE_TMPDIR="$SESSION_SYNC_WINDOWS_CLAUDE_DIR/wsl-tmp"

   mkdir -p "$CLAUDE_CONFIG_DIR/projects" "$CLAUDE_CODE_TMPDIR"
   ln -sT "$SESSION_SYNC_WINDOWS_CLAUDE_DIR/projects/z--example" \
     "$CLAUDE_CONFIG_DIR/projects/-mnt-z-example"
   ```

   Use the names from your existing Windows history and the Linux Claude launch. If the Linux project directory already holds sessions, inspect it before adding the link. Keep Linux MCP commands and authentication in the Linux profile. If you share the whole profile, point `CLAUDE_CONFIG_DIR` at `SESSION_SYNC_WINDOWS_CLAUDE_DIR` in WSL and place any needed project link inside its `projects` directory.
3. Keep the Windows Codex hooks installed. For a shared `settings.json`, run `node scripts/agents/sync.js install --wsl` from the Windows checkout with the intended Windows `CLAUDE_CONFIG_DIR`. With a separate Linux profile, generate the hook groups from Windows and merge the `hooks` object into the Linux profile's `settings.json`:

   ```powershell
   node -e "const p=require('node:path'); const s=require('./src/sync'); console.log(JSON.stringify(s.hookConfigs(p.resolve('scripts/agents/sync.js'), {wsl:true}).claude, null, 2))"
   ```

   The sync hooks run on SessionStart, UserPromptSubmit and Stop. They translate the WSL paths before calling the existing Windows sync engine. If the hooks cannot reach Codex's local app-server, start it from Windows with `codex app-server daemon start`.
4. If Windows Codex needs a nondefault Claude profile, add its project entry to `CODEX_HOME/agent-kit/sync-profiles.json`. `CODEX_HOME` defaults to `%USERPROFILE%\.codex`. An explicit Windows `CLAUDE_CONFIG_DIR` takes precedence.

   ```json
   {
     "Z:\\example": "Z:\\example\\.claude-work"
   }
   ```

### Resume the same session

Close the Windows Claude instance that owns the conversation. From the original project directory in WSL, run `claude --resume` and select the same session. The Linux CLI opens the existing transcript and the sync engine reuses the existing pair. Normal Claude context limits still apply.

With GoodAccess, launch the native CLI inside `ganet-enter`. Run this after exporting the profile paths and the Windows Node path from the previous steps.

```bash
sudo -n --preserve-env=WSL_INTEROP /usr/local/sbin/ganet-enter \
  /usr/bin/env TZ=Europe/Warsaw PATH="$PATH" \
  CLAUDE_CONFIG_DIR="$CLAUDE_CONFIG_DIR" \
  SESSION_SYNC_WINDOWS_CLAUDE_DIR="$SESSION_SYNC_WINDOWS_CLAUDE_DIR" \
  CLAUDE_CODE_TMPDIR="$CLAUDE_CODE_TMPDIR" \
  AGENT_KIT_WINDOWS_NODE="$AGENT_KIT_WINDOWS_NODE" \
  "$HOME/.local/bin/claude" --resume
```

A local Windows launcher can dispatch the work folder to WSL and open the picker. In the tested setup, `%USERPROFILE%\.claude\bin\claude-start.cmd` takes the project directory as its argument. The launcher is a local file.

```powershell
& "$env:USERPROFILE\.claude\bin\claude-start.cmd" 'Z:\example'
```

### Use the Windows broker from WSL

Run `bash /mnt/z/agent-kit/scripts/agents/broker-wsl.sh` with the usual broker arguments. It uses `AGENT_KIT_WINDOWS_NODE` and translates paths supplied to options such as `--cwd`, `--state`, and `--prompt`. Use the session scratchpad under the shared `CLAUDE_CODE_TMPDIR` for `--state`. Windows workers use the Windows network.

For automatic notifications, use the [standard mesh hook events](../scripts/agents/README.md#launch-resume-and-result-delivery) in the Linux Claude profile. Set each mesh hook's `shell` to `bash` and use the following as its `command`. Keep `asyncRewake` on SessionStart, PostToolUse and Stop, and keep SessionEnd synchronous.

```bash
export AGENT_KIT_WSL_BROKER=1
export AGENT_KIT_CLAUDE_UID="$(id -u)"
export AGENT_KIT_CLAUDE_PROJECT_DIR="$CLAUDE_PROJECT_DIR"
export WSLENV="$WSLENV:CLAUDE_CODE_TMPDIR/pw:AGENT_KIT_WSL_BROKER/w:AGENT_KIT_CLAUDE_UID/w:AGENT_KIT_CLAUDE_PROJECT_DIR/w"
exec "$AGENT_KIT_WINDOWS_NODE" \
  "$(wslpath -w /mnt/z/agent-kit/scripts/agents/mesh-hook.js)"
```

Use `events --next` through the wrapper when the automatic receiver is absent. The automatic hook and a manual waiter both consume events from the same scratchpad, so use one receiver per session.

### Verify the move

- Resume an existing pair and exchange one message in each direction. Confirm the same pair ID, the same transcript and advancing read positions. Then change into a child repository within the Claude session and check that it still uses the original pair.
- If the picker is empty, check the launch directory and the project transcript link first. If a hook reports `Orphan mirror`, check which profile owns the pair and which one the hook selected.
- Verify broker delivery with a completed turn. Claude should receive the completion and a usable report path while the worker is still running. Check MCP connectivity in the Linux profile with `claude mcp list`. A connected MCP server can still require a browser or a local service to perform its work.
