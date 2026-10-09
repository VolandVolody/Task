import fs from "node:fs";
import path from "node:path";
import type {
  AiRouting,
  BuildArtifactRef,
  CreateTaskInput,
  FeedbackItem,
  Project,
  ProjectRepository,
  ProjectStage,
  Task,
  TaskArtifact,
  TaskView,
  TaskosConfig,
  TestRun,
} from "./types.js";
import { WorkflowError } from "./types.js";
import { computeProgress, createTask } from "./workflow.js";

export type DocName = "spec.md" | "plan.md" | "review.md" | "result.md";

export const DEFAULT_ROUTING: AiRouting = {
  spec: "grok-build",
  plan: "grok-build",
  builder: "grok-build",
  reviewer: "grok-build",
  feedback: "grok-build",
};

export const DEFAULT_CONFIG: TaskosConfig = {
  version: 1,
  grokCommand: "grok",
  grokModel: "grok-4.7",
  baseBranch: "main",
  defaultRepoPath: ".",
  testCommand: "npm test",
  grokTimeoutMs: 900000,
  aiRouting: DEFAULT_ROUTING,
};

export class TaskStore {
  readonly dataDir: string;
  readonly localDir: string;

  constructor(readonly root: string) {
    this.dataDir = path.join(root, ".taskos");
    this.localDir = path.join(root, ".taskos-local");
  }

  ensure(): void {
    for (const dir of [
      this.dataDir,
      path.join(this.dataDir, "projects"),
      path.join(this.dataDir, "tasks"),
      this.localDir,
      path.join(this.localDir, "locks"),
      path.join(this.localDir, "logs"),
      path.join(this.localDir, "prompts"),
    ]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(this.configPath())) this.saveConfig(DEFAULT_CONFIG);
  }

  getConfig(): TaskosConfig {
    this.ensure();
    try {
      const parsed = JSON.parse(fs.readFileSync(this.configPath(), "utf8")) as Partial<TaskosConfig>;
      return {
        ...DEFAULT_CONFIG,
        ...parsed,
        version: 1,
        aiRouting: { ...DEFAULT_ROUTING, ...(parsed.aiRouting ?? {}) },
      };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  saveConfig(config: TaskosConfig): void {
    writeJson(this.configPath(), config);
  }

  listTaskIds(): string[] {
    const dir = path.join(this.dataDir, "tasks");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^TASK-\d+$/.test(entry.name))
      .map((entry) => entry.name);
  }

  listTasks(): TaskView[] {
    return this.listTaskIds()
      .map((id) => this.getTask(id))
      .sort((a, b) => (a.task.updatedAt < b.task.updatedAt ? 1 : -1));
  }

  getTask(id: string): TaskView {
    assertId(id, "TASK");
    const file = this.taskFile(id);
    if (!fs.existsSync(file)) throw new WorkflowError(`Задача ${id} не найдена`);
    const task = normalizeTask(JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Task>);
    return { task, originalRequest: this.readRequest(id) };
  }

  createTask(input: CreateTaskInput, now: string): TaskView {
    this.ensure();
    const task = createTask(input, this.listTaskIds(), now);
    const dir = this.taskDir(task.id);
    fs.mkdirSync(path.join(dir, "feedback"), { recursive: true });
    fs.mkdirSync(path.join(dir, "runs"), { recursive: true });
    writeText(path.join(dir, "request.md"), input.request.trim() + "\n");
    writeJson(this.taskFile(task.id), task);
    return { task, originalRequest: input.request.trim() };
  }

  save(view: TaskView): void {
    assertId(view.task.id, "TASK");
    const requestPath = path.join(this.taskDir(view.task.id), "request.md");
    if (!fs.existsSync(requestPath)) throw new WorkflowError("Пропал исходный запрос задачи");
    const stored = fs.readFileSync(requestPath, "utf8").trim();
    if (stored !== view.originalRequest.trim()) {
      throw new WorkflowError("Исходный запрос нельзя изменять");
    }
    const task = { ...view.task, progress: computeProgress(view.task) };
    if (task.timeline.length > 300) task.timeline = task.timeline.slice(-300);
    writeJson(this.taskFile(task.id), task);
    view.task.progress = task.progress;
  }

  writeDoc(id: string, name: DocName, markdown: string): void {
    assertId(id, "TASK");
    writeText(path.join(this.taskDir(id), name), markdown.endsWith("\n") ? markdown : `${markdown}\n`);
  }

  readDoc(id: string, name: DocName): string | null {
    const file = path.join(this.taskDir(id), name);
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, "utf8");
  }

  addFeedback(id: string, body: string, now: string): FeedbackItem {
    const dir = path.join(this.taskDir(id), "feedback");
    fs.mkdirSync(dir, { recursive: true });
    const numbers = fs
      .readdirSync(dir)
      .map((name) => Number(name.match(/^(\d+)\.md$/)?.[1] ?? 0))
      .filter((value) => value > 0);
    const next = String(Math.max(0, ...numbers) + 1).padStart(3, "0");
    const item: FeedbackItem = { id: next, createdAt: now, body: body.trim() };
    writeText(path.join(dir, `${next}.md`), `createdAt: ${now}\n\n${item.body}\n`);
    return item;
  }

  listFeedback(id: string): FeedbackItem[] {
    const dir = path.join(this.taskDir(id), "feedback");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((name) => /^\d+\.md$/.test(name))
      .sort()
      .map((name) => {
        const raw = fs.readFileSync(path.join(dir, name), "utf8");
        const match = raw.match(/^createdAt:\s*(.+)\r?\n\r?\n([\s\S]*)$/);
        return {
          id: name.replace(/\.md$/, ""),
          createdAt: match?.[1]?.trim() ?? "",
          body: (match?.[2] ?? raw).trim(),
        };
      });
  }

  appendRun(id: string, runId: string, event: unknown): void {
    const dir = path.join(this.taskDir(id), "runs");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${runId}.jsonl`), `${JSON.stringify(event)}\n`, "utf8");
  }

  listProjects(): Project[] {
    const dir = path.join(this.dataDir, "projects");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((name) => /^PROJECT-\d+\.json$/.test(name))
      .map((name) => normalizeProject(JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as Partial<Project>))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  createProject(
    input: Omit<Project, "schemaVersion" | "id" | "createdAt" | "updatedAt" | "repository"> & {
      id?: string;
      repository?: ProjectRepository | null;
    },
    now: string,
  ): Project {
    this.ensure();
    const ids = this.listProjects().map((project) => project.id);
    const project: Project = {
      schemaVersion: 1,
      id: input.id ?? nextProjectId(ids),
      name: input.name.trim(),
      scope: input.scope,
      goal: input.goal.trim(),
      currentState: input.currentState.trim(),
      nextAction: input.nextAction.trim(),
      definitionOfDone: input.definitionOfDone.trim(),
      stages: input.stages,
      repository: input.repository ?? null,
      createdAt: now,
      updatedAt: now,
    };
    if (!project.name) throw new WorkflowError("У проекта нужно имя");
    writeJson(path.join(this.dataDir, "projects", `${project.id}.json`), project);
    return project;
  }

  saveProject(project: Project): void {
    writeJson(path.join(this.dataDir, "projects", `${project.id}.json`), project);
  }

  touchProject(id: string, now: string): void {
    const file = path.join(this.dataDir, "projects", `${id}.json`);
    if (!fs.existsSync(file)) return;
    const project = normalizeProject(JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Project>);
    project.updatedAt = now;
    this.saveProject(project);
  }

  findProjectByName(name: string): Project | undefined {
    const needle = name.trim().toLowerCase();
    return this.listProjects().find((project) => project.name.toLowerCase() === needle);
  }

  logFile(taskId: string, runId: string): string {
    const dir = path.join(this.localDir, "logs", taskId);
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${runId}.log`);
  }

  appendLog(taskId: string, runId: string, line: string): void {
    fs.appendFileSync(this.logFile(taskId, runId), `${line}\n`, "utf8");
  }

  readLogTail(taskId: string, maxLines = 200): string {
    const dir = path.join(this.localDir, "logs", taskId);
    if (!fs.existsSync(dir)) return "";
    const files = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".log"))
      .sort();
    const latest = files[files.length - 1];
    if (!latest) return "";
    const lines = fs.readFileSync(path.join(dir, latest), "utf8").split(/\r?\n/);
    return lines.slice(-maxLines).join("\n").trim();
  }

  listArtifacts(id: string): TaskArtifact[] {
    assertId(id, "TASK");
    const file = path.join(this.taskDir(id), "artifacts.json");
    if (!fs.existsSync(file)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { artifacts?: TaskArtifact[] };
      return Array.isArray(parsed.artifacts) ? parsed.artifacts.map(normalizeArtifact) : [];
    } catch {
      return [];
    }
  }

  saveArtifacts(id: string, artifacts: TaskArtifact[]): void {
    assertId(id, "TASK");
    writeJson(path.join(this.taskDir(id), "artifacts.json"), { artifacts });
  }

  registerArtifacts(id: string, repo: string, refs: BuildArtifactRef[], now: string, source: TaskArtifact["source"] = "ai"): TaskArtifact[] {
    const current = this.listArtifacts(id);
    const next = current.slice();
    for (const ref of refs) {
      const rel = ref.path.replace(/\\/g, "/").replace(/^\.\//, "");
      if (!rel || rel.split("/").includes("..")) continue;
      const abs = path.resolve(repo, rel);
      const root = path.resolve(repo);
      const relative = path.relative(root, abs);
      if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
      let size: number | null = null;
      try {
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) size = fs.statSync(abs).size;
      } catch {
        size = null;
      }
      const existing = next.find((item) => item.path === relative.replace(/\\/g, "/"));
      if (existing) {
        existing.sizeBytes = size;
        existing.name = ref.label || existing.name;
        continue;
      }
      next.push({
        id: `art-${String(next.length + 1).padStart(3, "0")}`,
        name: ref.label || path.basename(rel),
        path: relative.replace(/\\/g, "/"),
        kind: "file",
        sizeBytes: size,
        createdAt: now,
        source,
      });
    }
    this.saveArtifacts(id, next);
    return next;
  }

  promptFile(taskId: string, role: string): string {
    const dir = path.join(this.localDir, "prompts");
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${taskId}-${role}.md`);
  }

  private readRequest(id: string): string {
    const file = path.join(this.taskDir(id), "request.md");
    if (!fs.existsSync(file)) return "";
    return fs.readFileSync(file, "utf8").trim();
  }

  private taskDir(id: string): string {
    return path.join(this.dataDir, "tasks", id);
  }

  private taskFile(id: string): string {
    return path.join(this.taskDir(id), "task.json");
  }

  private configPath(): string {
    return path.join(this.dataDir, "config.json");
  }
}

function nextProjectId(existing: string[]): string {
  let max = 0;
  for (const id of existing) {
    const match = id.match(/^PROJECT-(\d+)$/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `PROJECT-${String(max + 1).padStart(4, "0")}`;
}

function assertId(id: string, prefix: "TASK" | "PROJECT"): void {
  if (!new RegExp(`^${prefix}-\\d{4,}$`).test(id)) throw new WorkflowError(`Некорректный id: ${id}`);
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

function writeText(file: string, value: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, value, "utf8");
  fs.renameSync(tmp, file);
}

function normalizeTask(raw: Partial<Task>): Task {
  const base = raw as Task;
  if (base.schemaVersion !== 1) throw new WorkflowError("Неизвестная версия task.json. Нужна миграция.");
  return {
    ...base,
    plan: Array.isArray(base.plan) ? base.plan : [],
    timeline: Array.isArray(base.timeline) ? base.timeline : [],
    stageDurations: Array.isArray(base.stageDurations) ? base.stageDurations : [],
    assumptions: Array.isArray(base.assumptions) ? base.assumptions : [],
    goal: typeof base.goal === "string" ? base.goal : null,
    aiProvider: typeof base.aiProvider === "string" && base.aiProvider ? base.aiProvider : "grok-build",
    testRuns: Array.isArray(base.testRuns) ? base.testRuns.map(normalizeTestRun) : [],
    testCommands: Array.isArray(base.testCommands) ? base.testCommands.filter((item): item is string => typeof item === "string") : null,
    reviewCounts: normalizeCounts(base.reviewCounts),
    aiRuns: Array.isArray(base.aiRuns) ? base.aiRuns.map(normalizeRun) : [],
    git: normalizeGit(base.git),
  };
}

function normalizeGit(git: Partial<Task["git"]> | undefined): Task["git"] {
  const repoPath = git?.repoPath ?? null;
  const source = git?.repoSource === "project" || git?.repoSource === "manual" || git?.repoSource === "none"
    ? git.repoSource
    : repoPath
      ? "manual"
      : "none";
  return {
    repoPath,
    repoSource: source,
    branch: git?.branch ?? null,
    baseBranch: git?.baseBranch ?? "",
    baseBranchExplicit: git?.baseBranchExplicit === true,
    baseBranchWarning: git?.baseBranchWarning ?? null,
    headCommit: git?.headCommit ?? null,
    commitsCount: git?.commitsCount ?? 0,
    changedFiles: git?.changedFiles ?? 0,
    changedFileNames: Array.isArray(git?.changedFileNames) ? git.changedFileNames : [],
    diffStat: git?.diffStat ?? "",
    dirty: git?.dirty === true,
    prUrl: git?.prUrl ?? null,
    prState: git?.prState ?? null,
    remoteBranch: git?.remoteBranch ?? null,
    upstream: git?.upstream ?? null,
    ahead: typeof git?.ahead === "number" ? git.ahead : null,
    behind: typeof git?.behind === "number" ? git.behind : null,
  };
}

function normalizeRun(raw: Task["aiRuns"][number]): Task["aiRuns"][number] {
  return {
    ...raw,
    provider: typeof raw.provider === "string" && raw.provider ? raw.provider : "grok-build",
    model: typeof raw.model === "string" ? raw.model : null,
  };
}

function normalizeTestRun(raw: TestRun): TestRun {
  return {
    id: raw.id,
    command: raw.command,
    status: raw.status === "passed" ? "passed" : "failed",
    exitCode: typeof raw.exitCode === "number" ? raw.exitCode : null,
    passed: typeof raw.passed === "number" ? raw.passed : null,
    failed: typeof raw.failed === "number" ? raw.failed : null,
    durationMs: typeof raw.durationMs === "number" ? raw.durationMs : null,
    summary: raw.summary ?? "",
    startedAt: raw.startedAt ?? "",
    finishedAt: raw.finishedAt ?? "",
  };
}

function normalizeCounts(raw: Task["reviewCounts"]): Task["reviewCounts"] {
  if (!raw || typeof raw !== "object") return null;
  return {
    high: Number(raw.high) || 0,
    medium: Number(raw.medium) || 0,
    low: Number(raw.low) || 0,
  };
}

function normalizeArtifact(raw: TaskArtifact): TaskArtifact {
  return {
    id: raw.id || "art-000",
    name: raw.name || raw.path || "файл",
    path: raw.path || "",
    kind: raw.kind === "document" || raw.kind === "other" ? raw.kind : "file",
    sizeBytes: typeof raw.sizeBytes === "number" ? raw.sizeBytes : null,
    createdAt: raw.createdAt || "",
    source: raw.source === "taskos" || raw.source === "user" ? raw.source : "ai",
  };
}

function normalizeProject(raw: Partial<Project>): Project {
  if (raw.schemaVersion !== 1) throw new WorkflowError("Неизвестная версия проекта. Нужна миграция.");
  return {
    schemaVersion: 1,
    id: raw.id ?? "PROJECT-0000",
    name: raw.name ?? "Без имени",
    scope: raw.scope === "personal" ? "personal" : "work",
    goal: raw.goal ?? "",
    currentState: raw.currentState ?? "",
    nextAction: raw.nextAction ?? "",
    definitionOfDone: raw.definitionOfDone ?? "",
    stages: Array.isArray(raw.stages) ? raw.stages.map(normalizeStage) : [],
    repository: normalizeRepository(raw.repository),
    createdAt: raw.createdAt ?? "",
    updatedAt: raw.updatedAt ?? "",
  };
}

function normalizeRepository(raw: Project["repository"] | undefined): ProjectRepository | null {
  if (!raw || typeof raw !== "object") return null;
  const localPath = typeof raw.localPath === "string" ? raw.localPath.trim() : "";
  if (!localPath) return null;
  const commands = Array.isArray(raw.testCommands) ? raw.testCommands.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
  const legacy = typeof raw.testCommand === "string" && raw.testCommand.trim() ? raw.testCommand.trim() : null;
  return {
    localPath,
    remoteUrl: typeof raw.remoteUrl === "string" && raw.remoteUrl.trim() ? raw.remoteUrl.trim() : null,
    baseBranch: typeof raw.baseBranch === "string" && raw.baseBranch.trim() ? raw.baseBranch.trim() : null,
    testCommand: legacy,
    testCommands: commands.length > 0 ? commands : legacy ? [legacy] : [],
  };
}

function normalizeStage(raw: ProjectStage): ProjectStage {
  return {
    id: raw.id,
    title: raw.title,
    status: raw.status === "doing" || raw.status === "done" ? raw.status : "todo",
  };
}
