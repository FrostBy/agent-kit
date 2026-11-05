# Agent broker

Use native agents inside the current harness. Use this broker for work across different harnesses; a conversation migrated from another client does not by itself require a broker. This README owns the lifecycle instructions; project instructions should link here instead of maintaining copies.

Run a persistent Codex, Kimi ACP, OpenCode V2 ACP or Claude stream-json worker:

```sh
node scripts/agents/broker.js --agent kimi --name worker --state DIR --prompt task.md --cwd PROJECT
node scripts/agents/broker.js events --state DIR --next
node scripts/agents/broker.js answer --name worker --state DIR --request ID --text "A"
node scripts/agents/broker.js approve --name worker --state DIR --request ID
node scripts/agents/broker.js deny --name worker --state DIR --request ID
node scripts/agents/broker.js send --name worker --state DIR --text "Next task"
node scripts/agents/broker.js interrupt --name worker --state DIR
node scripts/agents/broker.js send --name worker --state DIR --text /exit
```

Use `--agent codex|kimi|opencode|claude`. Executables come from PATH, the global connector's `executable`, or `AGENT_BROKER_CODEX`, `AGENT_BROKER_KIMI`, `AGENT_BROKER_OPENCODE`, `AGENT_BROKER_CLAUDE` (environment overrides take precedence). Kimi defaults to `kimi acp`; explicitly use `--kimi-print` for old installations without ACP. Print mode cannot handle questions, approvals or interrupt. OpenCode uses its V2 ACP CLI, not a Codex model provider. Claude uses the permission host protocol without bypassing permissions. Codex's `--approval-policy` defaults to `never`; opt into `on-request` when needed.
Codex-only `--mode default|plan` defaults to `default`; `plan` enables agent questions while preserving the selected model/effort, and survives resurrection by `send`.

[Global and project model policies](../../docs/agent-models.md) select connector priority and allowed models, including umbrella directories above Git repositories. Pass `--model` whenever a model allowlist applies. Concrete model IDs and budget restrictions belong in those policies, not broker source. `--effort` overrides Codex reasoning for the worker without changing the client's global configuration.

Kimi, OpenCode and Claude advertise `steer=false`: messages received during a turn wait for the next turn. `send` waits for completion; answers/decisions/interrupt/exit use an independent inbox route. `send/wait` ACK the completion they return; `send ... --text /exit` also ACKs its exit. Sparse cursor ACKs preserve unread questions. Brokers exit after `--idle-min 15`; `send` revives them from the saved session, without repeating the initial prompt.

Claude orchestrators can use `events --next` in a background tool or the opt-in [mesh hook](../../docs/agent-mesh.md). On Windows, Codex orchestrators launch detached outside the sandbox with `require_escalated`: `Start-Process node -WindowStyle Hidden -ArgumentList '<repo>/scripts/agents/broker.js','--agent','codex','--name','NAME','--state','DIR','--prompt','FILE','--cwd','PROJECT'`, inheriting `CODEX_THREAD_ID` and using the same app-server daemon and CODEX_HOME. End the orchestrator turn to allow asynchronous wake only after verifying the owner route as described below; otherwise use the documented waiter. The observer sends `turn/steer` with `expectedTurnId` while busy, or `turn/start` while idle, and never answers the owner's server requests. Only an owner absent from `thread/loaded/list` gets embedded-TUI advice. See the [AGENTS instruction snippet](../../templates/mesh-orchestrator.md).

Kimi terminal wake is unsupported. For a server-owned `kimi web` session, set `KIMI_SESSION_ID`, `AGENT_MESH_KIMI_URL`, and `AGENT_MESH_KIMI_TOKEN` if the server requires a bearer token. The broker POSTs `/api/v1/sessions/ID/prompts`; it never takes over a terminal session or stores the token in state. Configure the orchestrator's model before sending events. A successful POST is transport acceptance, not proof of a model reply.

## Launch, resume and result delivery

1. Before launching or resuming, choose how this orchestrator will receive completion, questions and errors: a supported owner/event route or a host-managed waiter. A detached process, a log file or `status: running` does not establish delivery or prove current progress.
2. After startup, inspect `NAME.state.json`: `orchestrator` must identify the current orchestrator and a supported delivery route. `owner` alone is not a route. Codex owner wake requires that thread to be loaded on the same daemon and CODEX_HOME; Claude requires its event waiter or explicitly installed hook. Do not assume a hook exists because another harness used one. Local `events.jsonl` output proves event recording, not receipt by the orchestrator.
3. **Resume preserves the old route.** `--resume` retains saved `state.orchestrator`, including `null` or another orchestrator's ID. Setting `CODEX_THREAD_ID` in the new shell does not rebind it. `send` resurrection also uses `--resume`. Check the route again after a pause, harness change or process restart; do not silently edit state to claim another owner. If the saved route does not reach this orchestrator, use native agents or the waiter below.
4. **Without verified automatic delivery, keep a waiter attached to the task.** `send` sends a follow-up and waits for its completion; `wait` waits for a completion after it starts. Use the host's supported background tool with completion notification, or keep its tool session awaited and report meaningful progress. Do not launch a detached waiter and assume its output will wake the orchestrator. The completion waiter does not surface pending questions or approvals; use the supported event receiver for those and route decisions through answer/approve/deny. If using `events --next`, handle questions/errors and continue receiving events until the target completion; do not start a second reader for a directory already watched by a hook.
5. If the target turn already completed before the waiter started, read its matching `lastCompletionEvent`, `events.jsonl` and `NAME.out.md` directly. `wait` records the current `turns` as its baseline, so starting it after completion waits for the next turn. A dead broker or waiter timeout is a failed wait, not successful completion.
6. On completion, read the full report, check its scope and evidence, and report the result or concrete blocker to the user. Remaining authorized work is not complete merely because the agent ended its turn. Handle pending questions/approvals through their commands, and distinguish an interrupted/idle/exited worker from a completed task. Do not leave the user to discover completion by asking for status.

For a running turn or an ordinary follow-up:

```sh
node scripts/agents/broker.js wait --name worker --state DIR --timeout-min 120
node scripts/agents/broker.js send --name worker --state DIR --text "Continue the authorized task" --timeout-min 120
```

Choose the command that matches the task; do not run both for the same completion. `send/wait` ACK the completion they print. Preserve that event identity so it is not processed twice.

Run `node scripts/agents/smoke-mesh.js --live` for opt-in real CLI tests with loopback providers and fresh isolated homes under `.native/mesh-*`. Optional `--only kimi|claude|codex|web|claude-kimi` selects a probe. No account credentials are copied. The temporary daemon is stopped after the test; artifacts and `results.json` remain for inspection. These checks cover protocols, not idle TUI rendering or real-provider behavior. Full status: [agent mesh matrix](../../docs/agent-mesh.md#матрица-оркестратор--агент).
