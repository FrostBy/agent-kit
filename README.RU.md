<h1 align="center">claude-statusline-ultimate</h1>

<p align="center">
  <a href="https://github.com/FrostBy/claude-statusline-ultimate/actions/workflows/ci.yml"><img src="https://github.com/FrostBy/claude-statusline-ultimate/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/licence-MIT-blue" alt="Лицензия: MIT"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="Node >= 20">
  <img src="https://img.shields.io/badge/dependencies-0-success" alt="Без зависимостей">
  <img src="https://img.shields.io/badge/i18n-en%20%7C%20ru-informational" alt="Английский и русский">
</p>

**Настраиваемый статуслайн для [Claude Code](https://code.claude.com).** Контекст, лимиты на 5 часов, неделю и по моделям с прогнозом по темпу, git по всем репо папки-зонтика, текущая активность. Без зависимостей, с TUI-редактором, на английском и русском.

English version: [README.md](README.md)

```
Fable 5.1 high   ctx ▰▰▱▱▱ 42% 84k/200k   ⚙  Edit render.js   📋 3/7   agents 2
5h ▰▰▰▱▱ 63% ↻ 1h00m   7d ▰▰▱▱▱ 41% ↻ 3d0h   Fable 18%
#128 ✓ approved
▸ api  ⎇ feat/login 1 to push +120 −14 ?1
  web  ⎇ main       2 to pull +8 −2
  Σ +128 −16
```

## Что показывает

- **Контекст**: сколько токенов занято из окна (`84k/200k`, `170k/1M`), полоска окрашивается по порогам.
- **Лимиты**: окна на 5 часов и неделю со временем до сброса и недельные лимиты по моделям, например Fable. Если тратите быстрее, чем идёт окно, цифры краснеют, а `out in 1d9h` показывает, когда при таком темпе лимит кончится.
- **Git в папках-зонтиках**: если сессия запущена в папке с несколькими репо, каждое репо с незакоммиченными или незапушенными изменениями выводится отдельной строкой, колонки выровнены, репо, в котором сейчас Claude, помечено `▸`, строки суммируются (`Σ`). Внутри одного репо показывается это репо.
- **Активность**: текущий инструмент и его аргумент, прогресс todo, работающие сабагенты, PR ветки и статус ревью.
- **Деньги, только когда это деньги**: стоимость сессии и расход за сегодня по всем сессиям видны при оплате через API или на подписке, когда в текущей сессии пошёл расход extra usage. Пока вы в рамках подписки, они скрыты.
- **Строки сабагентов**: по строке на сабагента в панели агентов: модель, effort, токены, доля контекста и мини-график.

## Установка

Глобально с GitHub, затем подключить к Claude Code:

```sh
npm install -g github:FrostBy/claude-statusline-ultimate
claude-statusline-ultimate --install
```

`--install` прописывает `statusLine` и `subagentStatusLine` в `~/.claude/settings.json` как `node "<путь установки>/statusline.js"`: каждая отрисовка запускает установленную копию и ничего не скачивает. Прежние значения сохраняются, `--uninstall` их возвращает. Если settings.json не разбирается, он не трогается.

Обновление: та же команда `npm install -g`.

## Настройка

```sh
claude-statusline-ultimate --configure
```

Редактор показывает живое превью на тестовых данных. Клавиши: `↑↓` выбор, `a` добавить блок, `d` удалить, `K`/`J` двигать, `|` разделитель, `Enter` опции блока, `n` новая строка, `g` общие настройки, `s` сохранить, `q` выход. В mintty и Git Bash запускайте через `winpty`.

Конфиг лежит в `~/.claude/statusline.json` (путь меняется через `CLAUDE_STATUSLINE_CONFIG`). Всё, чего нет в файле, берётся из умолчаний, `--init` записывает их в файл.

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

<!-- widgets:start -->
#### Модель и сессия

| id | описание | опции |
|---|---|---|
| `model` | Модель |  |
| `effort` | Уровень effort |  |
| `thinking` | Extended thinking включён |  |
| `fast` | Fast mode |  |
| `plan` | Тариф: Pro / Max 5x / Max 20x / API |  |
| `session-name` | Имя сессии | `max=24` |
| `duration` | Длительность сессии |  |
| `api-time` | Доля времени на ожидание API |  |
| `version` | Версия Claude Code |  |
| `style` | Output style, если не default |  |
| `vim` | Режим vim |  |
| `agent` | Имя агента (--agent) |  |
| `permission-mode` | Режим разрешений, если не default (из транскрипта) |  |

#### Контекст

| id | описание | опции |
|---|---|---|
| `context` | Контекст: полоска, %, занято/окно | `label="ctx", bar=5, percent=true, used=true, left=false` |
| `context-breakdown` | Контекст по типам: свежий ввод / чтение кэша / запись кэша |  |

#### Лимиты

| id | описание | опции |
|---|---|---|
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
- Кэш лежит в `claude-statusline` во временной папке системы.

## Windows Terminal

В Cascadia Mono, шрифте по умолчанию, нет части символов. Windows берёт их из запасного шрифта, они шире клетки и налезают на следующий символ. Значки по умолчанию проверены глазами в Windows Terminal: отсутствующие в шрифте — эмодзи или идут с лишним пробелом. Ещё Claude Code обрезает пробелы в начале каждой строки, поэтому отступ строк git начинается с U+2800, пустого символа Брайля.

## Приватность

Лимиты по моделям, extra usage и деньги на подписке требуют данных аккаунта. Для этого статуслайн читает OAuth-токен Claude Code из `~/.claude/.credentials.json` и обращается к `api.anthropic.com/api/oauth/usage`, тому же эндпоинту, что у `/usage`. Он недокументирован и может измениться. Токен больше никуда не уходит. Если убрать из раскладки `limit-model`, `extra-usage`, `week-breakdown` и денежные блоки (`cost`, `burn-rate`, `cost-today`), запросов не будет.

## Разработка

```sh
npm test
node statusline.js --preview
```

## Лицензия

[MIT](LICENSE) © Vladislav Romanovsky
