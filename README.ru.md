# bookstack-mcp

🇬🇧 [English version](README.md) — основная документация, обновляется в первую очередь.

Небольшой MCP-сервер для [BookStack](https://www.bookstackapp.com/), рассчитанный на Claude Code
(и CLI, и вкладку Code в десктопном приложении Claude). Читает, ищет и пишет документацию в Markdown.
11 инструментов, 3 переменные окружения, настройка одной командой.

Сделан специально проще существующих аналогов: там, где другие MCP-серверы для BookStack тащат за собой
весь API один в один (галереи изображений, пользователи и роли, десятки инструментов), здесь — только
то, что нужно, чтобы читать и писать вики через диалог с Claude.

Для себя сервер запускается локально через stdio. Для команды есть [HTTP-режим](#общий-сервер-http):
один контейнер на сервере, подключение к Claude по URL, каждый входит со своим токеном BookStack.

## Установка

**1. Получите API-токен в BookStack.** Аватар → *My Account* → *Access & Security* → *API Tokens* →
*Create Token* (в старых версиях: *Edit Profile* → *API Tokens*). Сохраните *Token ID* и *Token Secret* —
секрет показывается один раз. Роли пользователя нужно право **Access System API** (у админов оно есть).

**2. Подключите сервер** — через npx, из готового Docker-образа (в обоих случаях ничего клонировать и
собирать не нужно) или из исходников.

**Вариант А: npx.** Нужен установленный Node 20 или новее:

```bash
npx -y -p @yand3r3d3v/bookstack-mcp bookstack-mcp-setup
```

Это мастер настройки, описанный в варианте В. Сервер он пропишет как `npx -y @yand3r3d3v/bookstack-mcp`,
так что каждая новая сессия запускает последний релиз.

**Вариант Б: Docker.** Добавьте в `~/.claude.json` в раздел `mcpServers` (или в `.mcp.json` в корне
проекта, если сервер нужен только в нём):

```json
"bookstack": {
  "type": "stdio",
  "command": "docker",
  "args": [
    "run", "-i", "--rm", "--no-healthcheck",
    "-e", "BOOKSTACK_URL", "-e", "BOOKSTACK_TOKEN_ID", "-e", "BOOKSTACK_TOKEN_SECRET",
    "ghcr.io/yand3r3d3v/bookstack_mcp:latest", "node", "dist/index.js"
  ],
  "env": {
    "BOOKSTACK_URL": "https://wiki.example.com",
    "BOOKSTACK_TOKEN_ID": "...",
    "BOOKSTACK_TOKEN_SECRET": "..."
  }
}
```

Это тот же образ, что и для [общего сервера](#общий-сервер-http); `node dist/index.js` в конце
переключает его на stdio. Флаги `-e ИМЯ` без значения пробрасывают переменные из `env` в контейнер, так
что секрет не попадает в `args`. Образ мультиархитектурный (amd64 / arm64); `:latest` собирается из
`main`, теги релизов вроде `:0.1.0` фиксированы. Обновиться:
`docker pull ghcr.io/yand3r3d3v/bookstack_mcp:latest`. Если десктопное приложение не находит `docker`,
укажите абсолютный путь (`which docker`).

**Вариант В: из исходников.** Склонируйте, установите и запустите настройку:

```bash
git clone https://github.com/yand3r3d3v/bookstack_mcp.git
cd bookstack_mcp
npm install
npm run setup
```

`setup` спросит URL, Token ID и Token Secret, проверит подключение и пропишет сервер в `~/.claude.json`
(user scope — доступен во всех проектах; копия исходного файла сохраняется в `~/.claude.json.before-bookstack-mcp`).
Повторный запуск позволяет поменять настройки: Enter оставляет текущее значение.

**3. Откройте новую сессию** в Claude Code. Проверить можно командой `/mcp` — `bookstack` должен быть ✔.

<details>
<summary>Настройка вручную, без скрипта</summary>

Добавьте в `~/.claude.json` в раздел `mcpServers` (или в `.mcp.json` в корне проекта, если сервер нужен
только в нём):

```json
"bookstack": {
  "type": "stdio",
  "command": "/opt/homebrew/bin/node",
  "args": ["/путь/к/bookstack_mcp/dist/index.js"],
  "env": {
    "BOOKSTACK_URL": "https://wiki.example.com",
    "BOOKSTACK_TOKEN_ID": "...",
    "BOOKSTACK_TOKEN_SECRET": "..."
  }
}
```

Путь к `node` лучше указывать абсолютный: GUI-приложение может не видеть ваш `PATH` из shell.
Перед этим выполните `npm run build`, чтобы появился `dist/index.js`.
</details>

## Общий сервер (HTTP)

Вместо того чтобы каждый клонировал репозиторий, можно поднять один сервер на всю команду и подключать
его в Claude по URL. Он работает за reverse proxy на **подпути** существующего домена
(`https://tools.example.com/bookstack-mcp`) — новый домен и сертификат не нужны.

- **Каждый входит со своим API-токеном BookStack** через стандартный OAuth: Claude открывает страницу
  входа, вы вставляете Token ID и Secret — готово. У каждого остаются ровно его права в BookStack.
- **Сервер ничего не хранит.** Токены, которые он выдаёт Claude, зашифрованы ключом `MCP_AUTH_SECRET`
  и содержат внутри токен пользователя. Ни базы, ни сессий — можно спокойно перезапускать и масштабировать.
- **Отозвать доступ** = удалить API-токен в BookStack (срабатывает в течение 5 минут).

### Запуск

Образ уже собран и лежит в GHCR, так что нужен не репозиторий, а два файла:

```bash
mkdir bookstack-mcp && cd bookstack-mcp
curl -fsSLO https://raw.githubusercontent.com/yand3r3d3v/bookstack_mcp/main/compose.yaml
curl -fsSL https://raw.githubusercontent.com/yand3r3d3v/bookstack_mcp/main/.env.example -o .env
# заполните в .env BOOKSTACK_URL, MCP_PUBLIC_URL, MCP_AUTH_SECRET
docker compose up -d
```

Обновиться: `docker compose pull && docker compose up -d`. Из клона репозитория
`docker compose up -d --build` соберёт образ локально. Без Docker: `npm install && npm run build`,
задать переменные, `npm run serve`.

| Переменная | |
|---|---|
| `BOOKSTACK_URL` | Адрес BookStack, например `https://wiki.example.com` |
| `MCP_PUBLIC_URL` | Публичный адрес этого сервера **вместе с подпутём**, например `https://tools.example.com/bookstack-mcp`. MCP-эндпоинт — это адрес + `/mcp` |
| `MCP_AUTH_SECRET` | Ключ шифрования токенов, выдаваемых Claude: `openssl rand -base64 32`. Держите в секрете; смена ключа разлогинивает всех |
| `MCP_ALLOWED_REDIRECT_HOSTS` | Куда можно возвращаться после входа. По умолчанию `claude.ai,claude.com,localhost,127.0.0.1,[::1]` — для Claude достаточно; для других MCP-клиентов добавьте их хосты, `*` — любые |
| `MCP_HOST`, `MCP_PORT` | Адрес прослушивания, по умолчанию `127.0.0.1:3000` (в Docker — `0.0.0.0`) |
| `BOOKSTACK_READ_ONLY` | `true` — только инструменты чтения |

`BOOKSTACK_TOKEN_ID` / `BOOKSTACK_TOKEN_SECRET` в этом режиме не используются.

### Reverse proxy на подпути

nginx, в блоке `server` существующего домена:

```nginx
location /bookstack-mcp/ {
    proxy_pass http://127.0.0.1:3000;
}

# OAuth discovery сначала смотрит в корень домена (RFC 8414). Обязательно, если основной сайт отвечает
# 200 на любые URL (SPA, catch-all) — иначе Claude не подключится; в остальных случаях не мешает.
location = /.well-known/oauth-authorization-server/bookstack-mcp {
    proxy_pass http://127.0.0.1:3000;
}
location = /.well-known/oauth-protected-resource/bookstack-mcp/mcp {
    proxy_pass http://127.0.0.1:3000;
}
```

Подпуть можно передавать как есть (как выше) или срезать (`proxy_pass http://127.0.0.1:3000/;`) — сервер
понимает оба варианта. С любым другим прокси — аналогично. Для всего, кроме `localhost`, нужен HTTPS.

### Подключение к Claude

**Как коннектор** (десктопное приложение Claude, claude.ai — и чат, и Cowork, и вкладка Code):
*Settings → Connectors → Add custom connector*, URL `https://tools.example.com/bookstack-mcp/mcp`, затем
*Connect* и вход с токеном BookStack. На тарифах Team/Enterprise владелец добавляет его один раз на всю
организацию. Кастомные коннекторы Claude подключает **из облака Anthropic**, поэтому сервер должен быть
доступен из интернета, а не только из VPN.

**В Claude Code** (CLI; вкладка Code в десктопе читает тот же конфиг) — подключение идёт с вашей машины,
так что сервер может быть и внутренним:

```bash
claude mcp add --transport http --scope user bookstack https://tools.example.com/bookstack-mcp/mcp
```

Затем `/mcp` → `bookstack` → *Authenticate*. Или без OAuth, передав токен BookStack напрямую:

```bash
claude mcp add --transport http --scope user bookstack https://tools.example.com/bookstack-mcp/mcp --header "Authorization: Token TOKEN_ID:TOKEN_SECRET"
```

## Как пользоваться

Просто пишите обычным текстом:

- «найди в букстеке, как у нас настроен nginx»
- «что есть в книге Infra?»
- «запиши это в документацию, в книгу Infra, главу Networking»
- «добавь в страницу про VLAN раздел про камеры»
- «создай полку Проекты и книгу Backend на ней»

Для типового сценария «оформи итоги этого диалога как страницу» есть готовая команда:

```text
/mcp__bookstack__document
```

Claude найдёт подходящее место, проверит, нет ли уже страницы на эту тему (и тогда дополнит её, а не
создаст дубль), напишет текст для коллеги, который диалог не видел, и пришлёт ссылку.

Чтобы Claude Code не спрашивал разрешения на каждое чтение, добавьте в `~/.claude/settings.json`:

```json
{ "permissions": { "allow": ["mcp__bookstack__search", "mcp__bookstack__list", "mcp__bookstack__get"] } }
```

Инструменты записи при этом по-прежнему будут спрашивать подтверждение.

## Инструменты

| Инструмент | Что делает |
|---|---|
| `search` | Полнотекстовый поиск с синтаксисом BookStack: `"фраза"`, `[tag=value]`, `{in_name:...}` |
| `list` | Список полок / книг / глав / страниц; фильтр по имени и книге, сортировка по дате изменения |
| `get` | Страница — содержимое в Markdown; книга — оглавление; глава — страницы; полка — книги. Длинная страница обрезается по `max_chars` и дополняется оглавлением — дальше читается по `offset` или по одному разделу (`section`) |
| `create_page` | Новая страница из Markdown в главе или прямо в книге |
| `update_page` | Заменить текст, дописать в конец/начало (`mode`), переименовать, теги, перенести. С `expected_revision` обновление отклоняется, если страницу сохранили после того, как её прочитали |
| `edit_page` | Точечная замена фрагмента текста — не нужно пересылать всю страницу |
| `create_book` | Новая книга (сразу можно положить на полку) |
| `create_chapter` | Новая глава в книге |
| `create_shelf` | Новая полка с книгами |
| `update` | Переименовать / описание / теги у полки, книги, главы; перенести главу; книги на полке |
| `delete` | Удалить в корзину BookStack (восстанавливается в *Settings → Maintenance → Recycle Bin*) |

Все элементы в ответах выглядят как `[page:12] Название` — по этим id Claude потом обращается к ним.

## Markdown и WYSIWYG

В BookStack два редактора: **WYSIWYG** (визуальный, хранит HTML) и **Markdown** (хранит исходник
в Markdown). Сервер работает с Markdown и сохраняет «родной» редактор каждой страницы:

| | Markdown-страница | WYSIWYG-страница |
|---|---|---|
| Чтение (`get`) | исходник как есть | конвертируется в Markdown через экспорт BookStack |
| `update_page` | пишет Markdown | Markdown → HTML, страница остаётся WYSIWYG; при `append`/`prepend` существующий HTML не трогается |
| `edit_page` | точная замена в исходнике | недоступно (нет исходника) — используйте `update_page` |

Новые страницы всегда создаются в Markdown. Помимо обычного GFM (таблицы, чек-листы, блоки кода)
BookStack понимает callout-блоки: `<p class="callout info">Текст</p>` (`info`, `success`, `warning`, `danger`).

## Настройки

| Переменная | |
|---|---|
| `BOOKSTACK_URL` | Адрес BookStack, например `https://wiki.example.com` |
| `BOOKSTACK_TOKEN_ID` | Token ID |
| `BOOKSTACK_TOKEN_SECRET` | Token Secret |
| `BOOKSTACK_READ_ONLY` | `true` — только чтение: инструменты записи не регистрируются |

Все права определяются пользователем, которому принадлежит токен: сервер видит и меняет ровно то же, что
этот пользователь в веб-интерфейсе.

## Что есть, а чего нет

**Есть:** полки, книги, главы и страницы — чтение, полнотекстовый поиск, создание, редактирование
(полная замена, дописывание в конец/начало, точечная замена фрагмента), переименование, теги, перенос
между книгами/главами, добавление и удаление книг на полке, удаление в корзину.

**Пока нет** — потому что для запуска с Claude Code это не нужно в первую очередь:

- Изображения, чертежи и вложения (галерея изображений / attachments API)
- Комментарии к страницам
- Пользователи, роли и права доступа к контенту
- Сама корзина (восстановление или окончательное удаление) — только отправка туда
- Шаблоны страниц
- Журнал аудита (audit log)
- Экспорт в PDF / чистый HTML (экспорт в Markdown используется только внутри — для чтения WYSIWYG-страниц)
- Работа с несколькими инстансами BookStack из одного процесса сервера

Если что-то из этого нужно — это довольно локальные доработки в `src/tools.ts` и `src/bookstack.ts`,
issue или PR приветствуются.

## Если что-то не работает

Ошибки сервер возвращает прямо в диалог, Claude их покажет. Частые случаи:

- **«isn't configured»** — не заданы переменные окружения. Запустите `npm run setup` (Docker: проверьте
  и `env`, и флаги `-e` в `args`).
- **401** — неверный Token ID / Secret или токен истёк.
- **403** — у роли нет права *Access System API* или прав на конкретную книгу/страницу.
- **«redirects to https://…»** — укажите в URL `https://`.
- **Самоподписанный сертификат** — добавьте в `env` сервера `NODE_EXTRA_CA_CERTS=/путь/к/ca.pem`.
  В Docker файл нужно ещё и смонтировать: `"-v", "/путь/к/ca.pem:/ca.pem:ro", "-e", "NODE_EXTRA_CA_CERTS=/ca.pem"`.
- **Docker: BookStack на `localhost`** — внутри контейнера `localhost` — это сам контейнер; используйте
  `http://host.docker.internal:ПОРТ` (на Linux ещё добавьте в `args` `"--add-host=host.docker.internal:host-gateway"`).
- **Перенесли папку проекта** — снова запустите `npm run setup`: путь к серверу хранится в конфиге.
- **Лимит запросов** — по умолчанию в BookStack 180 запросов в минуту. Если ждать недолго (до 30 секунд
  в сумме), сервер сам подождёт и повторит запрос; иначе вернёт ошибку.

HTTP-режим:

- **Коннектор сразу падает / «Unexpected token '<'»** — корневые `.well-known` URL отдают HTML основного
  сайта; добавьте два блока `location = /.well-known/…` из примера для nginx.
- **«Redirects to … aren't allowed»** — хоста колбэка клиента нет в `MCP_ALLOWED_REDIRECT_HOSTS`.
- **После перезапуска всем приходится переподключаться** — не задан `MCP_AUTH_SECRET`, используется случайный.
- **Страница входа пишет, что токен отклонён** — те же причины, что у 401/403 выше, для токена этого пользователя.

## Разработка

```bash
npm run build
npm test
```

Тестам нужен Node 22.18+ (это TypeScript, который Node запускает напрямую). BookStack для них не нужен:
его API изображает `test/fake-bookstack.ts`.

- `src/bookstack.ts` — HTTP-клиент BookStack API и понятные сообщения об ошибках
- `src/tools.ts` — инструменты и промпт `document`
- `src/excerpt.ts` — чтение длинных страниц по частям: по разделу или по смещению
- `src/server.ts` — MCP-сервер и инструкции для модели, общие для обоих транспортов
- `src/index.ts` — запуск через stdio
- `src/http.ts` — запуск по HTTP: Streamable HTTP, маршрутизация на подпути
- `src/oauth.ts` — OAuth-вход по API-токену BookStack, stateless-шифрованные токены
- `src/setup.ts` — мастер настройки

**Релизы.** `npm version minor` (или `patch` / `major`) поднимает версию в `package.json` и создаёт тег;
после `git push --follow-tags` он публикуется: CI прогоняет тесты, выкладывает пакет в npm, создаёт
релиз на GitHub с автоматическим описанием и собирает Docker-образ с тегом версии. Публикация в npm
идёт через [trusted publishing](https://docs.npmjs.com/trusted-publishers): в настройках пакета на
npmjs.com этот репозиторий и `release.yml` указаны как издатель, так что токен хранить не нужно.
