export const TASK_STATUSES = [
  "INBOX",
  "SPEC",
  "PLAN",
  "BUILD",
  "REVIEW",
  "TEST",
  "USER_QA",
  "READY",
  "DONE",
  "PAUSED",
  "BLOCKED",
  "CANCELLED",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export type Scope = "work" | "personal";

export type TaskType =
  | "development"
  | "research"
  | "content"
  | "design"
  | "data"
  | "personal"
  | "other";

export type QualityMode = "fast" | "verified" | "deep";

export type RequiresCodeMode = "auto" | "yes" | "no";

export type PlanStepStatus = "pending" | "running" | "done" | "skipped" | "failed";

export interface PlanStep {
  id: string;
  title: string;
  status: PlanStepStatus;
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

export interface StageDuration {
  stage: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export interface TestState {
  status: "pending" | "running" | "passed" | "failed" | "skipped";
  passed: number | null;
  failed: number | null;
  command: string | null;
  summary: string | null;
}

export interface TestRun {
  id: string;
  command: string;
  status: "passed" | "failed";
  exitCode: number | null;
  passed: number | null;
  failed: number | null;
  durationMs: number | null;
  summary: string;
  startedAt: string;
  finishedAt: string;
}

export interface ReviewCounts {
  high: number;
  medium: number;
  low: number;
}

export type AiRole = "spec" | "plan" | "builder" | "reviewer" | "fix" | "feedback" | "report";

export interface AiRunRecord {
  id: string;
  role: "spec" | "plan" | "builder" | "reviewer" | "fix" | "feedback";
  provider: string;
  model: string | null;
  status: "running" | "ok" | "failed" | "cancelled";
  startedAt: string;
  finishedAt: string | null;
  sessionId: string | null;
  summary: string | null;
}

export type RepoSource = "project" | "manual" | "none";

export interface GitState {
  repoPath: string | null;
  repoSource: RepoSource;
  branch: string | null;
  baseBranch: string;
  baseBranchExplicit: boolean;
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
}

export interface TaskError {
  code: string;
  message: string;
  details?: string;
}

export interface Task {
  schemaVersion: 1;
  id: string;
  title: string;
  scope: Scope;
  projectId: string | null;
  projectMode: "auto" | "none" | "manual";
  type: TaskType;
  typeSetByUser: boolean;
  status: TaskStatus;
  statusBeforePause: TaskStatus | null;
  createdAt: string;
  updatedAt: string;
  stageStartedAt: string | null;
  requiresCodeMode: RequiresCodeMode;
  requiresCode: boolean;
  qualityMode: QualityMode;
  aiProvider: string;
  progress: number;
  git: GitState;
  currentStage: string;
  nextAction: string | null;
  goal: string | null;
  blockedReason: string | null;
  specReady: boolean;
  planReady: boolean;
  buildComplete: boolean;
  reviewPassed: boolean | null;
  reviewSkipped: boolean;
  tests: TestState;
  testRuns: TestRun[];
  testCommands: string[] | null;
  reviewCounts: ReviewCounts | null;
  userApproved: boolean;
  fixCycles: number;
  aiLabel: string;
  aiRuns: AiRunRecord[];
  timeline: TimelineEvent[];
  stageDurations: StageDuration[];
  assumptions: string[];
  error: TaskError | null;
  plan: PlanStep[];
}

export interface TaskView {
  task: Task;
  originalRequest: string;
}

export interface ProjectStage {
  id: string;
  title: string;
  status: "todo" | "doing" | "done";
}

export interface ProjectRepository {
  localPath: string;
  remoteUrl: string | null;
  baseBranch: string | null;
  testCommand: string | null;
  testCommands: string[];
}

export interface Project {
  schemaVersion: 1;
  id: string;
  name: string;
  scope: Scope;
  goal: string;
  currentState: string;
  nextAction: string;
  definitionOfDone: string;
  stages: ProjectStage[];
  repository: ProjectRepository | null;
  createdAt: string;
  updatedAt: string;
}

export interface AiRouting {
  spec: string;
  plan: string;
  builder: string;
  reviewer: string;
  feedback: string;
}

export interface TaskosConfig {
  version: 1;
  grokCommand: string;
  grokModel: string;
  baseBranch: string;
  defaultRepoPath: string;
  testCommand: string;
  grokTimeoutMs: number;
  aiRouting: AiRouting;
}

export interface CreateTaskInput {
  request: string;
  scope: Scope;
  projectId?: string | null;
  projectMode?: "auto" | "none" | "manual";
  type?: TaskType;
  qualityMode?: QualityMode;
  requiresCodeMode?: RequiresCodeMode;
  repoPath?: string | null;
  baseBranch?: string;
  testCommands?: string[] | null;
}

export interface FeedbackItem {
  id: string;
  createdAt: string;
  body: string;
}

export interface SpecDocument {
  title: string;
  goal: string;
  required: string[];
  notRequired: string[];
  constraints: string[];
  components: string[];
  risks: string[];
  assumptions: string[];
  definitionOfDone: string[];
  checks: string[];
  expectedResult: string;
  requiresCode: boolean;
  type: TaskType;
  projectName: string | null;
  criticalQuestion: string | null;
}

export interface ReviewDocument {
  passed: boolean;
  summary: string;
  findings: { severity: "high" | "medium" | "low"; detail: string }[];
}

export interface FeedbackAnalysis {
  understood: string;
  changes: string[];
  requiresCode: boolean;
}

export interface EtaEstimate {
  label: string;
  uncertain: boolean;
  minMinutes: number | null;
  maxMinutes: number | null;
}

export interface BuildReportStep {
  id: string;
  status: "done" | "pending" | "failed" | "skipped";
  note: string;
}

export interface BuildArtifactRef {
  path: string;
  label: string;
}

export interface BuildReport {
  summary: string;
  steps: BuildReportStep[];
  artifacts?: BuildArtifactRef[];
}

export type ArtifactKind = "file" | "document" | "other";
export type ArtifactSource = "ai" | "taskos" | "user";

export interface TaskArtifact {
  id: string;
  name: string;
  path: string;
  kind: ArtifactKind;
  sizeBytes: number | null;
  createdAt: string;
  source: ArtifactSource;
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

export type InactivityLevel = "ok" | "stale" | "cold";

export class WorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowError";
  }
}

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}
