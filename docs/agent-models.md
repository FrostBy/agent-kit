# Broker model policy

The broker reads `~/.config/agent-kit/agents.json`, then applies every `.agent-kit/agents.json` from the filesystem root down to the current directory, including policies above repository boundaries. It skips the home directory project policy. Each level may disable connectors, narrow model lists and set priority; attempts to expand permissions have no effect. Project `executable` values are ignored.

```json
{"priority":["codex","kimi","opencode"],"connectors":{"opencode":{"enabled":true,"models":["<provider>/<model-id>"]}}}
```

When a connector has a `models` list, pass an allowed model explicitly; an empty list blocks all models. OpenCode additionally requires a nonempty global allowlist. Start it with `--agent opencode --model <provider>/<model-id>`. The broker uses the OpenCode CLI; `AGENT_BROKER_OPENCODE` overrides its executable. Policy files contain no credentials.

The broker rechecks policy for new `send` messages and before executing a turn or steering an active Codex turn, including queued inbox messages. A new restriction does not interrupt work already running; `/interrupt` and `/exit` remain available to stop a live worker. Legacy Kimi print mode omits `-m` when no model was selected, preserving the Kimi client's own default.

Selection follows priority without detecting subscriptions or automatically falling back after an error.

The global connector can set `executable` to a native binary path, useful for npm-installed CLIs on Windows. Project policies cannot change executables. An explicit `AGENT_BROKER_OPENCODE` environment override takes precedence. OpenCode uses the V2 ACP protocol; no Console provider or API key is added to Codex.
