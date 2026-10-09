import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskLock } from "./lock.js";
import { TaskStore } from "./storage.js";

const dirs: string[] = [];

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskos-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("storage", () => {
  it("writes a task once and refuses to change the original request", () => {
    const store = new TaskStore(tempRoot());
    const created = store.createTask({ request: "идея для хоррор игры\n\nтихо", scope: "personal" }, "2026-10-09T10:00:00.000Z");
    expect(created.task.id).toBe("TASK-0001");
    expect(created.originalRequest).toBe("идея для хоррор игры\n\nтихо");
    const second = store.createTask({ request: "ещё одна", scope: "work" }, "2026-10-09T11:00:00.000Z");
    expect(second.task.id).toBe("TASK-0002");

    store.writeDoc(created.task.id, "spec.md", "# Цель\n\nпроверка\n");
    const loaded = store.getTask(created.task.id);
    expect(loaded.originalRequest).toContain("хоррор");
    expect(store.readDoc(created.task.id, "spec.md")).toMatch(/проверка/);

    expect(() => store.save({ ...loaded, originalRequest: "другой текст" })).toThrow(/нельзя изменять/i);
    expect(store.getTask(created.task.id).originalRequest).toContain("хоррор");
  });

  it("round-trips feedback without touching request.md", () => {
    const store = new TaskStore(tempRoot());
    const created = store.createTask({ request: "проверить цены", scope: "work" }, "2026-10-09T10:00:00.000Z");
    const requestPath = path.join(store.dataDir, "tasks", created.task.id, "request.md");
    const before = fs.readFileSync(requestPath, "utf8");
    const feedback = store.addFeedback(created.task.id, "цена считается неправильно", "2026-10-09T12:00:00.000Z");
    expect(feedback.id).toBe("001");
    expect(store.listFeedback(created.task.id)[0]?.body).toBe("цена считается неправильно");
    expect(fs.readFileSync(requestPath, "utf8")).toBe(before);
  });
});

describe("locking", () => {
  it("allows one owner and replaces a dead pid", () => {
    const dir = path.join(tempRoot(), "locks");
    const lock = new TaskLock(dir);
    const first = lock.tryAcquire("TASK-0001");
    expect(first.ok).toBe(true);
    expect(lock.tryAcquire("TASK-0001").ok).toBe(false);
    expect(lock.isLocked("TASK-0001")).toBe(true);
    if (first.ok) lock.release("TASK-0001", first.token);
    expect(lock.isLocked("TASK-0001")).toBe(false);

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "TASK-0002.json"),
      JSON.stringify({ token: "stale", pid: 2_147_000_000, startedAt: "2020-01-01T00:00:00.000Z" }),
    );
    const taken = lock.tryAcquire("TASK-0002");
    expect(taken.ok).toBe(true);
  });
});
