import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type {
  FeedbackAnalysis,
  PlanStep,
  ReviewDocument,
  SpecDocument,
  Task,
  TaskStore,
} from "@taskos/core";
import {
  buildGrokArgs,
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
  | { type: "timeline"; message: string }
  | { type: "session"; sessionId: string };

export interface ExecuteOutcome {
  ok: boolean;
  summary: string;
  sessionId: string | null;
}

export interface AiContext {
  task: Task;
  originalRequest: string;
  spec: string | null;
  plan: string | null;
  review: string | null;
  feedback: string[];
  diffStat: string;
  repoPath: string;
  mode: "build" | "fix";
  signal?: AbortSignal;
}

type Listen = (event: ProviderEvent) => void;

export interface AIProvider {
  readonly id: "grok-build" | "fake";
  generateSpec(ctx: AiContext, onEvent?: Listen): Promise<SpecDocument>;
  generatePlan(ctx: AiContext, onEvent?: Listen): Promise<PlanStep[]>;
  executeTask(ctx: AiContext, onEvent?: Listen): Promise<ExecuteOutcome>;
  reviewTask(ctx: AiContext, onEvent?: Listen): Promise<ReviewDocument>;
  analyzeFeedback(ctx: AiContext, onEvent?: Listen): Promise<FeedbackAnalysis>;
}

export class GrokBuildProvider implements AIProvider {
  readonly id = "grok-build" as const;
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
      return { ok: true, summary: markdown, sessionId: null };
    }
    const prompt = buildPrompt(ctx);
    const file = this.store.promptFile(ctx.task.id, ctx.mode);
    fs.writeFileSync(file, prompt, "utf8");
    const config = this.store.getConfig();
    const command = await this.command(config.grokCommand);
    let text = "";
    let sessionId: string | null = null;
    let streamError: string | null = null;
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
        if (parsed.timeline) onEvent?.({ type: "timeline", message: parsed.timeline });
        if (parsed.sessionId) {
          sessionId = parsed.sessionId;
          onEvent?.({ type: "session", sessionId });
        }
        if (parsed.error) streamError = parsed.error;
      },
    });
    if (result.cancelled) throw abortError();
    if (result.timedOut) throw new AppError(504, "AI_TIMEOUT", "Grok не ответил вовремя", tail(result.stderr));
    if (result.spawnError) throw new AppError(503, "GROK_UNAVAILABLE", "Grok Build не запустился", result.spawnError);
    if (streamError || result.exitCode !== 0) {
      throw new AppError(502, "GROK_FAILED", "Grok завершился с ошибкой", streamError || tail(result.stderr) || tail(result.stdout));
    }
    return { ok: true, summary: text.trim() || "Проход Grok завершён.", sessionId };
  }

  private async structured<T>(
    ctx: AiContext,
    role: "spec" | "plan" | "review" | "feedback" | "compose",
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
  readonly id = "fake" as const;
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
    return { ok: true, summary: ctx.task.requiresCode ? "Код обновлён." : "# Результат\n\nЧерновик готов.\n", sessionId: "fake-session" };
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

function specPrompt(ctx: AiContext): string {
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

function planPrompt(ctx: AiContext): string {
  return `Составь пошаговый план из конкретных действий.\n\nТЗ:\n${ctx.spec ?? ""}\n\nЗапрос:\n${ctx.originalRequest}`;
}

function buildPrompt(ctx: AiContext): string {
  return [
    ctx.mode === "fix" ? "Исправь задачу по замечанию. Не начинай заново." : "Выполни задачу по плану.",
    "Не делай merge, push, rebase, reset --hard и не удаляй ветки. Не коммить в main.",
    "",
    "Исходный запрос:",
    ctx.originalRequest,
    "",
    "ТЗ:",
    ctx.spec ?? "",
    "",
    "План:",
    ctx.plan ?? "",
    "",
    ctx.feedback.length ? `Замечания:\n${ctx.feedback.join("\n\n")}` : "",
    ctx.diffStat ? `Текущий diff stat:\n${ctx.diffStat}` : "",
  ].join("\n");
}

function composePrompt(ctx: AiContext): string {
  return `Подготовь результат задачи в markdown. Это не задача на изменение кода.\n\nЗапрос:\n${ctx.originalRequest}\n\nТЗ:\n${ctx.spec ?? ""}\n\nПлан:\n${ctx.plan ?? ""}\n\nЗамечания:\n${ctx.feedback.join("\n")}`;
}

function reviewPrompt(ctx: AiContext): string {
  return [
    "Ты независимый ревьюер. У тебя новый контекст, ты не автор изменений.",
    "Верни passed=false, если есть серьёзная проблема.",
    "",
    "Запрос:",
    ctx.originalRequest,
    "",
    "ТЗ:",
    ctx.spec ?? "",
    "",
    "Diff stat:",
    ctx.diffStat || "нет",
    "",
    "Предыдущее ревью:",
    ctx.review ?? "нет",
  ].join("\n");
}

function feedbackPrompt(ctx: AiContext): string {
  return `Разбери последнее замечание пользователя и скажи, что менять.\n\nЗапрос:\n${ctx.originalRequest}\n\nЗамечания:\n${ctx.feedback.join("\n\n")}`;
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
