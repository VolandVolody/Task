import { describe, expect, it } from "vitest";
import {
  applyFeedbackRestart,
  approveTask,
  branchName,
  completeTask,
  computeProgress,
  createTask,
  estimateEta,
  isSecretPath,
  nextId,
  parseTestOutput,
  transition,
} from "./index.js";
import type { PlanStep, StageDuration, Task } from "./index.js";

const NOW = "2026-10-09T12:00:00.000Z";
const LATER = "2026-10-09T12:05:00.000Z";

function task(partial?: Partial<Task>): Task {
  return {
    ...createTask({ request: "сделать импорт нового поставщика", scope: "work" }, [], NOW),
    ...partial,
  };
}

function step(id: string, status: PlanStep["status"], weight = 1): PlanStep {
  return { id, title: id, status, startedAt: null, finishedAt: null, durationMs: null, weight };
}

describe("ids and branch names", () => {
  it("generates padded ids", () => {
    expect(nextId([], "TASK")).toBe("TASK-0001");
    expect(nextId(["TASK-0001", "TASK-0009", "note"], "TASK")).toBe("TASK-0010");
    expect(nextId(["PROJECT-0002"], "PROJECT")).toBe("PROJECT-0003");
  });

  it("builds a git branch from a russian title", () => {
    expect(branchName("TASK-0017", "Парсер поставщика")).toBe("task/TASK-0017-parser-postavschika");
  });
});

describe("status transitions", () => {
  it("walks the happy path to done only after approval", () => {
    let item = task();
    for (const status of ["SPEC", "PLAN", "BUILD", "REVIEW", "TEST", "USER_QA"] as const) {
      item = transition(item, status, LATER);
    }
    expect(() => completeTask(item, LATER)).toThrow(/подтверждение/i);
    item = approveTask(item, LATER);
    expect(item.status).toBe("READY");
    item = completeTask(item, LATER);
    expect(item.status).toBe("DONE");
    expect(item.userApproved).toBe(true);
  });

  it("rejects a jump from inbox to done", () => {
    expect(() => transition(task(), "DONE", LATER)).toThrow(/нельзя перейти/i);
  });

  it("sends user feedback back to build and keeps the request out of the model", () => {
    let item = task();
    for (const status of ["SPEC", "PLAN", "BUILD", "REVIEW", "TEST", "USER_QA"] as const) {
      item = transition({ ...item, specReady: true, planReady: true, buildComplete: true }, status, LATER);
    }
    item = { ...item, reviewPassed: true, tests: { ...item.tests, status: "passed" } };
    const restarted = applyFeedbackRestart(item, LATER, "кнопка не работает");
    expect(restarted.status).toBe("BUILD");
    expect(restarted.buildComplete).toBe(false);
    expect(restarted.reviewPassed).toBeNull();
    expect(restarted.userApproved).toBe(false);
    expect(restarted.plan.at(-1)?.title).toMatch(/кнопка не работает/);
    expect(restarted.tests.status).toBe("pending");
  });
});

describe("progress", () => {
  it("uses stage weights and plan steps instead of a model guess", () => {
    let item = task({ specReady: true, planReady: true, plan: [step("01", "done"), step("02", "pending")] });
    expect(computeProgress(item)).toBe(20 + 18);
    item = { ...item, plan: [step("01", "done"), step("02", "done")], buildComplete: true, reviewSkipped: true };
    item = { ...item, tests: { ...item.tests, status: "skipped" } };
    expect(computeProgress(item)).toBe(85);
    item = { ...item, userApproved: true, status: "DONE" };
    expect(computeProgress(item)).toBe(100);
  });

  it("does not count a failed review", () => {
    const item = task({
      specReady: true,
      planReady: true,
      buildComplete: true,
      reviewPassed: false,
      plan: [step("01", "done")],
    });
    expect(computeProgress(item)).toBe(55);
  });
});

describe("eta and secrets", () => {
  it("says the estimate is rough without history", () => {
    const estimate = estimateEta(task(), []);
    expect(estimate.uncertain).toBe(true);
    expect(estimate.label).toMatch(/Оценка пока неточная/);
  });

  it("uses history after three samples", () => {
    const history: StageDuration[] = ["SPEC", "RELEASE"].flatMap((stage) =>
      [1, 2, 3].map((index) => ({
        stage,
        startedAt: NOW,
        finishedAt: LATER,
        durationMs: index * 60_000,
      })),
    );
    const item = task({ specReady: false, planReady: true, buildComplete: true, reviewSkipped: true, tests: { status: "skipped", passed: null, failed: null, command: null, summary: null }, userApproved: true, status: "READY" });
    const estimate = estimateEta(item, history);
    expect(estimate.uncertain).toBe(false);
    expect(estimate.label).not.toMatch(/неточная/);
  });

  it("waits on the user during QA", () => {
    const item = task({ status: "USER_QA", userApproved: false });
    expect(estimateEta(item, []).label).toBe("Ждёт вашей проверки");
  });

  it("flags secret-looking paths and parses test counts", () => {
    expect(isSecretPath(".env")).toBe(true);
    expect(isSecretPath("src/app.ts")).toBe(false);
    expect(isSecretPath("keys/id_rsa")).toBe(true);
    expect(parseTestOutput("Tests  2 failed | 32 passed")).toEqual({ passed: 32, failed: 2 });
  });
});
