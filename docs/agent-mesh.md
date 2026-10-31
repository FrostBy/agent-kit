# Интерактивная сеть агентов agent-kit

Обновлено 31 октября 2026. Реализованы Codex app-server, Kimi ACP и Claude stream-json агенты, доставка оркестратору через Codex daemon и Kimi web. Live-прогоны: Kimi 2.3.2, Claude 2.1.316, Codex 0.166.0, временные home/config и loopback provider, без реальных аккаунтов. Автономный Claude idle wake и отображение в TUI остаются отдельной приёмкой. Ниже текущая инструкция и матрица; исходное исследование сохранено как историческое.

## Текущие адаптеры и проверки

- `--agent kimi` запускает один `kimi acp`: initialize, session/new либо session/load по сохранённому sessionId, session/prompt и session/update. Завершение prompt RPC создаёт turn.completed. Session/request_permission и elicitation/create удерживаются до answer/approve/deny; approve выбирает только allow_once. Interrupt отправляет session/cancel, exit вызывает session/close. Старый режим выбирается явно через `--kimi-print`, без скрытого fallback после ошибки или auth_required.
- `--agent claude` использует `claude -p --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio`. Initialize/control requests, can_use_tool и AskUserQuestion обслуживаются теми же командами. Session_id сохраняется, воскрешение использует --resume. Result оставляет stdin открытым. Interrupt идёт control request, exit закрывает процесс; bypass permissions не используется.
- Оба адаптера объявляют `steer=false`: busy send записывается в log как следующий ход. Control-команды обрабатываются независимо от очереди prompt. Неподдержанные возможности print-режима дают ошибку.
- Если команда запуска унаследовала `CODEX_THREAD_ID`, брокер сохраняет `state.orchestrator={agent:"codex",id:...}`. Отдельный observer подключается через app-server proxy, проверяет thread/loaded/list, подписывается через thread/resume без смены настроек и отправляет turn/steer с expectedTurnId либо turn/start. На server requests оркестратора он не отвечает. Отсутствующий на daemon owner даёт error с инструкцией запустить TUI на общем daemon через `codex --remote`. Embedded TUI по одному ID не подключается.
- Kimi terminal wake невозможен выбранным штатным путём. Для server-owned сессии задаются `KIMI_SESSION_ID`, `AGENT_MESH_KIMI_URL`, при необходимости `AGENT_MESH_KIMI_TOKEN`. GET session и `/api/v2/sessions` проверяют, что owner уже живёт в этом сервере и имеет `activity.model`; холодная/terminal сессия не усыновляется. Затем события уходят POST `/api/v1/sessions/ID/prompts`; terminal lock/неизвестная сессия дают ошибку, takeover не вызывается. Token не сохраняется в state. В Kimi 2.3.2 новой web-сессии требуется назначить модель через POST profile, даже при наличии default_model в config.
- `send/wait` подтверждают точный turn.completed, который они напечатали; `send --text /exit` также подтверждает соответствующий agent.exited и завершается без нового хода. Разреженные ACK находятся в `cursor.delivered`, не скрывают более ранние вопросы или события соседей. ACK доступен при работающем waiter; вложенный брокер подтверждает также активный курсор родительской scratchpad. Состояние записывается атомарно.

Короткие команды: [README брокера](../scripts/agents/README.md). Инструкция для Codex-оркестратора: [AGENTS snippet](../templates/mesh-orchestrator.md). Глобальные инструкции и профили автоматически не устанавливаются.

ID владельца сохраняется также в совместимом поле `state.owner`; `state.orchestrator` хранит тип и маршрут доставки.

Live: `node scripts/agents/smoke-mesh.js --live`, либо `--only kimi|claude|codex|web|claude-kimi`. При необходимости задайте AGENT_BROKER_CODEX/KIMI/CLAUDE абсолютными путями. Launcher использует allowlist окружения, свои home/config под `.native/mesh-*`, фальшивые ключи и loopback HTTP provider. Артефакты и results.json сохраняются. Короткий путь нужен Windows daemon из-за SUN_LEN сокета. `npm.cmd test` выполняет npm test без заблокированного PowerShell npm.ps1.

Проверено живыми CLI: Kimi ACP question→answer, approval→deny/approve (отклонённая команда не исполняется, одобренная исполняется), cancel, close/load и воскрешение; Claude question→answer, deny, interrupt, несколько ходов и --resume; настоящий Claude Bash вызывает answer/deny/approve брокера для Kimi; настоящий Codex-брокер наследует CODEX_THREAD_ID и его completion запускает ход владельца на изолированном daemon; Kimi web POST события запускает модель и возвращает ответ. Детерминированный loopback проверяет транспорт, а не качество реальной модели.

Не проверены живым TUI: Claude final→idle→asyncRewake→самостоятельный ответ, сохранность набираемого текста Codex, одновременный Enter/review/compact, reconnect владельца и все девять пар целиком. Для этого нужны интерактивные TUI; launcher headless. Fake-тесты покрывают busy/idle routing, passive server requests, stale IDs и ACK. Embedded Codex и Kimi terminal помечены X и не заменены другим способом ввода.

## Подключение итераций 1–2

`scripts/agents/broker.js` сохраняет прежние текстовый inbox, `send` и `wait`. Codex server requests обслуживаются через `onRequest(msg)` и `respond(id, result)`; для ошибки передайте `{code, message}` вторым аргументом (либо `undefined, error`). Без callback транспорт по-прежнему отвечает `-32601`. Sync/archive используют прежний контракт.

Брокер пишет `<name>.events.jsonl` с конвертом `v/id/seq/at/from/type/turnId/requestId/summary/payload`. Типы: `question`, `approval`, `turn.completed`, `error`, `agent.exited`, `request.resolved`. Итог ограничен 320 символами, полный текст остаётся в `.out.md`. Успешная запись команды в inbox означает только постановку; ошибки ответа приходят событием `error` с `commandId`. Pending ID непрозрачный, не JSON-RPC ID; разрешённый ответ уходит в исходное соединение. Завершение хода, interrupt, server resolution, disconnect и restart инвалидируют прежние ID. Повторный server request в том же соединении не создаёт второй вопрос. `isBlocking` и полные вопросы/options остаются в payload; nonblocking request может разрешиться самим сервером.

```sh
node scripts/agents/broker.js --agent codex --name worker --state SCRATCHPAD --prompt task.md --cwd PROJECT --approval-policy on-request
node scripts/agents/broker.js events --state SCRATCHPAD --next --timeout-min 120
node scripts/agents/broker.js answer --name worker --state SCRATCHPAD --request REQUEST_ID --text "answer"
node scripts/agents/broker.js answer --name worker --state SCRATCHPAD --request REQUEST_ID --file answers.json
node scripts/agents/broker.js approve --name worker --state SCRATCHPAD --request REQUEST_ID
node scripts/agents/broker.js deny --name worker --state SCRATCHPAD --request REQUEST_ID
node scripts/agents/broker.js interrupt --name worker --state SCRATCHPAD
node scripts/agents/broker.js exit --name worker --state SCRATCHPAD
```

Default approval policy остаётся `never`; поддержаны также `on-request`, `on-failure`, `untrusted`. `--text` предназначен для одного вопроса; JSON-файл: `{"answers":{"question-id":{"answers":["option label or text"]}}}`. Требуются все question IDs. Command/file approval возвращает `accept`/`decline` с проверкой `availableDecisions`; permissions approval возвращает запрошенные permissions либо `{}` со scope `turn`. Ответы и управление идут отдельным маршрутом, даже если `turn/start`/`turn/steer` ещё ждёт RPC ACK.

`events --next` читает DIR и одну вложенную папку, ждёт первое актуальное важное событие, печатает краткий итог и команду ответа. Exit 0 означает событие, 1 — timeout/ошибка. Один ожидатель на DIR защищён `.mesh-events.lock`, завершившийся владелец lock восстанавливается по PID. `.mesh-events.cursor.json` автоматически подтверждает событие при выдаче; `ack --state DIR --event EVENT_ID` доступен и идемпотентен. Не запускайте ручной waiter одновременно с hook для той же DIR. Cursor обновляется перед печатью: авария в этом промежутке может потерять уведомление, исходный JSONL сохраняется. Это не exactly-once доставка модели.

Установка/удаление после ревью (в этой реализации на реальном профиле **не запускались**):

```sh
node scripts/agents/mesh-hook.js install
node scripts/agents/mesh-hook.js uninstall
```

Установщик использует только `CLAUDE_CONFIG_DIR/settings.json` (по умолчанию `~/.claude/settings.json`), сохраняет backup перед изменением, не переписывает файл при повторной установке, сохраняет сторонние hooks и удаляет только собственный точный command/args. Для установки вручную добавьте в существующий `hooks` обе группы (путь ниже соответствует этому checkout):

```json
{
  "hooks": {
    "SessionStart": [{"hooks": [{"type": "command", "command": "node", "args": ["Z:/claude-statusline/scripts/agents/mesh-hook.js"], "asyncRewake": true, "timeout": 14400}]}],
    "Stop": [{"hooks": [{"type": "command", "command": "node", "args": ["Z:/claude-statusline/scripts/agents/mesh-hook.js"], "asyncRewake": true, "timeout": 14400}]}],
    "SessionEnd": [{"hooks": [{"type": "command", "command": "node", "args": ["Z:/claude-statusline/scripts/agents/mesh-hook.js"], "timeout": 5}]}]
  }
}
```

Hook читает `session_id`, `transcript_path`, `cwd` из stdin и вычисляет `<os.tmpdir()>/claude/<project-slug>/<session_id>/scratchpad`. Slug из transcript имеет приоритет (в том числе регистр диска); fallback использует существующий project slug helper. `--state` брокера должен указывать на эту scratchpad либо её подпапку. Subagent/broker sessions пропускаются. Событие подтверждается курсором, затем короткий текст пишется в stderr и hook выходит 2; SessionStart/Stop делят тот же lock. Stop после обработки снова ставит ожидатель; `stop_hook_active` не отключает вооружение, поскольку это фоновый hook.

По [актуальной документации Claude hooks](https://code.claude.com/docs/en/hooks#run-hooks-in-the-background), `asyncRewake` запускается в фоне, будит idle Claude на exit 2 и передаёт stderr (либо stdout, если stderr пуст). Его timeout **действует**, в отличие от `async: true`. Документация указывает default 600 секунд для command hooks и не задаёт отдельный максимум для asyncRewake. Здесь timeout — 14400 секунд, внутреннее ожидание — 235 минут с запасом 5 минут. Если при запуске в scratchpad нет живого брокера, hook сразу выходит 0 без ожидателя; следующий Stop перевооружит его. Без события служебное пробуждение возможно только после 235 минут ожидания, если брокер ещё жив, для перевооружения через Stop. Запущенный async hook завершается вместе с `claude -p`; не использовать этот режим для постоянного idle waiter.

Проверено: `node --test test/agent-broker.test.js test/agent-mesh.test.js` с fake proxy/stdio, временными scratchpad/settings и без настоящих аккаунтов. Live-приёмка: Claude final → idle → Codex question → answer → completion; approval → deny; два события подряд; timeout → Stop → новый event; concurrent user Enter. `request_user_input` должен быть доступен в режиме агента (см. ниже ограничение Plan). SIGKILL самого брокера всё ещё требует supervisor из итерации 6 и не создаёт `agent.exited` из погибшего процесса.

## Решение

Оставить существующий брокер владельцем процессов и сессий агентов. Добавить типизированные события и ответы на незавершённые запросы; доставку модели оркестратора сделать отдельным адаптером. Способ запуска агента и способ пробуждения оркестратора независимы.

Полная симметрия в произвольных уже открытых CLI сейчас не подтверждается. Claude Code предоставляет штатные способы пробуждения. Codex 0.166 допускает внешнее управление через **тот app-server, к которому подключён TUI**. Для Kimi необходимо различать прежний Python `kimi-cli` и новый Node.js `kimi-code`: у них разные протоколы и возможности. Один ID сессии не соединяет два работающих процесса.

«Доставлено» имеет три разных значения: записано брокером; принято клиентом; обработано моделью. Ни вывод строки в терминал, ни изменение state-файла, ни успешная запись в MCP transport сами по себе не доказывают последнее.

## Область и доказательства

Этот раздел и последующие протокольные исследования описывают исходную версию до реализации. Текущее состояние находится в начале документа и в обновлённой матрице ниже.

Прочитаны текущие `scripts/agents/broker.js`, `src/agents/codex-client.js`, их вызывающие места и тесты, раздел README о брокере; целевые исходники дерева `.native/work/check-0.166/codex-rust-v0.166.0/codex-rs/`; официальные документы Claude и обоих поколений Kimi. Далее `N/` означает этот каталог `codex-rs/`.

Это статическое исследование протоколов, не результат end-to-end прогона. Версии установленных Claude/Kimi и доступность account-dependent функций не установлены: команды этих клиентов не найдены через `Get-Command` в доступном окружении. Дерево Codex рассматривается именно как предоставленная локальная копия 0.166, без утверждения о его побайтовом совпадении с чистым upstream tag. Онлайн-документация может описывать более новые возможности.

Рабочая ветка `master`. В процессе исследования наблюдались существующие изменения `scripts/agents/broker.js` и `test/agent-broker.test.js`; документ их не меняет. Реальные `~/.claude`, `~/.codex` и другие пользовательские конфиги не изменялись. Отдельного проектного memory index в доступных файлах не найдено; история других сессий не использовалась.

## Что уже делает брокер

| Участок | Текущее поведение | Чего не хватает |
| --- | --- | --- |
| Codex | `app-server proxy`, живое соединение; `turn/start`, `turn/steer`, `turn/interrupt`; reconnect и resume | Обработчика входящих server requests и обратного push оркестратору |
| Codex permissions | `threadParams()` задаёт `approvalPolicy: 'never'` | Управляемого режима запроса разрешений; наличие callback само по себе не включит approvals |
| Kimi | Отдельный `kimi -p` на каждый ход, затем `-S`; session ID извлекается из текстовой подсказки `kimi -r session_...` | Структурированного протокола, реального steer/interrupt и вопросов/approvals |
| Inbox | Текстовые файлы, чтение примерно раз в секунду; `/interrupt`, `/exit` | Различения сообщения, ответа на вопрос и решения о правах |
| `send` / `wait` | Ожидают роста `turns`, печатают последний `.out.md` | Событий посреди хода; корреляции с конкретным сообщением; они сейчас опрашивают state |
| Результат | `.out.md`, `.history.md`, `.log`, `.state.json` | Истории событий с ID и курсором; короткого уведомления для модели |

Источники: [брокер](../scripts/agents/broker.js), [Codex transport](../src/agents/codex-client.js), [тесты](../test/agent-broker.test.js), [README](../README.RU.md#брокер-агентов-и-синхронизация-сессий-экспериментально).

`codex-client.js` сейчас отвечает `-32601` на любой входящий запрос с `id` и `method`. Это активный отказ, а не ожидание ответа. В Codex обработчик вопроса после такой ошибки может передать модели пустой набор ответов: `N/app-server/src/bespoke_event_handling.rs`, `on_request_user_input_response()`.

## Доставка в Claude Code

| Механизм | Реакция в idle | Применимость |
| --- | --- | --- |
| Фоновая Bash-команда | Завершение может запустить продолжение модели | Запускать отдельный ожидатель **следующего события**, а не ждать завершения долгоживущего брокера |
| `Monitor(command)` | Документирована реакция на строки фонового процесса; требуется приёмочный тест idle на целевой версии | Поток JSONL событий; ограниченная по времени подписка |
| Hook `async` | **Нет**: результат ждёт следующего взаимодействия | Добавление контекста, не транспорт пробуждения |
| Hook `asyncRewake` | **Да**, при exit code 2 | Одноразовый ожидатель события; повторная постановка после обработки |
| MCP channel | **Да**, push в открытую сессию | Хороший постоянный канал, но research preview и session opt-in |
| Обычный MCP | Общего unsolicited wake-контракта нет | Инструменты отправки команд брокеру; сам по себе не решает idle |
| `SendMessage` | Доставка нативным участникам автоматическая | Адреса нативных агентов; не публичный API регистрации внешнего Codex/Kimi |

### Фоновая команда и Monitor

`Monitor` передаёт строки работающей команды модели; default deadline 5 минут, максимум 30. На Windows нужен Git Bash; при отключённом feature-flag fetching на некоторых конфигурациях нужен Claude Code >= 2.1.310. WebSocket-вариант отклоняет private/link-local адреса, поэтому для локального брокера выбирать `command`, не предполагать доступ к `ws://127.0.0.1`. Подписку надо автоматически восстанавливать. [Tools reference](https://code.claude.com/docs/en/tools-reference#monitor-tool).

Ожидатель `events --next` должен завершаться и на вопросе/approval, пока агент ещё работает. Фоновый `broker.js` не завершится на конце хода, а существующий `wait` пропустит вопрос и создаст взаимное ожидание. В programmatic mode официально описан дополнительный ход после окончания background command; это подтверждает механику, но не заменяет тест интерактивного терминала. [Background tasks at exit](https://code.claude.com/docs/en/headless#background-tasks-at-exit).

### Hooks

`asyncRewake: true` запускает hook в фоне и при коде 2 будит Claude даже из idle; stderr, либо stdout при пустом stderr, приходит как reminder. У обычного `async` результат ждёт следующего хода. Для `asyncRewake` продолжает действовать hook timeout. Hook запускается событием жизненного цикла, а не произвольной записью файла: нужна заранее установленная подписка. Проектный вариант: один ожидатель на owner/session, запуск при `SessionStart`, проверка/перевооружение при `Stop`, вывод короткого события и exit 2. Не запускать новый ожидатель на каждый tool call. Это проект интеграции, его повторное вооружение и отсутствие Stop-loop ещё надо проверить. [Hooks reference](https://code.claude.com/docs/en/hooks#run-hooks-in-the-background).

### Channels и SendMessage

Channel объявляет `claude/channel`, посылает `notifications/claude/channel`; обратное направление идёт обычными MCP tools. Busy-события объединяются для следующего хода. Transport write не подтверждает обработку; нужен явный ACK модели. [Channels reference](https://code.claude.com/docs/en/channels-reference#notification-format).

Custom channel требует `--dangerously-load-development-channels server:agent-mesh` для разработки либо разрешённого plugin. Research preview зависит от провайдера и политики организации; обычный `--mcp-config` без channel opt-in не гарантирует push. [Channels](https://code.claude.com/docs/en/channels#research-preview).

У нативных teams сообщения и финальные ответы доставляются автоматически. Подменять файлы `~/.claude/teams/.../inboxes` или выдавать брокер за teammate не рекомендуется: это внутренний lifecycle и формат. `SendMessage` можно использовать через нативного посредника Claude, но это добавляет ещё одну модель и стоимость. Для прямой интеграции выбрать channel/Monitor. [Agent teams](https://code.claude.com/docs/en/agent-teams#messages-between-agents).

## Доставка в Codex CLI 0.166

### Один app-server с открытым TUI

Внешний клиент может подписаться через `thread/resume`, получить активный ход, вызвать `turn/steer` с точным `expectedTurnId`; в idle вызвать `turn/start`. Это реальные операции исполнения модели. TUI, подписанный на тот же поток того же сервера, получает lifecycle и output notifications. Документированный протокол: [App Server](https://developers.openai.com/codex/app-server#steer-an-active-turn). Поведение именно предоставленного дерева проверено в исходниках ниже.

Локальные подтверждения:

- `N/tui/src/lib.rs:1063`, `app_server_target_for_launch()`: существуют `Embedded`, `LocalDaemon`, `Remote`; implicit daemon допускает fallback на embedded.
- `N/tui/src/startup_orchestration.rs:364`: проверка доступного daemon; разные launch overrides могут исключить его использование.
- `N/tui/src/daemon_startup.rs`, `implicit_daemon_exclusion_reason()`: не все CLI config overrides совместимы с общим daemon.
- `N/cli/src/main.rs:970`, `InteractiveRemoteOptions`: явный `--remote ws://...`, `wss://...`, `unix://...`; возможен bearer token через `--remote-auth-token-env`.
- `N/app-server/src/request_processors/turn_processor.rs:1026`: проверка ожидаемого хода, ошибка при его отсутствии/смене; review/compact могут быть не steerable.
- `N/app-server/src/request_processors/thread_lifecycle.rs:1258`: pending server requests воспроизводятся подключившемуся клиенту; `serverRequest/resolved` закрывает запросы у подписчиков.
- `N/tui/src/app/app_server_event_targets.rs`: маршрутизация уведомлений к потоку TUI; `N/tui/src/app/owned_transcript_follow_tests.rs` содержит обработку `TurnStarted`. Это свидетельство архитектуры, не end-to-end доказательство конкретного внешнего запуска.

Для предсказуемого режима запускать TUI и bridge с явно общим endpoint. Пример штатного TUI: `codex --remote ws://127.0.0.1:<port>`. Broker transport пока умеет proxy default-daemon либо свой stdio server; подключение к выбранному endpoint необходимо спроектировать/добавить отдельно. Не считать, что нынешний `proxy` автоматически выберет произвольный `--remote` сервер.

### Почему CODEX_THREAD_ID недостаточно

`N/core/src/unified_exec/process_manager.rs`, `open_session_with_sandbox()`, устанавливает `CODEX_THREAD_ID` для дочерней команды. Это идентификатор потока, не endpoint и не право владения им. Общий каталог rollout не означает общего runtime.

Если TUI работает с embedded server, внешний `app-server proxy` подключится к другому серверу. Resume той же сохранённой истории там **не даёт управление активной моделью TUI** и может создать второго писателя. `thread/read` показывает историю, `thread/inject_items` добавляет контекст, но сама запись контекста не является запуском хода.

Итог: для произвольного embedded TUI без заранее подключённого моста штатного внешнего wake по одному ID не установлено. Нужен перезапуск на общем сервере либо отдельная native-интеграция. Не использовать ввод клавиш в PTY, редактирование rollout или повторный `codex exec resume` как замену.

### Hooks и background exec

В исследованной 0.166 async hook results читаются при начале/продолжении хода: `N/core/src/hook_runtime.rs:816`, `drain_async_hook_results()`, и `N/core/src/session/turn.rs:194,614`. `inject_hook_context_if_running()` отказывает без активного turn task (`N/core/src/session/inject.rs:45`). Аналог Claude `asyncRewake` в hooks не найден. Stop hook может продолжить заканчивающийся ход, но не является постоянной подпиской idle.

`N/core/src/unified_exec/async_watcher.rs`, `spawn_exit_watcher()` и `emit_exec_end_for_unified_exec()`, публикует terminal output/end events. В этом пути нет запуска нового model turn. Поэтому завершение background `exec_command` нельзя проектировать как гарантированный idle wake; обычное чтение через `write_stdin` остаётся явным ожиданием.

### Гонка с человеком

Bridge подписывается, а не делает blind resume с model/sandbox overrides оркестратора. На каждый owner/thread один отправитель mesh-событий. Для busy сохранять точный turn ID, при mismatch обновлять состояние по уведомлениям и повторно выбирать действие. Не превращать любую ошибку steer в новый turn: сбой транспорта не доказывает отсутствие принятого сообщения.

Подписка может принести также server requests самого оркестратора. Такой bridge должен быть пассивным для его questions/approvals: не отвечать `-32601` и не решать их вместо TUI. Нынешний default `connectProxy()` для этого небезопасен: один ошибочный ответ подписчика может закрыть общий pending request. Входящие запросы обслуживать только у принадлежащих брокеру агентов либо при явно переданном владении решением.

Между наблюдением idle и `turn/start` человек может отправить свой prompt. `expectedTurnId` защищает steer, но не предоставляет общей транзакции над вводом TUI и bridge. Внешнее событие появится как дополнительный user input, а не как нативное сообщение subagent. Нужны correlation ID, ограничение повторов и тест одновременного ввода. Если требуется строгий приоритет пользовательского ввода, нужна native очередь событий; это отдельная итерация, не свойство JSON-RPC.

## Доставка в Kimi CLI

### Не смешивать два поколения

Официально новый Kimi Code CLI переписан с Python на Node.js; миграция отдельная. Исследование не определило, какой бинарник у пользователя. Перед реализацией зафиксировать executable/version и проверить `--help`; автоматически мигрировать пользователя нельзя. [Migration](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/migration.html).

| Вариант | Агент под брокером | Пробуждение уже открытого оркестратора |
| --- | --- | --- |
| Прежний Python `kimi-cli` | `--wire`: двусторонний JSON-RPC | Wire управляет своим процессом; привязка к чужому Shell UI по `-S` не документирована |
| Новый Node.js Kimi Code | `-p --output-format stream-json`; для полной интерактивности исследовать ACP/server API | Background Bash notifications; внешнее управление server-owned сессией возможно через её API, общий runtime с произвольным TUI не доказан |

### Прежний Wire

Wire предоставляет `initialize`, `prompt`, `steer` (с 1.4), `cancel`; события `TurnEnd` и запросы `ApprovalRequest`/`QuestionRequest` с ответом по JSON-RPC ID. `prompt` завершается после хода; при interrupt `TurnEnd` может отсутствовать, учитывать ответ `prompt` и exit. Запускать один процесс `kimi --wire`, затем `--session` при восстановлении. Это полноценный кандидат для агентского адаптера; интерфейс experimental, нужна фиксация версии. [Wire mode](https://moonshotai.github.io/kimi-cli/en/customization/wire-mode.html).

Print mode старой версии не подходит для вопросов и прав: он неинтерактивен и неявно включает AFK, включая автоматическую обработку вопросов. Stream-json делает вывод структурированным, но не прикрепляет процесс к другому TUI. [Print mode](https://moonshotai.github.io/kimi-cli/en/customization/print-mode.html).

Старые hooks Beta работают на lifecycle checkpoints; MCP описан как доступ к tools. Публичного channel-like unsolicited idle wake в этих документах не найдено. Это ограничение проверенных интерфейсов, а не доказательство невозможности внутреннего patch. [Hooks](https://moonshotai.github.io/kimi-cli/en/customization/hooks.html), [MCP](https://moonshotai.github.io/kimi-cli/en/customization/mcp.html).

### Новый Kimi Code

Документы описывают `-S/--session`, одноразовый `-p`, stream-json. Совпадение ID обеспечивает историю, а не steering другого процесса. В `-p` нет человеческих approvals; не представлять его как interactive transport. [CLI reference](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command).

Новый `Bash(run_in_background)` публикует автоматические task completion notifications; `WaitFor` ожидает событие и исключает дублирующее completion. Кандидат: tracked background `events --next`, который завершится на любом важном событии. Доставка agent notification документирована, самостоятельный новый model turn из совершенно idle TUI требует приёмочного теста. Не обещать это как проверенный аналог channel. [Built-in tools](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/tools.html#background-tasks).

Новые hooks имеют только `event`, `matcher`, `command`, `timeout`; штатного `asyncRewake` нет. Notification hook наблюдает события клиента, не вводит входящие сообщения. MCP tools решают отправку команд, но документированного произвольного push в модель не найдено. [Hooks](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/hooks.html), [MCP](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/mcp).

Server API позволяет вести server-owned сессию, подписываться на события и отправлять prompts/решения. Но при другом живом писателе есть `40931`; takeover живого TUI небезопасен. Это не доказанный attach к работающей терминальной модели. Если background completion не будит целевую версию, полный режим потребует собственного владельца сессии через API/ACP либо native-моста; один `-S` проблему не исправит. [Server API](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/server-api.html).

Для нового агента есть конкретный штатный ACP transport: `kimi acp`, затем `initialize`, `session/new` или `session/load`, `session/prompt`; поток `session/update`; interrupt через `session/cancel`, exit через `session/close`. Вопросы/права приходят через `session/request_permission`, формы также через `elicitation/create`. Отдельный steer в опубликованной матрице методов не заявлен. Это более подходящая база агента, чем print; совместимость всё равно проверить на выбранной версии. [ACP reference](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp.html).

Если нужен документированный steer нового Kimi, server adapter использует следующие endpoints:

| Действие | API |
| --- | --- |
| Новый ход | `POST /api/v1/sessions/{id}/prompts`, с собственным `prompt_id` |
| Steer | `POST /api/v1/sessions/{id}/prompts:steer`, с queued `prompt_ids` |
| Interrupt | `POST /api/v1/sessions/{id}/prompts/{prompt_id}:abort` |
| Ответ/права | `POST /api/v1/sessions/{id}/interactions/{interaction_id}` |
| События | WebSocket: `turn.ended`, `interaction`, shell/task lifecycle; восстановление через cursor/epoch |

Эти операции управляют server-owned runtime; открытый отдельно TUI от этого не становится подписчиком. [Prompts and interactions](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/server-api.html#prompts).

## Claude как агент брокера

Минимальный транспорт: `claude -p --input-format stream-json --output-format stream-json --verbose`, открытый stdin; сохранять `session_id` из init/output, при перезапуске `--resume <id>`. Читатель stdout должен работать постоянно. Assistant partial text не означает конец хода; нормализовать result и его error/status. Одноразовый `claude -p "..." --resume <id>` годится для последовательных ходов, но не для mid-turn управления. [CLI reference](https://code.claude.com/docs/en/cli-reference), [Streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode).

Вопросы `AskUserQuestion` и permissions обслуживаются host callback/control protocol. Отложить ответ до решения оркестратора; не включать bypass permissions. Документированный CLI fallback для прав: `--permission-prompt-tool` с загруженным MCP tool. [User input](https://code.claude.com/docs/en/agent-sdk/user-input), [Permission prompt tool](https://code.claude.com/docs/en/cli-reference#flags).

Для dependency-free адаптера использовать узкий stream control protocol, уже реализованный официальным SDK: `control_request`/`control_response`, initialize, `can_use_tool`, cancel, interrupt. Это version-sensitive реализация SDK, а не обещание стабильности всех внутренних полей CLI; зафиксировать совместимую версию. `interrupt` передаётся control request с subtype `interrupt`. Result не должен закрывать stdin долгоживущего агента. [SDK query implementation](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py).

Поступившие во время работы user messages документированы как очередь. Пока точная версия не доказала иной контракт, объявлять `steer=false`: отправка во время busy означает следующий ход. Отдельная команда interrupt + новый prompt возможна, но её нельзя незаметно выдавать за steer. Exit: interrupt при необходимости, завершение control requests, EOF и ограниченное ожидание процесса, затем termination.

## Матрица оркестратор × агент

Текущее состояние реализации. **R** = готово и покрыто тестами; «live» отдельно указывает проверенный сценарий. **E** = указанная часть не проверена живым клиентом. **X** = штатный путь невозможен/не поддержан. Готовность транспорта не равна приёмке всех режимов TUI. Ответ на question/approval идёт исходному запросу, не обычным prompt.

| Оркестратор | Агент Codex | Агент Kimi | Агент Claude |
| --- | --- | --- | --- |
| Claude Code | **R** waiter/hook и Codex API. **E** эта пара целиком и автономный idle wake в TUI | **R**, **live**: Claude Bash читает events, вызывает answer/approve/deny Kimi ACP, получает продолжение. **E** автономный idle wake | **R**, Claude-агент отдельно **live**: ход/question/deny/interrupt/resume. **E** эта пара целиком и idle wake. Steer **X**, очередь следующего хода **R** |
| Codex daemon 0.166 | **R**, **live**: CODEX_THREAD_ID → настоящий Codex-брокер → completion → ход владельца на том же daemon; busy turn/steer с expectedTurnId. Passive requests проверены fake. **E** TUI/Enter/compact/reconnect. Embedded **X** | **R**, wake daemon и ACP проверены **live** отдельно. **E** эта пара целиком. Kimi steer **X**, next **R** | **R**, wake daemon и Claude control проверены **live** отдельно. **E** эта пара целиком. Claude steer **X**, next **R** |
| Kimi web 2.3.2 | **R** POST prompt server-owned owner, wake/ответ **live** отдельно. **E** пара с Codex целиком. Terminal owner **X** | **R**, web wake/ответ и ACP question/approval/resume **live** отдельно. **E** пара целиком. Terminal owner/ACP steer **X** | **R**, web wake/ответ и Claude-агент **live** отдельно. **E** пара целиком. Terminal owner/Claude steer **X** |

Запрос решения адресуется сохранённому оркестратору. Прямой router `to` между произвольными соседними агентами не реализован: для этого оркестратор вызывает send конкретного брокера. События сохраняются до завершения наблюдателя; RPC ACK/HTTP принятие означают принятие транспортом, а не подтверждение обработки моделью.

## Как удерживать запрос Codex до ответа

1. В `connectProxy()` добавить необязательный `onRequest` и метод `respond(id, result/error)`. Для клиентов без callback сохранить нынешний отказ unsupported. Не менять поведение sync/archive tools.
2. Входящие `item/tool/requestUserInput`, `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval` зарегистрировать отдельно от исходящих client requests. Не отвечать `-32601` для поддержанных методов и не блокировать read loop на ожидании.
3. Хранить `{connectionEpoch, rpcId, method, threadId, turnId, itemId, state}`; mesh request ID непрозрачный и отдельный от wire ID. Не приводить числовые и строковые JSON-RPC IDs к одному ключу.
4. Выпустить `question`/`approval` с полным структурированным payload и `blocking`. Состояние потока остаётся running с pending request; `waiting` можно показать как дополнительное поле, сохранив существующий status для виджетов.
5. Команда `answer` находит pending request, валидирует question IDs/значения и пишет **JSON-RPC response с исходным id в то же соединение**. Пример результата вопроса: `{"answers":{"question-id":{"answers":["выбранный ответ"]}}}`. Это не `turn/start`, не `turn/steer` и не новый JSON-RPC request.
6. Для execution/file approval вернуть типизированный `decision`, например допустимый `accept`/`decline`; учитывать `availableDecisions`. Permissions approval имеет отдельную схему, её нельзя свести к тому же enum. При необходимости добавить отдельные адаптеры MCP elicitation; неизвестные методы по-прежнему отвергать явно.
7. Отдельный pending-server-request lifecycle не наследует 90-секундный timeout исходящих RPC. При `isBlocking=false`, auto-resolution, interrupt, `serverRequest/resolved` или завершении хода запрос может устареть; поздний ответ отклонять. Не обещать, что любой вопрос можно удержать бесконечно.
8. Disconnect инвалидирует connection epoch. После resume сверить воспроизведённые server requests; не отправлять старый wire ID в новое соединение вслепую. Resolved/cancelled закрывать во всех подписчиках; первый валидный ответ побеждает.

В этой копии Codex сам `request_user_input` разрешён только root thread и проверяет доступность режима; blocking включается в Plan (`N/core/src/tools/handlers/request_user_input.rs:66`). Broker-created обычный root thread и нативный subagent здесь различаются. Для теста удержания выбрать разрешённый blocking mode; транспорт не может заставить недоступный tool появиться у модели.

Ключевые типы: `N/app-server-protocol/src/protocol/common.rs:1849–1875`; `N/app-server-protocol/src/protocol/v2/item.rs:1830–1924`; permissions — `protocol/v2/permissions.rs`. Ожидание ответа: `N/app-server/src/bespoke_event_handling.rs:1675`. Broadcast/pending callbacks: `N/app-server/src/outgoing_message.rs:362`; resume replay/resolved — `request_processors/thread_lifecycle.rs`.

Прямые ссылки в исследованное дерево: [выбор TUI server](../.native/work/check-0.166/codex-rust-v0.166.0/codex-rs/tui/src/lib.rs), [turn processor](../.native/work/check-0.166/codex-rust-v0.166.0/codex-rs/app-server/src/request_processors/turn_processor.rs), [вопросы и ответы](../.native/work/check-0.166/codex-rust-v0.166.0/codex-rs/app-server/src/bespoke_event_handling.rs), [схемы](../.native/work/check-0.166/codex-rust-v0.166.0/codex-rs/app-server-protocol/src/protocol/v2/item.rs), [async hooks](../.native/work/check-0.166/codex-rust-v0.166.0/codex-rs/core/src/hook_runtime.rs), [background exec](../.native/work/check-0.166/codex-rust-v0.166.0/codex-rs/core/src/unified_exec/async_watcher.rs). Для переносимого просмотра upstream: [Codex v0.166.0](https://github.com/openai/codex/tree/rust-v0.166.0/codex-rs); доказательства выше относятся к локальной копии.

Для проверки approvals сделать явную launch policy агента, например `--approval-policy on-request`; текущий `never` оставить совместимым умолчанием до отдельного решения. Не менять права оркестратора при attach. Оркестратор может approve только внутри уже делегированных полномочий; остальные запросы направлять человеку, не выдавая модельное решение за пользовательское.

## Минимальная архитектура

```text
Codex app-server / Kimi Wire или API / Claude stream-json
                         ↕
                существующий broker
              ↙                     ↘
     typed inbox commands       per-agent events.jsonl
              ↑                     ↓
       CLI / MCP tools       wake adapter оркестратора
              ↑                     ↓
                модель оркестратора
```

Сначала использовать существующие файлы и стандартный Node.js. Каждый broker — единственный писатель своего `<name>.events.jsonl`; inbox сохраняет атомарный rename. `events --follow` подписывается через `fs.watch`, перечитывает дописанное по cursor; сначала установить watch, затем выполнить catch-up, чтобы не потерять событие между чтением и подпиской. При reset/truncate нужен новый instance ID. Не создавать отдельную сеть, БД, daemon mesh и новый WebSocket framing ради первой итерации.

Смерть процесса нельзя надёжно сообщить из самого погибшего процесса. При запуске через tracked background command его exit наблюдает клиент; для независимого broker нужен supervisor/наблюдение process handle. До его появления допустим явно обозначенный внутренний liveness-check в ожидателе, но это не строго event-only механизм. Ни heartbeat-файлы, ни неизменный `status=running` не доказывают жизнь. Модель не должна регулярно спрашивать status.

Существующий inbox polling можно сохранить в первой итерации: это внутренняя доставка с задержкой до секунды, без ручных пингов. Event-only вход и supervisor — следующая итерация, если требуется исключить и этот технический polling. Длительная работа и ожидание ответов должны переживать idle агента, но не молча переживать exit владельца.

### Конверт события

Пример схемы, не реализованный API:

```json
{
  "v": 1,
  "id": "worker:instance-uuid:42",
  "seq": 42,
  "at": "2026-10-31T10:00:00Z",
  "from": "worker",
  "to": "owner-session-id",
  "type": "question",
  "threadId": "thread-id",
  "turnId": "turn-id",
  "requestId": "mesh-request-id",
  "blocking": true,
  "summary": "Нужен выбор способа миграции",
  "payload": { "questions": [] }
}
```

Обязательные типы: `turn.completed`, `question`, `approval`, `error`, `agent.exited`; также нужны `request.resolved` и `command.accepted` для корреляции. У `turn.completed` — status и короткий final text, полный ответ остаётся `.out.md`/историей. Итог брать из ответа агента и ограничивать размер; отдельная модель для суммаризации не нужна. У ошибки — источник/код/retriable, у exit — exit code/signal. Success процесса не равен success хода.

Команды: `{v,id,from,to,type,payload,replyTo?,expectedTurnId?}`, типы `message`, `answer`, `approval`, `interrupt`, `exit`. Не помещать RPC ID и decision в свободный текст. `message` явно выбирает `next` или `steer`; неподдерживаемый steer возвращает ошибку capability, не меняет семантику молча.

ACK разделить на принятие команды транспортом и обработку события моделью (`ack <event-id>`). Повторная доставка допускается до ACK; dedup по event ID. После таймаута неоднозначного RPC нельзя слепо повторять исполняющее действие: сопоставить command ID/turn/history. Это at-least-once уведомления, без обещания exactly-once исполнения.

### Предлагаемые команды CLI

Все дополнительные подкоманды ниже — проект. Уже существуют только запуск с flags и `send`/`wait` с нынешней семантикой.

```text
broker.js --agent codex|kimi|claude --name worker --state DIR --prompt FILE
broker.js message --name worker --state DIR --file FILE --mode next|steer
broker.js answer --name worker --state DIR --request ID --file ANSWERS_JSON
broker.js approve --name worker --state DIR --request ID --scope once
broker.js deny --name worker --state DIR --request ID --reason TEXT
broker.js interrupt --name worker --state DIR
broker.js exit --name worker --state DIR
broker.js events --state DIR --owner OWNER --after CURSOR --next|--follow
broker.js ack --state DIR --owner OWNER --event ID
```

`message` возвращает command ID после атомарного принятия, не ждёт конца хода. Старый `send` остаётся совместимым; не менять его на fire-and-forget. `events --next` печатает первое непрочитанное важное событие/пакет и завершается; `--follow` печатает JSONL для Monitor/channel adapter. Answer/approval/interrupt обслуживать даже пока обычный message ждёт: один последовательный обработчик, ожидающий завершения хода, создаст deadlock.

Возврат через CLI доступен каждому оркестратору. MCP tools над теми же командами добавлять только для channel или когда это существенно упрощает discoverability. `status` оставить диагностикой человека, не рабочим циклом модели.

## Итерации реализации

| Итерация | Изменения | Критерий готовности |
| --- | --- | --- |
| 0. Зафиксировать клиентов | Определить executable/version/capabilities без установки и миграции; выбрать Kimi generation; установить ownership Codex server | Есть список точных версий и воспроизводимые isolated launch commands |
| 1. Codex requests + события | `codex-client.js`: callback/respond; `broker.js`: typed inbox, pending requests, events, nonblocking message; сохранить старые CLI и state | Fake transport: вопрос реально остаётся без ответа, затем правильный result; approve/deny; cancel, stale ID, death/error и dedup |
| 2. Claude orchestrator | Один `events --next` background waiter как простой fallback; Monitor command как основной probe; asyncRewake или channel для постоянной интеграции | Модель сама отвечает на question, approval и completion, когда до события уже дала final и idle; без ручного ввода и status-loop |
| 3. Claude agent | Живой stream-json процесс, session/resume, control requests, interrupt/exit; capability steer=false | Два хода, вопрос посреди хода, deny, interrupt, resume; stdin остаётся открыт после result |
| 4. Codex orchestrator | Bridge на явно общем app-server; subscribe, busy/idle routing, ACK | Внешний event вызывает модель и виден в том же TUI; typed draft сохранён; race с Enter, review/compact, reconnect и два подписчика |
| 5. Kimi | Старый Wire adapter либо отдельный новый API/ACP adapter; затем native background waiter probe оркестратора | Вопрос/approval без auto-approve, steer/cancel; idle wake доказан для выбранного бинарника либо явно зафиксирован unsupported |
| 6. Закрыть lifecycle | Supervisor, автоматическое восстановление подписок, owner exit; только при необходимости native bridge | Kill без graceful exit вызывает событие; timeout/потеря подписки не оставляют невидимые pending requests |

Возможная область будущих правок: `scripts/agents/broker.js`, `src/agents/codex-client.js`, небольшие адаптеры Claude/Kimi и wake delivery; `test/agent-broker.test.js` и целевые fixtures, README. Проверить совместимость вызывающих `connectProxy`: sync names/mirror/recreate и archive scripts. Существующие `src/sources/broker.js` и widgets сохраняют формат state; менять их только если добавляется отображение waiting. Installer/global hooks/session-sync не входят в первую итерацию.

Тесты реализации выполнять сначала с fake child/transport без аккаунтов, затем с isolated config/home и loopback provider для Codex; для Claude/Kimi live probe отдельно, на разрешённой тестовой сессии. Ключевые сценарии: final→idle→event→самостоятельная реакция; busy→question→answer→completion; approval→deny; смерть; reconnect; duplicate; поздний ответ; два события подряд; simultaneous user Enter. Отдельно доказать отсутствие настоящей авторизации в локальном тестовом launcher. Нынешнее исследование таких запусков не делало.

## Риски и границы

- **Нет универсальной совместимости.** Полная цель пока не закрывается настройкой одного брокера: embedded Codex и произвольный старый Kimi TUI требуют другой точки подключения либо native bridge.
- **Approval deadlock.** Нельзя ждать completion там, где агент ждёт question/approval. Разрешения должны иметь отдельный маршрут и lifetime.
- **Повтор после обрыва.** Текущую логику повторного продолжения Codex нельзя автоматически переносить на approvals или исполнение команд: транспорт мог потерять только ACK.
- **Смена возможностей.** Channels preview, старый Wire experimental, новые версии CLI и account flags требуют version gates. Недоступность канала должна быть видна, а не превращаться в молчаливое ожидание.
- **Гонка с пользователем.** Mesh wake расходует токены и может начать работу раньше пользовательского Enter. Приоритет и полномочия должны быть явно заданы; emergency interrupt не должен запускать автоматический новый ход.
- **Приватность и подмена отправителя.** Owner/session и agent IDs проверять при каждой команде, state ограничить рабочей областью, запретить path traversal. События содержат данные и цитаты агента, не доверенные system instructions. Не копировать credentials в события и не публиковать полный transcript.
- **Жизненный цикл.** Watch deadlines, отключение channels, закрытие TUI, SIGKILL и stale PID требуют обработки; сам брокер не может гарантировать уведомление о собственной внезапной смерти.
- **Не абсолютная доставка.** Channel write/RPC acceptance не означает ответ модели. Нужны ACK и обнаружение зависших необработанных событий; бесконечные автоповторы могут создать цикл агентов.

## Выжимка

1. Единые события и команды реализуемы в существующем брокере; wake зависит от клиента оркестратора.
2. Claude: asyncRewake будит idle; Monitor подходит для потока, channel даёт постоянный push с ограничениями preview.
3. Codex: start/steer работает через общий с TUI app-server; одного CODEX_THREAD_ID недостаточно.
4. Kimi: сначала выбрать поколение CLI; Wire даёт интерактивного агента, `-p` не заменяет его.
5. Server requests Codex надо удерживать без ответа и завершать тем же JSON-RPC ID, отдельно от message/steer.
6. Claude-агент добавляется через живой stream-json/resume и control requests; mid-turn steer пока не обещать.
7. Полная симметрия и работа из idle требуют приёмочных прогонов; runtime, код и пользовательские конфиги здесь не менялись.
