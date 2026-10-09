import { describe, expect, it } from "vitest";
import {
  buildGrokArgs,
  coercePlan,
  coerceReview,
  coerceSpec,
  extractBuildReport,
  parseGrokFinal,
  parseGrokStreamLine,
  renderSpecMarkdown,
} from "./index.js";

const ALLOWED = new Set([
  "--prompt-file",
  "--cwd",
  "-m",
  "--output-format",
  "--json-schema",
  "--permission-mode",
  "--max-turns",
  "--disallowed-tools",
  "--deny",
  "--rules",
  "--no-subagents",
]);

function flags(args: string[]): string[] {
  const names: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index]?.startsWith("--") || args[index] === "-m") {
      names.push(args[index] ?? "");
      index += 1;
    }
  }
  return names;
}

describe("grok command", () => {
  it("uses streaming json for the builder and denies destructive git", () => {
    const args = buildGrokArgs({ role: "build", promptFile: "p.md", cwd: "C:\\repo", model: "grok-4.7" });
    expect(args).toContain("streaming-json");
    expect(args).toContain("bypassPermissions");
    expect(args).toContain("Bash(git push*)");
    expect(args).not.toContain("--json-schema");
    for (const flag of flags(args)) expect(ALLOWED.has(flag)).toBe(true);
  });

  it("asks for structured json without a shell for spec", () => {
    const args = buildGrokArgs({ role: "spec", promptFile: "p.md", cwd: "C:\\repo", model: "grok-4.7" });
    expect(args).toContain("json");
    expect(args).toContain("--json-schema");
    expect(args).toContain("plan");
    expect(args).toContain("run_terminal_cmd");
    for (const flag of flags(args)) expect(ALLOWED.has(flag)).toBe(true);
  });
});

describe("grok parsing", () => {
  it("turns tool events into a timeline and keeps text", () => {
    const edit = parseGrokStreamLine(
      JSON.stringify({
        type: "tool_call",
        toolName: "search_replace",
        status: "in_progress",
        rawInput: { path: "src/importer.ts" },
      }),
    );
    expect(edit.timeline).toBe("Изменён src/importer.ts");
    const text = parseGrokStreamLine(JSON.stringify({ type: "text", data: "готово" }));
    expect(text.textDelta).toBe("готово");
    const end = parseGrokStreamLine(JSON.stringify({ type: "end", sessionId: "abc", stopReason: "end_turn" }));
    expect(end.done).toBe(true);
    expect(end.sessionId).toBe("abc");
    const failure = parseGrokStreamLine(JSON.stringify({ type: "error", message: "Couldn't start session" }));
    expect(failure.error).toMatch(/Couldn't start session/);
    const command = parseGrokStreamLine(JSON.stringify({
      type: "tool_call",
      toolName: "run_terminal_command",
      kind: "execute",
      rawInput: { command: "npm test" },
    }));
    expect(command.timeline).toBe("Команда: npm test");
  });

  it("reads a json result and coerces a spec", () => {
    const spec = {
      title: "Импорт",
      goal: "Добавить поставщика",
      required: ["файл импорта"],
      assumptions: ["формат CSV"],
      definitionOfDone: ["файл открывается"],
      expectedResult: "CSV",
      requiresCode: true,
      type: "development",
      criticalQuestion: null,
    };
    const final = parseGrokFinal(JSON.stringify({
      text: "prose",
      sessionId: "s1",
      stopReason: "end_turn",
      structured_output: spec,
    }));
    expect(final.sessionId).toBe("s1");
    expect(final.data).toEqual(spec);
    const parsed = coerceSpec(final.data);
    expect(parsed.requiresCode).toBe(true);
    expect(parsed.assumptions).toEqual(["формат CSV"]);
    const markdown = renderSpecMarkdown("сделать импорт", parsed);
    expect(markdown).toContain("сделать импорт");
    expect(markdown).toContain("# Что НЕ требуется делать");
  });

  it("coerces plan and review", () => {
    const steps = coercePlan({ steps: [{ title: "Inspect existing code" }, { id: "02", title: "Add tests", weight: 2 }] });
    expect(steps.map((item) => item.id)).toEqual(["01", "02"]);
    expect(steps[1]?.weight).toBe(2);
    const review = coerceReview({ passed: false, summary: "есть баг", findings: [{ severity: "high", detail: "кнопка" }] });
    expect(review.findings[0]?.severity).toBe("high");
    expect(() => coerceSpec({ title: "x" })).toThrow(/разобрать|цели/i);
  });

  it("asks the report pass to copy step ids and not call tools", () => {
    const args = buildGrokArgs({ role: "report", promptFile: "p.md", cwd: "C:\\repo", model: "grok-4.7" });
    expect(args).toContain("plan");
    expect(args).toContain("--json-schema");
    const rules = args[args.indexOf("--rules") + 1] ?? "";
    expect(rules).toMatch(/Не вызывай инструменты/);
    expect(rules).toMatch(/Копируй id/);
  });

  it("reads structuredOutput from the installed grok json format", () => {
    const stdout = [
      "{",
      '  "text": "{\\"ok\\": true}",',
      '  "stopReason": "end_turn",',
      '  "sessionId": "abc",',
      '  "structuredOutput": { "title": "Импорт", "goal": "Цель", "required": ["шаг"], "assumptions": [], "definitionOfDone": ["готово"], "expectedResult": "файл", "requiresCode": false }',
      "}",
    ].join("\n");
    const final = parseGrokFinal(stdout);
    expect(final.sessionId).toBe("abc");
    expect(coerceSpec(final.data).goal).toBe("Цель");
  });

  it("extracts the last build report when structured output is null", () => {
    const draft = JSON.stringify({
      summary: "черновик",
      steps: [{ id: "read-readme", status: "in_progress", note: "смотрю" }],
    });
    const latest = JSON.stringify({
      summary: "строка добавлена",
      steps: [
        { id: "01", status: "done", note: "готово" },
        { id: "append-line", status: "in_progress", note: "выдумал" },
      ],
    });
    const stdout = JSON.stringify({
      text: draft + latest,
      stopReason: "end_turn",
      sessionId: "rep",
      structuredOutput: null,
      structuredOutputError: "model did not produce structured output",
      usage: { tokens: 3 },
    });
    const report = extractBuildReport(stdout);
    expect(report?.summary).toBe("строка добавлена");
    expect(report?.steps.map((step) => [step.id, step.status])).toEqual([
      ["01", "done"],
      ["append-line", "pending"],
    ]);
  });

  it("prefers a schema report over a draft inside text", () => {
    const stdout = JSON.stringify({
      text: JSON.stringify({ summary: "черновик", steps: [{ id: "99", status: "done" }] }),
      structuredOutput: { summary: "по схеме", steps: [{ id: "01", status: "done", note: "" }] },
    });
    const report = extractBuildReport(stdout);
    expect(report?.summary).toBe("по схеме");
    expect(report?.steps[0]?.id).toBe("01");
  });

  it("returns null when the output has no steps array", () => {
    const stdout = JSON.stringify({
      text: "я не смог составить отчёт",
      structuredOutput: null,
      usage: { tokens: 3 },
    });
    expect(extractBuildReport(stdout)).toBeNull();
  });

  it("surfaces a grok error object", () => {
    const final = parseGrokFinal(`noise\n${JSON.stringify({ type: "error", message: "Couldn't start session: no" })}`);
    expect(final.error).toMatch(/Couldn't start session/);
  });
});
