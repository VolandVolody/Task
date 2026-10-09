import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type {
  BuildReport,
  FeedbackAnalysis,
  PlanStep,
  ReviewDocument,
  SpecDocument,
  Task,
  TaskStore,
  TestRun,
} from "@taskos/core";
import {
  blockedCommandReason,
  buildGrokArgs,
  extractBuildReport,
  coerceCompose,
  coerceFeedback,
  coercePlan,
  coerceReview,
  coerceSpec,
  parseGrokFinal,
  parseGrokStreamLine,
} from "@taskos/core";
import { AppError, abortError } from "./errors.js";
import type { ProcessRunner } from "./runner.js";

export type ProviderEvent =
  | { type: "log"; stream: "stdout" | "stderr"; line: string }
  | { type: "timeline"; message: string; command?: string }
  | { type: "session"; sessionId: string };

export interface ExecuteOutcome {
  ok: boolean;
  summary: string;
  sessionId: string | null;
  report: BuildReport | null;
}

export interface AiContext {
  task: Task;
  originalRequest: string;
  spec: string | null;
  plan: string | null;
  review: string | null;
  result: string | null;
  feedback: string[];
  diffStat: string;
  gitDiff: string;
  changedFiles: string[];
  testSummary: string | null;
  testStatus: string | null;
  testRuns: TestRun[];
  testCommands: string[];
  repositoryContext: string | null;
  repoPath: string;
  mode: "build" | "fix";
  signal?: AbortSignal;
}

type Listen = (event: ProviderEvent) => void;

export interface AIProvider {
  readonly id: string;
  generateSpec(ctx: AiContext, onEvent?: Listen): Promise<SpecDocument>;
  generatePlan(ctx: AiContext, onEvent?: Listen): Promise<PlanStep[]>;
  executeTask(ctx: AiContext, onEvent?: Listen): Promise<ExecuteOutcome>;
  reviewTask(ctx: AiContext, onEvent?: Listen): Promise<ReviewDocument>;
  analyzeFeedback(ctx: AiContext, onEvent?: Listen): Promise<FeedbackAnalysis>;
}

export class ProviderRegistry {
  private readonly providers = new Map<string, AIProvider>();

  register(provider: AIProvider): void {
    this.providers.set(provider.id, provider);
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }

  get(id: string): AIProvider {
    const found = this.providers.get(id);
    if (!found) throw new AppError(503, "PROVIDER", `Провайдер «${id}» не подключён`);
    return found;
  }
}

export class GrokBuildProvider implements AIProvider {
  readonly id = "grok-build";
  private resolved: string | null = null;

  constructor(
    private readonly store: TaskStore,
    private readonly runner: ProcessRunner,
  ) {}

  generateSpec(ctx: AiContext, onEvent?: Listen): Promise<SpecDocument> {
    return this.structured(ctx, "spec", specPrompt(ctx), coerceSpec, onEvent);
  }

  generatePlan(ctx: AiContext, onEvent?: Listen): Promise<PlanStep[]> {
    return this.structured(ctx, "plan", planPrompt(ctx), coercePlan, onEvent);
  }

  reviewTask(ctx: AiContext, onEvent?: Listen): Promise<ReviewDocument> {
    return this.structured(ctx, "review", reviewPrompt(ctx), coerceReview, onEvent);
  }

  analyzeFeedback(ctx: AiContext, onEvent?: Listen): Promise<FeedbackAnalysis> {
    return this.structured(ctx, "feedback", feedbackPrompt(ctx), coerceFeedback, onEvent);
  }

  async executeTask(ctx: AiContext, onEvent?: Listen): Promise<ExecuteOutcome> {
    if (!ctx.task.requiresCode) {
      const markdown = await this.structured(ctx, "compose", composePrompt(ctx), coerceCompose, onEvent);
      return { ok: true, summary: markdown, sessionId: null, report: doneReport(ctx, "Результат подготовлен") };
    }
    const prompt = buildPrompt(ctx);
    const file = this.store.promptFile(ctx.task.id, ctx.mode);
    fs.writeFileSync(file, prompt, "utf8");
    const config = this.store.getConfig();
    const command = await this.command(config.grokCommand);
    let text = "";
    let sessionId: string | null = null;
    let streamError: string | null = null;
    let blocked: string | null = null;
    const result = await this.runner.run(ctx.task.id, {
      command,
      args: buildGrokArgs({ role: "build", promptFile: file, cwd: ctx.repoPath, model: config.grokModel }),
      cwd: ctx.repoPath,
      timeoutMs: config.grokTimeoutMs,
      signal: ctx.signal,
      onLine: (stream, line) => {
        onEvent?.({ type: "log", stream, line });
        if (stream !== "stdout") return;
        const parsed = parseGrokStreamLine(line);
        if (parsed.textDelta) text += parsed.textDelta;
        if (parsed.command && !blocked) {
          blocked = blockedCommandReason(parsed.command);
          if (blocked) this.runner.cancel(ctx.task.id);
        }
        if (parsed.timeline) onEvent?.({ type: "timeline", message: parsed.timeline, command: parsed.command ?? undefined });
        if (parsed.sessionId) {
          sessionId = parsed.sessionId;
          onEvent?.({ type: "session", sessionId });
        }
        if (parsed.error) streamError = parsed.error;
      },
    });
    if (blocked) throw new AppError(409, "COMMAND_BLOCKED", blocked);
    if (result.cancelled) throw abortError();
    if (result.timedOut) throw new AppError(504, "AI_TIMEOUT", "Grok не ответил вовремя", tail(result.stderr));
    if (result.spawnError) throw new AppError(503, "GROK_UNAVAILABLE", "Grok Build не запустился", result.spawnError);
    if (streamError || result.exitCode !== 0) {
      throw new AppError(502, "GROK_FAILED", "Grok завершился с ошибкой", streamError || tail(result.stderr) || tail(result.stdout));
    }
    const report = await this.report(ctx, text, onEvent);
    return { ok: true, summary: report.summary || text.trim() || "Проход Grok завершён.", sessionId, report };
  }

  private async report(ctx: AiContext, transcript: string, onEvent?: Listen): Promise<BuildReport> {
    const file = this.store.promptFile(ctx.task.id, "report");
    const prompt = reportPrompt(ctx, transcript);
    fs.writeFileSync(file, prompt, "utf8");
    const config = this.store.getConfig();
    const command = await this.command(config.grokCommand);
    const result = await this.runner.run(ctx.task.id, {
      command,
      args: buildGrokArgs({ role: "report", promptFile: file, cwd: ctx.repoPath, model: config.grokModel }),
      cwd: ctx.repoPath,
      timeoutMs: config.grokTimeoutMs,
      signal: ctx.signal,
      onLine: (stream, line) => onEvent?.({ type: "log", stream, line }),
    });
    if (result.cancelled) throw abortError();
    if (result.timedOut) throw new AppError(504, "AI_TIMEOUT", "Grok не ответил вовремя", tail(result.stderr));
    if (result.spawnError) throw new AppError(503, "GROK_UNAVAILABLE", "Grok Build не запустился", result.spawnError);
    const parsed = extractBuildReport(`${result.stdout}\n${result.stderr}`);
    if (parsed) return parsed;
    if (result.exitCode !== 0) {
      throw new AppError(502, "GROK_FAILED", "Grok завершился с ошибкой", tail(result.stderr) || tail(result.stdout));
    }
    return {
      summary: "Отчёт сборки не разобран. Шаги плана не отмечены выполненными.",
      steps: [],
    };
  }

  private async structured<T>(
    ctx: AiContext,
    role: "spec" | "plan" | "review" | "feedback" | "compose" | "report",
    prompt: string,
    coerce: (value: unknown) => T,
    onEvent?: Listen,
  ): Promise<T> {
    const file = this.store.promptFile(ctx.task.id, role);
    fs.writeFileSync(file, prompt, "utf8");
    const config = this.store.getConfig();
    const command = await this.command(config.grokCommand);
    const result = await this.runner.run(ctx.task.id, {
      command,
      args: buildGrokArgs({ role, promptFile: file, cwd: ctx.repoPath, model: config.grokModel }),
      cwd: ctx.repoPath,
      timeoutMs: config.grokTimeoutMs,
      signal: ctx.signal,
      onLine: (stream, line) => onEvent?.({ type: "log", stream, line }),
    });
    if (result.cancelled) throw abortError();
    if (result.timedOut) throw new AppError(504, "AI_TIMEOUT", "Grok не ответил вовремя", tail(result.stderr));
    if (result.spawnError) throw new AppError(503, "GROK_UNAVAILABLE", "Grok Build не запустился", result.spawnError);
    const parsed = parseGrokFinal(result.stdout);
    if (parsed.sessionId) onEvent?.({ type: "session", sessionId: parsed.sessionId });
    if (parsed.error || result.exitCode !== 0) {
      throw new AppError(502, "GROK_FAILED", "Grok завершился с ошибкой", parsed.error || tail(result.stderr) || tail(result.stdout));
    }
    return coerce(parsed.data);
  }

  private async command(name: string): Promise<string> {
    if (this.resolved) return this.resolved;
    if (path.isAbsolute(name) && fs.existsSync(name)) {
      this.resolved = name;
      return name;
    }
    const located = await locate(name);
    if (!located) throw new AppError(503, "GROK_UNAVAILABLE", `Команда ${name} не найдена. Установите Grok Build и проверьте PATH.`);
    this.resolved = located;
    return located;
  }
}

export class FakeProvider implements AIProvider {
  readonly id = "fake";
  readonly calls: string[] = [];
  reviewPassesOn = 1;
  private reviews = 0;
  hangBuild: Promise<void> | null = null;

  async generateSpec(ctx: AiContext): Promise<SpecDocument> {
    this.calls.push("spec");
    return {
      title: "Импорт поставщика",
      goal: "Собрать понятный результат из короткой формулировки.",
      required: [ctx.originalRequest.split("\n")[0] || "Сделать задачу"],
      notRequired: ["Облачный аккаунт"],
      constraints: ["Не затирать исходный запрос"],
      components: [ctx.task.requiresCode ? "репозиторий" : "result.md"],
      risks: ["Мало исходных данных"],
      assumptions: ["Берём безопасное допущение, раз деталей немного."],
      definitionOfDone: ["Результат можно прочитать и проверить"],
      checks: ["Исходный текст на месте"],
      expectedResult: "Готовый артефакт задачи",
      requiresCode: ctx.task.requiresCodeMode !== "no",
      type: ctx.task.scope === "personal" ? "personal" : "development",
      projectName: ctx.task.projectMode === "auto" ? null : null,
      criticalQuestion: ctx.originalRequest.includes("???") ? "Уточните, какой именно файл менять?" : null,
    };
  }

  async generatePlan(): Promise<PlanStep[]> {
    this.calls.push("plan");
    return [
      { id: "01", title: "Inspect existing code", status: "pending", startedAt: null, finishedAt: null, durationMs: null, weight: 1 },
      { id: "02", title: "Implement the change", status: "pending", startedAt: null, finishedAt: null, durationMs: null, weight: 1 },
    ];
  }

  async executeTask(ctx: AiContext, onEvent?: Listen): Promise<ExecuteOutcome> {
    this.calls.push(ctx.mode === "fix" ? "fix" : "build");
    if (this.hangBuild) await this.hangBuild;
    onEvent?.({ type: "log", stream: "stdout", line: "fake builder" });
    onEvent?.({ type: "timeline", message: "Изменён importer.ts" });
    if (ctx.task.requiresCode) {
      fs.writeFileSync(path.join(ctx.repoPath, "importer.txt"), "ok\n", "utf8");
    }
    const summary = ctx.task.requiresCode ? "Код обновлён." : "# Результат\n\nЧерновик готов.\n";
    return {
      ok: true,
      summary,
      sessionId: "fake-session",
      report: {
        ...doneReport(ctx, summary),
        artifacts: ctx.task.requiresCode ? [{ path: "importer.txt", label: "Импортёр" }] : [],
      },
    };
  }

  async reviewTask(): Promise<ReviewDocument> {
    this.reviews += 1;
    this.calls.push("review");
    const passed = this.reviews >= this.reviewPassesOn;
    return {
      passed,
      summary: passed ? "Замечаний нет." : "Нужно исправление.",
      findings: passed ? [] : [{ severity: "high", detail: "кнопка не подключена" }],
    };
  }

  async analyzeFeedback(ctx: AiContext): Promise<FeedbackAnalysis> {
    this.calls.push("feedback");
    return {
      understood: ctx.feedback.at(-1) ?? "замечание",
      changes: ["исправить по замечанию"],
      requiresCode: ctx.task.requiresCode,
    };
  }
}

function doneReport(ctx: AiContext, summary: string): BuildReport {
  return {
    summary,
    steps: ctx.task.plan
      .filter((step) => step.status !== "skipped")
      .map((step) => ({ id: step.id, status: "done" as const, note: "" })),
  };
}

export function specPrompt(ctx: AiContext): string {
  return [
    "Составь ТЗ для персональной системы TaskOS.",
    "Пиши по-русски. Если данных мало, сделай безопасное допущение и запиши его.",
    "criticalQuestion заполняй только если без ответа задачу нельзя начать, не опасаясь вреда. Иначе null.",
    "Не переписывай исходный запрос: он ниже дословно.",
    "",
    "Исходный запрос:",
    ctx.originalRequest,
    "",
    ctx.feedback.length ? `Уже данные уточнения:\n${ctx.feedback.join("\n")}` : "",
  ].join("\n");
}

export function planPrompt(ctx: AiContext): string {
  return `Составь пошаговый план из конкретных действий.\n\nТЗ:\n${ctx.spec ?? ""}\n\nЗапрос:\n${ctx.originalRequest}`;
}

export function buildPrompt(ctx: AiContext): string {
  const lines = [
    ctx.mode === "fix" ? "Исправь задачу по замечанию. Не начинай заново." : "Выполни задачу по плану.",
    "Не делай merge, push, rebase, reset --hard и не удаляй ветки. Не коммить в main.",
    "",
    "ORIGINAL REQUEST",
    ctx.originalRequest,
    "",
    "SPEC",
    ctx.spec ?? "",
    "",
    "PLAN",
    ctx.plan ?? "",
  ];
  if (ctx.mode === "fix") {
    lines.push("", "PREVIOUS REVIEW", ctx.review ?? "нет", "", "CURRENT DIFF", ctx.gitDiff || ctx.diffStat || "нет", "", "TEST RESULTS", testBlock(ctx), "", "USER FEEDBACK", ctx.feedback.join("\n\n") || "нет");
  } else if (ctx.feedback.length > 0) {
    lines.push("", "USER FEEDBACK", ctx.feedback.join("\n\n"));
  }
  return lines.join("\n");
}

function reportPrompt(ctx: AiContext, transcript: string): string {
  const ids = ctx.task.plan.map((step) => `${step.id}: ${step.title}`).join("\n") || "шагов нет";
  return [
    "Верни только JSON отчёта. Не вызывай инструменты и не проверяй файлы заново.",
    "Поле steps содержит только id из списка ниже. Не выдумывай новые id.",
    "status: done, pending, failed или skipped. done — только если ход выполнения это подтверждает.",
    "",
    "STEPS",
    ids,
    "",
    "Ход выполнения:",
    tail(transcript) || "Кодовый проход завершился без текстового отчёта.",
  ].join("\n");
}

export function composePrompt(ctx: AiContext): string {
  return `Подготовь результат задачи в markdown. Это не задача на изменение кода.\n\nЗапрос:\n${ctx.originalRequest}\n\nТЗ:\n${ctx.spec ?? ""}\n\nПлан:\n${ctx.plan ?? ""}\n\nЗамечания:\n${ctx.feedback.join("\n")}`;
}

export function reviewPrompt(ctx: AiContext): string {
  return [
    "Ты независимый ревьюер. У тебя новый контекст, ты не автор изменений.",
    "Проверь соответствие ТЗ, регрессии, баги, безопасность, несогласованность типов, пропущенные проверки, покрытие тестами, разрушительные операции и правила архитектуры TaskOS.",
    "Верни passed=false, если есть серьёзная проблема.",
    "",
    "ORIGINAL REQUEST",
    ctx.originalRequest,
    "",
    "SPEC",
    ctx.spec ?? "",
    "",
    "PLAN",
    ctx.plan ?? "",
    "",
    "TEST RESULTS",
    testBlock(ctx),
    "",
    "CHANGED FILES",
    ctx.changedFiles.join("\n") || "нет",
    "",
    "GIT DIFF",
    ctx.gitDiff || ctx.diffStat || "нет",
    "",
    "PREVIOUS REVIEW",
    ctx.review ?? "нет",
  ].join("\n");
}

export function feedbackPrompt(ctx: AiContext): string {
  return [
    "Разбери замечание пользователя. Смотри на формулу, изменённые файлы, тесты и прошлые замечания, а не только на текст замечания.",
    "",
    "ORIGINAL REQUEST",
    ctx.originalRequest,
    "",
    "SPEC",
    ctx.spec ?? "",
    "",
    "PLAN",
    ctx.plan ?? "",
    "",
    "CURRENT RESULT",
    ctx.result ?? "",
    "",
    "CURRENT REVIEW",
    ctx.review ?? "нет",
    "",
    "CURRENT GIT DIFF",
    ctx.gitDiff || ctx.diffStat || "нет",
    "",
    "TESTS STATUS",
    ctx.testStatus ?? "нет",
    "",
    "TESTS SUMMARY",
    ctx.testSummary ?? "нет",
    "",
    "CHANGED FILES",
    ctx.changedFiles.join("\n") || "нет",
    "",
    "USER FEEDBACK",
    ctx.feedback.join("\n\n") || "нет",
  ].join("\n");
}

function testBlock(ctx: AiContext): string {
  const commands = ctx.testCommands.length > 0 ? ctx.testCommands.join("\n") : "Команда тестов не задана";
  const runs = ctx.testRuns.length
    ? ctx.testRuns.map((run) => `${run.command} exit=${run.exitCode ?? "?"} ${run.status} ${run.summary}`).join("\n")
    : "прогонов нет";
  return [`TEST COMMANDS`, commands, `STATUS ${ctx.testStatus ?? "нет"}`, `SUMMARY ${ctx.testSummary ?? "нет"}`, "RUNS", runs].join("\n");
}

function tail(text: string): string {
  return text.trim().slice(-4000);
}

function locate(command: string): Promise<string | null> {
  const which = process.platform === "win32" ? "where.exe" : "which";
  return new Promise((resolve) => {
    execFile(which, [command], { windowsHide: true }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const line = stdout.split(/\r?\n/).map((item) => item.trim()).find(Boolean) ?? null;
      resolve(line);
    });
  });
}
