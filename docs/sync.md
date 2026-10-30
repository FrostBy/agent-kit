# Session sync and agent broker: internals

User-facing overview: [README](../README.md#agent-broker-and-session-sync-experimental). Русская версия: [sync.RU.md](sync.RU.md).

## App-server access

Sync and the broker use `codex app-server proxy`. Originator is process-global in Codex 0.166, so `initialize` cannot isolate it; sync registries and managed checkpoints protect mirrors from both archive paths across default/env/explicit Claude profiles (`--claude-config-dir DIR` is repeatable, corrupt registries fail closed). Proxy only connects to an existing socket; if needed, start the daemon with `codex app-server daemon start`.

## Hooks and eligibility

Only `SessionStart`, `UserPromptSubmit` and `Stop` are used: the first two deliver pending context, Stop captures completed work. There is no per-tool process scan. CLI eligibility is reused while its process identity is unchanged; the initial Windows CIM / Unix ps check can be slower. Broker agents (`SESSION_SYNC_BROKER`), `SESSION_SYNC_EXCLUDE`, noninteractive exec/print sessions and subagents/sidechains are excluded. Codex requires a CLI build supporting these experimental hooks and `additionalContext`.

## Context budget and delivery

Seeds and backlog replacements use the latest compact summary plus the bounded recent context; without compaction, omitted earlier history is labeled. The default budget is about 50k tokens (UTF-8 bytes / 4), configurable with `SESSION_SYNC_CONTEXT_TOKENS`; compaction or an oversized pending backlog replaces that backlog with current context.

Hook delivery is separate from the seed budget: Claude has a [10,000-character cap](https://code.claude.com/docs/en/hooks#json-output), so sync conservatively uses 10,000 UTF-8 bytes. Codex's `additionalContextLimit` is approximate tokens (`ceil(UTF-8 bytes / 4)`): our 16000 means 64000 bytes, default 2500, 0 unlimited; no explicit maximum beyond `usize`. Snapshots and large events are sent in sequential acknowledged chunks, each marked at the start. Busy locks exit silently and expire after 30 seconds; unchanged checkpoints are not rewritten, event keys are bounded to 256, and denied decisions to 128 entries / seven days. CLI PID/start-time checks reuse eligibility across SessionStart; Windows uses local WSH/WMI for identity, falling back to full CIM if unavailable. Claude mirror versions use transcripts or a cached `--version` query; Codex writes its own metadata.

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

## Broker archiving

Codex brokers archive their thread on `/exit`, idle timeout or graceful shutdown, unarchive before resume, and keep failed turns open. `node scripts/agents/archive-broker-sessions.js [--minutes 60] [--state DIR] [--apply]` defaults to a read-only list of old idle broker sessions.

## Manual checks

None of these are part of `npm test`.

- `node scripts/agents/demo-sync.js`: creates both directions in retained temporary homes, uses dedicated stdio app-servers and a loopback-only provider, copies no auth, verifies native Codex resume items and prints launch commands for both clients. No real model replies or quotas.
- `node scripts/agents/audit-mirror.js --claude "<transcript.jsonl>" [--codex-home DIR] [--count 3] [--json]`: read-only; exercises extraction and the presentation renderers on related interactive non-broker rollouts and prints categories/counts/display examples without conversation bodies or tool arguments. RAW, service text as a user message, or insufficient Codex samples exit 1.
- `node scripts/agents/measure-sync.js /path/to/session-sync-state/pairs.json`: offline timing on **copies** of a legacy pair in temporary isolated homes; reports initial rebuild and repeated hook timings, then removes its temporary tree.
- `node scripts/agents/smoke-live.js --live`: real daemon/model smoke; requests exactly `pong`, sends `/exit`, verifies `state.archived=true` and SQLite `archived=1` read-only; artifacts are retained. Without `--live` it does nothing. The SQLite check requires Node 22.13+; the broker itself supports Node 20.
