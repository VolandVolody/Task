# Архитектура TaskOS

TaskOS — локальный command center для жизненного цикла задачи. Это не todo-list и не CRM. Главная сущность — `TASK`.

Продукт запускается на одном компьютере. Метаданные задач лежат в git-friendly каталоге `.taskos/`, поэтому дом и работа синхронизируются через GitHub. Облачной базы и сервера нет.

## Поток

```
UI (React)
  → HTTP + SSE
  → Task service / Orchestrator
       ├── AIProvider          сейчас только GrokBuildProvider
       ├── GitAdapter
       ├── ProcessRunner
       └── TaskStore
```

UI не вызывает Grok CLI. Единственная точка запуска модели — `GrokBuildProvider`.

## Пакеты

| Путь | Роль |
| --- | --- |
| `packages/core` | Домен: статусы, прогресс, ETA, id, ветки, разбор ответа Grok, файловое хранилище, блокировка |
| `apps/server` | Fastify: API, оркестратор, процессы, git, провайдер |
| `apps/web` | Интерфейс на русском |

`packages/core` не знает про HTTP и про конкретный CLI. Сервер подставляет реализацию `AIProvider`.

## AIProvider

```ts
generateSpec()
generatePlan()
executeTask()
reviewTask()
analyzeFeedback()
```

Сейчас реализован `GrokBuildProvider`. Он вызывает установленный `grok` 1.x в headless-режиме:

- промпт передаётся через `--prompt-file` (без кавычек Windows в командной строке);
- spec / plan / review / feedback: `--output-format json --json-schema`, `--permission-mode plan`, `--disallowed-tools run_terminal_cmd`, `--no-subagents`;
- кодовое выполнение: `--output-format streaming-json`, `--permission-mode bypassPermissions`, несколько `--deny` на опасный git (`push`, `reset --hard`, `clean`, удаление веток, `merge`, `rebase`, переход в `main`/`master`);
- живые строки `streaming-json` (`text`, `tool_call`, `tool_call_update`, `error`, `end`) превращаются в timeline и raw log. Поле `toolName` в этой сборке бывает `run_terminal_command`, а флаг `--disallowed-tools` ждёт id `run_terminal_cmd`.
- ответ со схемой на установленном `grok` 1.0.46 лежит в `structuredOutput`. Парсер также принимает `structured_output`. Если поля нет, берётся JSON из `text`.

Независимость ревьюера — это новый процесс без `--resume`, а не другая модель. Пока доступен один Grok. Имена `CodexProvider` / `ChatGPTProvider` / `GLMProvider` в коде не появляются и не имитируются.

Режимы качества отличаются числом проходов одного и того же CLI:

| Режим | Что запускается | Подпись в UI |
| --- | --- | --- |
| `fast` | builder, отдельного ревьюера нет | Grok ×1 |
| `verified` | builder + reviewer | Grok ×2 review |
| `deep` | builder → reviewer → до 2 циклов исправление + повторный reviewer | Grok ×3 deep |

## Статусы

`INBOX → SPEC → PLAN → BUILD → REVIEW → TEST → USER_QA → READY → DONE`

Дополнительно: `PAUSED`, `BLOCKED`, `CANCELLED`.

`DONE` недоступен, пока пользователь не подтвердил `USER_QA` (статус становится `READY`) и отдельно не закрыл задачу.

Замечание пользователя возвращает задачу в `BUILD`, затем снова `REVIEW → TEST → USER_QA`.

## Прогресс

Процент считает домен, не модель.

| Этап | Вес |
| --- | --- |
| SPEC | 10 |
| PLAN | 10 |
| BUILD | 35, внутри — по весам шагов плана |
| REVIEW | 15 |
| TEST | 15 |
| USER_QA | 10 |
| RELEASE | 5 |

Для `fast` отдельный reviewer не запускается: этап REVIEW засчитывается как пропущенный режимом, иначе шкала не может дойти до 100. Для задачи без кода TEST помечается `skipped` по той же причине. Оба решения записаны в `docs/DECISIONS.md`.

## Хранение

```
.taskos/
  config.json
  projects/PROJECT-0001.json
  tasks/TASK-0001/
    task.json
    request.md          # исходный текст, пишется один раз
    spec.md
    plan.md
    review.md
    result.md
    feedback/001.md
    runs/run-001.jsonl  # короткие события прогона

.taskos-local/          # gitignore
  locks/
  logs/
  prompts/
```

`request.md` не перезаписывается. `task.json` не содержит копии, которую можно случайно затереть API-сохранением.

Секреты, токены и `.env` в репозиторий не пишутся. Перед коммитом ветки задачи индекс проверяется на типичные имена секретов.

## Git

Для `requiresCode` оркестратор создаёт ветку `task/TASK-0001-short-name` от `baseBranch` (по умолчанию `main`).

Запрещено продуктом и правилами для Grok:

- работа прямо в `main`;
- force push;
- удаление `main`;
- merge без человека;
- `git reset --hard`, `git clean`, rebase и push из прогона.

Если рабочее дерево грязное, ветка не переключается. Конфликт не чинится автоматически.

`gh` используется только чтобы прочитать уже существующий PR. Без `gh` страница задачи всё равно показывает ветку, коммит и diff через `git`.

## Процессы

`ProcessRunner` хранит pid, статус, время, код выхода, stdout/stderr и умеет отменить процесс. Повторный запуск той же задачи блокируется файловым lock в `.taskos-local/locks`. Мёртвый pid считается устаревшим lock и снимается.

UI получает события по SSE `GET /api/events`. Параллельно пишется raw log.

## Запуск

Разработка: Vite `:5173` проксирует `/api` на Fastify `:8787`.

Продакшен-сборка: Fastify отдаёт `apps/web/dist` и API с одного порта.
