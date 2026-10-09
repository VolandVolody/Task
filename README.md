# TaskOS

Локальный command center для полного цикла задачи: сырой запрос, ТЗ, план, выполнение, ревью, тесты, проверка человеком и только потом закрытие.

Это не todo-list и не CRM. Главная сущность — `TASK`. Работа и личное живут в одном интерфейсе, но не смешиваются.

Метаданные лежат в `.taskos/` и ездят между домом и работой через GitHub. Облачной базы нет. Модель вызывается только через установленный на компьютере Grok Build CLI.

## Архитектура

```text
UI (React)
  → HTTP + SSE
  → Orchestrator
       ├── AIProvider        сейчас GrokBuildProvider
       ├── GitAdapter
       ├── ProcessRunner
       └── TaskStore
```

| Путь | Роль |
| --- | --- |
| `packages/core` | Статусы, прогресс, ETA, id, ветки, разбор ответа Grok, файлы, lock |
| `apps/server` | Fastify, оркестратор, процессы, git |
| `apps/web` | Интерфейс на русском |

UI не вызывает `grok`. Подробности — в [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Короткие решения — в [docs/DECISIONS.md](docs/DECISIONS.md).

Позже в тот же интерфейс `AIProvider` можно добавить другие CLI. Сейчас реализован только Grok.

## Требования

- Windows, macOS или Linux
- Node.js 22+
- Git
- [Grok Build CLI](https://x.ai) в `PATH` (`grok --version`). Проверено на `grok 1.0.46`
- GitHub CLI `gh` не обязателен. Без него PR просто не показывается

## Установка

```bash
npm install
```

## Запуск

Разработка (Vite `:5173`, API `:8787`, только `127.0.0.1`):

```bash
npm run dev
```

Откройте `http://127.0.0.1:5173`.

Сборка и один процесс:

```bash
npm run build
npm start
```

После сборки интерфейс и API открываются на `http://127.0.0.1:8787`.

Проверки:

```bash
npm test
npm run lint
npm run typecheck
```

## Как подключается Grok Build

1. Установите CLI и выполните `grok login`.
2. Убедитесь, что `grok` находится через `where grok` или `which grok`.
3. В `.taskos/config.json` заданы `grokCommand` и `grokModel` (`grok-4.7` по умолчанию).

TaskOS вызывает CLI сам:

- ТЗ, план, ревью и разбор замечания: `grok --prompt-file … --output-format json --json-schema … --permission-mode plan --disallowed-tools run_terminal_cmd --no-subagents`
- Кодовое выполнение: `--output-format streaming-json --permission-mode bypassPermissions` и `--deny` на `push`, `merge`, `rebase`, `reset --hard`, `clean`, удаление веток и переход в `main`
- Живые строки попадают в timeline и во вкладку Raw log через SSE `GET /api/events`

Режимы качества — это число проходов одного и того же Grok, а не разные модели:

| Режим | Проходы | Подпись |
| --- | --- | --- |
| Быстро | один builder | Grok ×1 |
| С проверкой | builder + новый процесс reviewer | Grok ×2 review |
| Глубоко | builder, reviewer и до двух циклов исправления | Grok ×3 deep |

`TASKOS_AI=fake` подменяет провайдер заглушкой для тестов. В интерфейсе в этом случае есть плашка. Задачи всё равно помечены провайдером `grok-build`.

## Как устроена задача

Статусы: `INBOX → SPEC → PLAN → BUILD → REVIEW → TEST → USER_QA → READY → DONE`.

Дополнительно: `PAUSED`, `BLOCKED`, `CANCELLED`.

Исходный текст лежит в `request.md` и больше не перезаписывается. ТЗ и план — отдельные файлы. Если данных мало, модель записывает допущение. В `BLOCKED` задача уходит только при критической неоднозначности.

Процент считает система, не модель:

`SPEC 10 + PLAN 10 + BUILD 35 + REVIEW 15 + TEST 15 + USER_QA 10 + RELEASE 5`.

Внутри `BUILD` доля берётся из весов шагов плана. Для режима «Быстро» отдельный reviewer не запускается, и этап REVIEW помечается пропущенным. Для задачи без кода так же пропускаются тесты.

`DONE` недоступен, пока человек не нажал «Подтвердить» на `USER_QA`. Замечание («Что не так?») возвращает задачу в `BUILD`, затем снова ревью, тесты и проверка.

ETA — диапазон. Пока по этапу меньше трёх замеров, подпись начинается с «Оценка пока неточная».

## Структура `.taskos`

```text
.taskos/
  config.json
  projects/PROJECT-0001.json
  tasks/TASK-0001/
    task.json
    request.md
    spec.md
    plan.md
    review.md
    result.md
    feedback/001.md
    runs/run-001.jsonl

.taskos-local/          # в .gitignore
  locks/
  logs/
  prompts/
```

Секреты и сырой stdout в git не коммитятся. Между компьютерами едут `task.json`, документы и короткий timeline.

## Git workflow

Разработка самого TaskOS идёт в ветке `dev/taskos-mvp`. В `main` напрямую не коммитим и не мержим без отдельного решения.

Для задачи с кодом оркестратор создаёт ветку `task/TASK-0001-short-name` от `baseBranch` (по умолчанию `main`).

- грязное дерево не переключается, показывается `REPO_DIRTY`;
- конфликт не чинится автоматически;
- коммит TaskOS разрешён только в `task/…`;
- `.taskos` и `.taskos-local` в этот коммит не входят;
- файлы вроде `.env` и ключей из индекса убираются, коммит останавливается;
- force push, удаление `main` и merge продукт не делает.

Каталог репозитория берётся из `repoPath` задачи или `defaultRepoPath` в конфиге. Для задач про сам TaskOS укажите этот клон. Не запускайте кодовую задачу, пока в клоне есть чужие незакоммиченные файлы: переключение ветки будет заблокировано.

## Известные ограничения MVP

- Один провайдер: Grok Build. Codex, ChatGPT и GLM не подключены.
- Нет аккаунтов, команд, почты, Telegram, календаря и push-уведомлений.
- Нет автоматического merge и push. PR читается через `gh`, если он уже есть.
- План выполняется одним проходом builder, а не отдельным процессом на каждый шаг.
- ETA грубый, пока мало истории длительностей.
- Raw log остаётся на том компьютере, где шёл процесс.
- Сервер слушает только localhost. Это однопользовательский локальный инструмент.
- Шрифты системные, чтобы экран открывался без сети.

## Roadmap

- Второй провайдер за интерфейсом `AIProvider`, первым кандидатом — Codex как независимый reviewer.
- Разные роли (planner / builder / reviewer) на разных CLI без смены ядра.
- Более точный ETA по истории этапов.
- Отдельный прогон на каждый шаг плана, а не один общий builder.
- Явный push ветки `task/…` только после подтверждения.
- Напоминание о проекте без движения дольше N дней внутри интерфейса, без push.
