import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AiRouting, AiRunRecord, Project, Task, TaskStatus, TaskStore, TaskView, TestRun } from "@taskos/core";
import {
  applyBuildReport,
  applyFeedbackRestart,
  approveTask,
  branchName,
  completeTask,
  parseTestOutput,
  pathInside,
  pauseTask,
  renderPlanMarkdown,
  renderReviewMarkdown,
  renderSpecMarkdown,
  resolveBoundRepo,
  resolveTestCommands,
  resumeTask,
  reviewCountsFrom,
  transition,
} from "@taskos/core";
import type { AIProvider, AiContext, ProviderEvent } from "./ai.js";
import { ProviderRegistry } from "./ai.js";
import type { Bus } from "./bus.js";
import { AppError, abortError, isAbort, publicError } from "./errors.js";
import type { GitAdapter } from "./git.js";
import type { GrokProbe } from "./grok-probe.js";
import type { ProcessRunner } from "./runner.js";
import { toCard, type TaskCard } from "./present.js";
import type { TaskLock } from "@taskos/core";

export interface OrchestratorDeps {
  store: TaskStore;
  lock: TaskLock;
  provider?: AIProvider;
  registry?: ProviderRegistry;
  routing?: AiRouting;
  git: GitAdapter;
  runner: ProcessRunner;
  bus: Bus;
  root: string;
  now?: () => string;
  grokProbe?: GrokProbe | null;
}

export class Orchestrator {
  private tokens = new Map<string, string>();
  private aborts = new Map<string, AbortController>();
  private readonly registry: ProviderRegistry;

  constructor(private readonly deps: OrchestratorDeps) {
    this.registry = deps.registry ?? new ProviderRegistry();
    if (deps.provider && !this.registry.has(deps.provider.id)) this.registry.register(deps.provider);
  }

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

  async push(taskId: string): Promise<TaskCard> {
    this.assertIdle(taskId);
    const view = this.deps.store.getTask(taskId);
    if (!view.task.git.repoPath || !view.task.git.branch?.startsWith("task/")) {
      throw new AppError(409, "BRANCH", "Push доступен только для ветки задачи");
    }
    await this.deps.git.pushTaskBranch(view.task.git.repoPath);
    await this.refreshGit(this.deps.store.getTask(taskId));
    this.remember(this.deps.store.getTask(taskId), "Ветка отправлена на origin");
    return this.card(this.deps.store.getTask(taskId));
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
    this.assertCompatible();
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
    const exhausted = view.task.reviewPassed === false && view.task.qualityMode === "deep" && view.task.fixCycles >= 2;
    view.task.nextAction = exhausted
      ? "AI review не пройден после 2 исправлений. Нужна проверка пользователя"
      : view.task.reviewPassed === false
        ? "Ревью нашло замечания. Проверьте результат"
        : "Проверить результат";
    view.task.error = null;
    this.remember(view, "Ожидание проверки пользователя");
  }

  private async makeSpec(taskId: string, signal: AbortSignal): Promise<void> {
    const view = this.live(taskId, signal);
    const run = this.openRun(view, "spec");
    try {
      const spec = await this.providerFor("spec").generateSpec(await this.context(view, "build", signal), (event) => this.onEvent(taskId, run.id, event));
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
      const steps = await this.providerFor("plan").generatePlan(await this.context(view, "build", signal), (event) => this.onEvent(taskId, run.id, event));
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
        const analysis = await this.providerFor("feedback").analyzeFeedback(await this.context(view, "fix", signal), (event) => this.onEvent(taskId, run.id, event));
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
      const outcome = await this.providerFor(fixing ? "fix" : "builder").executeTask(
        await this.context(this.live(taskId, signal), fixing ? "fix" : "build", signal),
        (event) => this.onEvent(taskId, run.id, event),
      );
      const fresh = this.live(taskId, signal);
      fresh.task = applyBuildReport(fresh.task, outcome.report, this.now());
      fresh.task.error = null;
      if (outcome.report?.artifacts?.length && fresh.task.git.repoPath) {
        this.deps.store.registerArtifacts(taskId, fresh.task.git.repoPath, outcome.report.artifacts, this.now());
      }
      if (!fresh.task.buildComplete) fresh.task.nextAction = "Часть шагов плана не подтверждена отчётом";
      if (outcome.summary) this.deps.store.writeDoc(taskId, "result.md", outcome.summary.endsWith("\n") ? outcome.summary : `${outcome.summary}\n`);
      this.deps.store.writeDoc(taskId, "plan.md", renderPlanMarkdown(fresh.task.plan));
      this.closeRun(fresh, run.id, "ok", outcome.summary.slice(0, 180), outcome.sessionId);
      if (fresh.task.requiresCode) {
        await this.commitWork(fresh);
        await this.guardWorktree(taskId);
      }
      this.remember(this.deps.store.getTask(taskId), fresh.task.buildComplete ? "Выполнение закончено" : "Выполнение закончено не по всем шагам");
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
        const review = await this.providerFor("reviewer").reviewTask(await this.context(view, "build", signal), (event) => this.onEvent(taskId, run.id, event));
        const fresh = this.live(taskId, signal);
        fresh.task.reviewPassed = review.passed;
        fresh.task.reviewCounts = reviewCountsFrom(review.findings);
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
    const commands = resolveTestCommands(view.task, this.projectOf(view.task));
    const repo = view.task.git.repoPath;
    if (!repo) {
      throw new AppError(409, "REPO_REQUIRED", "Для тестов нужен репозиторий задачи");
    }
    if (commands.length === 0) {
      view.task.tests = {
        status: "failed",
        passed: null,
        failed: null,
        command: null,
        summary: "Команда тестов не задана",
      };
      view.task.testRuns = [];
      view.task.error = { code: "TEST_COMMAND_MISSING", message: "Команда тестов не задана" };
      view.task.nextAction = "Задайте команду тестов в проекте";
      this.remember(view, "Команда тестов не задана");
      return false;
    }
    const config = this.deps.store.getConfig();
    const runs: TestRun[] = [];
    let allPassed = true;
    for (const command of commands) {
      const started = this.now();
      const shell = process.platform === "win32";
      const result = await this.deps.runner.run(taskId, {
        command: shell ? process.env.ComSpec || "cmd.exe" : "sh",
        args: shell ? ["/d", "/s", "/c", command] : ["-c", command],
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
      runs.push({
        id: `test-${String(runs.length + 1).padStart(2, "0")}`,
        command,
        status: passed ? "passed" : "failed",
        exitCode: result.exitCode,
        passed: counts.passed,
        failed: counts.failed,
        durationMs: Math.max(0, Date.parse(this.now()) - Date.parse(started)),
        summary: summary || (passed ? "Тесты прошли" : "Тесты не прошли"),
        startedAt: started,
        finishedAt: this.now(),
      });
      if (!passed) allPassed = false;
    }
    const passedCount = runs.reduce((sum, run) => sum + (run.passed ?? 0), 0);
    const failedCount = runs.reduce((sum, run) => sum + (run.failed ?? 0), 0);
    const fresh = this.live(taskId, signal);
    fresh.task.testRuns = runs;
    fresh.task.tests = {
      status: allPassed ? "passed" : "failed",
      passed: runs.some((run) => run.passed !== null) ? passedCount : null,
      failed: runs.some((run) => run.failed !== null) ? failedCount : null,
      command: commands.join(" && "),
      summary: runs.map((run) => `${run.command}: ${run.status} (exit ${run.exitCode ?? "?"})`).join("\n"),
    };
    if (!allPassed) {
      fresh.task.error = { code: "TEST_FAILED", message: "Тесты не прошли", details: fresh.task.tests.summary ?? "" };
      fresh.task.nextAction = "Тесты не прошли. Можно отправить замечание.";
    } else {
      fresh.task.error = null;
    }
    this.remember(fresh, allPassed ? "Тесты прошли" : "Тесты не прошли");
    return allPassed;
  }

  private async prepareGit(taskId: string, signal: AbortSignal): Promise<void> {
    const view = this.live(taskId, signal);
    const project = this.projectOf(view.task);
    const bound = resolveBoundRepo(view.task, project, this.deps.root);
    if (!bound.repoPath) {
      throw new AppError(409, "REPO_REQUIRED", "Для задачи с кодом нужен репозиторий. Укажите его в проекте или вручную — TaskOS не подставляет свой репозиторий.");
    }
    let base = view.task.git.baseBranch;
    let warning: string | null = view.task.git.baseBranchWarning;
    if (!(view.task.git.baseBranchExplicit && base)) {
      if (project?.repository?.baseBranch) {
        base = project.repository.baseBranch;
        warning = null;
      } else {
        const detected = await this.deps.git.detectBase(bound.repoPath);
        base = detected.branch;
        warning = detected.warning;
      }
    }
    const branch = view.task.git.branch ?? branchName(view.task.id, view.task.title);
    view.task.git.repoPath = bound.repoPath;
    view.task.git.repoSource = bound.source;
    view.task.git.branch = branch;
    view.task.git.baseBranch = base;
    view.task.git.baseBranchWarning = warning;
    this.save(view);
    await this.deps.git.ensureBranch(bound.repoPath, base, branch);
    const fresh = this.live(taskId, signal);
    await this.refreshGit(fresh);
    const note = warning ? `Ветка ${branch}. ${warning}` : `Ветка ${branch}`;
    this.remember(this.live(taskId, signal), note);
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

  private async context(view: TaskView, mode: "build" | "fix", signal: AbortSignal): Promise<AiContext> {
    const project = this.projectOf(view.task);
    let gitDiff = view.task.git.diffStat;
    if (view.task.requiresCode && view.task.git.repoPath && view.task.git.baseBranch) {
      try {
        const loaded = await this.deps.git.diff(view.task.git.repoPath, view.task.git.baseBranch);
        if (loaded.text) gitDiff = loaded.text;
      } catch {
        gitDiff = view.task.git.diffStat;
      }
    }
    return {
      task: view.task,
      originalRequest: view.originalRequest,
      spec: this.deps.store.readDoc(view.task.id, "spec.md"),
      plan: this.deps.store.readDoc(view.task.id, "plan.md"),
      review: this.deps.store.readDoc(view.task.id, "review.md"),
      result: this.deps.store.readDoc(view.task.id, "result.md"),
      feedback: this.deps.store.listFeedback(view.task.id).map((item) => item.body),
      diffStat: view.task.git.diffStat,
      gitDiff,
      changedFiles: view.task.git.changedFileNames,
      testSummary: view.task.tests.summary,
      testStatus: view.task.tests.status,
      testRuns: view.task.testRuns,
      testCommands: resolveTestCommands(view.task, project),
      repositoryContext: project?.repository
        ? `${project.name}: ${project.repository.localPath}`
        : null,
      repoPath: view.task.requiresCode && view.task.git.repoPath ? view.task.git.repoPath : this.deps.root,
      mode,
      signal,
    };
  }

  private projectOf(task: Task): Project | null {
    if (!task.projectId) return null;
    return this.deps.store.listProjects().find((project) => project.id === task.projectId) ?? null;
  }

  private providerFor(role: "spec" | "plan" | "builder" | "reviewer" | "feedback" | "fix"): AIProvider {
    const routing = this.deps.routing ?? this.deps.store.getConfig().aiRouting;
    const key = role === "fix" ? "builder" : role;
    return this.registry.get(routing[key]);
  }

  private assertCompatible(): void {
    const probe = this.deps.grokProbe;
    if (!probe) return;
    const routing = this.deps.routing ?? this.deps.store.getConfig().aiRouting;
    if (!Object.values(routing).includes("grok-build")) return;
    if (!probe.available) throw new AppError(503, "GROK_UNAVAILABLE", probe.message ?? "Grok Build не найден");
    if (!probe.compatible) throw new AppError(503, "GROK_INCOMPATIBLE", probe.message ?? "Эта версия Grok Build не подходит TaskOS");
  }

  private async guardWorktree(taskId: string): Promise<void> {
    const view = this.deps.store.getTask(taskId);
    const repo = view.task.git.repoPath;
    if (!repo) return;
    try {
      const top = path.resolve(await this.deps.git.toplevel(repo));
      if (top !== path.resolve(repo)) this.remember(view, `Корень репозитория не совпал: ${top}`);
    } catch {
      return;
    }
    const escaped = view.task.git.changedFileNames.filter((name) => !pathInside(repo, name));
    if (escaped.length === 0) return;
    const fresh = this.deps.store.getTask(taskId);
    fresh.task.error = { code: "PATH_ESCAPE", message: "Изменение вышло за каталог репозитория", details: escaped.join("\n") };
    this.remember(fresh, "Путь вышел за пределы репозитория");
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
    const provider = this.providerFor(role);
    const run: AiRunRecord = {
      id: `run-${String(view.task.aiRuns.length + 1).padStart(3, "0")}`,
      role,
      provider: provider.id,
      model: provider.id === "grok-build" ? this.deps.store.getConfig().grokModel : null,
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
    if (pub.code === "REPO_REQUIRED" && view.task.status !== "BLOCKED" && view.task.status !== "CANCELLED" && view.task.status !== "DONE") {
      view.task = transition(view.task, "BLOCKED", this.now());
      view.task.blockedReason = pub.message;
      view.task.nextAction = "Укажите репозиторий проекта";
    } else {
      view.task.nextAction = "Можно запустить снова";
    }
    view.task.error = { code: pub.code, message: pub.message, details: pub.details };
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
  if (role === "spec") return "Модель пишет ТЗ";
  if (role === "plan") return "Модель пишет план";
  if (role === "builder") return "Модель выполняет задачу";
  if (role === "fix") return "Модель исправляет замечание";
  if (role === "reviewer") return "Независимая проверка результата";
  return "Модель разбирает замечание";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
