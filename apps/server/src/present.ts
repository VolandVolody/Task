import type { Project, StageDuration, Task, TaskActions, TaskStore, TaskView } from "@taskos/core";
import { estimateEta, getAvailableActions, inactivityLabel, inactivityLevel } from "@taskos/core";

export interface TaskCard {
  id: string;
  title: string;
  scope: "work" | "personal";
  projectId: string | null;
  projectName: string | null;
  type: string;
  status: string;
  progress: number;
  qualityMode: "fast" | "verified" | "deep";
  aiLabel: string;
  requiresCode: boolean;
  running: boolean;
  tests: { status: string; passed: number | null; failed: number | null; summary: string | null; command: string | null };
  goal: string | null;
  etaLabel: string;
  etaUncertain: boolean;
  nextAction: string | null;
  blockedReason: string | null;
  error: { code: string; message: string; details?: string } | null;
  updatedAt: string;
  currentStage: string;
  reviewLabel: string | null;
  actions: TaskActions;
}

export interface TaskDetail extends TaskCard {
  originalRequest: string;
  documents: { spec: string | null; plan: string | null; review: string | null; result: string | null };
  feedback: { id: string; createdAt: string; body: string }[];
  plan: TaskView["task"]["plan"];
  timeline: TaskView["task"]["timeline"];
  aiRuns: TaskView["task"]["aiRuns"];
  assumptions: string[];
  git: TaskView["task"]["git"];
  fixCycles: number;
  requiresCodeMode: string;
  createdAt: string;
  testRuns: TaskView["task"]["testRuns"];
  artifacts: { id: string; name: string; path: string; kind: string; sizeBytes: number | null; createdAt: string; source: string; missing: boolean }[];
  reviewCounts: TaskView["task"]["reviewCounts"];
}

export function toCard(view: TaskView, store: TaskStore, running: boolean): TaskCard {
  const projects = store.listProjects();
  const history: StageDuration[] = store.listTasks().flatMap((item) => item.task.stageDurations);
  const eta = estimateEta(view.task, history);
  const project = projects.find((item) => item.id === view.task.projectId);
  return {
    id: view.task.id,
    title: view.task.title,
    scope: view.task.scope,
    projectId: view.task.projectId,
    projectName: project?.name ?? null,
    type: view.task.type,
    status: view.task.status,
    progress: view.task.progress,
    qualityMode: view.task.qualityMode,
    aiLabel: view.task.aiLabel,
    requiresCode: view.task.requiresCode,
    running,
    tests: {
      status: view.task.tests.status,
      passed: view.task.tests.passed,
      failed: view.task.tests.failed,
      summary: view.task.tests.summary,
      command: view.task.tests.command,
    },
    goal: view.task.goal,
    etaLabel: eta.label,
    etaUncertain: eta.uncertain,
    nextAction: view.task.nextAction,
    blockedReason: view.task.blockedReason,
    error: view.task.error,
    updatedAt: view.task.updatedAt,
    currentStage: view.task.currentStage,
    reviewLabel: reviewLabel(view.task),
    actions: getAvailableActions(view.task, running),
  };
}

export function toDetail(view: TaskView, store: TaskStore, running: boolean): TaskDetail {
  const card = toCard(view, store, running);
  return {
    ...card,
    originalRequest: view.originalRequest,
    documents: {
      spec: store.readDoc(view.task.id, "spec.md"),
      plan: store.readDoc(view.task.id, "plan.md"),
      review: store.readDoc(view.task.id, "review.md"),
      result: store.readDoc(view.task.id, "result.md"),
    },
    feedback: store.listFeedback(view.task.id),
    plan: view.task.plan,
    timeline: view.task.timeline,
    aiRuns: view.task.aiRuns,
    assumptions: view.task.assumptions,
    git: view.task.git,
    fixCycles: view.task.fixCycles,
    requiresCodeMode: view.task.requiresCodeMode,
    createdAt: view.task.createdAt,
    testRuns: view.task.testRuns,
    reviewCounts: view.task.reviewCounts,
    artifacts: store.listArtifacts(view.task.id).map((artifact) => ({
      ...artifact,
      missing: artifact.sizeBytes === null,
    })),
  };
}

export function projectView(project: Project, tasks: Task[], now: string): Project & {
  inactivity: string | null;
  inactivityLevel: "ok" | "stale" | "cold";
  activeTasks: number;
  waitingQa: number;
  doneTasks: number;
} {
  const own = tasks.filter((task) => task.projectId === project.id);
  return {
    ...project,
    inactivity: inactivityLabel(project.updatedAt, now),
    inactivityLevel: inactivityLevel(project.updatedAt, now),
    activeTasks: own.filter((task) => task.status !== "DONE" && task.status !== "CANCELLED").length,
    waitingQa: own.filter((task) => task.status === "USER_QA").length,
    doneTasks: own.filter((task) => task.status === "DONE").length,
  };
}

function reviewLabel(task: Task): string | null {
  if (task.reviewPassed !== false) return null;
  const counts = task.reviewCounts;
  const total = counts ? counts.high + counts.medium + counts.low : 0;
  const parts = [`AI review: ${total} замечаний`];
  if (counts) parts.push(`High ${counts.high}`, `Medium ${counts.medium}`);
  if (task.qualityMode === "deep" && task.fixCycles >= 2) {
    parts.push("AI review не пройден после 2 исправлений");
    parts.push("Нужна проверка пользователя");
  }
  return parts.join(" · ");
}
