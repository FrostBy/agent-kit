# Agent broker

Run a persistent Codex, Kimi ACP or Claude stream-json worker:

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

Use `--agent codex|kimi|claude`. Executables come from PATH or `AGENT_BROKER_CODEX`, `AGENT_BROKER_KIMI`, `AGENT_BROKER_CLAUDE`. Kimi defaults to `kimi acp`; explicitly use `--kimi-print` for old installations without ACP. Print mode cannot handle questions, approvals or interrupt. Claude uses the permission host protocol without bypassing permissions. Codex's `--approval-policy` defaults to `never`; opt into `on-request` when needed.
Codex-only `--mode default|plan` defaults to `default`; `plan` enables agent questions while preserving the selected model/effort, and survives resurrection by `send`.

Kimi and Claude advertise `steer=false`: messages received during a turn wait for the next turn. `send` waits for completion; answers/decisions/interrupt/exit use an independent inbox route. `send/wait` ACK the completion they return; `send ... --text /exit` also ACKs its exit. Sparse cursor ACKs preserve unread questions. Brokers exit after `--idle-min 15`; `send` revives them from the saved session, without repeating the initial prompt.

Claude orchestrators can use `events --next` in a background tool or the opt-in [mesh hook](../../docs/agent-mesh.md). Codex orchestrators inherit `CODEX_THREAD_ID` when launching a broker on the same app-server daemon. The observer sends `turn/steer` with `expectedTurnId` while busy, or `turn/start` while idle, and never answers the owner's server requests. Embedded TUI sessions return an explicit unsupported-owner event. See the [AGENTS instruction snippet](../../templates/mesh-orchestrator.md).

Kimi terminal wake is unsupported. For a server-owned `kimi web` session, set `KIMI_SESSION_ID`, `AGENT_MESH_KIMI_URL`, and `AGENT_MESH_KIMI_TOKEN` if the server requires a bearer token. The broker POSTs `/api/v1/sessions/ID/prompts`; it never takes over a terminal session or stores the token in state. Configure the orchestrator's model before sending events. A successful POST is transport acceptance, not proof of a model reply.

Run `node scripts/agents/smoke-mesh.js --live` for opt-in real CLI tests with loopback providers and fresh isolated homes under `.native/mesh-*`. Optional `--only kimi|claude|codex|web|claude-kimi` selects a probe. No account credentials are copied. The temporary daemon is stopped after the test; artifacts and `results.json` remain for inspection. These checks cover protocols, not idle TUI rendering or real-provider behavior. Full status: [agent mesh matrix](../../docs/agent-mesh.md#матрица-оркестратор--агент).
