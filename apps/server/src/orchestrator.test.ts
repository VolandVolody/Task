import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskLock, TaskStore } from "@taskos/core";
import { FakeProvider, GrokBuildProvider } from "./ai.js";
import { Bus } from "./bus.js";
import { GitAdapter } from "./git.js";
import { Orchestrator } from "./orchestrator.js";
import { ProcessRunner } from "./runner.js";
import { createApp } from "./app.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskos-"));
  dirs.push(dir);
  return dir;
}

function gitRepo(): string {
  const dir = tempDir();
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "hi\n");
  fs.writeFileSync(path.join(dir, "pass.js"), "console.log('3 passed');\n");
  execFileSync("git", ["add", "README.md", "pass.js"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function setup(dir: string, provider = new FakeProvider()) {
  const store = new TaskStore(dir);
  store.ensure();
  store.saveConfig({ ...store.getConfig(), testCommand: "node pass.js", defaultRepoPath: ".", grokCommand: "grok-missing-taskos" });
  const orch = new Orchestrator({
    store,
    lock: new TaskLock(path.join(store.localDir, "locks")),
    provider,
    git: new GitAdapter(),
    runner: new ProcessRunner(),
    bus: new Bus(),
    root: dir,
  });
  return { store, orch, provider };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("orchestrator", () => {
  it("runs a code task through user QA and keeps the original request", async () => {
    const dir = gitRepo();
    const { store, orch } = setup(dir);
    const created = store.createTask({
      request: "сделать импорт нового поставщика",
      scope: "work",
      requiresCodeMode: "yes",
      qualityMode: "verified",
    }, "2026-10-09T12:00:00.000Z");
    await orch.run(created.task.id);
    const view = store.getTask(created.task.id);
    expect(view.task.status).toBe("USER_QA");
    expect(view.originalRequest).toBe("сделать импорт нового поставщика");
    expect(store.readDoc(created.task.id, "spec.md")).toContain("сделать импорт нового поставщика");
    expect(view.task.plan.length).toBeGreaterThan(0);
    expect(view.task.git.branch).toMatch(/^task\/TASK-0001-/);
    expect(view.task.git.commitsCount).toBeGreaterThan(0);
    expect(view.task.progress).toBeGreaterThanOrEqual(85);
    expect(fs.existsSync(path.join(dir, "importer.txt"))).toBe(true);

    orch.prepareFeedback(created.task.id, "кнопка не работает");
    await orch.run(created.task.id);
    const fixed = store.getTask(created.task.id);
    expect(fixed.task.status).toBe("USER_QA");
    expect(store.listFeedback(created.task.id)[0]?.body).toBe("кнопка не работает");
    expect(fixed.originalRequest).toBe("сделать импорт нового поставщика");

    orch.approve(created.task.id);
    const done = orch.complete(created.task.id);
    expect(done.status).toBe("DONE");
    expect(done.progress).toBe(100);
    const reloaded = new TaskStore(dir).getTask(created.task.id);
    expect(reloaded.task.status).toBe("DONE");
    expect(reloaded.originalRequest).toBe("сделать импорт нового поставщика");
  });

  it("does not start a second run while the first is locked", async () => {
    const dir = gitRepo();
    const provider = new FakeProvider();
    let release = () => {};
    provider.hangBuild = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { store, orch } = setup(dir, provider);
    const created = store.createTask({
      request: "долгая задача",
      scope: "work",
      requiresCodeMode: "yes",
      qualityMode: "fast",
    }, "2026-10-09T12:00:00.000Z");
    const pending = orch.run(created.task.id);
    try {
      await waitFor(() => provider.calls.includes("build"));
      expect(() => orch.run(created.task.id)).toThrow(/уже выполняется/);
    } finally {
      release();
      await pending;
    }
    expect(store.getTask(created.task.id).task.status).toBe("USER_QA");
    expect(provider.calls).not.toContain("review");
  });

  it("refuses to switch branches when the repo is dirty", async () => {
    const dir = gitRepo();
    fs.writeFileSync(path.join(dir, "dirty.txt"), "x\n");
    const { store, orch } = setup(dir);
    const created = store.createTask({
      request: "правка кода",
      scope: "work",
      requiresCodeMode: "yes",
      qualityMode: "fast",
    }, "2026-10-09T12:00:00.000Z");
    await orch.run(created.task.id);
    const view = store.getTask(created.task.id);
    expect(view.task.error?.code).toBe("REPO_DIRTY");
    expect(execFileSync("git", ["branch", "--show-current"], { cwd: dir, encoding: "utf8" }).trim()).toBe("main");
  });

  it("repeats the reviewer at most through the deep fix cycle", async () => {
    const dir = gitRepo();
    const provider = new FakeProvider();
    provider.reviewPassesOn = 2;
    const { store, orch } = setup(dir, provider);
    const created = store.createTask({
      request: "починить парсер",
      scope: "work",
      requiresCodeMode: "yes",
      qualityMode: "deep",
    }, "2026-10-09T12:00:00.000Z");
    await orch.run(created.task.id);
    const view = store.getTask(created.task.id);
    expect(view.task.status).toBe("USER_QA");
    expect(provider.calls.filter((call) => call === "review").length).toBe(2);
    expect(provider.calls).toContain("fix");
    expect(view.task.fixCycles).toBe(1);
  });

  it("stores a clear error when Grok is not installed", async () => {
    const dir = tempDir();
    const store = new TaskStore(dir);
    store.ensure();
    store.saveConfig({ ...store.getConfig(), grokCommand: "grok-missing-taskos" });
    const orch = new Orchestrator({
      store,
      lock: new TaskLock(path.join(store.localDir, "locks")),
      provider: new GrokBuildProvider(store, new ProcessRunner()),
      git: new GitAdapter(),
      runner: new ProcessRunner(),
      bus: new Bus(),
      root: dir,
    });
    const created = store.createTask({
      request: "идея для игры",
      scope: "personal",
      requiresCodeMode: "no",
    }, "2026-10-09T12:00:00.000Z");
    await orch.run(created.task.id);
    expect(store.getTask(created.task.id).task.error?.code).toBe("GROK_UNAVAILABLE");
  });

  it("keeps a task paused when the run ends after pause", async () => {
    const dir = gitRepo();
    const provider = new FakeProvider();
    let release = () => {};
    provider.hangBuild = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { store, orch } = setup(dir, provider);
    const created = store.createTask({
      request: "долгая правка",
      scope: "work",
      requiresCodeMode: "yes",
      qualityMode: "fast",
    }, "2026-10-09T12:00:00.000Z");
    const pending = orch.run(created.task.id);
    try {
      await waitFor(() => provider.calls.includes("build"));
      const paused = orch.pause(created.task.id);
      expect(paused.status).toBe("PAUSED");
    } finally {
      release();
      await pending;
    }
    expect(store.getTask(created.task.id).task.status).toBe("PAUSED");
  });
});

describe("http api", () => {
  it("keeps a task after the server is created again", async () => {
    const dir = tempDir();
    const app = await createApp({ root: dir, ai: "fake", logger: false });
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { request: "продумать идею игры", scope: "personal", requiresCodeMode: "no" },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().task.id as string;
    expect(id).toBe("TASK-0001");
    await app.close();

    const again = await createApp({ root: dir, ai: "fake", logger: false });
    const list = await again.inject({ method: "GET", url: "/api/tasks?scope=personal" });
    expect(list.json().tasks.map((task: { id: string }) => task.id)).toContain(id);
    const empty = await again.inject({ method: "POST", url: "/api/tasks", payload: { request: "  ", scope: "work" } });
    expect(empty.statusCode).toBe(400);
    await again.close();
  });

  it("accepts pause when the client sends an empty json body", async () => {
    const dir = tempDir();
    const app = await createApp({ root: dir, ai: "fake", logger: false });
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { request: "идея для игры", scope: "personal", requiresCodeMode: "no" },
    });
    const id = created.json().task.id as string;
    const paused = await app.inject({
      method: "POST",
      url: `/api/tasks/${id}/pause`,
      headers: { "content-type": "application/json" },
      payload: "",
    });
    expect(paused.statusCode).toBe(200);
    expect(paused.json().task.status).toBe("PAUSED");
    const early = await app.inject({
      method: "POST",
      url: `/api/tasks/${id}/feedback`,
      payload: { text: "рано" },
    });
    expect(early.statusCode).toBe(409);
    expect(new TaskStore(dir).listFeedback(id)).toHaveLength(0);
    await app.close();
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out");
}
