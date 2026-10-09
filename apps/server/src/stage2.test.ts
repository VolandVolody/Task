import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskLock, TaskStore } from "@taskos/core";
import { buildPrompt, feedbackPrompt, FakeProvider, GrokBuildProvider, ProviderRegistry, reviewPrompt, type AiContext } from "./ai.js";
import { Bus } from "./bus.js";
import { GitAdapter } from "./git.js";
import { missingGrokFlags } from "./grok-probe.js";
import { Orchestrator } from "./orchestrator.js";
import { ProcessRunner } from "./runner.js";
import { MetadataSync } from "./sync.js";
import { createApp } from "./app.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskos-s2-"));
  dirs.push(dir);
  return dir;
}

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

function gitRepo(base = "main"): string {
  const dir = tempDir();
  git(dir, ["init", "-b", base]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(dir, "README.md"), "hi\n");
  fs.writeFileSync(path.join(dir, "pass.js"), "console.log('1 passed');\n");
  git(dir, ["add", "README.md", "pass.js"]);
  git(dir, ["commit", "-m", "init"]);
  return dir;
}

function setup(dir: string, provider = new FakeProvider()) {
  const store = new TaskStore(dir);
  store.ensure();
  store.saveConfig({
    ...store.getConfig(),
    testCommand: "npm test",
    defaultRepoPath: ".",
    grokCommand: "grok-missing-taskos",
    aiRouting: { spec: provider.id, plan: provider.id, builder: provider.id, reviewer: provider.id, feedback: provider.id },
  });
  const orch = new Orchestrator({
    store,
    lock: new TaskLock(path.join(store.localDir, "locks")),
    provider,
    git: new GitAdapter(),
    runner: new ProcessRunner(),
    bus: new Bus(),
    root: dir,
  });
  return { store, orch };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("multi-repo", () => {
  it("inherits each project repository and does not fall back to TaskOS", async () => {
    const workspace = gitRepo("main");
    const repoA = gitRepo("main");
    const repoB = gitRepo("master");
    const { store, orch } = setup(workspace);
    const projectA = store.createProject({
      name: "Parser",
      scope: "work",
      goal: "парсер",
      currentState: "есть репозиторий",
      nextAction: "править",
      definitionOfDone: "тест зелёный",
      stages: [],
      repository: { localPath: repoA, remoteUrl: null, baseBranch: null, testCommand: null, testCommands: ["node pass.js"] },
    }, "2026-10-09T12:00:00.000Z");
    const projectB = store.createProject({
      name: "Game",
      scope: "personal",
      goal: "игра",
      currentState: "есть репозиторий",
      nextAction: "править",
      definitionOfDone: "тест зелёный",
      stages: [],
      repository: { localPath: repoB, remoteUrl: null, baseBranch: "master", testCommand: "node pass.js", testCommands: [] },
    }, "2026-10-09T12:00:00.000Z");
    const taskA = store.createTask({ request: "поменять парсер", scope: "work", projectId: projectA.id, projectMode: "manual", requiresCodeMode: "yes", qualityMode: "fast" }, "2026-10-09T12:00:00.000Z");
    const taskB = store.createTask({ request: "поменять игру", scope: "personal", projectId: projectB.id, projectMode: "manual", requiresCodeMode: "yes", qualityMode: "fast" }, "2026-10-09T12:01:00.000Z");
    await orch.run(taskA.task.id);
    await orch.run(taskB.task.id);
    const loadedA = store.getTask(taskA.task.id);
    const loadedB = store.getTask(taskB.task.id);
    expect(loadedA.task.git.repoSource).toBe("project");
    expect(path.resolve(loadedA.task.git.repoPath ?? "")).toBe(path.resolve(repoA));
    expect(loadedA.task.git.baseBranch).toBe("main");
    expect(loadedB.task.git.baseBranch).toBe("master");
    expect(path.resolve(loadedB.task.git.repoPath ?? "")).toBe(path.resolve(repoB));
    expect(git(repoA, ["branch", "--list", "task/*"])).toContain(loadedA.task.git.branch ?? "missing-a");
    expect(git(repoB, ["branch", "--list", "task/*"])).toContain(loadedB.task.git.branch ?? "missing-b");
    expect(git(repoA, ["branch", "--list", "task/*"])).not.toContain(loadedB.task.id);
    expect(git(workspace, ["branch", "--show-current"])).toBe("main");
    expect(fs.existsSync(path.join(repoA, "importer.txt"))).toBe(true);
    expect(fs.existsSync(path.join(repoB, "importer.txt"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "importer.txt"))).toBe(false);
  });

  it("blocks a code task when no repository is configured", async () => {
    const workspace = gitRepo("main");
    const { store, orch } = setup(workspace);
    const created = store.createTask({ request: "код без репозитория", scope: "work", requiresCodeMode: "yes", qualityMode: "fast" }, "2026-10-09T12:00:00.000Z");
    await orch.run(created.task.id);
    const view = store.getTask(created.task.id);
    expect(view.task.status).toBe("BLOCKED");
    expect(view.task.error?.code).toBe("REPO_REQUIRED");
    expect(git(workspace, ["branch", "--show-current"])).toBe("main");
    expect(git(workspace, ["branch", "--list", "task/*"])).toBe("");
  });

  it("uses an explicit project base branch", async () => {
    const repo = gitRepo("main");
    git(repo, ["branch", "release"]);
    const workspace = tempDir();
    const { store, orch } = setup(workspace);
    const project = store.createProject({
      name: "Release",
      scope: "work",
      goal: "",
      currentState: "",
      nextAction: "",
      definitionOfDone: "",
      stages: [],
      repository: { localPath: repo, remoteUrl: null, baseBranch: "release", testCommand: null, testCommands: ["node pass.js"] },
    }, "2026-10-09T12:00:00.000Z");
    const created = store.createTask({ request: "ветка release", scope: "work", projectId: project.id, projectMode: "manual", requiresCodeMode: "yes", qualityMode: "fast" }, "2026-10-09T12:00:00.000Z");
    await orch.run(created.task.id);
    expect(store.getTask(created.task.id).task.git.baseBranch).toBe("release");
  });
});

describe("remote task branches", () => {
  it("tracks origin instead of creating a second local branch", async () => {
    const origin = gitRepo("main");
    git(origin, ["checkout", "-b", "task/TASK-0009-remote"]);
    fs.writeFileSync(path.join(origin, "remote.txt"), "from-origin\n");
    git(origin, ["add", "remote.txt"]);
    git(origin, ["commit", "-m", "remote task"]);
    git(origin, ["checkout", "main"]);
    const local = tempDir();
    git(local, ["clone", origin, "."]);
    git(local, ["config", "user.email", "test@example.com"]);
    git(local, ["config", "user.name", "Test"]);
    const adapter = new GitAdapter();
    await adapter.ensureBranch(local, "main", "task/TASK-0009-remote");
    expect(git(local, ["branch", "--show-current"])).toBe("task/TASK-0009-remote");
    expect(git(local, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])).toBe("origin/task/TASK-0009-remote");
    expect(fs.readFileSync(path.join(local, "remote.txt"), "utf8")).toContain("from-origin");
  });

  it("does not create a branch when fetch fails and the local branch is absent", async () => {
    const repo = gitRepo("main");
    git(repo, ["remote", "add", "origin", path.join(repo, "no-such-remote")]);
    const adapter = new GitAdapter();
    await expect(adapter.ensureBranch(repo, "main", "task/TASK-0003-offline")).rejects.toThrow(/Нет связи с remote/);
    expect(git(repo, ["branch", "--list", "task/TASK-0003-offline"])).toBe("");
  });

  it("keeps a local branch when the remote cannot be fetched", async () => {
    const repo = gitRepo("main");
    git(repo, ["checkout", "-b", "task/TASK-0004-local"]);
    git(repo, ["checkout", "main"]);
    git(repo, ["remote", "add", "origin", path.join(repo, "no-such-remote")]);
    const adapter = new GitAdapter();
    await adapter.ensureBranch(repo, "main", "task/TASK-0004-local");
    expect(git(repo, ["branch", "--show-current"])).toBe("task/TASK-0004-local");
  });
});

describe("review context", () => {
  it("puts the diff, the previous review, and the user feedback into the prompts", () => {
    const ctx = {
      task: { plan: [], testRuns: [], tests: { status: "failed", summary: "цена" } },
      originalRequest: "посчитать цену",
      spec: "формула price * qty",
      plan: "1. формула",
      review: "формула без скидки",
      result: "price * qty",
      feedback: ["цена считается неправильно"],
      diffStat: "1 file",
      gitDiff: "price * qty",
      changedFiles: ["src/price.ts"],
      testSummary: "1 failed",
      testStatus: "failed",
      testRuns: [{ command: "node pass.js", status: "failed", exitCode: 1, summary: "1 failed" }],
      testCommands: ["node pass.js"],
      mode: "fix",
    } as unknown as AiContext;
    const review = reviewPrompt(ctx);
    expect(review).toContain("ORIGINAL REQUEST");
    expect(review).toContain("GIT DIFF");
    expect(review).toContain("price * qty");
    expect(review).toContain("TEST COMMANDS");
    expect(review).toContain("src/price.ts");
    const fix = buildPrompt(ctx);
    expect(fix).toContain("PREVIOUS REVIEW");
    expect(fix).toContain("формула без скидки");
    expect(fix).toContain("CURRENT DIFF");
    expect(fix).toContain("USER FEEDBACK");
    const feedback = feedbackPrompt(ctx);
    expect(feedback).toContain("цена считается неправильно");
    expect(feedback).toContain("SPEC");
    expect(feedback).toContain("PLAN");
    expect(feedback).toContain("CURRENT GIT DIFF");
    expect(feedback).toContain("src/price.ts");
  });

  it("registers fake and grok providers by id", () => {
    const registry = new ProviderRegistry();
    const fake = new FakeProvider();
    const grok = new GrokBuildProvider(new TaskStore(tempDir()), new ProcessRunner());
    registry.register(fake);
    registry.register(grok);
    expect(registry.get("fake").id).toBe("fake");
    expect(registry.get("grok-build").id).toBe("grok-build");
    expect(() => registry.get("codex")).toThrow(/не подключён/);
    expect(missingGrokFlags("--version\n--prompt-file\n")).toEqual(["--output-format", "--json-schema", "--permission-mode"]);
  });
});

describe("artifacts and honest build", () => {
  it("keeps an unreported plan step pending and stores the named artifact", async () => {
    const repo = gitRepo("main");
    const provider = new FakeProvider();
    const original = provider.executeTask.bind(provider);
    provider.executeTask = async (ctx, onEvent) => {
      const outcome = await original(ctx, onEvent);
      return { ...outcome, report: { summary: "только первый шаг", steps: [{ id: "01", status: "done", note: "ок" }], artifacts: [{ path: "importer.txt", label: "Импортёр" }] } };
    };
    const { store, orch } = setup(repo, provider);
    const created = store.createTask({
      request: "частичная сборка",
      scope: "work",
      requiresCodeMode: "yes",
      qualityMode: "fast",
      repoPath: repo,
      testCommands: ["node pass.js"],
    }, "2026-10-09T12:00:00.000Z");
    await orch.run(created.task.id);
    const view = store.getTask(created.task.id);
    expect(view.task.plan.find((step) => step.id === "01")?.status).toBe("done");
    expect(view.task.plan.find((step) => step.id === "02")?.status).toBe("pending");
    expect(view.task.buildComplete).toBe(false);
    const artifacts = store.listArtifacts(created.task.id);
    expect(artifacts.some((item) => item.path === "importer.txt" && item.sizeBytes !== null)).toBe(true);
    store.registerArtifacts(created.task.id, repo, [{ path: "missing.txt", label: "нет" }, { path: "../outside.txt", label: "вне" }], "2026-10-09T12:02:00.000Z");
    const again = store.listArtifacts(created.task.id);
    expect(again.find((item) => item.path === "missing.txt")?.sizeBytes).toBeNull();
    expect(again.some((item) => item.path.includes(".."))).toBe(false);
  });
});

describe("metadata sync", () => {
  it("fast-forwards clean metadata and stops on a divergence", async () => {
    const origin = gitRepo("main");
    fs.mkdirSync(path.join(origin, ".taskos"), { recursive: true });
    fs.writeFileSync(path.join(origin, ".taskos", "config.json"), "{}\n");
    git(origin, ["add", ".taskos"]);
    git(origin, ["commit", "-m", "metadata"]);
    const machineA = tempDir();
    const machineB = tempDir();
    git(machineA, ["clone", origin, "."]);
    git(machineB, ["clone", origin, "."]);
    for (const dir of [machineA, machineB]) {
      git(dir, ["config", "user.email", "test@example.com"]);
      git(dir, ["config", "user.name", "Test"]);
    }
    git(machineA, ["checkout", "-b", "dev/sync"]);
    git(machineA, ["push", "-u", "origin", "dev/sync"]);
    git(machineB, ["fetch", "origin"]);
    git(machineB, ["checkout", "-b", "dev/sync", "origin/dev/sync"]);
    fs.writeFileSync(path.join(machineA, ".taskos", "note.txt"), "home\n");
    const syncA = new MetadataSync(machineA);
    const committed = await syncA.commit();
    expect(committed.message).toMatch(/закоммичены/);
    await syncA.push();
    const syncB = new MetadataSync(machineB);
    const remote = await syncB.fetch();
    expect(remote.state).toBe("remote");
    const pulled = await syncB.pull();
    expect(pulled.state).toBe("synced");
    expect(fs.readFileSync(path.join(machineB, ".taskos", "note.txt"), "utf8")).toMatch(/home/);

    fs.writeFileSync(path.join(machineA, ".taskos", "note.txt"), "home-2\n");
    await syncA.commit();
    await syncA.push();
    fs.writeFileSync(path.join(machineB, ".taskos", "other.txt"), "work\n");
    await syncB.commit();
    const conflict = await syncB.pull();
    expect(conflict.state).toBe("conflict");
    expect(git(machineB, ["status", "--porcelain"])).not.toMatch(/^(UU|AA|DD)/m);
    expect(fs.readFileSync(path.join(machineB, ".taskos", "other.txt"), "utf8")).toBe("work\n");
  });

  it("refuses to commit metadata on main", async () => {
    const repo = gitRepo("main");
    fs.mkdirSync(path.join(repo, ".taskos"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".taskos", "note.txt"), "x\n");
    await expect(new MetadataSync(repo).commit()).rejects.toThrow(/main/);
  });
});

describe("search and health", () => {
  it("finds a task by the original request", async () => {
    const dir = tempDir();
    const app = await createApp({ root: dir, ai: "fake", logger: false });
    await app.inject({ method: "POST", url: "/api/tasks", payload: { request: "цена поставщика", scope: "work", requiresCodeMode: "no" } });
    const found = await app.inject({ method: "GET", url: "/api/search?q=поставщика" });
    expect(found.statusCode).toBe(200);
    expect(found.json().tasks).toHaveLength(1);
    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.json().nodeVersion).toMatch(/^v/);
    expect(health.json().sync.state).toBeTruthy();
    await app.close();
  });
});
