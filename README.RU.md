<h1 align="center">agent-kit</h1>

<p align="center">
  <a href="https://github.com/FrostBy/agent-kit/actions/workflows/ci.yml"><img src="https://github.com/FrostBy/agent-kit/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/licence-MIT-blue" alt="Лицензия: MIT"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="Node >= 20">
  <img src="https://img.shields.io/badge/dependencies-0-success" alt="Без зависимостей">
  <img src="https://img.shields.io/badge/i18n-en%20%7C%20ru-informational" alt="Английский и русский">
</p>

**Набор для [Claude Code](https://code.claude.com) и [Codex CLI](https://github.com/openai/codex): один статуслайн для обоих, патчи Codex, брокер агентов и двусторонний синк сессий.**

- **Статуслайн для Claude Code и Codex** (в Codex: нативный футер или панель по логам): контекст, лимиты, git по репозиториям папки-зонтика, текущая активность, виджеты исполнителей Codex/Kimi. Node без зависимостей, TUI-редактор, английский и русский.
- **Патчи Codex**: нативный футер на том же рендерере, полные диффы, время команд, повторы при перегрузке, Shift+Tab Plan/Auto, ограниченные сабагенты. Codex собирается у вас из пропатченных исходников, бинарники не распространяются.
- **Ускоренный голос Codex**: промпт realtime для более быстрой речи (только конфиг).
- **Брокер агентов**: Claude запускает Codex/Kimi фоновыми исполнителями; завершённые потоки Codex архивируются и не засоряют списки сессий.
- **Синк сессий (экспериментально)**: сессии Claude Code и Codex в одном проекте зеркалятся в обе стороны, с нативной историей, заголовками и вызовами инструментов; кончились токены Claude, продолжаете в Codex и обратно.

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

### Нативный футер (пропатченный CLI)

Сборка на Windows x64 (см. [Требования](#требования)); macOS/Linux пока завершаются явной ошибкой. Распространяются только патчи исходников.

```sh
npm run codex:build -- --dev     # без --dev release; --features a,b выбирает патчи, по умолчанию все
npm run codex:install            # включает <version>-agent-kit рядом с официальным релизом
npm run codex:sync-footer        # после правок JS: обновить упакованный рендерер
npm run codex:restore            # вернуть официальный релиз
```

Установка копирует официальный standalone-пакет в `<version>-agent-kit`, сохраняет состояние отката и не трогает конфиг и авторизацию. Обновление Codex: `codex:restore`, `codex update` до версии из [manifest](patches/codex/manifest.json) (из PowerShell или cmd, не из Git Bash), сборка, `codex:install`.

Футер повторяет раскладку Claude на данных из нативного JSON CLI и заканчивается строкой режима auto/plan/read-only; `maxLines` в `--codex --configure` ограничивает число строк содержимого. `node scripts/native-codex.js [папка]` запускает dev-сборку в изолированном home с loopback-провайдером, не трогая ваш Codex.

Подробнее в [patches/README.md](patches/README.md): что добавляет каждый патч, устройство сборки и установки, пути и ограничения.

<details>
<summary><b>Отдельный просмотрщик логов (прежний режим)</b></summary>

Отдельная панель для вкладки терминала, читает локальные логи сессий Codex (без сети и без credentials Claude):

```sh
node statusline.js --codex --watch      # выход q / Ctrl+C; без --watch один снимок
node statusline.js --codex --preview    # демо папки-зонтика с тремя репозиториями
```

`--root="Z:/work"` задаёт папку-зонтик, `--session=UUID` или `--session="C:/path/session.jsonl"` закрепляет сессию; иначе берётся `CODEX_THREAD_ID` или самая новая сессия в корне. `ctx` считается от эффективного `model_context_window` сессии; лимиты показывают израсходованную квоту. Формат логов внутренний и может меняться. Настройка: `node statusline.js --codex --configure` (`~/.codex/statusline.json`).

</details>

## Брокер агентов и синхронизация сессий (экспериментально)

**Брокер.** Claude запускает Codex (через `codex app-server proxy`) или Kimi фоновыми исполнителями, с inbox для следующих сообщений, steering и прерывания. `--state` указывайте на scratchpad, который читает статуслайн. `node install.js --only broker` печатает команду; npm также даёт `agent-broker`. Исполняемые файлы берутся из PATH или `AGENT_BROKER_CODEX` / `AGENT_BROKER_KIMI`. Завершённые потоки Codex архивируются и разархивируются при resume.

```sh
node scripts/agents/broker.js --agent codex --name reviewer --state /tmp/scratchpad --prompt /tmp/prompt.md --cwd /path/to/project
```

**Синк сессий** по умолчанию выключен, в том числе с `--yes`:

```sh
node install.js --only sync
node scripts/agents/sync.js uninstall
```

Он добавляет глобальные хуки в `CLAUDE_CONFIG_DIR/settings.json` и `CODEX_HOME/config.toml` и включается для проекта только после того, как в этой папке запускались оба клиента. Каждая исходная сессия получает зеркало в другом клиенте с заголовком `<заголовок источника> · Claude/Codex`: возобновите его и продолжайте. Зеркало несёт актуальный контекст после компакта (около 50k токенов, `SESSION_SYNC_CONTEXT_TOKENS`) с нативной историей и вызовами инструментов; последующие ходы приходят контекстом хука. Агенты брокера, сабагенты и неинтерактивные сессии исключены. Ничего не исполняется и credentials не читаются, но переданный текст может содержать приватные данные.

Устройство, ограничения, хранение состояния и ручные проверки: [docs/sync.RU.md](docs/sync.RU.md).

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
