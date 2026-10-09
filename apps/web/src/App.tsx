import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api, type Health, type Project, type TaskCard, type TaskDetail } from "./api";
import { DetailView, type TabId } from "./detail";

type Scope = "work" | "personal";
type Bucket = "inbox" | "active" | "qa" | "paused" | "done" | "all";

const BUCKETS: { id: Bucket; label: string }[] = [
  { id: "inbox", label: "Входящие" },
  { id: "active", label: "Активные" },
  { id: "qa", label: "На проверке" },
  { id: "paused", label: "Приостановлено" },
  { id: "done", label: "Готово" },
  { id: "all", label: "Все" },
];

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

export function App() {
  const [scope, setScope] = useState<Scope>("work");
  const [bucket, setBucket] = useState<Bucket>("active");
  const [tasks, setTasks] = useState<TaskCard[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [showProjects, setShowProjects] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [log, setLog] = useState("");
  const [tab, setTab] = useState<TabId>("overview");

  async function reload() {
    const [taskBody, projectBody] = await Promise.all([
      api<{ tasks: TaskCard[] }>(`/api/tasks?scope=${scope}`),
      api<{ projects: Project[] }>("/api/projects"),
    ]);
    setTasks(taskBody.tasks);
    setProjects(projectBody.projects.filter((project) => project.scope === scope));
  }

  useEffect(() => {
    api<Health>("/api/health").then(setHealth).catch(() => setError("Сервер TaskOS недоступен. Запустите npm run dev."));
  }, []);

  useEffect(() => {
    reload().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Не удалось загрузить задачи"));
  }, [scope]);

  useEffect(() => {
    const source = new EventSource("/api/events");
    source.onmessage = (event) => {
      let data: { type?: string; task?: TaskCard; taskId?: string; line?: string };
      try {
        data = JSON.parse(event.data) as typeof data;
      } catch {
        return;
      }
      if (data.type === "task" && data.task) {
        const incoming = data.task;
        setTasks((current) => {
          if (incoming.scope !== scope) return current.filter((item) => item.id !== incoming.id);
          const index = current.findIndex((item) => item.id === incoming.id);
          if (index < 0) return [incoming, ...current];
          const next = current.slice();
          next[index] = incoming;
          return next;
        });
        if (incoming.id === selected) {
          api<{ task: TaskDetail }>(`/api/tasks/${incoming.id}`).then((body) => setDetail(body.task)).catch(() => undefined);
        }
      }
      if (data.type === "log" && data.taskId === selected && data.line) {
        setLog((current) => `${current}\n${data.line}`.slice(-12000));
      }
    };
    return () => source.close();
  }, [selected, scope]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    api<{ task: TaskDetail }>(`/api/tasks/${selected}`).then((body) => setDetail(body.task)).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Задача не открылась"));
    api<{ log: string }>(`/api/tasks/${selected}/log`).then((body) => setLog(body.log)).catch(() => setLog(""));
  }, [selected]);

  const visible = useMemo(() => tasks.filter((task) => inBucket(task.status, bucket)), [tasks, bucket]);
  const counts = useMemo(() => Object.fromEntries(BUCKETS.map((item) => [item.id, tasks.filter((task) => inBucket(task.status, item.id)).length])), [tasks]);

  async function act(path: string) {
    if (!selected) return;
    setError(null);
    try {
      await api(`/api/tasks/${selected}/${path}`, { method: "POST" });
      if (path !== "run" && path !== "review") {
        const body = await api<{ task: TaskDetail }>(`/api/tasks/${selected}`);
        setDetail(body.task);
      }
      await reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Действие не выполнилось");
    }
  }

  const hour = new Date().getHours();
  const hello = hour < 12 ? "Доброе утро" : hour < 18 ? "Добрый день" : "Добрый вечер";

  return (
    <div className="shell">
      <aside className="side">
        <div>
          <div className="brand"><span className="mark" /><strong>TaskOS</strong></div>
          <p className="brand-sub">личный контур задач</p>
        </div>
        <div className="switch" role="group" aria-label="Раздел">
          <button className={scope === "work" ? "on" : ""} onClick={() => { setScope("work"); setShowProjects(false); }}>Работа</button>
          <button className={scope === "personal" ? "on" : ""} onClick={() => { setScope("personal"); setShowProjects(false); }}>Личное</button>
        </div>
        <nav className="nav">
          {BUCKETS.map((item) => (
            <button key={item.id} className={!showProjects && bucket === item.id ? "on" : ""} onClick={() => { setBucket(item.id); setShowProjects(false); }}>
              {item.label}<em>{counts[item.id] ?? 0}</em>
            </button>
          ))}
        </nav>
        <div className="side-label">Проекты</div>
        <div className="projects-mini">
          <button className={`textish ${showProjects ? "on" : ""}`} onClick={() => setShowProjects(true)}>Все проекты</button>
          {projects.slice(0, 6).map((project) => (
            <button key={project.id} className="textish" onClick={() => setShowProjects(true)}>{project.name}</button>
          ))}
        </div>
      </aside>
      <main className="main">
        <header className="top">
          <div>
            <p className="eyebrow">{new Date().toLocaleDateString("ru-RU", { day: "numeric", month: "long" })}</p>
            <h1>{hello}</h1>
          </div>
          <button className="primary" onClick={() => setCreating(true)}>+ Новая задача</button>
        </header>
        {health?.runtime === "fake" && <div className="banner warn">Режим проверки: AI-заглушка, это не Grok.</div>}
        {health && !health.grok && health.runtime !== "fake" && <div className="banner warn">Grok Build не найден в PATH. Задачи сохранятся, но запуск AI не начнётся.</div>}
        {error && <div className="banner">{error}</div>}
        {showProjects ? <Projects projects={projects} scope={scope} onCreated={reload} /> : (
          <>
            <div className="stats">
              <div><strong>{tasks.filter((task) => ["SPEC", "PLAN", "BUILD", "REVIEW", "TEST"].includes(task.status)).length}</strong>в работе</div>
              <div><strong>{tasks.filter((task) => task.status === "USER_QA").length}</strong>ждут вас</div>
              <div><strong>{tasks.filter((task) => task.running).length}</strong>идут сейчас</div>
            </div>
            <section className="cards">
              {visible.length === 0 && (
                <div className="empty">
                  <strong>Пока пусто</strong>
                  Сюда попадут задачи, которые не должны потеряться на половине пути.
                </div>
              )}
              {visible.map((task) => (
                <button key={task.id} className="card" onClick={() => { setSelected(task.id); setTab("overview"); }}>
                  <div>
                    <div className="id">{task.id}</div>
                    <h2>{task.title}</h2>
                    <div className="meta">
                      <span className={`chip ${task.scope}`}>{task.scope === "work" ? "Работа" : "Личное"}</span>
                      {task.projectName && <span>{task.projectName}</span>}
                      <span>{task.aiLabel}</span>
                      {task.running && <span className="chip live">идёт</span>}
                    </div>
                  </div>
                  <div className="side-note">
                    <b>{STATUS[task.status] ?? task.status}</b>
                    {task.tests.passed !== null && <span>Тесты: {task.tests.passed}{task.tests.failed !== null ? ` / ${task.tests.passed + task.tests.failed}` : ""}</span>}
                    <span>{task.etaLabel}</span>
                  </div>
                  <Meter value={task.progress} personal={task.scope === "personal"} />
                </button>
              ))}
            </section>
          </>
        )}
      </main>
      {creating && <NewTask scope={scope} projects={projects} onClose={() => setCreating(false)} onCreated={async (id) => { setCreating(false); await reload(); setSelected(id); }} />}
      {detail && (
        <DetailView
          task={detail}
          log={log}
          tab={tab}
          onTab={setTab}
          onClose={() => setSelected(null)}
          onRun={() => act("run")}
          onPause={() => act("pause")}
          onResume={() => act("resume")}
          onReview={() => act("review")}
          onApprove={() => act("approve")}
          onComplete={() => act("complete")}
          onFeedback={async (text) => {
            setError(null);
            try {
              await api(`/api/tasks/${detail.id}/feedback`, { method: "POST", body: JSON.stringify({ text }) });
              const body = await api<{ task: TaskDetail }>(`/api/tasks/${detail.id}`);
              setDetail(body.task);
              await reload();
            } catch (reason) {
              setError(reason instanceof Error ? reason.message : "Замечание не отправилось");
            }
          }}
        />
      )}
    </div>
  );
}

function Meter({ value, personal }: { value: number; personal: boolean }) {
  const cells = 18;
  const filled = Math.round((value / 100) * cells);
  return (
    <div className={`meter ${personal ? "personal" : ""}`} aria-label={`${value}%`}>
      {Array.from({ length: cells }, (_, index) => <i key={index} className={index < filled ? "on" : ""} />)}
      <span>{value}%</span>
    </div>
  );
}

function inBucket(status: string, bucket: Bucket): boolean {
  if (bucket === "all") return true;
  if (bucket === "inbox") return status === "INBOX";
  if (bucket === "active") return ["SPEC", "PLAN", "BUILD", "REVIEW", "TEST", "BLOCKED"].includes(status);
  if (bucket === "qa") return status === "USER_QA" || status === "READY";
  if (bucket === "paused") return status === "PAUSED";
  return status === "DONE" || status === "CANCELLED";
}

function NewTask({ scope, projects, onClose, onCreated }: { scope: Scope; projects: Project[]; onClose: () => void; onCreated: (id: string) => void }) {
  const [request, setRequest] = useState("");
  const [ownScope, setOwnScope] = useState<Scope>(scope);
  const [choice, setChoice] = useState("auto");
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [newName, setNewName] = useState("");
  const [quality, setQuality] = useState("verified");
  const [code, setCode] = useState("auto");
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      const body = await api<{ task: TaskCard }>("/api/tasks", {
        method: "POST",
        body: JSON.stringify({
          request,
          scope: ownScope,
          projectChoice: choice,
          projectId,
          newProjectName: newName,
          qualityMode: quality,
          requiresCodeMode: code,
        }),
      });
      onCreated(body.task.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось создать задачу");
    }
  }

  return (
    <>
      <button className="backdrop" aria-label="Закрыть" onClick={onClose} />
      <form className="modal" onSubmit={submit}>
        <div className="modal-top"><h2>Новая задача</h2><button type="button" className="ghost" onClick={onClose}>Закрыть</button></div>
        <label htmlFor="request">Что нужно сделать?</label>
        <textarea id="request" autoFocus value={request} onChange={(event) => setRequest(event.target.value)} placeholder="сделать импорт нового поставщика" />
        <div className="choices" role="group" aria-label="Раздел задачи">
          <button type="button" className={ownScope === "work" ? "on" : ""} onClick={() => setOwnScope("work")}>Работа</button>
          <button type="button" className={ownScope === "personal" ? "on" : ""} onClick={() => setOwnScope("personal")}>Личное</button>
        </div>
        <label htmlFor="project">Проект</label>
        <select id="project" value={choice} onChange={(event) => setChoice(event.target.value)}>
          <option value="auto">Автоматически</option>
          <option value="none">Без проекта</option>
          <option value="existing" disabled={projects.length === 0}>Существующий</option>
          <option value="new">Создать новый</option>
        </select>
        {choice === "existing" && (
          <select aria-label="Существующий проект" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        )}
        {choice === "new" && <input aria-label="Имя проекта" value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Имя проекта" />}
        <label>Режим качества</label>
        <div className="quality">
          <button type="button" className={quality === "fast" ? "on" : ""} onClick={() => setQuality("fast")}>Быстро<small>Grok ×1</small></button>
          <button type="button" className={quality === "verified" ? "on" : ""} onClick={() => setQuality("verified")}>С проверкой<small>Grok ×2 review</small></button>
          <button type="button" className={quality === "deep" ? "on" : ""} onClick={() => setQuality("deep")}>Глубоко<small>Grok ×3 deep</small></button>
        </div>
        <label>Код</label>
        <div className="choices">
          <button type="button" className={code === "auto" ? "on" : ""} onClick={() => setCode("auto")}>Авто</button>
          <button type="button" className={code === "yes" ? "on" : ""} onClick={() => setCode("yes")}>Нужен git</button>
          <button type="button" className={code === "no" ? "on" : ""} onClick={() => setCode("no")}>Без кода</button>
        </div>
        {error && <div className="banner">{error}</div>}
        <div className="actions"><button className="primary" type="submit">Создать</button></div>
      </form>
    </>
  );
}

function Projects({ projects, scope, onCreated }: { projects: Project[]; scope: Scope; onCreated: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [state, setState] = useState("");
  const [next, setNext] = useState("");
  const [done, setDone] = useState("");
  const [stages, setStages] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        name,
        scope,
        goal,
        currentState: state,
        nextAction: next,
        definitionOfDone: done,
        stages: stages.split("\n").map((title) => title.trim()).filter(Boolean).map((title, index) => ({ id: String(index + 1), title, status: "todo" })),
      }),
    });
    setOpen(false);
    setName("");
    await onCreated();
  }

  return (
    <section>
      <div className="top"><h2>Проекты</h2><button className="ghost" onClick={() => setOpen((value) => !value)}>+ Проект</button></div>
      {open && (
        <form onSubmit={submit} className="project">
          <input aria-label="Имя" value={name} onChange={(event) => setName(event.target.value)} placeholder="Имя" required />
          <input aria-label="Цель" value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="Цель" />
          <input aria-label="Сейчас" value={state} onChange={(event) => setState(event.target.value)} placeholder="Текущее состояние" />
          <input aria-label="Дальше" value={next} onChange={(event) => setNext(event.target.value)} placeholder="Следующий шаг" />
          <input aria-label="Готово когда" value={done} onChange={(event) => setDone(event.target.value)} placeholder="Definition of Done" />
          <textarea aria-label="Этапы" value={stages} onChange={(event) => setStages(event.target.value)} placeholder={"Этапы, по одному в строке\nмодель\nпечать"} />
          <button className="primary" type="submit">Сохранить проект</button>
        </form>
      )}
      {projects.length === 0 && <div className="empty"><strong>Проектов нет</strong>Личная идея не должна оставаться безымянной карточкой.</div>}
      {projects.map((project) => (
        <article key={project.id} className="project">
          <div className="id">{project.id}</div>
          <h2>{project.name}</h2>
          <p>{project.goal || "Цель ещё не записана"}</p>
          <div className="meta">
            <span>Сейчас: {project.currentState || "—"}</span>
            <span>Дальше: {project.nextAction || "—"}</span>
            {project.inactivity && <span className="chip">{project.inactivity}</span>}
          </div>
          {project.definitionOfDone && <p>Готово, когда: {project.definitionOfDone}</p>}
          {project.stages.length > 0 && <div className="meta">{project.stages.map((stage) => <span key={stage.id}>{stage.title}</span>)}</div>}
        </article>
      ))}
    </section>
  );
}
