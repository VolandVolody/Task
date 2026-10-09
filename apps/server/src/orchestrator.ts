import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AiRunRecord, Task, TaskStatus, TaskStore, TaskView } from "@taskos/core";
import {
  applyFeedbackRestart,
  approveTask,
  branchName,
  completeTask,
  markPlanDone,
  pauseTask,
  renderPlanMarkdown,
  renderReviewMarkdown,
  renderSpecMarkdown,
  resumeTask,
  transition,
} from "@taskos/core";
import type { AIProvider, AiContext, ProviderEvent } from "./ai.js";
import type { Bus } from "./bus.js";
import { AppError, abortError, isAbort, publicError } from "./errors.js";
import type { GitAdapter } from "./git.js";
import { parseTestOutput } from "@taskos/core";
import type { ProcessRunner } from "./runner.js";
import { toCard, type TaskCard } from "./present.js";
import type { TaskLock } from "@taskos/core";

export interface OrchestratorDeps {
  store: TaskStore;
  lock: TaskLock;
  provider: AIProvider;
  git: GitAdapter;
  runner: ProcessRunner;
  bus: Bus;
  root: string;
  now?: () => string;
}

export class Orchestrator {
  private tokens = new Map<string, string>();
  private aborts = new Map<string, AbortController>();

  constructor(private readonly deps: OrchestratorDeps) {}

  run(taskId: string): Promise<void> {
    const acquired = this.deps.lock.tryAcquire(taskId);
    if (!acquired.ok) throw new AppError(409, "LOCKED", "Эта задача уже выполняется");
    this.tokens.set(taskId, acquired.token);
    const abort = new AbortController();
    this.aborts.set(taskId, abort);
    return this.execute(taskId, abort.signal);
  }

  pause(taskId: string): TaskCard {
    this.aborts.get(taskId)?.abort();
    this.deps.runner.cancel(taskId);
    const view = this.deps.store.getTask(taskId);
    if (view.task.status === "PAUSED") return this.card(view);
    view.task = pauseTask(view.task, this.now());
    this.remember(view, "Пауза");
    return this.card(view);
  }

  resume(taskId: string): TaskCard {
    const view = this.deps.store.getTask(taskId);
    view.task = resumeTask(view.task, this.now());
    this.remember(view, "Пауза снята");
    return this.card(view);
  }

  prepareFeedback(taskId: string, text: string): void {
    this.assertIdle(taskId);
    const body = text.trim();
    if (!body) throw new AppError(400, "EMPTY", "Напишите, что не так");
    const view = this.deps.store.getTask(taskId);
    const canAnswer = view.task.status === "BLOCKED" || ["USER_QA", "TEST", "REVIEW", "READY", "BUILD"].includes(view.task.status);
    if (!canAnswer) throw new AppError(409, "WORKFLOW", "Замечание можно отправить, когда есть что исправлять");
    this.deps.store.addFeedback(taskId, body, this.now());
    if (view.task.status === "BLOCKED") {
      view.task.blockedReason = null;
      view.task.error = null;
      view.task = transition(view.task, "SPEC", this.now());
      this.remember(view, "Ответ получен");
      return;
    }
    view.task = applyFeedbackRestart(view.task, this.now(), body);
    this.remember(view, `Замечание: ${body.slice(0, 120)}`);
  }

  approve(taskId: string): TaskCard {
    this.assertIdle(taskId);
    const view = this.deps.store.getTask(taskId);
    view.task = approveTask(view.task, this.now());
    this.remember(view, "Пользователь подтвердил результат");
    return this.card(view);
  }

  complete(taskId: string): TaskCard {
    this.assertIdle(taskId);
    const view = this.deps.store.getTask(taskId);
    view.task = completeTask(view.task, this.now());
    this.remember(view, "Задача закрыта");
    return this.card(view);
  }

  requestReview(taskId: string): Promise<void> {
    this.assertIdle(taskId);
    const view = this.deps.store.getTask(taskId);
    view.task.reviewSkipped = false;
    view.task.reviewPassed = null;
    view.task.tests = { status: "pending", passed: null, failed: null, command: view.task.tests.command, summary: null };
    this.save(view);
    return this.run(taskId);
  }

  card(view: TaskView): TaskCard {
    return toCard(view, this.deps.store, this.deps.lock.isLocked(view.task.id));
  }

  private async execute(taskId: string, signal: AbortSignal): Promise<void> {
    const token = this.tokens.get(taskId);
    try {
      await this.pipeline(taskId, signal);
    } catch (error) {
      if (isAbort(error) || signal.aborted) return;
      this.fail(taskId, error);
    } finally {
      this.aborts.delete(taskId);
      this.tokens.delete(taskId);
      if (token) this.deps.lock.release(taskId, token);
    }
  }

  private async pipeline(taskId: string, signal: AbortSignal): Promise<void> {
    let view = this.live(taskId, signal);
    if (view.task.status === "DONE" || view.task.status === "CANCELLED") {
      throw new AppError(409, "CLOSED", "Задача закрыта");
    }
    if (view.task.status === "PAUSED") throw new AppError(409, "PAUSED", "Сначала снимите паузу");
    this.remember(view, "Запуск обработки");

    if (!view.task.specReady) {
      view = this.enter(this.live(taskId, signal), "SPEC");
      await this.makeSpec(taskId, signal);
      view = this.live(taskId, signal);
      if (view.task.status === "BLOCKED") return;
    }
    if (!view.task.planReady) {
      view = this.enter(this.live(taskId, signal), "PLAN");
      await this.makePlan(taskId, signal);
    }
    view = this.live(taskId, signal);
    if (!view.task.buildComplete) {
      view = this.enter(view, "BUILD");
      await this.makeBuild(taskId, signal);
    }
    view = this.live(taskId, signal);
    if (!(view.task.reviewPassed === true || view.task.reviewSkipped)) {
      if (view.task.qualityMode === "fast") {
        view.task.reviewSkipped = true;
        this.remember(view, "Отдельный reviewer не запускался: режим Grok ×1");
      } else {
        await this.reviewLoop(taskId, signal);
      }
    }
    view = this.live(taskId, signal);
    if (view.task.requiresCode) {
      if (view.task.tests.status !== "passed") {
        view = this.enter(view, "TEST");
        const passed = await this.runTests(taskId, signal);
        if (!passed) return;
      }
    } else if (view.task.tests.status !== "skipped") {
      view.task.tests = { ...view.task.tests, status: "skipped", summary: "Для этой задачи тесты кода не требуются" };
      this.save(view);
    }
    view = this.enter(this.live(taskId, signal), "USER_QA");
    view.task.nextAction = view.task.reviewPassed === false
      ? "Ревью нашло замечания. Проверьте результат"
      : "Проверить результат";
    view.task.error = null;
    this.remember(view, "Ожидание проверки пользователя");
  }

  private async makeSpec(taskId: string, signal: AbortSignal): Promise<void> {
    const view = this.live(taskId, signal);
    const run = this.openRun(view, "spec");
    try {
      const spec = await this.deps.provider.generateSpec(this.context(view, "build", signal), (event) => this.onEvent(taskId, run.id, event));
      const fresh = this.live(taskId, signal);
      this.closeRun(fresh, run.id, "ok", spec.goal);
      if (spec.criticalQuestion) {
        this.deps.store.writeDoc(taskId, "spec.md", renderSpecMarkdown(fresh.originalRequest, spec));
        let task = this.live(taskId, signal).task;
        task.assumptions = spec.assumptions;
        task.blockedReason = spec.criticalQuestion;
        task.nextAction = "Ответьте на вопрос";
        task = transition(task, "BLOCKED", this.now());
        const blocked = this.live(taskId, signal);
        blocked.task = task;
        this.remember(blocked, `Нужен ответ: ${spec.criticalQuestion}`);
        return;
      }
      this.deps.store.writeDoc(taskId, "spec.md", renderSpecMarkdown(fresh.originalRequest, spec));
      const next = this.live(taskId, signal);
      next.task.specReady = true;
      next.task.assumptions = spec.assumptions;
      next.task.error = null;
      if (spec.title) next.task.title = spec.title;
      next.task.goal = spec.goal;
      if (!next.task.typeSetByUser) next.task.type = spec.type;
      if (next.task.requiresCodeMode === "auto") next.task.requiresCode = spec.requiresCode;
      if (next.task.projectMode === "auto" && spec.projectName && !next.task.projectId) {
        const existing = this.deps.store.findProjectByName(spec.projectName);
        const project = existing ?? this.deps.store.createProject({
          name: spec.projectName,
          scope: next.task.scope,
          goal: spec.goal,
          currentState: "Создан из задачи",
          nextAction: spec.title,
          definitionOfDone: spec.definitionOfDone[0] ?? "",
          stages: [],
        }, this.now());
        next.task.projectId = project.id;
      }
      this.remember(next, "ТЗ готово");
    } catch (error) {
      this.closeRun(this.deps.store.getTask(taskId), run.id, signal.aborted ? "cancelled" : "failed", errorText(error));
      throw error;
    }
  }

  private async makePlan(taskId: string, signal: AbortSignal): Promise<void> {
    const view = this.live(taskId, signal);
    const run = this.openRun(view, "plan");
    try {
      const steps = await this.deps.provider.generatePlan(this.context(view, "build", signal), (event) => this.onEvent(taskId, run.id, event));
      const fresh = this.live(taskId, signal);
      fresh.task.plan = steps;
      fresh.task.planReady = true;
      fresh.task.nextAction = steps[0]?.title ?? "Выполнить план";
      this.deps.store.writeDoc(taskId, "plan.md", renderPlanMarkdown(steps));
      this.closeRun(fresh, run.id, "ok", `${steps.length} шагов`);
      this.remember(fresh, "План готов");
    } catch (error) {
      this.closeRun(this.deps.store.getTask(taskId), run.id, signal.aborted ? "cancelled" : "failed", errorText(error));
      throw error;
    }
  }

  private async makeBuild(taskId: string, signal: AbortSignal): Promise<void> {
    let view = this.live(taskId, signal);
    if (view.task.requiresCode) await this.prepareGit(taskId, signal);
    view = this.live(taskId, signal);
    const fixing = view.task.plan.some((step) => step.status === "pending" && step.title.startsWith("Исправить"));
    if (fixing) {
      const run = this.openRun(view, "feedback");
      try {
        const analysis = await this.deps.provider.analyzeFeedback(this.context(view, "fix", signal), (event) => this.onEvent(taskId, run.id, event));
        const fresh = this.live(taskId, signal);
        this.closeRun(fresh, run.id, "ok", analysis.understood);
        this.remember(fresh, `Понял замечание: ${analysis.understood}`);
      } catch (error) {
        this.closeRun(this.deps.store.getTask(taskId), run.id, signal.aborted ? "cancelled" : "failed", errorText(error));
        throw error;
      }
    }
    view = this.live(taskId, signal);
    const run = this.openRun(view, fixing ? "fix" : "builder");
    try {
      const outcome = await this.deps.provider.executeTask(
        this.context(this.live(taskId, signal), fixing ? "fix" : "build", signal),
        (event) => this.onEvent(taskId, run.id, event),
      );
      const fresh = this.live(taskId, signal);
      fresh.task = markPlanDone(fresh.task, this.now());
      fresh.task.buildComplete = true;
      fresh.task.error = null;
      if (outcome.summary) this.deps.store.writeDoc(taskId, "result.md", outcome.summary.endsWith("\n") ? outcome.summary : `${outcome.summary}\n`);
      this.deps.store.writeDoc(taskId, "plan.md", renderPlanMarkdown(fresh.task.plan));
      this.closeRun(fresh, run.id, "ok", outcome.summary.slice(0, 180), outcome.sessionId);
      if (fresh.task.requiresCode) await this.commitWork(fresh);
      this.remember(fresh, "Выполнение закончено");
    } catch (error) {
      this.closeRun(this.deps.store.getTask(taskId), run.id, signal.aborted ? "cancelled" : "failed", errorText(error));
      throw error;
    }
  }

  private async reviewLoop(taskId: string, signal: AbortSignal): Promise<void> {
    let cycles = this.live(taskId, signal).task.fixCycles;
    for (let guard = 0; guard < 4; guard += 1) {
      let view = this.enter(this.live(taskId, signal), "REVIEW");
      if (view.task.requiresCode) await this.refreshGit(view);
      view = this.live(taskId, signal);
      const run = this.openRun(view, "reviewer");
      let passed = false;
      try {
        const review = await this.deps.provider.reviewTask(this.context(view, "build", signal), (event) => this.onEvent(taskId, run.id, event));
        const fresh = this.live(taskId, signal);
        fresh.task.reviewPassed = review.passed;
        this.deps.store.writeDoc(taskId, "review.md", renderReviewMarkdown(review));
        this.closeRun(fresh, run.id, "ok", review.summary);
        this.remember(fresh, review.passed ? "Ревью принято" : "Ревью нашло замечания");
        passed = review.passed;
      } catch (error) {
        this.closeRun(this.deps.store.getTask(taskId), run.id, signal.aborted ? "cancelled" : "failed", errorText(error));
        throw error;
      }
      if (passed) return;
      const current = this.live(taskId, signal);
      if (current.task.qualityMode !== "deep" || cycles >= 2) return;
      cycles += 1;
      current.task.fixCycles = cycles;
      current.task.buildComplete = false;
      current.task.reviewPassed = null;
      current.task.plan.push({
        id: String(current.task.plan.length + 1).padStart(2, "0"),
        title: `Исправить замечания ревью ${cycles}`,
        status: "pending",
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        weight: 1,
      });
      this.save(current);
      this.enter(this.live(taskId, signal), "BUILD");
      await this.makeBuild(taskId, signal);
    }
  }

  private async runTests(taskId: string, signal: AbortSignal): Promise<boolean> {
    const view = this.live(taskId, signal);
    const config = this.deps.store.getConfig();
    const repo = view.task.git.repoPath || this.repoOf(view.task);
    view.task.tests = { status: "running", passed: null, failed: null, command: config.testCommand, summary: null };
    this.remember(view, "Тесты запущены");
    const shell = process.platform === "win32";
    const result = await this.deps.runner.run(taskId, {
      command: shell ? process.env.ComSpec || "cmd.exe" : "sh",
      args: shell ? ["/d", "/s", "/c", config.testCommand] : ["-c", config.testCommand],
      cwd: repo,
      timeoutMs: Math.min(config.grokTimeoutMs, 600_000),
      signal,
      onLine: (stream, line) => {
        this.deps.store.appendLog(taskId, "tests", `[${stream}] ${line}`);
        this.deps.bus.publish({ type: "log", taskId, stream, line });
      },
    });
    if (result.cancelled || signal.aborted) throw abortError();
    const counts = parseTestOutput(`${result.stdout}\n${result.stderr}`);
    const passed = result.exitCode === 0 && !result.timedOut && !result.spawnError;
    const summary = (result.stderr || result.stdout || result.spawnError || "").trim().slice(-1500);
    const fresh = this.live(taskId, signal);
    fresh.task.tests = {
      status: passed ? "passed" : "failed",
      passed: counts.passed,
      failed: counts.failed,
      command: config.testCommand,
      summary: summary || (passed ? "Тесты прошли" : "Тесты не прошли"),
    };
    if (!passed) {
      fresh.task.error = { code: result.timedOut ? "AI_TIMEOUT" : "TEST_FAILED", message: "Тесты не прошли", details: summary };
      fresh.task.nextAction = "Тесты не прошли. Можно отправить замечание.";
    } else {
      fresh.task.error = null;
    }
    const label = counts.passed !== null ? `${counts.passed} passed${counts.failed ? `, ${counts.failed} failed` : ""}` : passed ? "Тесты прошли" : "Тесты не прошли";
    this.remember(fresh, label);
    return passed;
  }

  private async prepareGit(taskId: string, signal: AbortSignal): Promise<void> {
    const view = this.live(taskId, signal);
    const config = this.deps.store.getConfig();
    const repo = this.repoOf(view.task);
    const branch = view.task.git.branch ?? branchName(view.task.id, view.task.title);
    view.task.git.repoPath = repo;
    view.task.git.branch = branch;
    view.task.git.baseBranch = config.baseBranch;
    this.save(view);
    await this.deps.git.ensureBranch(repo, config.baseBranch, branch);
    const fresh = this.live(taskId, signal);
    await this.refreshGit(fresh);
    this.remember(this.live(taskId, signal), `Ветка ${branch}`);
  }

  private async commitWork(view: TaskView): Promise<void> {
    const repo = view.task.git.repoPath;
    if (!repo || !view.task.git.branch) return;
    const sha = await this.deps.git.commitAll(repo, `task: ${view.task.id} ${view.task.title}`.slice(0, 120));
    await this.refreshGit(view);
    this.remember(this.deps.store.getTask(view.task.id), sha ? `Коммит ${sha}` : "Изменений для коммита нет");
  }

  private async refreshGit(view: TaskView): Promise<void> {
    if (!view.task.git.repoPath) return;
    const snap = await this.deps.git.snapshot(view.task.git.repoPath, view.task.git.baseBranch);
    const pr = await this.deps.git.pullRequest(view.task.git.repoPath);
    const fresh = this.deps.store.getTask(view.task.id);
    fresh.task.git = { ...fresh.task.git, ...snap, prUrl: pr?.url ?? fresh.task.git.prUrl, prState: pr?.state ?? fresh.task.git.prState };
    this.save(fresh);
  }

  private context(view: TaskView, mode: "build" | "fix", signal: AbortSignal): AiContext {
    return {
      task: view.task,
      originalRequest: view.originalRequest,
      spec: this.deps.store.readDoc(view.task.id, "spec.md"),
      plan: this.deps.store.readDoc(view.task.id, "plan.md"),
      review: this.deps.store.readDoc(view.task.id, "review.md"),
      feedback: this.deps.store.listFeedback(view.task.id).map((item) => item.body),
      diffStat: view.task.git.diffStat,
      repoPath: view.task.requiresCode && view.task.git.repoPath ? view.task.git.repoPath : this.repoOf(view.task),
      mode,
      signal,
    };
  }

  private repoOf(task: Task): string {
    const config = this.deps.store.getConfig();
    return path.resolve(this.deps.root, task.git.repoPath || config.defaultRepoPath);
  }

  private enter(view: TaskView, status: TaskStatus): TaskView {
    if (view.task.status === "PAUSED") throw abortError();
    if (view.task.status !== status) view.task = transition(view.task, status, this.now());
    this.save(view);
    if (view.task.projectId) this.deps.store.touchProject(view.task.projectId, this.now());
    this.emit(view);
    return this.deps.store.getTask(view.task.id);
  }

  private openRun(view: TaskView, role: AiRunRecord["role"]): AiRunRecord {
    const run: AiRunRecord = {
      id: `run-${String(view.task.aiRuns.length + 1).padStart(3, "0")}`,
      role,
      provider: "grok-build",
      model: this.deps.store.getConfig().grokModel,
      status: "running",
      startedAt: this.now(),
      finishedAt: null,
      sessionId: null,
      summary: null,
    };
    view.task.aiRuns.push(run);
    this.remember(view, runLabel(role));
    return run;
  }

  private closeRun(view: TaskView, runId: string, status: AiRunRecord["status"], summary: string | null, sessionId?: string | null): void {
    const run = view.task.aiRuns.find((item) => item.id === runId);
    if (!run) return;
    run.status = status;
    run.finishedAt = this.now();
    run.summary = summary;
    if (sessionId) run.sessionId = sessionId;
    this.save(view);
  }

  private onEvent(taskId: string, runId: string, event: ProviderEvent): void {
    if (event.type === "log") {
      this.deps.store.appendLog(taskId, runId, `[${event.stream}] ${event.line}`);
      this.deps.bus.publish({ type: "log", taskId, stream: event.stream, line: event.line });
      return;
    }
    if (event.type === "session") {
      const view = this.deps.store.getTask(taskId);
      const run = view.task.aiRuns.find((item) => item.id === runId);
      if (run) run.sessionId = event.sessionId;
      this.save(view);
      return;
    }
    const view = this.deps.store.getTask(taskId);
    this.remember(view, event.message);
  }

  private fail(taskId: string, error: unknown): void {
    const view = this.deps.store.getTask(taskId);
    if (view.task.status === "PAUSED") return;
    const pub = publicError(error);
    view.task.error = { code: pub.code, message: pub.message, details: pub.details };
    view.task.nextAction = "Можно запустить снова";
    this.remember(view, pub.message);
  }

  private live(taskId: string, signal: AbortSignal): TaskView {
    if (signal.aborted) throw abortError();
    const view = this.deps.store.getTask(taskId);
    if (view.task.status === "PAUSED") throw abortError();
    return view;
  }

  private remember(view: TaskView, message: string): void {
    view.task.timeline.push({ id: randomUUID(), at: this.now(), message, stage: view.task.status });
    if (view.task.timeline.length > 300) view.task.timeline = view.task.timeline.slice(-300);
    view.task.updatedAt = this.now();
    this.save(view);
    const runId = view.task.aiRuns.at(-1)?.id ?? "run-000";
    this.deps.store.appendRun(view.task.id, runId, { at: this.now(), stage: view.task.status, message });
    this.emit(view);
  }

  private emit(view: TaskView): void {
    this.deps.bus.publish({ type: "task", task: this.card(view) });
  }

  private now(): string {
    return this.deps.now ? this.deps.now() : new Date().toISOString();
  }

  private assertIdle(taskId: string): void {
    if (this.deps.lock.isLocked(taskId)) throw new AppError(409, "LOCKED", "Эта задача уже выполняется");
  }

  private save(view: TaskView): void {
    const disk = this.deps.store.getTask(view.task.id);
    if (disk.task.status === "PAUSED" && view.task.status !== "PAUSED") throw abortError();
    this.deps.store.save(view);
  }
}

function runLabel(role: AiRunRecord["role"]): string {
  if (role === "spec") return "Grok пишет ТЗ";
  if (role === "plan") return "Grok пишет план";
  if (role === "builder") return "Grok выполняет задачу";
  if (role === "fix") return "Grok исправляет замечание";
  if (role === "reviewer") return "Независимый Grok проверяет результат";
  return "Grok разбирает замечание";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
