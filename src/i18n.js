'use strict';

function detectLang(config = {}) {
  if (config.lang && config.lang !== 'auto') return config.lang;
  const env = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || process.env.LANGUAGE || '';
  let loc = env;
  if (!loc) { try { loc = Intl.DateTimeFormat().resolvedOptions().locale; } catch { loc = ''; } }
  return /^(ru|be|uk)\b/i.test(loc) ? 'ru' : 'en';
}

const tr = (x, lang) => (x && typeof x === 'object' ? x[lang] ?? x.en : x);

const UI = {
  saved: { en: 'saved', ru: 'сохранено' },
  unsaved: { en: '● unsaved', ru: '● не сохранено' },
  preview: { en: 'preview', ru: 'превью' },
  loading: { en: 'loading…', ru: 'загрузка…' },
  layout: { en: 'layout', ru: 'раскладка' },
  keys: { en: 'keys', ru: 'клавиши' },
  line: { en: 'Line', ru: 'Строка' },
  newLine: { en: '+ new line', ru: '+ новая строка' },
  separator: { en: 'separator', ru: 'разделитель' },
  unknownWidget: { en: 'unknown widget', ru: 'неизвестный блок' },
  layoutKeys: {
    en: '↑↓ select  a add  d delete  K/J move  | separator  Enter options  n line  g global  s save  q quit',
    ru: '↑↓ выбор  a добавить  d удалить  K/J двигать  | разделитель  Enter опции  n строка  g общие  s сохранить  q выход',
  },
  addWidget: { en: 'add widget', ru: 'добавить блок' },
  filter: { en: 'filter', ru: 'фильтр' },
  typeToFilter: { en: '(type to filter)', ru: '(печатайте для фильтра)' },
  pickerKeys: { en: '↑↓ select  Enter add  Esc back', ru: '↑↓ выбор  Enter добавить  Esc назад' },
  options: { en: 'options', ru: 'опции' },
  global: { en: 'global settings', ru: 'общие настройки' },
  noOptions: { en: 'this widget has no options', ru: 'у этого блока нет опций' },
  inputKeys: { en: 'Enter done  Esc cancel', ru: 'Enter готово  Esc отмена' },
  fieldKeys: { en: '↑↓ select  ←→/Space change  Enter type text  Esc back', ru: '↑↓ выбор  ←→/Space менять  Enter ввести текст  Esc назад' },
  writtenTo: { en: 'written to', ru: 'записано в' },
  quitConfirm: { en: 'press q again to quit without saving', ru: 'ещё раз q — выйти без сохранения' },
  needTty: {
    en: 'The editor needs an interactive terminal (Windows Terminal, PowerShell, cmd). In mintty/Git Bash run: winpty node statusline.js --configure',
    ru: 'Редактору нужен интерактивный терминал (Windows Terminal, PowerShell, cmd). В mintty/Git Bash запустите: winpty node statusline.js --configure',
  },
  g_lang: { en: 'Language', ru: 'Язык' },
  g_money: { en: 'Money: auto — only on API or extra usage', ru: 'Деньги: auto — только API или extra usage' },
  g_gap: { en: 'Empty line after the status line', ru: 'Пустая строка после статуслайна' },
  g_icons: { en: 'Icons', ru: 'Иконки' },
  g_separator: { en: 'Widget separator', ru: 'Разделитель блоков' },
  g_warn: { en: 'Warning threshold, %', ru: 'Порог «внимание», %' },
  g_crit: { en: 'Critical threshold, %', ru: 'Порог «критично», %' },
  g_color: { en: 'Colors', ru: 'Цвета' },
  g_links: { en: 'Clickable links', ru: 'Кликабельные ссылки' },
  g_usageTtl: { en: 'Usage API cache, sec', ru: 'Кэш usage API, сек' },
  g_todayTtl: { en: 'Daily spend cache, sec', ru: 'Кэш расхода за день, сек' },
  g_colorKey: { en: 'Color', ru: 'Цвет' },
  listHeader: { en: '| id | description | options |', ru: '| id | описание | опции |' },
};

function makeT(lang) { return (key) => tr(UI[key], lang) ?? key; }

module.exports = { detectLang, tr, makeT, UI };
