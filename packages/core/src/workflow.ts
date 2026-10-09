import type {
  CreateTaskInput,
  EtaEstimate,
  PlanStep,
  QualityMode,
  StageDuration,
  Task,
  TaskStatus,
  TaskType,
} from "./types.js";
import { WorkflowError } from "./types.js";

const ALLOWED: Record<TaskStatus, TaskStatus[]> = {
  INBOX: ["SPEC", "PAUSED", "BLOCKED", "CANCELLED"],
  SPEC: ["PLAN", "BUILD", "PAUSED", "BLOCKED", "CANCELLED"],
  PLAN: ["BUILD", "PAUSED", "BLOCKED", "CANCELLED"],
  BUILD: ["REVIEW", "TEST", "USER_QA", "PAUSED", "BLOCKED", "CANCELLED"],
  REVIEW: ["BUILD", "TEST", "USER_QA", "PAUSED", "BLOCKED", "CANCELLED"],
  TEST: ["BUILD", "USER_QA", "REVIEW", "PAUSED", "BLOCKED", "CANCELLED"],
  USER_QA: ["BUILD", "READY", "PAUSED", "BLOCKED", "CANCELLED"],
  READY: ["DONE", "BUILD", "PAUSED", "CANCELLED"],
  DONE: [],
  PAUSED: ["INBOX", "SPEC", "PLAN", "BUILD", "REVIEW", "TEST", "USER_QA", "READY", "BLOCKED", "CANCELLED"],
  BLOCKED: ["INBOX", "SPEC", "PLAN", "BUILD", "REVIEW", "TEST", "USER_QA", "PAUSED", "CANCELLED"],
  CANCELLED: [],
};

const TIMED = new Set<TaskStatus>(["SPEC", "PLAN", "BUILD", "REVIEW", "TEST", "USER_QA"]);

export const WEIGHTS = {
  SPEC: 10,
  PLAN: 10,
  BUILD: 35,
  REVIEW: 15,
  TEST: 15,
  USER_QA: 10,
  RELEASE: 5,
} as const;

const CYRILLIC: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y",
  к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
  х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

const DEFAULT_STAGE_MINUTES: Record<string, [number, number]> = {
  SPEC: [2, 6],
  PLAN: [2, 6],
  BUILD: [15, 40],
  REVIEW: [5, 12],
  TEST: [3, 10],
  RELEASE: [1, 2],
};

export function qualityLabel(mode: QualityMode): string {
  if (mode === "fast") return "Grok ×1";
  if (mode === "verified") return "Grok ×2 review";
  return "Grok ×3 deep";
}

export function nextId(existing: string[], prefix: "TASK" | "PROJECT"): string {
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  let max = 0;
  for (const id of existing) {
    const match = id.match(re);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${prefix}-${String(max + 1).padStart(4, "0")}`;
}

export function titleFromRequest(request: string): string {
  const line = request
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find(Boolean);
  const clean = (line ?? "Без названия").replace(/^#+\s*/, "");
  if (clean.length <= 80) return clean;
  return `${clean.slice(0, 79).trimEnd()}…`;
}

export function slug(input: string): string {
  let out = "";
  for (const char of input.toLowerCase()) out += CYRILLIC[char] ?? char;
  out = out
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return out.slice(0, 32) || "task";
}

export function branchName(id: string, title: string): string {
  return `task/${id}-${slug(title)}`;
}

function emptyTests(): Task["tests"] {
  return { status: "pending", passed: null, failed: null, command: null, summary: null };
}

function emptyGit(baseBranch: string, repoPath: string | null): Task["git"] {
  return {
    repoPath,
    branch: null,
    baseBranch,
    headCommit: null,
    commitsCount: 0,
    changedFiles: 0,
    changedFileNames: [],
    diffStat: "",
    dirty: false,
    prUrl: null,
    prState: null,
  };
}

export function createTask(input: CreateTaskInput, existingIds: string[], now: string): Task {
  const request = input.request.trim();
  if (!request) throw new WorkflowError("Опишите, что нужно сделать");
  if (input.scope !== "work" && input.scope !== "personal") {
    throw new WorkflowError("Раздел должен быть «работа» или «личное»");
  }
  const mode = input.requiresCodeMode ?? "auto";
  const type: TaskType = input.type ?? (input.scope === "personal" ? "personal" : "other");
  const quality = input.qualityMode ?? "verified";
  const task: Task = {
    schemaVersion: 1,
    id: nextId(existingIds, "TASK"),
    title: titleFromRequest(request),
    scope: input.scope,
    projectId: input.projectId ?? null,
    projectMode: input.projectMode ?? (input.projectId ? "manual" : "auto"),
    type,
    typeSetByUser: Boolean(input.type),
    status: "INBOX",
    statusBeforePause: null,
    createdAt: now,
    updatedAt: now,
    stageStartedAt: null,
    requiresCodeMode: mode,
    requiresCode: mode === "yes",
    qualityMode: quality,
    aiProvider: "grok-build",
    progress: 0,
    git: emptyGit(input.baseBranch ?? "main", input.repoPath ?? null),
    currentStage: "INBOX",
    nextAction: "Запустить обработку",
    goal: null,
    blockedReason: null,
    specReady: false,
    planReady: false,
    buildComplete: false,
    reviewPassed: null,
    reviewSkipped: false,
    tests: emptyTests(),
    userApproved: false,
    fixCycles: 0,
    aiLabel: qualityLabel(quality),
    aiRuns: [],
    timeline: [
      { id: `${now}-created`, at: now, message: "Задача создана", stage: "INBOX" },
    ],
    stageDurations: [],
    assumptions: [],
    error: null,
    plan: [],
  };
  task.progress = computeProgress(task);
  return task;
}

export function transition(task: Task, to: TaskStatus, now: string): Task {
  if (task.status === to) return task;
  if (!ALLOWED[task.status].includes(to)) {
    throw new WorkflowError(`Нельзя перейти из ${task.status} в ${to}`);
  }
  const stageDurations = task.stageDurations.slice();
  if (task.stageStartedAt && TIMED.has(task.status)) {
    stageDurations.push({
      stage: task.status,
      startedAt: task.stageStartedAt,
      finishedAt: now,
      durationMs: Math.max(0, Date.parse(now) - Date.parse(task.stageStartedAt)),
    });
  }
  return {
    ...task,
    status: to,
    currentStage: to,
    updatedAt: now,
    stageDurations,
    stageStartedAt: TIMED.has(to) ? now : null,
    statusBeforePause: to === "PAUSED" ? task.status : task.status === "PAUSED" ? null : task.statusBeforePause,
  };
}

export function computeProgress(task: Task): number {
  let score = 0;
  if (task.specReady) score += WEIGHTS.SPEC;
  if (task.planReady) score += WEIGHTS.PLAN;
  score += buildScore(task);
  if (task.reviewPassed === true || task.reviewSkipped) score += WEIGHTS.REVIEW;
  if (task.tests.status === "passed" || task.tests.status === "skipped") score += WEIGHTS.TEST;
  if (task.userApproved) score += WEIGHTS.USER_QA;
  if (task.status === "DONE") score += WEIGHTS.RELEASE;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function buildScore(task: Task): number {
  const steps = task.plan.filter((step) => step.status !== "skipped");
  if (steps.length === 0) return task.buildComplete ? WEIGHTS.BUILD : 0;
  const total = steps.reduce((sum, step) => sum + (step.weight || 1), 0);
  const done = steps
    .filter((step) => step.status === "done")
    .reduce((sum, step) => sum + (step.weight || 1), 0);
  if (total <= 0) return 0;
  return (WEIGHTS.BUILD * done) / total;
}

export function markPlanDone(task: Task, now: string): Task {
  return {
    ...task,
    plan: task.plan.map((step) =>
      step.status === "done" || step.status === "skipped"
        ? step
        : { ...step, status: "done", startedAt: step.startedAt ?? now, finishedAt: now, durationMs: step.durationMs ?? 0 },
    ),
  };
}

export function applyFeedbackRestart(task: Task, now: string, note: string): Task {
  const allowed: TaskStatus[] = ["USER_QA", "TEST", "REVIEW", "READY", "BUILD"];
  if (!allowed.includes(task.status)) {
    throw new WorkflowError("Замечание можно отправить, когда есть что исправлять");
  }
  const step: PlanStep = {
    id: String(task.plan.length + 1).padStart(2, "0"),
    title: `Исправить: ${note.replace(/\s+/g, " ").trim().slice(0, 72) || "замечание"}`,
    status: "pending",
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    weight: 1,
  };
  let next: Task = {
    ...task,
    plan: [...task.plan, step],
    buildComplete: false,
    reviewPassed: null,
    reviewSkipped: false,
    userApproved: false,
    error: null,
    blockedReason: null,
    tests: emptyTests(),
    nextAction: "Исправление по замечанию",
  };
  if (next.status !== "BUILD") next = transition(next, "BUILD", now);
  else next = { ...next, updatedAt: now };
  next.progress = computeProgress(next);
  return next;
}

export function approveTask(task: Task, now: string): Task {
  if (task.status !== "USER_QA") throw new WorkflowError("Подтвердить можно только на проверке");
  const next = transition({ ...task, userApproved: true, error: null }, "READY", now);
  next.nextAction = "Закрыть задачу";
  next.progress = computeProgress(next);
  return next;
}

export function completeTask(task: Task, now: string): Task {
  if (task.status !== "READY" || !task.userApproved) {
    throw new WorkflowError("Сначала нужно подтверждение пользователя");
  }
  const next = transition(task, "DONE", now);
  next.nextAction = null;
  next.error = null;
  next.progress = computeProgress(next);
  return next;
}

export function pauseTask(task: Task, now: string): Task {
  if (task.status === "PAUSED") return task;
  if (task.status === "DONE" || task.status === "CANCELLED") {
    throw new WorkflowError("Эту задачу нельзя поставить на паузу");
  }
  const next = transition(task, "PAUSED", now);
  next.nextAction = "Продолжить, когда будете готовы";
  next.progress = computeProgress(next);
  return next;
}

export function resumeTask(task: Task, now: string): Task {
  if (task.status !== "PAUSED") throw new WorkflowError("Задача не на паузе");
  const back = task.statusBeforePause ?? "INBOX";
  const next = transition(task, back, now);
  next.progress = computeProgress(next);
  return next;
}

function remainingStages(task: Task): string[] {
  const stages: string[] = [];
  if (!task.specReady) stages.push("SPEC");
  if (!task.planReady) stages.push("PLAN");
  if (!task.buildComplete) stages.push("BUILD");
  if (!(task.reviewPassed === true || task.reviewSkipped)) stages.push("REVIEW");
  if (task.tests.status !== "passed" && task.tests.status !== "skipped") stages.push("TEST");
  if (!task.userApproved) stages.push("USER_QA");
  if (task.status !== "DONE") stages.push("RELEASE");
  return stages;
}

export function estimateEta(task: Task, history: StageDuration[]): EtaEstimate {
  if (task.status === "DONE") return { label: "Готово", uncertain: false, minMinutes: 0, maxMinutes: 0 };
  if (task.status === "CANCELLED") return { label: "Отменено", uncertain: false, minMinutes: null, maxMinutes: null };
  if (task.status === "USER_QA" && !task.userApproved) {
    return { label: "Ждёт вашей проверки", uncertain: false, minMinutes: null, maxMinutes: null };
  }
  if (task.status === "BLOCKED") {
    return { label: "Нужен ваш ответ", uncertain: false, minMinutes: null, maxMinutes: null };
  }
  const stages = remainingStages(task).filter((stage) => stage !== "USER_QA");
  let min = 0;
  let max = 0;
  let uncertain = false;
  for (const stage of stages) {
    const samples = history.filter((item) => item.stage === stage && item.durationMs > 0);
    if (samples.length >= 3) {
      const sorted = samples.map((item) => item.durationMs).sort((a, b) => a - b);
      const mid = sorted[Math.floor(sorted.length / 2)] ?? sorted[0] ?? 0;
      const minutes = mid / 60000;
      min += Math.max(1, Math.round(minutes * 0.8));
      max += Math.max(min, Math.round(minutes * 1.4));
    } else {
      uncertain = true;
      const fallback = DEFAULT_STAGE_MINUTES[stage] ?? [5, 15];
      min += fallback[0];
      max += fallback[1];
    }
  }
  if (max < min) max = min;
  if (min === 0 && max === 0) return { label: "Почти готово", uncertain, minMinutes: 0, maxMinutes: 0 };
  const range = min === max ? `≈ ${min} мин` : `≈ ${min}–${max} мин`;
  return {
    label: uncertain ? `Оценка пока неточная · ${range}` : range,
    uncertain,
    minMinutes: min,
    maxMinutes: max,
  };
}

export function inactivityLabel(updatedAt: string, now: string): string | null {
  const days = Math.floor((Date.parse(now) - Date.parse(updatedAt)) / 86_400_000);
  if (!Number.isFinite(days) || days < 7) return null;
  return `Нет активности ${days} дн.`;
}

export function isSecretPath(file: string): boolean {
  const name = file.replace(/\\/g, "/");
  return /(^|\/)\.env($|\.)|(^|\/)id_rsa|(^|\/).+\.pem$|(^|\/)credentials\.json$|(^|\/)secrets?(\.|\/|$)/i.test(name);
}

export function parseTestOutput(text: string): { passed: number | null; failed: number | null } {
  const passedMatch = text.match(/(\d+)\s+passed/i);
  const failedMatch = text.match(/(\d+)\s+failed/i);
  return {
    passed: passedMatch ? Number(passedMatch[1]) : null,
    failed: failedMatch ? Number(failedMatch[1]) : null,
  };
}
