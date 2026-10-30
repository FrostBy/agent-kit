<h1 align="center">agent-kit</h1>

<p align="center">
  <a href="https://github.com/FrostBy/agent-kit/actions/workflows/ci.yml"><img src="https://github.com/FrostBy/agent-kit/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/licence-MIT-blue" alt="Лицензия: MIT"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="Node >= 20">
  <img src="https://img.shields.io/badge/dependencies-0-success" alt="Без зависимостей">
  <img src="https://img.shields.io/badge/i18n-en%20%7C%20ru-informational" alt="Английский и русский">
</p>

**Набор для [Claude Code](https://code.claude.com) и [Codex CLI](https://github.com/openai/codex): один статуслайн для обоих и патчи Codex.**

- **Статуслайн для Claude Code и Codex** (в Codex: нативный футер или панель по логам): контекст, лимиты, git по репозиториям папки-зонтика, текущая активность, виджеты исполнителей Codex/Kimi. Node без зависимостей, TUI-редактор, английский и русский.
- **Патчи Codex**: нативный футер на том же рендерере, полные диффы, время команд, повторы при перегрузке, Shift+Tab Plan/Auto, ограниченные сабагенты. Codex собирается у вас из пропатченных исходников, бинарники не распространяются.
- **Ускоренный голос Codex**: промпт realtime для более быстрой речи (только конфиг).

English version: [README.md](README.md)

```
Fable 5.1 high   ctx ▰▰▱▱▱ 42% 84k/200k   ⚙  Edit render.js   📋 3/7   agents 2
5h ▰▰▰▱▱ 63% ↻ 1h00m   7d ▰▰▱▱▱ 41% ↻ 3d0h   Fable 18%
#128 ✓ approved
▸ api  ⎇ feat/login 1 to push +120 −14 ?1
  web  ⎇ main       2 to pull +8 −2
  Σ +128 −16
```

## Требования

- **Статуслайн Claude Code**: Node.js 20+. Больше ничего.
- **Патчи Codex** (пока Windows x64, macOS/Linux в планах):
  - Git;
  - [rustup](https://rustup.rs) (`winget install Rustlang.Rustup`); версию Rust задаёт `rust-toolchain.toml` Codex;
  - MSVC C++ Build Tools: `winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"`;
  - установленный официальный standalone Codex целевой версии из [manifest](patches/codex/manifest.json) (его пакет берётся за основу);
  - короткий `CARGO_HOME` (подойдёт созданный вручную junction) или включённый Windows `LongPathsEnabled`; при риске MAX_PATH для rusty_v8 сборка напечатает команды исправления;
  - десятки ГБ на диске и от 20 минут на первую release-сборку.

Установщик только проверяет требования и печатает команды, сам ничего не ставит.

## Быстрый старт

```sh
git clone https://github.com/FrostBy/agent-kit && cd agent-kit
node install.js          # или install.cmd / sh install.sh
```

Стрелки, пробел и Enter: статуслайн Claude, каждый патч Codex отдельно, ускоренный голос. Зависимости подтягиваются сами. Без интерактива:

```sh
node install.js --list
node install.js --only claude
node install.js --only statusline,full-diff,interaction-modes,voice
node install.js --yes --skip voice
```

Перед изменениями делается бэкап настроек и `config.toml`; `CLAUDE_CONFIG_DIR` и `CODEX_HOME` учитываются. [Шаблон голоса](templates/codex-voice-prompt.md) основан на realtime-промпте Codex ([Apache-2.0](patches/LICENSE.Apache-2.0)).

Полный дифф, повторы при перегрузке и ускорение голоса основаны на патчах [booxter](https://github.com/booxter), см. [Благодарности](#благодарности).

## Codex

### Нативный футер в кастомном CLI

Сборка из исходников для Windows x64: нужны Node.js 20+, Git, rustup и MSVC C++ Build Tools с Windows SDK. Версию Rust задаёт `rust-toolchain.toml` исходного Codex. Бинарники не распространяются. Для сборки и установки на macOS/Linux пока явные TODO с понятной ошибкой.

```sh
npm run codex:prepare
npm run codex:build -- --features statusline,full-diff,exec-timing,capacity-retry,interaction-modes,restricted-subagents
npm run codex:install
npm run codex:sync-footer
npm run codex:restore
```

Без `--features` выбираются все фичи; зависимости добавляются автоматически. `--dev` выбирает debug вместо release. Установка копирует существующий официальный standalone-пакет в `<version>-agent-kit`, сохраняет состояние отката и учитывает `CODEX_HOME` / `--standalone`; конфиг и авторизация не меняются. Повторная установка обновляет тот же кастомный релиз на месте, переименовывая занятый exe. Для старой ручной установки находится штатный релиз, а прежний кастомный каталог сохраняется для ручного удаления. [Требования, пути и ограничения](patches/README.md#prerequisites--требования), [manifest фич](patches/codex/manifest.json). После правок JS команда `codex:sync-footer` обновляет упакованный рендерер.

Для обновления: выполните `npm run codex:restore`, затем `codex update` до версии из manifest, соберите соответствующий CLI с патчами и выполните `npm run codex:install`. Установка создаст новый `<version>-agent-kit`, сохранит старый кастомный релиз и напечатает его путь; последующий restore вернёт новый штатный релиз. Запускайте `codex update` из PowerShell или cmd: в Git Bash первым в PATH стоит GNU tar, из-за чего внутренний install.ps1 падает.

Целевая версия Codex — в manifest. Нативная сборка помечается его коммитом; install проверяет совпадение версии штатного пакета и build commit голосового host. Restore проверяет путь и хеш штатного пакета из state независимо от текущей версии manifest.

Патч также добавляет полный дифф в компактном режиме, время команд и счётчик живого вывода, повторы при перегрузке, переключение Plan/Auto и ограниченные режимы сабагентов через префикс имени задачи `readonly-`/`plan-`. Полный список и авторство — в [описании изменений патча](patches/README.md#what-the-patch-adds).

```sh
npm run codex:build -- --dev
node scripts/native-codex.js
```

Это запускает отдельный Codex CLI с нашим футером внутри его интерфейса. Можно передать рабочую папку вторым аргументом. Запускатель использует `.native/test-home` и тестовый локальный провайдер без авторизации; рабочий Codex и его настройки он не меняет. Запросы к модели и живые квоты аккаунта в этом профиле недоступны. Если CLI предлагает установить Windows Sandbox, нажмите Esc для просмотра футера без установки.

Раскладка и оформление повторяют исходную Claude-версию. Модель, effort, контекст, квоты, активный инструмент, todo, сабагенты и уже известный CLI PR приходят из нативного JSON. Git считает общий сканер проекта. Недоступные блоки скрываются; число строк учитывает размер терминала, итог Git включает скрытые репозитории. Патч и ограничения описаны в [patches/README.md](patches/README.md).

Нативный футер заканчивается строкой auto/plan/read-only с пустой строкой перед ней; `maxLines` в конфиге футера Codex (по умолчанию `4`, доступна в `--codex --configure`) ограничивает только содержимое, высота терминала и явно заданный Codex `max_lines` остаются внешними потолками; `gapAfter` добавляет одну завершающую пустую braille-строку, только если она помещается.

### Отдельный просмотрщик логов (прежний режим)

Из этой папки, в отдельном терминале или панели Windows Terminal:

```sh
node statusline.js --codex --watch
```

Выход: `q` или `Ctrl+C`. Без `--watch` выводится один снимок. Демо с тремя репозиториями:

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

`+/−` — строки относительно HEAD в отслеживаемых файлах; `?` — отдельные неотслеживаемые файлы. Их содержимое в число строк не входит. Сумма учитывает и репозитории, скрытые ограничением `git.max`.

`--root="Z:/work"` задаёт папку-зонтик. `--session=UUID` или `--session="C:/path/session.jsonl"` закрепляет сессию. Иначе используется текущий `CODEX_THREAD_ID`, если он относится к этому корню, либо самая новая сессия, запущенная в выбранной папке или её подпапках. Сессии других проектов автоматически не подмешиваются.

Просмотрщик читает `~/.codex/sessions` (или `$CODEX_HOME/sessions`), затем только дописанные байты. Он обновляется раз в 2 секунды; время последнего снимка usage указано в заголовке. Лимиты показывают использованную квоту. `ctx` — последний запрос относительно эффективного окна этой сессии (`model_context_window` в логе), которое может быть меньше максимума модели в API. Показываются только реально полученные окна лимитов.

Это отдельная панель, а не расширение встроенного `/statusline` Codex. Она работает рядом с CLI или desktop/IDE при наличии локальных сессионных логов. Их формат внутренний и может меняться. Инструменты, план и сабагенты видны, когда соответствующие события записаны в лог; вложенные команды внутри code mode не разбираются. Режим Codex не читает OAuth-токены Claude и не делает сетевых запросов; долларовые расходы и таймер остывания кэша не вычисляются.

Настройка: `node statusline.js --codex --configure`. Конфиг Codex отдельный: `~/.codex/statusline.json`. `AGENT_STATUSLINE_CONFIG` задаёт альтернативный файл для любого режима; старый `CLAUDE_STATUSLINE_CONFIG` продолжает работать для Claude.

## Установка

Глобально с GitHub, затем подключить к Claude Code:

```sh
npm install -g github:FrostBy/agent-kit
agent-kit --install
```

`--install` прописывает `statusLine` и `subagentStatusLine` в `~/.claude/settings.json` как `node "<путь установки>/statusline.js"`: каждая отрисовка запускает установленную копию и ничего не скачивает. Прежние значения сохраняются, `--uninstall` их возвращает. Если settings.json не разбирается, он не трогается.

Обновление: та же команда `npm install -g`.

## Настройка

```sh
agent-kit --configure
```

Редактор показывает живое превью на тестовых данных. Клавиши: `↑↓` выбор, `a` добавить блок, `d` удалить, `K`/`J` двигать, `|` разделитель, `Enter` опции блока, `n` новая строка, `g` общие настройки, `s` сохранить, `q` выход. В mintty и Git Bash запускайте через `winpty`.

Конфиг Claude лежит в `~/.claude/statusline.json` (путь меняется через `AGENT_STATUSLINE_CONFIG` или `CLAUDE_STATUSLINE_CONFIG`). Всё, чего нет в файле, берётся из умолчаний, `--init` записывает их в файл. Имя пакета и команда — `agent-kit`; `agent-statusline` и `claude-statusline-ultimate` сохранены как алиасы. Внутренний каталог Codex `codex-resources/agent-statusline` и имя файла `agent-statusline-state.json` не меняются ради совместимости.

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

| Ключ | По умолчанию | Что значит |
|---|---|---|
| `lines` | см. выше | Блоки по строкам. `"\|"` начинает новую группу. Элемент может быть объектом с опциями: `{ "id": "text", "value": "🔥" }` |
| `separator` | три пробела | Между группами |
| `gapAfter` | `true` | Пустая строка после статуслайна, перед строкой режима самого Claude Code |
| `money` | `auto` | `auto`: деньги только при API или extra usage; `always`: всегда |
| `lang` | `auto` | `en`, `ru` или `auto` по локали системы |
| `icons` | `unicode` | `unicode`, `ascii` для простых терминалов, `nerd` для Nerd Fonts |
| `colors` | | Имена ANSI (`cyan`, `brightRed`, `gray`…) или `#rrggbb`. `NO_COLOR` отключает цвета |
| `thresholds` | `50` / `80` | Проценты, с которых значения становятся жёлтыми и красными |
| `pricing` | | Свои цены моделей, $ за 1M токенов: `{ "claude-opus-5-5": { "in": 4, "out": 20, "read": 0.2 } }` |
| `usageTtl`, `todayTtl` | `120`, `300` | Как часто обновлять usage API и расход за сегодня, секунды |

Другие команды: `--preview` рисует тестовые данные в текущей папке, `--list [--md]` выводит все блоки с опциями.

## Блоки

В Claude-режиме добавьте `codex` и `kimi` в `lines` вручную. `exclude` — пути через `;`: виджет скрыт в этих папках и их потомках (на Windows без учёта регистра). `idleAfter` скрывает сессии после бездействия в минутах (по умолчанию 10); `maxAge` остаётся дополнительным ограничением возраста. Журналы Kimi больше 16 MiB скрываются. Чтение локальное, без credentials.
Сначала виджеты ищут state-файлы agent-broker в `input.scratchpad_dir`, связывая Codex по `threadId`, Kimi по `sessionId`: до трёх активных агентов, иначе последний завершившийся, если он ещё свежий. Свежесть и состояние хода определяются по журналу; state-файлы done/error игнорируются. Имена агентов серые, аккаунтные квоты Codex выводятся один раз в конце. Если свежего агента брокера нет, используется выбор по cwd: для Codex только сессии `codex exec`, для `kimi -p` — локальные сессии Kimi.
Kimi показывает `limit 5h` в течение 5 часов после ошибки 5-часовой квоты; `limit month` (месячный) и `limit` (неизвестное окно) сохраняются 30 дней от события.

<!-- widgets:start -->
#### Модель и сессия

| id | описание | опции |
|---|---|---|
| `codex` | Внешний Codex: модель, контекст, токены, лимиты | `exclude="", maxAge=120, idleAfter=10, tokens=false` |
| `kimi` | Внешний Kimi: модель, контекст, токены, limit | `exclude="", maxAge=120, idleAfter=10, tokens=false` |
| `model` | Модель |  |
| `effort` | Уровень effort |  |
| `thinking` | Extended thinking включён |  |
| `fast` | Fast mode |  |
| `plan` | Тариф: Pro / Max 5x / Max 20x / API |  |
| `session-name` | Имя сессии | `max=24` |
| `duration` | Длительность сессии |  |
| `api-time` | Доля времени на ожидание API |  |
| `version` | Версия харнеса |  |
| `style` | Output style, если не default |  |
| `vim` | Режим vim |  |
| `agent` | Имя агента (--agent) |  |
| `permission-mode` | Режим разрешений, если не default (из транскрипта) |  |

#### Контекст

| id | описание | опции |
|---|---|---|
| `context` | Контекст: полоска, %, занято/окно; учитывает `autoCompactWindow` Claude | `label="ctx", bar=5, percent=true, used=true, left=false` |
| `context-breakdown` | Контекст по типам: свежий ввод / чтение кэша / запись кэша |  |

#### Лимиты

| id | описание | опции |
|---|---|---|
| `limits` | Окна лимитов Codex с фактической длительностью | `label="", bar=5, countdown=true, pace=true, paceMargin=10` |
| `limit-5h` | Лимит за 5 часов | `label="5h", bar=5, countdown=true, pace=true, paceMargin=10` |
| `limit-7d` | Лимит за неделю | `label="7d", bar=5, countdown=true, pace=true, paceMargin=10` |
| `limit-model` | Недельные лимиты по моделям (Fable и т.п.), usage API | `countdown=false, pace=true, paceMargin=10` |
| `limit-spend` | Лимит трат гейтвея |  |
| `extra-usage` | Докупленные кредиты (extra usage), usage API |  |
| `week-breakdown` | На что ушла неделя: Claude Code / чаты / Cowork, usage API | `min=1` |

#### Деньги и правки

| id | описание | опции |
|---|---|---|
| `cost` | Стоимость сессии |  |
| `burn-rate` | $ в час по текущей сессии |  |
| `cost-today` | Расход за сегодня по всем сессиям (из транскриптов) | `sessions=false` |
| `session-lines` | Строки, изменённые Claude за сессию |  |

#### Кэш промптов

| id | описание | опции |
|---|---|---|
| `cache` | Кэш промптов: тёплый/остыл, когда остынет | `under=5` |
| `cache-hit` | Доля попаданий в кэш и промахи |  |

#### Git

| id | описание | опции |
|---|---|---|
| `git` | Git: ветка, коммиты to push/pull, +/− строк, untracked; в папке-зонтике строка на каждое изменённое репо и Σ | `depth=2, max=4, showClean=false, branchMax=24, rows=true, aheadBehind=true, lines=true, untracked=true, stash=false, budgetMs=400` |
| `worktree` | Имя worktree |  |
| `repo` | owner/name репозитория, кликабельно |  |
| `pr` | PR/MR: номер и статус ревью, кликабельно | `state=true` |

#### Папки

| id | описание | опции |
|---|---|---|
| `dir` | Текущая папка | `full=false` |
| `project-dir` | Папка запуска, если отличается от текущей |  |
| `added-dirs` | Число папок, добавленных через /add-dir |  |

#### Живая активность

| id | описание | опции |
|---|---|---|
| `activity` | Инструмент, который выполняется сейчас | `detail=true` |
| `todos` | Прогресс todo / задач |  |
| `subagents` | Число работающих сабагентов |  |

#### Прочее

| id | описание | опции |
|---|---|---|
| `clock` | Время | `seconds=false` |
| `text` | Произвольный текст | `value="", color="muted"` |
| `cmd` | Вывод своей команды (кэшируется) | `command="", ttl=30, color="muted"` |
<!-- widgets:end -->

## Как устроено

- Claude Code передаёт команде JSON сессии и показывает её вывод. Грузятся только источники, нужные блокам текущей раскладки.
- Git опрашивает репо параллельно с бюджетом 400 мс. Не успел — показывается последнее известное состояние, а скан доделывается в отдельном процессе, отрисовка не ждёт.
- Usage API и расход за сегодня обновляются в отдельных процессах по своему TTL.
- Расход за сегодня считается по ценам моделей из `usage` каждого ответа в сегодняшних транскриптах, включая сабагентов; повторяющиеся блоки одного ответа считаются один раз. Файлы читаются инкрементально, гигабайтные — кусками.
- Git берётся из папки, где запущена сессия, поэтому `cd` в одно репо не прячет остальные.
- Кэш лежит в `agent-statusline` во временной папке системы.

## Windows Terminal

В Cascadia Mono, шрифте по умолчанию, нет части символов. Windows берёт их из запасного шрифта, они шире клетки и налезают на следующий символ. Значки по умолчанию проверены глазами в Windows Terminal: отсутствующие в шрифте — эмодзи или идут с лишним пробелом. Ещё Claude Code обрезает пробелы в начале каждой строки, поэтому отступ строк git начинается с U+2800, пустого символа Брайля.

## Приватность

Лимиты по моделям, extra usage и деньги на подписке требуют данных аккаунта. Для этого статуслайн читает OAuth-токен Claude Code из `~/.claude/.credentials.json` и обращается к `api.anthropic.com/api/oauth/usage`, тому же эндпоинту, что у `/usage`. Он недокументирован и может измениться. Токен больше никуда не уходит. Если убрать из раскладки `limit-model`, `extra-usage`, `week-breakdown` и денежные блоки (`cost`, `burn-rate`, `cost-today`), запросов не будет.

## Разработка

```sh
npm test
node statusline.js --preview
```

## Благодарности

- [booxter](https://github.com/booxter): исходные патчи Codex для полных диффов в компактном режиме, повторов при перегрузке и лимита stream retry, идея ускорения голоса ([booxter/nix](https://github.com/booxter/nix)). Целевая версия Codex — в manifest.
- [GordonBeeming/codex-statusline](https://github.com/GordonBeeming/codex-statusline) (Apache-2.0): основа патча нативного футера.
- [OpenAI Codex](https://github.com/openai/codex) (Apache-2.0): пропатченные исходники и шаблон голосового промпта. См. [patches/NOTICE](patches/NOTICE).

## Лицензия

[MIT](LICENSE) © Vladislav Romanovsky

## Брокер агентов и синхронизация сессий (экспериментально)

Ручной smoke реального демона/модели (не входит в npm test): `node scripts/agents/smoke-live.js --live` запрашивает ровно `pong`, отправляет `/exit`, проверяет `state.archived=true` и SQLite `archived=1` через read-only доступ; артефакты сохраняются. Без `--live` действий нет. Для ручной SQLite-проверки нужен Node 22.13+; брокер по-прежнему поддерживает Node 20.

Sync/broker используют `codex app-server proxy`: originator в Codex 0.166 является process-global, отдельное имя initialize его не изолирует; защита обоих путей архивации — реестры sync/managed-checkpoint из стандартного, env и явно заданных профилей (`--claude-config-dir DIR` повторяемый; повреждённые реестры блокируют архивацию). Proxy только подключается к сокету; при необходимости запустите демон: `codex app-server daemon start`.

Аудит только на чтение: `node scripts/agents/audit-mirror.js --claude "<transcript.jsonl>" [--codex-home DIR] [--count 3] [--json]`. Он проверяет извлечение и реальные render-функции, выбирает интерактивные неброкерские rollout того же проекта/agent-kit, печатает категории, счётчики и примеры отображения без содержимого переписки и аргументов инструментов. RAW, служебный user-текст или нехватка запрошенных Codex-примеров дают exit 1. Для любого неизвестного/непереносимого инструмента действует общий ограниченный assistant-summary fallback; сырые tool outputs не копируются в сообщения-сводки. TodoWrite/update_plan и веб-поиск используют нативные аналоги, когда хватает данных; MCP и агенты другого клиента не получают выдуманные серверы/ID/живые действия.

Обработка user-записей и обёрток (проверены реальные bash-mode записи Claude и protocol/context Codex 0.166):

| Источник / маркер | Обработка |
| --- | --- |
| Claude `<bash-input>` → `<bash-stdout>` / `<bash-stderr>` | Объединяются по `parentUuid`, включая границу хуков; Codex показывает CommandExecution с `source=user_shell` («You ran»), оба потока вывода сохранены с обрезкой. Неизвестный exit code не выдумывается. |
| Codex `<user_shell_command>` / `shell.user_command` | Читается один модельный record с command/result; UI-копии событий повторно не импортируются. Claude получает нативные связанные bash-mode записи. Codex предоставляет объединённый вывод — разделение stdout/stderr не угадывается. |
| Контекст shell для архива и доставки | Короткий `User ran: … / Output: …`, без внешних XML-обёрток. Claude при resume использует свой родной bash-mode формат. |
| Незавершённый input, вывод без команды / с другим parent | Input ожидает результат; осиротевший вывод не превращается в сообщение пользователя. |
| `<command-name>`, `<command-message>`, `<command-args>`, `<local-command-stdout>`, `<local-command-caveat>` | Служебка локальных slash-команд исключается; соседний настоящий текст сохраняется. |
| `<user-memory-input>` | Локальная команда памяти исключается; удалённое изменение памяти не воспроизводится. В проверенном транскрипте этот тег не встретился. |
| `<system-reminder>`, `<task-notification>`, `<agent-message>` | Уведомления исключаются по origin/promptSource/turnOrigin и обёрткам; вложенные и незакрытые служебные блоки не протекают в чат. |
| Codex environment_context, user_instructions, AGENTS.md / INSTRUCTIONS | Контекст окружения и проектные инструкции исключаются по metadata и текстовым маркерам. |
| Codex hook_prompt / additional_context, turn_aborted, subagent_notification, codex_internal_context, goal_context | Служебные вставки исключаются; content_item_kinds/provenance фильтруются по блокам. |
| Отдельный Codex `<skill>`-фрагмент | Инструкции навыка исключаются; это не пользовательская реплика. |
| `<persisted-output>` внутри shell-вывода | Убирается только обёртка, сохраняется ограниченное превью; указанный файл автоматически не читается. |
| Произвольные `<note>`, HTML/XML/TypeScript теги настоящего ввода | Сохраняются как данные; фильтр не удаляет все теги подряд. |

Импортированные Claude-записи помечаются `session_sync_key`, чтобы нативные tool/bang-shell блоки не экспортировались обратно эхом. Создание зеркала не выполняет импортированные команды. Дельты открытой сессии по-прежнему приходят безопасным additionalContext.

Завершённые инструменты отображаются нативно, когда хватает записанных данных: Claude Bash → Codex CommandExecution («Ran»), правки → FileChange с диффом, Read/Grep/Glob/LS → исследование («Explored»). Codex exec/shell → Claude Bash, add/update из apply_patch → парные Write/Edit. Прочие инструменты, незавершённые команды и неподдерживаемые delete/move-патчи остаются короткими наблюдениями. Номера строк диффа относительны к переданным фрагментам; неизвестные exit code/длительность не выдумываются. Codex не включает эти UI-события в модельную историю повторно. `demo-sync.js` содержит Bash/Edit/Read и проверяет нативные tool-элементы resume без запуска модели.

Заголовки копируются из исходной сессии в формате `<заголовок> · Claude/Codex` и обновляются только при изменении. Создание ограничено 27 секундами, inject — 20; новые хуки и lease — 30 секунд (существующие таймауты обновляются повторной установкой sync вручную). `thread/start` не переопределяет sandbox/approval/permissions. Сохранённый read-only переживает resume; `node scripts/agents/reset-mirror-settings.js <thread-id> --apply` возвращает настройки проекта через ephemeral-пробу и `thread/settings/update`.

Видимая история Codex отделена от модельной: новый поток архивируется и выгружается, proxy закрывается, UI-события legacy и canonical ItemCompleted атомарно дописываются с ordinal, затем поток разархивируется. Claude получает завершённые пары tool_use/tool_result с совпадающими ID и моделью автора. Новые сообщения в открытой сессии остаются additionalContext: штатного видимого history-only API нет; предлагаемый следующий шаг — очередь UI-записей до подтверждённой выгрузки/resume. Ctx/квоты поступают после настоящего хода клиента, импорт их не выдумывает.

Ручная UI-проверка: `node scripts/agents/demo-sync.js`. Скрипт создаёт обе стороны во временных homes, использует отдельные stdio app-server и только loopback-провайдер, не копирует авторизацию, проверяет видимые элементы native resume и печатает команды открытия обоих клиентов. Настоящих ответов модели и аккаунтных квот в таком демо нет; временные данные сохраняются для просмотра.

`node install.js --only broker` показывает команду брокера; npm также предоставляет `agent-broker`. Он запускает Codex через `codex app-server proxy`, Kimi — через CLI; поддерживает inbox для следующих сообщений, steering и прерывание. Задайте `--state` в scratchpad, который получает статусная строка: формат `.state.json` совместим с существующими виджетами. Исполняемые файлы берутся из PATH либо `AGENT_BROKER_CODEX` / `AGENT_BROKER_KIMI` (пути к исполняемым файлам, не команды оболочки).

```sh
node scripts/agents/broker.js --agent codex --name reviewer --state /tmp/scratchpad --prompt /tmp/prompt.md --cwd /path/to/project
node install.js --only sync
node scripts/agents/sync.js uninstall
```

Sync **выключен по умолчанию**, в том числе с `--yes`; включается экспериментальным пунктом установщика или `--only sync`. Установка добавляет глобальные хуки в `CLAUDE_CONFIG_DIR/settings.json` и `CODEX_HOME/config.toml` (по умолчанию `~/.claude`, `~/.codex`). Так любой проект работает без изменения его настроек. Каждая исходная сессия получает свою пару с разделением по cwd. В другом клиенте возобновите созданную сессию `<заголовок> · Claude/Codex`. Существующие транскрипты не переписываются: последующие изменения приходят через контекст хука.

Используются только `SessionStart`, `UserPromptSubmit`, `Stop`: первые два доставляют ожидающий контекст, Stop сохраняет завершённую работу. Обхода процессов после каждого инструмента нет. Допуск повторно используется, пока идентификатор процесса CLI не изменился; первый запрос Windows CIM / Unix ps может быть медленнее. Брокер (`SESSION_SYNC_BROKER`), `SESSION_SYNC_EXCLUDE`, неинтерактивные exec/print, сабагенты и sidechain исключены. Для Codex нужна сборка CLI с поддержкой этих экспериментальных хуков и `additionalContext`.

Доставка хука отделена от бюджета засева: Claude имеет [предел 10000 символов](https://code.claude.com/docs/en/hooks#json-output), sync консервативно использует 10000 байт UTF-8. У Codex `additionalContextLimit` — приблизительные токены (`ceil(байты UTF-8 / 4)`): наши 16000 означают 64000 байт, по умолчанию 2500, 0 — без ограничения; явного максимума кроме `usize` нет ([сохранение превышений](.native/codex/codex-rs/hooks/src/output_spill.rs), [оценка](.native/codex/codex-rs/utils/string/src/truncate.rs)). Snapshot и большие события доставляются последовательными подтверждаемыми порциями с меткой в начале каждой. Занятый lock даёт тихий выход и протухает через 30 секунд; неизменный checkpoint не переписывается, ключей событий не больше 256, решений об исключении — 128 / семь дней. PID и время старта CLI позволяют повторно использовать допуск на SessionStart; Windows получает идентификатор через локальный WSH/WMI, при недоступности возвращается к полному CIM. Версии зеркал берутся из транскриптов или кэшированного `--version`.

Передаются текст пользователя/ассистента и входы/результаты завершённых инструментов как **обычный текст с указанием источника**, без исполнения инструментов. Thinking, изображения, вложения, зашифрованная compaction и незавершённые результаты не передаются. Сетевых запросов и чтения credentials нет; текст разговоров и инструментов может содержать приватные данные. Rollback, повреждённые записи, неизвестные зеркала и пути вне разрешённых каталогов останавливают синхронизацию.

Архивы находятся в `CLAUDE_CONFIG_DIR/agent-kit/sync/<cwd-hash>/`: append-only файлы `.events` и отдельные состояния пар со смещениями, ключами и ссылками ожидающей доставки; в `pairs.json` только идентификаторы. Сохраняйте состояние вместе с зеркалами. Установка/удаление идемпотентны, создают бэкапы изменяемых существующих настроек, сохраняют чужие хуки, последующие правки конфигурации, сессии и архивы. Удаление убирает только свои хуки и не затирает новые настройки старым бэкапом.

Ручной офлайн-замер на **копиях** существующей пары старого формата, без авторизации и запуска клиентов:

```sh
node scripts/agents/measure-sync.js /path/to/session-sync-state/pairs.json
```

Скрипт создаёт временные изолированные homes, копирует только транскрипты пары, импортирует прежний журнал событий, печатает время первого разбора и повторных CLI-хуков, затем удаляет временное дерево. Допуск офлайн-копий задан заранее: первый CIM/ps не входит в замер, запуск Node входит в повторные замеры.

Codex-??????? ????????? ????? `thread/start` (persistent, ???????????? cwd), `thread/inject_items` ? `thread/name/set`: ID/path ?????? ??????, ?? ?? ????????? SQLite ? rollout. ? 0.166 inject ?? ??????? user event, ? metadata/update ?? ?????? preview: ????????? ???? **paused**, ????? ?????????, ????????? ??????? preview ??? ???? ? ?????? ?????????? ?????????. SQLite picker ????????? ???????? preview; `vscode` ?????? ? interactive sources. ????? ????????? ???? goals; ????? ???????? ????????????? ? ?????, ??? ????????? ??? ? ????????? fallback. ?????? ???????? ?????????? ??? ?? thread. ??? ?????? ??????? ????????? ??????? ???????? ??? ???????: `node scripts/agents/recreate-mirror.js "<pairs.json>" "<pair-id>" --apply` (??? `--apply` ? ?????? ????); ????????? ??????????? ? ???????, ????????? ??? ???????? ?????? ??????? ??????? ???????.
