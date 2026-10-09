import { useRef, useState } from "react";
import type { TaskDetail } from "./api";

const STATUS: Record<string, string> = {
  INBOX: "Входящие",
  SPEC: "ТЗ",
  PLAN: "План",
  BUILD: "Выполнение",
  REVIEW: "Ревью",
  TEST: "Тесты",
  USER_QA: "На проверке",
  READY: "К закрытию",
  DONE: "Готово",
  PAUSED: "Пауза",
  BLOCKED: "Ждёт ответа",
  CANCELLED: "Отменено",
};

const TABS = [
  ["overview", "Обзор"],
  ["spec", "ТЗ"],
  ["plan", "План"],
  ["ai", "AI"],
  ["logs", "Журнал"],
  ["git", "Git"],
  ["tests", "Тесты"],
  ["files", "Файлы"],
] as const;

export type TabId = (typeof TABS)[number][0];

const ROLES: Record<string, string> = {
  spec: "ТЗ",
  plan: "План",
  builder: "Исполнитель",
  reviewer: "Ревьюер",
  fix: "Исправление",
  feedback: "Разбор замечания",
};

export function DetailView({
  task,
  log,
  tab,
  onTab,
  onClose,
  onRun,
  onPause,
  onResume,
  onReview,
  onApprove,
  onComplete,
  onPush,
  onFeedback,
  onArtifact,
}: {
  task: TaskDetail;
  log: string;
  tab: TabId;
  onTab: (tab: TabId) => void;
  onClose: () => void;
  onRun: () => void;
  onPause: () => void;
  onResume: () => void;
  onReview: () => void;
  onApprove: () => void;
  onComplete: () => void;
  onPush: () => void;
  onFeedback: (text: string) => void;
  onArtifact: (id: string, mode: "open" | "reveal") => void;
}) {
  const [note, setNote] = useState("");
  const [raw, setRaw] = useState(false);
  const [showError, setShowError] = useState(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const canFeedback = task.actions.canFeedback || task.status === "BLOCKED";
  const source = task.git.repoSource === "project" ? "Проект" : task.git.repoSource === "manual" ? "Вручную" : "нет";

  return (
    <>
      <button className="backdrop" aria-label="Закрыть" onClick={onClose} />
      <aside className="detail">
        <div className="detail-top">
          <div>
            <div className="id">{task.id}</div>
            <h2>{task.title}</h2>
            <div className="meta">
              <span className={`chip ${task.scope}`}>{task.scope === "work" ? "Работа" : "Личное"}</span>
              <span>{task.projectName || "без проекта"}</span>
              <span>{STATUS[task.status] ?? task.status}</span>
              <span>{task.aiLabel}</span>
              <span>{task.progress}%</span>
            </div>
          </div>
          <button className="ghost" onClick={onClose}>Закрыть</button>
        </div>
        <p className="hint">{task.etaLabel}</p>
        {task.reviewLabel && <p className="review-flag">{task.reviewLabel}</p>}
        {task.nextAction && <p>Дальше: {task.nextAction}</p>}
        {task.error && (
          <div className="error-card">
            <strong>{task.error.message}</strong>
            <div><button className="textish" onClick={() => setShowError((value) => !value)}>{showError ? "Скрыть подробности" : "Подробности"}</button></div>
            {showError && <pre>{task.error.details || task.error.code}</pre>}
          </div>
        )}
        <div className="actions">
          {task.actions.canResume && <button className="ghost" onClick={onResume}>Продолжить</button>}
          {task.actions.canPause && <button className="ghost" onClick={onPause}>Пауза</button>}
          {task.actions.canRun && <button className="primary" onClick={onRun} disabled={task.running}>{task.running ? "Выполняется…" : "Запустить"}</button>}
          {task.actions.canReview && <button className="ghost" onClick={onReview} disabled={task.running}>На ревью</button>}
          {task.actions.canApprove && <button className="ghost" onClick={() => noteRef.current?.focus()}>Проверить результат</button>}
          {task.actions.canApprove && <button className="primary" onClick={onApprove}>Подтвердить</button>}
          {task.actions.canComplete && <button className="primary" onClick={onComplete}>Закрыть задачу</button>}
          {task.actions.canPush && <button className="ghost" onClick={onPush}>Отправить ветку</button>}
        </div>
        <div className="tabs" role="tablist">
          {TABS.map(([id, label]) => (
            <button key={id} className={`tab ${tab === id ? "on" : ""}`} onClick={() => onTab(id)}>{label}</button>
          ))}
        </div>
        {tab === "overview" && (
          <div>
            <h3>Исходный запрос</h3>
            <p className="quote">{task.originalRequest}</p>
            <h3>Цель</h3>
            <p>{task.goal || "Появится вместе с ТЗ."}</p>
            <h3>Сейчас</h3>
            <p>{STATUS[task.currentStage] ?? task.currentStage}. {task.blockedReason || task.nextAction}</p>
            {task.assumptions.length > 0 && (
              <>
                <h3>Допущения</h3>
                <ul>{task.assumptions.map((item) => <li key={item}>{item}</li>)}</ul>
              </>
            )}
          </div>
        )}
        {tab === "spec" && <Doc text={task.documents.spec} empty="ТЗ появится после запуска." />}
        {tab === "plan" && (
          <ul className="check">
            {task.plan.length === 0 && <li>Плана ещё нет.</li>}
            {task.plan.map((step) => (
              <li key={step.id} className={step.status === "done" ? "done-step" : ""}>
                {step.status === "done" ? "✓" : "○"} {step.id} {step.title}
              </li>
            ))}
          </ul>
        )}
        {tab === "ai" && (
          <ul className="check">
            {task.aiRuns.length === 0 && <li>Прогонов ещё не было.</li>}
            {task.aiRuns.map((run) => (
              <li key={run.id}>
                <b>{ROLES[run.role] ?? run.role}</b> · {run.status}
                <div className="hint">{run.summary || "без итога"}{run.sessionId ? ` · ${run.sessionId}` : ""}</div>
              </li>
            ))}
          </ul>
        )}
        {tab === "logs" && (
          <div>
            <div className="subtabs">
              <button className={`subtab ${raw ? "" : "on"}`} onClick={() => setRaw(false)}>Timeline</button>
              <button className={`subtab ${raw ? "on" : ""}`} onClick={() => setRaw(true)}>Raw log</button>
            </div>
            {raw ? <pre className="log">{log || "Полный лог появится во время запуска. На другом компьютере его может не быть: в git уходит только timeline."}</pre> : (
              <ul className="timeline">
                {task.timeline.map((event) => (
                  <li key={event.id}><span className="time">{event.at.slice(11, 16)}</span>{event.message}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {tab === "git" && (
          <div className="meta" style={{ display: "grid", gap: 8 }}>
            <div>Репозиторий: {task.git.repoPath || "не выбран"}</div>
            <div>Источник: {source}</div>
            <div>Базовая ветка: {task.git.baseBranch || "определится при запуске"}</div>
            {task.git.baseBranchWarning && <div>{task.git.baseBranchWarning}</div>}
            <div>Команда тестов: {task.tests.command || "не задана"}</div>
            <div>Ветка: {task.git.branch || "нет"}</div>
            <div>Upstream: {task.git.upstream || "нет"}</div>
            <div>Ahead: {task.git.ahead ?? "—"} · Behind: {task.git.behind ?? "—"}</div>
            <div>Коммит: {task.git.headCommit || "нет"}</div>
            <div>Коммитов от {task.git.baseBranch}: {task.git.commitsCount}</div>
            <div>Изменённых файлов: {task.git.changedFiles}</div>
            {task.git.changedFileNames.length > 0 && <ul>{task.git.changedFileNames.map((file) => <li key={file}>{file}</li>)}</ul>}
            <div>PR: {task.git.prUrl ? <a href={task.git.prUrl}>{task.git.prState || "открыт"}</a> : task.git.prState || "нет, локальная ветка"}</div>
            {task.git.dirty && <div>Рабочее дерево грязное.</div>}
            {task.git.diffStat && <pre className="log">{task.git.diffStat}</pre>}
          </div>
        )}
        {tab === "tests" && (
          <div>
            <p>Статус: {task.tests.status}</p>
            <p>Команда: {task.tests.command || "не задана"}</p>
            <p>{task.tests.passed ?? "—"} passed / {task.tests.failed ?? "—"} failed</p>
            {task.testRuns.map((run) => (
              <p key={run.id}>{run.command} · exit {run.exitCode ?? "?"} · {run.status}</p>
            ))}
            {task.tests.summary && <pre className="log">{task.tests.summary}</pre>}
          </div>
        )}
        {tab === "files" && (
          <div>
            <h3>Документы задачи</h3>
            <ul>
              {task.documents.spec && <li>spec.md</li>}
              {task.documents.plan && <li>plan.md</li>}
              {task.documents.review && <li>review.md</li>}
              {task.documents.result && <li>result.md</li>}
              {task.feedback.map((item) => <li key={item.id}>feedback/{item.id}.md — {item.body}</li>)}
              {!task.documents.spec && !task.documents.result && task.feedback.length === 0 && <li>Документов пока нет.</li>}
            </ul>
            <h3>Сгенерированные артефакты</h3>
            <ul>
              {task.artifacts.length === 0 && <li>Артефактов пока нет.</li>}
              {task.artifacts.map((artifact) => (
                <li key={artifact.id}>
                  {artifact.name} · {artifact.path} · {artifact.missing ? "файл не найден" : `${artifact.sizeBytes ?? 0} байт`}
                  {!artifact.missing && (
                    <span className="actions">
                      <button type="button" className="textish" onClick={() => onArtifact(artifact.id, "open")}>Открыть</button>
                      <button type="button" className="textish" onClick={() => onArtifact(artifact.id, "reveal")}>Показать в папке</button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
            <h3>Изменённые исходники</h3>
            <ul>
              {task.git.changedFileNames.length === 0 && <li>Нет.</li>}
              {task.git.changedFileNames.map((file) => <li key={file}>{file}</li>)}
            </ul>
            {task.documents.result && <Doc text={task.documents.result} empty="" />}
          </div>
        )}
        {canFeedback && (
          <form onSubmit={(event) => { event.preventDefault(); if (!note.trim()) return; onFeedback(note.trim()); setNote(""); }}>
            <label htmlFor="note">{task.status === "BLOCKED" ? "Ваш ответ" : "Что не так?"}</label>
            <textarea ref={noteRef} id="note" value={note} onChange={(event) => setNote(event.target.value)} placeholder="кнопка не работает" />
            <div className="actions"><button className="primary" type="submit">Отправить на исправление</button></div>
          </form>
        )}
        {task.documents.result && tab === "overview" && <Doc text={task.documents.result} empty="" />}
      </aside>
    </>
  );
}

function Doc({ text, empty }: { text: string | null; empty: string }) {
  if (!text) return <p className="hint">{empty}</p>;
  return <div className="doc">{render(text)}</div>;
}

function render(text: string) {
  const blocks: { kind: "h" | "p" | "code" | "li"; text: string }[] = [];
  let code = false;
  let buffer: string[] = [];
  const flush = () => {
    if (buffer.length) blocks.push({ kind: "p", text: buffer.join(" ") });
    buffer = [];
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("```")) {
      if (code) {
        blocks.push({ kind: "code", text: buffer.join("\n") });
        buffer = [];
        code = false;
      } else {
        flush();
        code = true;
      }
      continue;
    }
    if (code) {
      buffer.push(line);
      continue;
    }
    if (line.startsWith("# ")) {
      flush();
      blocks.push({ kind: "h", text: line.slice(2) });
    } else if (line.startsWith("- ")) {
      flush();
      blocks.push({ kind: "li", text: line.slice(2) });
    } else if (line.trim() === "") flush();
    else buffer.push(line.trim());
  }
  flush();
  return blocks.map((block, index) => {
    if (block.kind === "h") return <h3 key={index}>{block.text}</h3>;
    if (block.kind === "code") return <pre key={index}>{block.text}</pre>;
    if (block.kind === "li") return <ul key={index}><li>{block.text}</li></ul>;
    return <p key={index}>{block.text}</p>;
  });
}
