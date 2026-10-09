import type { BuildReport, FeedbackAnalysis, PlanStep, ReviewDocument, SpecDocument, TaskType } from "./types.js";
import { ParseError } from "./types.js";

export type GrokRole = "spec" | "plan" | "build" | "review" | "feedback" | "compose" | "report";

const TASK_TYPES = new Set<TaskType>([
  "development",
  "research",
  "content",
  "design",
  "data",
  "personal",
  "other",
]);

export const SPEC_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    goal: { type: "string" },
    required: { type: "array", items: { type: "string" } },
    notRequired: { type: "array", items: { type: "string" } },
    constraints: { type: "array", items: { type: "string" } },
    components: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    assumptions: { type: "array", items: { type: "string" } },
    definitionOfDone: { type: "array", items: { type: "string" } },
    checks: { type: "array", items: { type: "string" } },
    expectedResult: { type: "string" },
    requiresCode: { type: "boolean" },
    type: { type: "string" },
    projectName: { type: ["string", "null"] },
    criticalQuestion: { type: ["string", "null"] },
  },
  required: ["title", "goal", "required", "assumptions", "definitionOfDone", "expectedResult", "requiresCode"],
} as const;

export const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          weight: { type: "number" },
        },
        required: ["title"],
      },
    },
  },
  required: ["steps"],
} as const;

export const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    passed: { type: "boolean" },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          severity: { type: "string" },
          detail: { type: "string" },
        },
        required: ["detail"],
      },
    },
  },
  required: ["passed", "summary", "findings"],
} as const;

export const FEEDBACK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    understood: { type: "string" },
    changes: { type: "array", items: { type: "string" } },
    requiresCode: { type: "boolean" },
  },
  required: ["understood", "changes", "requiresCode"],
} as const;

export const BUILD_REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          status: { type: "string" },
          note: { type: "string" },
        },
        required: ["id", "status"],
      },
    },
    artifacts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          label: { type: "string" },
        },
        required: ["path"],
      },
    },
  },
  required: ["summary", "steps"],
} as const;

export const COMPOSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    markdown: { type: "string" },
  },
  required: ["markdown"],
} as const;

const SCHEMA_BY_ROLE: Partial<Record<GrokRole, unknown>> = {
  spec: SPEC_SCHEMA,
  plan: PLAN_SCHEMA,
  review: REVIEW_SCHEMA,
  feedback: FEEDBACK_SCHEMA,
  compose: COMPOSE_SCHEMA,
  report: BUILD_REPORT_SCHEMA,
};

const BUILD_DENIES = [
  "Bash(git push*)",
  "Bash(git reset --hard*)",
  "Bash(git clean*)",
  "Bash(git branch -D*)",
  "Bash(git branch -d*)",
  "Bash(git merge*)",
  "Bash(git rebase*)",
  "Bash(git checkout main*)",
  "Bash(git checkout master*)",
  "Bash(git switch main*)",
  "Bash(git switch master*)",
];

export function buildGrokArgs(input: {
  role: GrokRole;
  promptFile: string;
  cwd: string;
  model: string;
}): string[] {
  const args = ["--prompt-file", input.promptFile, "--cwd", input.cwd, "-m", input.model];
  if (input.role === "build") {
    args.push(
      "--output-format",
      "streaming-json",
      "--permission-mode",
      "bypassPermissions",
      "--max-turns",
      "40",
      "--rules",
      "Ты работаешь внутри TaskOS. Не делай merge, force-push, rebase, reset --hard, clean и не удаляй ветки. Не коммить в main.",
    );
    for (const rule of BUILD_DENIES) args.push("--deny", rule);
    return args;
  }
  const schema = SCHEMA_BY_ROLE[input.role];
  args.push(
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(schema),
    "--permission-mode",
    "plan",
    "--max-turns",
    input.role === "compose" ? "12" : "8",
    "--disallowed-tools",
    "run_terminal_cmd",
    "--no-subagents",
    "--rules",
    input.role === "report"
      ? "Верни только объект по схеме. Не вызывай инструменты. Копируй id шагов из промпта. status только done, pending, failed или skipped."
      : "Отвечай по-русски. Верни только объект по схеме. Не изменяй файлы.",
  );
  return args;
}

export interface ParsedGrokLine {
  timeline: string | null;
  textDelta: string | null;
  error: string | null;
  done: boolean;
  sessionId: string | null;
  command: string | null;
}

export function parseGrokStreamLine(line: string): ParsedGrokLine {
  const empty: ParsedGrokLine = { timeline: null, textDelta: null, error: null, done: false, sessionId: null, command: null };
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return empty;
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return empty;
  }
  const type = typeof event.type === "string" ? event.type : "";
  if (type === "text" && typeof event.data === "string") return { ...empty, textDelta: event.data };
  if (type === "error") {
    const message = typeof event.message === "string" ? event.message : "Grok вернул ошибку";
    return { ...empty, error: message, done: true };
  }
  if (type === "end") {
    return {
      ...empty,
      done: true,
      sessionId: typeof event.sessionId === "string" ? event.sessionId : null,
    };
  }
  if (type === "tool_call" || type === "tool_call_update") {
    return { ...empty, timeline: toolTimeline(event), command: toolCommand(event) };
  }
  return empty;
}

function toolTimeline(event: Record<string, unknown>): string | null {
  const name = String(event.toolName ?? event.title ?? "");
  const kind = String(event.kind ?? "");
  const raw = (event.rawInput ?? {}) as Record<string, unknown>;
  const path = stringField(raw, ["path", "file_path", "target_file", "filePath"]);
  const command = typeof raw.command === "string" ? raw.command.replace(/\s+/g, " ").slice(0, 90) : "";
  const writing = /write|search_replace|edit/i.test(name) || kind === "edit" || kind === "write";
  if (writing && event.type === "tool_call") {
    return path ? `Изменён ${path}` : "Изменён файл";
  }
  if ((kind === "read" || name === "read_file") && event.type === "tool_call") {
    return path ? `Чтение ${basename(path)}` : null;
  }
  const shell = name === "run_terminal_cmd" || name === "run_terminal_command" || name === "bash" || kind === "execute";
  if (shell && event.type === "tool_call" && command) {
    return `Команда: ${command}`;
  }
  return null;
}

function toolCommand(event: Record<string, unknown>): string | null {
  const name = String(event.toolName ?? event.title ?? "");
  const kind = String(event.kind ?? "");
  const shell = name === "run_terminal_cmd" || name === "run_terminal_command" || name === "bash" || kind === "execute";
  if (!shell || event.type !== "tool_call") return null;
  const raw = (event.rawInput ?? {}) as Record<string, unknown>;
  return typeof raw.command === "string" ? raw.command : null;
}

function basename(file: string): string {
  const parts = file.split(/[/\\]/);
  return parts[parts.length - 1] || file;
}

function stringField(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

export interface GrokFinal {
  text: string;
  sessionId: string | null;
  data: unknown | null;
  error: string | null;
}

export function parseGrokFinal(stdout: string): GrokFinal {
  const candidates = jsonObjects(stdout);
  const last = candidates[candidates.length - 1];
  if (!last || typeof last !== "object") {
    return { text: stdout.trim(), sessionId: null, data: extractJsonObject(stdout), error: null };
  }
  const record = last as Record<string, unknown>;
  if (record.type === "error") {
    return {
      text: "",
      sessionId: typeof record.sessionId === "string" ? record.sessionId : null,
      data: null,
      error: typeof record.message === "string" ? record.message : "Grok вернул ошибку",
    };
  }
  const structured = record.structured_output ?? record.structuredOutput;
  const text = typeof record.text === "string" ? record.text : typeof record.result === "string" ? record.result : "";
  const data = structured ?? extractJsonObject(text) ?? (looksLikeDocument(record) ? record : null);
  return {
    text,
    sessionId: typeof record.sessionId === "string" ? record.sessionId : typeof record.session_id === "string" ? record.session_id : null,
    data,
    error: null,
  };
}

function looksLikeDocument(record: Record<string, unknown>): boolean {
  return "goal" in record || "steps" in record || "passed" in record || "markdown" in record || "understood" in record;
}

function jsonObjects(text: string): unknown[] {
  const found: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      found.push(JSON.parse(trimmed));
    } catch {
      // not a single-line object
    }
  }
  if (found.length > 0) return found;
  const extracted = extractJsonObject(text);
  return extracted ? [extracted] : [];
}

export function extractJsonObject(text: string): unknown | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ParseError(`Не удалось разобрать ответ Grok (${label})`);
  }
  return value as Record<string, unknown>;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function coerceSpec(value: unknown): SpecDocument {
  const record = asRecord(value, "ТЗ");
  const title = optionalString(record.title);
  const goal = optionalString(record.goal);
  const expectedResult = optionalString(record.expectedResult);
  if (!title || !goal || !expectedResult) throw new ParseError("В ТЗ нет цели или ожидаемого результата");
  const type = TASK_TYPES.has(record.type as TaskType) ? (record.type as TaskType) : "other";
  return {
    title,
    goal,
    required: stringList(record.required),
    notRequired: stringList(record.notRequired),
    constraints: stringList(record.constraints),
    components: stringList(record.components),
    risks: stringList(record.risks),
    assumptions: stringList(record.assumptions),
    definitionOfDone: stringList(record.definitionOfDone),
    checks: stringList(record.checks),
    expectedResult,
    requiresCode: record.requiresCode === true,
    type,
    projectName: optionalString(record.projectName),
    criticalQuestion: optionalString(record.criticalQuestion),
  };
}

export function coercePlan(value: unknown): PlanStep[] {
  const record = asRecord(value, "план");
  if (!Array.isArray(record.steps) || record.steps.length === 0) {
    throw new ParseError("План не содержит шагов");
  }
  return record.steps.map((item, index) => {
    const step = asRecord(item, "шаг плана");
    const title = optionalString(step.title);
    if (!title) throw new ParseError("У шага плана нет названия");
    const weight = typeof step.weight === "number" && step.weight > 0 ? step.weight : 1;
    return {
      id: optionalString(step.id) ?? String(index + 1).padStart(2, "0"),
      title,
      status: "pending",
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      weight,
    };
  });
}

export function coerceReview(value: unknown): ReviewDocument {
  const record = asRecord(value, "ревью");
  if (typeof record.passed !== "boolean" || typeof record.summary !== "string") {
    throw new ParseError("Ревью без итога");
  }
  const findings = Array.isArray(record.findings) ? record.findings : [];
  return {
    passed: record.passed,
    summary: record.summary.trim(),
    findings: findings.map((item) => {
      const finding = asRecord(item, "замечание ревью");
      const severity = finding.severity === "high" || finding.severity === "low" ? finding.severity : "medium";
      return { severity, detail: optionalString(finding.detail) ?? "Замечание без текста" };
    }),
  };
}

export function coerceFeedback(value: unknown): FeedbackAnalysis {
  const record = asRecord(value, "разбор замечания");
  const understood = optionalString(record.understood);
  if (!understood) throw new ParseError("Разбор замечания пустой");
  return {
    understood,
    changes: stringList(record.changes),
    requiresCode: record.requiresCode === true,
  };
}

function isBuildReportShape(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Array.isArray((value as Record<string, unknown>).steps);
}

export function extractBuildReport(stdout: string): BuildReport | null {
  const final = parseGrokFinal(stdout);
  const fromSchema = coerceIfReport(final.data);
  if (fromSchema) return fromSchema;
  const candidates: unknown[] = [];
  for (const source of [final.text, stdout]) {
    if (!source) continue;
    for (let index = 0; index < source.length; index += 1) {
      if (source[index] !== "{") continue;
      const slice = balancedObject(source, index);
      if (!slice) continue;
      try {
        candidates.push(JSON.parse(slice));
      } catch {
        // keep scanning
      }
      if (slice.length > 2) index += slice.length - 1;
    }
  }
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const report = coerceIfReport(candidates[index]);
    if (report) return report;
  }
  return null;
}

function coerceIfReport(value: unknown): BuildReport | null {
  if (!isBuildReportShape(value)) return null;
  try {
    return coerceBuildReport(value);
  } catch {
    return null;
  }
}

function balancedObject(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

export function coerceBuildReport(value: unknown): BuildReport {
  const record = asRecord(value, "отчёт сборки");
  const summary = optionalString(record.summary) ?? "Сборка завершена";
  const steps = Array.isArray(record.steps) ? record.steps : [];
  const artifacts = Array.isArray(record.artifacts) ? record.artifacts : [];
  return {
    summary,
    steps: steps.flatMap((item) => {
      const step = asRecord(item, "шаг отчёта");
      const id = optionalString(step.id);
      if (!id) return [];
      const allowed = ["done", "pending", "failed", "skipped"] as const;
      const status = allowed.find((item) => item === step.status) ?? "pending";
      return [{ id, status, note: optionalString(step.note) ?? "" }];
    }),
    artifacts: artifacts.flatMap((item) => {
      const artifact = asRecord(item, "артефакт");
      const artifactPath = optionalString(artifact.path);
      if (!artifactPath) return [];
      return [{ path: artifactPath, label: optionalString(artifact.label) ?? artifactPath }];
    }),
  };
}

export function coerceCompose(value: unknown): string {
  const record = asRecord(value, "результат");
  const markdown = optionalString(record.markdown);
  if (!markdown) throw new ParseError("Пустой результат");
  return markdown;
}

function bullets(title: string, items: string[]): string {
  const body = items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "—";
  return `# ${title}\n\n${body}\n`;
}

function fence(text: string): string {
  let size = 3;
  while (text.includes("`".repeat(size))) size += 1;
  const ticks = "`".repeat(size);
  return `${ticks}text\n${text}\n${ticks}`;
}

export function renderSpecMarkdown(original: string, spec: SpecDocument): string {
  return [
    "# Цель",
    "",
    spec.goal,
    "",
    "# Исходный запрос",
    "",
    fence(original),
    "",
    bullets("Что требуется сделать", spec.required).trimEnd(),
    "",
    bullets("Что НЕ требуется делать", spec.notRequired).trimEnd(),
    "",
    bullets("Ограничения", spec.constraints).trimEnd(),
    "",
    bullets("Затрагиваемые компоненты", spec.components).trimEnd(),
    "",
    bullets("Риски", spec.risks).trimEnd(),
    "",
    bullets("Допущения", spec.assumptions).trimEnd(),
    "",
    bullets("Definition of Done", spec.definitionOfDone).trimEnd(),
    "",
    bullets("Проверки", spec.checks).trimEnd(),
    "",
    "# Ожидаемый результат",
    "",
    spec.expectedResult,
    "",
  ].join("\n");
}

export function renderPlanMarkdown(steps: PlanStep[]): string {
  const lines = ["# План", ""];
  for (const step of steps) {
    const mark = step.status === "done" ? "x" : " ";
    lines.push(`- [${mark}] ${step.id} ${step.title}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function renderReviewMarkdown(review: ReviewDocument): string {
  const findings = review.findings.length
    ? review.findings.map((item) => `- (${item.severity}) ${item.detail}`).join("\n")
    : "Замечаний нет.";
  return `# Ревью\n\nИтог: ${review.passed ? "принято" : "есть замечания"}\n\n${review.summary}\n\n${findings}\n`;
}
