import type { Project, StageDuration, TaskStore, TaskView } from "@taskos/core";
import { estimateEta, inactivityLabel } from "@taskos/core";

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
  };
}

export function projectView(project: Project, now: string): Project & { inactivity: string | null } {
  return { ...project, inactivity: inactivityLabel(project.updatedAt, now) };
}
