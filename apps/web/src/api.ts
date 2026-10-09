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

export interface TaskActions {
  canRun: boolean;
  canReview: boolean;
  canPause: boolean;
  canResume: boolean;
  canApprove: boolean;
  canComplete: boolean;
  canFeedback: boolean;
  canCancel: boolean;
  canPush: boolean;
}

export interface PlanStep {
  id: string;
  title: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  weight: number;
}

export interface TimelineEvent {
  id: string;
  at: string;
  message: string;
  stage: string;
}

export interface TaskDetail extends TaskCard {
  originalRequest: string;
  documents: { spec: string | null; plan: string | null; review: string | null; result: string | null };
  feedback: { id: string; createdAt: string; body: string }[];
  plan: PlanStep[];
  timeline: TimelineEvent[];
  aiRuns: { id: string; role: string; status: string; startedAt: string; finishedAt: string | null; summary: string | null; sessionId: string | null }[];
  assumptions: string[];
  git: {
    repoPath: string | null;
    repoSource: "project" | "manual" | "none";
    branch: string | null;
    baseBranch: string;
    baseBranchWarning: string | null;
    headCommit: string | null;
    commitsCount: number;
    changedFiles: number;
    changedFileNames: string[];
    diffStat: string;
    dirty: boolean;
    prUrl: string | null;
    prState: string | null;
    remoteBranch: string | null;
    upstream: string | null;
    ahead: number | null;
    behind: number | null;
  };
  fixCycles: number;
  requiresCodeMode: string;
  createdAt: string;
  reviewCounts: { high: number; medium: number; low: number } | null;
  testRuns: { id: string; command: string; status: string; exitCode: number | null; passed: number | null; failed: number | null; summary: string }[];
  artifacts: { id: string; name: string; path: string; sizeBytes: number | null; source: string; missing: boolean }[];
}

export interface Project {
  id: string;
  name: string;
  scope: "work" | "personal";
  goal: string;
  currentState: string;
  nextAction: string;
  definitionOfDone: string;
  stages: { id: string; title: string; status: string }[];
  createdAt: string;
  updatedAt: string;
  inactivity: string | null;
  inactivityLevel: "ok" | "stale" | "cold";
  activeTasks: number;
  waitingQa: number;
  doneTasks: number;
  repository: {
    localPath: string;
    remoteUrl: string | null;
    baseBranch: string | null;
    testCommand: string | null;
    testCommands: string[];
  } | null;
}

export interface SyncSnapshot {
  state: "synced" | "local" | "remote" | "conflict" | "offline";
  branch: string | null;
  ahead: number | null;
  behind: number | null;
  dirty: boolean;
  message: string;
}

export interface Health {
  ok: boolean;
  runtime: string;
  grok: boolean;
  grokCompatible: boolean | null;
  grokVersion: string | null;
  grokMessage: string | null;
  git: boolean;
  nodeVersion: string;
  model: string;
  repo: { path: string; branch: string | null };
  sync: { state: string; ahead: number | null; behind: number | null; message: string };
  storage: boolean;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public code = "HTTP",
    public details?: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers);
  let payload = init?.body;
  if (method !== "GET" && method !== "HEAD") {
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    if (payload == null || payload === "") payload = "{}";
  }
  const response = await fetch(path, {
    ...init,
    method,
    body: payload,
    headers,
  });
  const body = (await response.json().catch(() => ({}))) as { error?: { message?: string; code?: string; details?: string } };
  if (!response.ok) {
    throw new ApiError(body.error?.message || "Запрос не выполнился", body.error?.code || "HTTP", body.error?.details);
  }
  return body as T;
}
