# Синк сессий и брокер агентов: внутреннее устройство

Обзор для пользователя: [README.RU](../README.RU.md#брокер-агентов-и-синхронизация-сессий-экспериментально). English version: [sync.md](sync.md).

## Доступ к app-server

Sync и брокер используют `codex app-server proxy`. Originator в Codex 0.166 общий для процесса, отдельное имя в `initialize` его не изолирует; оба пути архивации защищены реестрами sync и managed-checkpoint из стандартного, env и явно заданных профилей Claude (`--claude-config-dir DIR` повторяемый; повреждённые реестры блокируют архивацию). Proxy только подключается к существующему сокету; при необходимости запустите демон: `codex app-server daemon start`.

## Хуки и допуск

Используются только `SessionStart`, `UserPromptSubmit`, `Stop`: первые два доставляют ожидающий контекст, Stop сохраняет завершённую работу. Обхода процессов после каждого инструмента нет. Допуск повторно используется, пока идентификатор процесса CLI не изменился; первый запрос Windows CIM / Unix ps может быть медленнее. Брокер (`SESSION_SYNC_BROKER`), `SESSION_SYNC_EXCLUDE`, неинтерактивные exec/print, сабагенты и sidechain исключены. Для Codex нужна сборка CLI с поддержкой этих экспериментальных хуков и `additionalContext`.

## Бюджет контекста и доставка

Сессия Claude, запущенная в папке-зонтике, сохраняет одну пару при переходах между вложенными репозиториями. Хук определяет исходную папку по каталогу транскрипта Claude.

Если Codex сжал управляемое зеркало в `.jsonl.zst`, а обычного файла уже нет, следующий хук Claude создаёт новое зеркало Codex из ограниченного актуального контекста Claude и обновляет пару. Старый поток, сжатая история и резервная копия checkpoint сохраняются. Исходные сессии Codex не заменяются; отсутствие файла без сжатой копии по-прежнему считается ошибкой.

При экспорте из Codex в Claude сначала идут все сообщения разговора из последнего компакта в исходном порядке. Затем добавляются свежие сообщения, которые помещаются в остаток бюджета. Если компакт занимает весь бюджет, синк передаёт его целиком и помечает пропущенный хвост. Для источника Claude сохраняются последняя сводка и ограниченный хвост. Бюджет по умолчанию около 50k токенов (байты UTF-8 / 4), задаётся `SESSION_SYNC_CONTEXT_TOKENS`.

Claude получает экспорт одним ответом хука и сохраняет большие ответы в файл. У Codex `additionalContextLimit` в приблизительных токенах (`ceil(байты UTF-8 / 4)`): наши 16000 означают 64000 байт, по умолчанию 2500, 0 без ограничения; явного максимума кроме `usize` нет. Codex получает слепки и большие события последовательными подтверждаемыми порциями с меткой в начале каждой. Занятый lock даёт тихий выход и протухает через 30 секунд; неизменный checkpoint не переписывается, ключей событий не больше 256, решений об исключении 128 / семь дней. PID и время старта CLI позволяют повторно использовать допуск на SessionStart; Windows получает идентификатор через локальный WSH/WMI, при недоступности через полный CIM. Версии зеркал берутся из транскриптов или кэшированного `--version`.

## Что передаётся

Текст пользователя/ассистента и входы/результаты завершённых инструментов с указанием источника; ничего не исполняется. Thinking, изображения, вложения, зашифрованная compaction и незавершённые результаты не передаются. Sync не читает credentials и не запускает ход модели; зеркало Codex создаётся через локальный app-server API. Текст разговоров и инструментов может содержать приватные данные. Rollback, повреждённые записи, неизвестные зеркала и пути вне разрешённых каталогов останавливают синхронизацию.

Импортированные записи Claude помечаются `session_sync_key`, чтобы нативные tool/shell блоки не уходили обратно эхом. Обновления открытой сессии приходят через additionalContext.

Завершённые инструменты отображаются нативно, когда хватает записанных данных: Claude Bash → Codex CommandExecution («Ran»), правки → FileChange с диффом, Read/Grep/Glob/LS → исследование («Explored»). Codex exec/shell → Claude Bash, add/update из apply_patch → парные Write/Edit. Прочие инструменты, незавершённые команды и неподдерживаемые delete/move-патчи остаются короткими наблюдениями. Номера строк диффа относительны к переданным фрагментам; неизвестные exit code и длительность не выдумываются. Codex не включает эти UI-события в модельную историю повторно. Неизвестные и непереносимые инструменты получают общую ограниченную сводку без сырого вывода. TodoWrite/update_plan и веб-поиск используют нативные аналоги, когда хватает данных; MCP и агенты другого клиента не получают выдуманные серверы, ID и живые действия.

### Служебная разметка в сообщениях

| Источник / маркер | Обработка |
| --- | --- |
| Claude `<bash-input>` → `<bash-stdout>` / `<bash-stderr>` | Объединяются по `parentUuid`, включая границу хуков; Codex показывает CommandExecution с `source=user_shell` («You ran»), оба потока вывода сохранены с обрезкой. Неизвестный exit code не выдумывается. |
| Codex `<user_shell_command>` / `shell.user_command` | Читается один модельный record с command/result; UI-копии событий повторно не импортируются. Claude получает нативные связанные bash-mode записи. Объединённый вывод Codex на stdout/stderr не делится. |
| Контекст shell для архива и доставки | Короткий `User ran: … / Output: …`, без XML-обёрток. Claude при resume использует свой bash-mode формат. |
| Незавершённый input, вывод без команды / с другим parent | Input ждёт результат; осиротевший вывод не превращается в сообщение пользователя. |
| `<command-name>`, `<command-message>`, `<command-args>`, `<local-command-stdout>`, `<local-command-caveat>` | Служебка slash-команд исключается; соседний настоящий текст сохраняется. |
| `<user-memory-input>` | Локальная команда памяти исключается; изменение памяти не воспроизводится. |
| `<system-reminder>`, `<task-notification>`, `<agent-message>` | Исключаются по origin/promptSource/turnOrigin и обёрткам; вложенные и незакрытые служебные блоки не протекают в чат. |
| Codex environment_context, user_instructions, AGENTS.md / INSTRUCTIONS | Исключаются по metadata и текстовым маркерам. |
| Codex hook_prompt / additional_context, turn_aborted, subagent_notification, codex_internal_context, goal_context | Служебные вставки исключаются по блокам. |
| Отдельный Codex `<skill>`-фрагмент | Инструкции навыка исключаются. |
| `<persisted-output>` в shell-выводе | Снимается только обёртка, остаётся ограниченное превью; файл не читается. |
| Произвольные HTML/XML/TypeScript теги настоящего ввода | Сохраняются как данные. |

## Зеркала Codex

Зеркало Codex создаётся через `thread/start` (persistent, канонический cwd), `thread/inject_items` и `thread/name/set`; ID и путь выдаёт сервер, он же пишет SQLite и модельную историю. В 0.166 inject не создаёт user event, а metadata/update не задаёт preview: временная цель в статусе **paused**, сразу очищаемая, публикует нативный preview без хода и дублирования контекста. Список resume фильтрует пустой preview; `vscode` входит в интерактивные источники. Нужны goals; иначе создание откладывается с записью в лог, без включения фич и синтетических rollout. Прерванное создание повторяется на том же потоке.

Заголовки копируются из исходной сессии в формате `<заголовок> · Claude/Codex` и обновляются только при изменении. Создание ограничено 27 секундами, inject 20; новые хуки и lease 30 секунд (существующие таймауты обновляются повторной установкой sync вручную). `thread/start` не переопределяет sandbox/approval/permissions. Сохранённый read-only переживает resume; `node scripts/agents/reset-mirror-settings.js <thread-id> --apply` возвращает настройки проекта через ephemeral-пробу и `thread/settings/update`.

Видимая история Codex отделена от модельной: новый поток архивируется и выгружается, proxy закрывается, UI-события legacy и canonical ItemCompleted атомарно дописываются с ordinal, затем поток разархивируется. Claude получает завершённые пары tool_use/tool_result с совпадающими ID и моделью автора. Новые сообщения в открытой сессии приходят через additionalContext: видимого history-only API нет, а правка загруженного rollout небезопасна. Ctx и квоты приходят после настоящего хода клиента, импорт их не выдумывает.

Пересоздать зеркало: закройте оба клиента и выполните `node scripts/agents/recreate-mirror.js "<pairs.json>" "<pair-id>" --apply` (без `--apply` только план); оригиналы сохраняются в бэкап, следующий хук источника создаст новое зеркало.

## Состояние

Архивы лежат в `CLAUDE_CONFIG_DIR/agent-kit/sync/<cwd-hash>/`: append-only файлы `.events` и состояния пар со смещениями, ключами и ссылками ожидающей доставки; в `pairs.json` только идентификаторы. Храните состояние вместе с зеркалами. Установка и удаление идемпотентны, делают бэкап изменяемых настроек, сохраняют чужие хуки, последующие правки, сессии и архивы. Удаление убирает только свои хуки и не затирает новые настройки старым бэкапом.

Если два профиля Claude делят папку `projects` через симлинк или junction, проверенное зеркало может использовать реестр рядом с физической папкой `projects`. Пары, уже зарегистрированные в текущем профиле, имеют приоритет.

## Архивация брокера

Брокер Codex архивирует поток на `/exit`, по idle-таймауту или при штатном завершении, разархивирует перед resume и не архивирует упавшие ходы. `node scripts/agents/archive-broker-sessions.js [--minutes 60] [--state DIR] [--apply]` по умолчанию только выводит список старых простаивающих сессий брокера.

## Ручные проверки

В `npm test` не входят.

- `node scripts/agents/demo-sync.js`: создаёт обе стороны во временных homes, использует отдельные stdio app-server и loopback-провайдер, не копирует авторизацию, проверяет элементы native resume и печатает команды открытия обоих клиентов. Ответов модели и квот нет.
- `node scripts/agents/audit-mirror.js --claude "<transcript.jsonl>" [--codex-home DIR] [--count 3] [--json]`: только чтение; прогоняет извлечение и рендер на интерактивных неброкерских rollout проекта и печатает категории, счётчики и примеры без содержимого переписки и аргументов инструментов. RAW, служебный текст как сообщение пользователя или нехватка примеров Codex дают exit 1.
- `node scripts/agents/measure-sync.js /path/to/session-sync-state/pairs.json`: офлайн-замер на **копиях** пары старого формата во временных изолированных homes; печатает время первого разбора и повторных хуков, затем удаляет временное дерево.
- `node scripts/agents/smoke-live.js --live`: smoke с реальным демоном и моделью; запрашивает ровно `pong`, отправляет `/exit`, проверяет `state.archived=true` и SQLite `archived=1` в режиме чтения; артефакты сохраняются. Без `--live` ничего не делает. Для SQLite-проверки нужен Node 22.13+; сам брокер поддерживает Node 20.

## WSL и существующие пары

Claude Code работает нативно в WSL. Codex, синк и исполнители брокера работают на Windows. В примере `Z:\example` и `/mnt/z/example` указывают на один проект, а `Z:\agent-kit` содержит репозиторий agent-kit. Подставьте свои пути.

### Проверьте пути и interop

Выполните из той оболочки, из которой будет запускаться Claude.

```bash
cd /mnt/z/example
python3 --version
wslpath -w "$PWD"
export AGENT_KIT_WINDOWS_NODE="$(wslpath -u 'C:\Program Files\nodejs\node.exe')"
"$AGENT_KIT_WINDOWS_NODE" --version
```

Путь проекта должен преобразоваться в `Z:\example`. Если Windows Node установлен в другом месте, узнайте путь в PowerShell командой `(Get-Command node.exe).Source`. Если `node.exe` падает с `Exec format error`, проверьте WSL interop до отладки синка. Для GoodAccess выполните те же проверки внутри `ganet-enter`.

### Сохраните историю и подключите хуки

1. Сохраните Windows-профиль Claude, в котором лежит реестр пары. В его `agent-kit/sync` хранятся ID пар и позиции чтения.
2. Направьте Linux-профиль в существующий каталог транскриптов проекта. Claude выбирает этот каталог по пути запуска, поэтому имена на Linux и Windows могут различаться. Для отдельного WSL-профиля ссылка может выглядеть так:

   ```bash
   export CLAUDE_CONFIG_DIR="$HOME/.claude-work"
   export SESSION_SYNC_WINDOWS_CLAUDE_DIR=/mnt/z/example/.claude-work
   export CLAUDE_CODE_TMPDIR="$SESSION_SYNC_WINDOWS_CLAUDE_DIR/wsl-tmp"

   mkdir -p "$CLAUDE_CONFIG_DIR/projects" "$CLAUDE_CODE_TMPDIR"
   ln -sT "$SESSION_SYNC_WINDOWS_CLAUDE_DIR/projects/z--example" \
     "$CLAUDE_CONFIG_DIR/projects/-mnt-z-example"
   ```

   Используйте имя каталога Windows-истории и имя, которое выбирает Claude при Linux-запуске. Если в каталоге Linux уже есть свои сессии, проверьте его перед созданием ссылки. Linux-команды MCP и авторизацию храните в Linux-профиле. Если профиль целиком общий, укажите `SESSION_SYNC_WINDOWS_CLAUDE_DIR` как значение `CLAUDE_CONFIG_DIR` в WSL. При необходимости создайте ссылку на проект в общем `projects`.
3. Оставьте установленные хуки Codex на Windows. Для общего `settings.json` выполните `node scripts/agents/sync.js install --wsl` из Windows-копии репозитория с нужным Windows `CLAUDE_CONFIG_DIR`. Для отдельного Linux-профиля сгенерируйте хуки из Windows и объедините полученный объект `hooks` с `settings.json` Linux-профиля:

   ```powershell
   node -e "const p=require('node:path'); const s=require('./src/sync'); console.log(JSON.stringify(s.hookConfigs(p.resolve('scripts/agents/sync.js'), {wsl:true}).claude, null, 2))"
   ```

   Хуки синка срабатывают на SessionStart, UserPromptSubmit и Stop. Они переводят пути WSL перед вызовом существующего синка на Windows. Если хук не может подключиться к локальному серверу Codex, выполните `codex app-server daemon start` в Windows.
4. Если Windows Codex должен использовать отдельный профиль Claude, добавьте запись проекта в `CODEX_HOME/agent-kit/sync-profiles.json`. По умолчанию `CODEX_HOME` находится в `%USERPROFILE%\.codex`. Явно заданный Windows `CLAUDE_CONFIG_DIR` имеет приоритет.

   ```json
   {
     "Z:\\example": "Z:\\example\\.claude-work"
   }
   ```

### Продолжите ту же сессию

Закройте Windows Claude с нужной перепиской. Из исходной папки проекта в WSL выполните `claude --resume` и выберите ту же сессию. Linux Claude откроет существующий транскрипт, а синк продолжит ту же пару. Обычные лимиты контекста Claude сохраняются.

Для GoodAccess запускайте Linux CLI внутри `ganet-enter`. Перед запуском экспортируйте пути к профилям и Windows Node, как в предыдущих шагах.

```bash
sudo -n --preserve-env=WSL_INTEROP /usr/local/sbin/ganet-enter \
  /usr/bin/env TZ=Europe/Warsaw PATH="$PATH" \
  CLAUDE_CONFIG_DIR="$CLAUDE_CONFIG_DIR" \
  SESSION_SYNC_WINDOWS_CLAUDE_DIR="$SESSION_SYNC_WINDOWS_CLAUDE_DIR" \
  CLAUDE_CODE_TMPDIR="$CLAUDE_CODE_TMPDIR" \
  AGENT_KIT_WINDOWS_NODE="$AGENT_KIT_WINDOWS_NODE" \
  "$HOME/.local/bin/claude" --resume
```

Локальный Windows-лаунчер может выбирать WSL для рабочей папки и открывать список сессий. В проверенной установке `%USERPROFILE%\.claude\bin\claude-start.cmd` принимает папку проекта как аргумент. Это локальный файл.

```powershell
& "$env:USERPROFILE\.claude\bin\claude-start.cmd" 'Z:\example'
```

### Запускайте брокер из WSL

Вызовите `bash /mnt/z/agent-kit/scripts/agents/broker-wsl.sh` со штатными аргументами брокера. Обёртка использует `AGENT_KIT_WINDOWS_NODE` и переводит пути, переданные в `--cwd`, `--state`, `--prompt` и другие файловые аргументы. В `--state` укажите scratchpad текущей сессии внутри общего `CLAUDE_CODE_TMPDIR`. Исполнители Windows используют сеть Windows.

Для автоуведомлений используйте [штатные события mesh-хука](../scripts/agents/README.md#launch-resume-and-result-delivery) в Linux-профиле Claude. Для каждого mesh-хука задайте `shell` как `bash` и используйте этот фрагмент как `command`. Сохраните `asyncRewake` на SessionStart, PostToolUse и Stop, а SessionEnd оставьте синхронным.

```bash
export AGENT_KIT_WSL_BROKER=1
export AGENT_KIT_CLAUDE_UID="$(id -u)"
export AGENT_KIT_CLAUDE_PROJECT_DIR="$CLAUDE_PROJECT_DIR"
export WSLENV="$WSLENV:CLAUDE_CODE_TMPDIR/pw:AGENT_KIT_WSL_BROKER/w:AGENT_KIT_CLAUDE_UID/w:AGENT_KIT_CLAUDE_PROJECT_DIR/w"
exec "$AGENT_KIT_WINDOWS_NODE" \
  "$(wslpath -w /mnt/z/agent-kit/scripts/agents/mesh-hook.js)"
```

Если автоуведомления ещё не подключены, используйте `events --next` через обёртку. Автохук и ручной ожидатель читают одну очередь, поэтому на сессию нужен один получатель событий.

### Проверьте переход

- Откройте старую пару и обменяйтесь сообщением в обе стороны. Убедитесь, что ID пары и транскрипт те же, а позиции чтения идут вперёд. Перейдите внутри сессии Claude в дочерний репозиторий и убедитесь, что она всё ещё использует исходную пару.
- Если список сессий пуст, проверьте папку запуска и ссылку на каталог транскриптов. При `Orphan mirror` проверьте, какой профиль владеет парой и какой выбрал хук.
- Проверьте доставку брокера на завершённой задаче. Claude должен получить уведомление и доступный из WSL путь к отчёту, пока исполнитель ещё работает. Подключения MCP в Linux-профиле проверьте через `claude mcp list`. Для работы уже подключённому MCP может отдельно понадобиться браузер или локальный сервис.
