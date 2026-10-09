import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { TaskLock, TaskStore, WorkflowError, type ProjectStage, type QualityMode, type TaskType } from "@taskos/core";
import { FakeProvider, GrokBuildProvider, type AIProvider } from "./ai.js";
import { Bus } from "./bus.js";
import { AppError, publicError } from "./errors.js";
import { GitAdapter } from "./git.js";
import { Orchestrator } from "./orchestrator.js";
import { projectView, toDetail } from "./present.js";
import { ProcessRunner } from "./runner.js";

export interface AppOptions {
  root: string;
  ai?: "grok" | "fake";
  logger?: boolean;
}

export async function createApp(options: AppOptions): Promise<FastifyInstance> {
  const root = path.resolve(options.root);
  const store = new TaskStore(root);
  store.ensure();
  const lock = new TaskLock(path.join(store.localDir, "locks"));
  const bus = new Bus();
  const runner = new ProcessRunner();
  const git = new GitAdapter();
  const runtime = options.ai === "fake" ? "fake" : "grok";
  const provider: AIProvider = runtime === "fake" ? new FakeProvider() : new GrokBuildProvider(store, runner);
  const orchestrator = new Orchestrator({ store, lock, provider, git, runner, bus, root });
  const app = fastify({ logger: options.logger ?? false });
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    const text = typeof body === "string" ? body : body.toString("utf8");
    if (text.length === 0) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(text) as unknown);
    } catch {
      const error = new AppError(400, "JSON", "Некорректный JSON");
      done(error, undefined);
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    const pub = publicError(error);
    reply.code(pub.status).send({ error: { code: pub.code, message: pub.message, details: pub.details ?? null } });
  });

  app.get("/api/health", async () => {
    const config = store.getConfig();
    return {
      ok: true,
      runtime,
      grok: runtime === "fake" ? false : await commandExists(config.grokCommand),
      git: await commandExists("git"),
      model: config.grokModel,
    };
  });

  app.get("/api/events", (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const send = (event: unknown) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    send({ type: "hello", runtime });
    const unsubscribe = bus.subscribe(send);
    const ping = setInterval(() => reply.raw.write(": ping\n\n"), 15000);
    request.raw.on("close", () => {
      clearInterval(ping);
      unsubscribe();
    });
  });

  app.get("/api/tasks", async (request) => {
    const scope = queryString(request.query, "scope");
    const tasks = store
      .listTasks()
      .filter((view) => !scope || view.task.scope === scope)
      .map((view) => orchestrator.card(view));
    return { tasks };
  });

  app.post("/api/tasks", async (request, reply) => {
    const body = record(request.body);
    const requestText = stringField(body, "request");
    if (!requestText.trim()) throw new AppError(400, "EMPTY", "Опишите, что нужно сделать");
    const scope = stringField(body, "scope");
    if (scope !== "work" && scope !== "personal") throw new AppError(400, "SCOPE", "Выберите «Работа» или «Личное»");
    const choice = stringField(body, "projectChoice") || "auto";
    let projectId: string | null = null;
    let projectMode: "auto" | "none" | "manual" = "auto";
    if (choice === "none") projectMode = "none";
    if (choice === "existing") {
      projectMode = "manual";
      projectId = stringField(body, "projectId");
      if (!projectId) throw new AppError(400, "PROJECT", "Выберите проект");
    }
    if (choice === "new") {
      const name = stringField(body, "newProjectName");
      if (!name.trim()) throw new AppError(400, "PROJECT", "Введите имя проекта");
      const project = store.createProject({
        name,
        scope,
        goal: stringField(body, "newProjectGoal"),
        currentState: "Только что создан",
        nextAction: "Определить первый шаг",
        definitionOfDone: "",
        stages: [],
      }, new Date().toISOString());
      projectId = project.id;
      projectMode = "manual";
    }
    const created = store.createTask({
      request: requestText,
      scope,
      projectId,
      projectMode,
      type: optionalType(body.type),
      qualityMode: optionalQuality(body.qualityMode),
      requiresCodeMode: optionalCodeMode(body.requiresCodeMode),
      repoPath: stringField(body, "repoPath") || null,
      baseBranch: store.getConfig().baseBranch,
    }, new Date().toISOString());
    return reply.code(201).send({ task: orchestrator.card(created) });
  });

  app.get("/api/tasks/:id", async (request) => {
    const id = paramId(request.params);
    const view = store.getTask(id);
    return { task: toDetail(view, store, lock.isLocked(id)) };
  });

  app.get("/api/tasks/:id/log", async (request) => {
    const id = paramId(request.params);
    store.getTask(id);
    return { log: store.readLogTail(id) };
  });

  app.post("/api/tasks/:id/run", async (request, reply) => {
    const done = orchestrator.run(paramId(request.params));
    done.catch((error) => app.log.error({ err: error }, "task run failed"));
    return reply.code(202).send({ ok: true });
  });

  app.post("/api/tasks/:id/pause", async (request) => ({ task: orchestrator.pause(paramId(request.params)) }));
  app.post("/api/tasks/:id/resume", async (request) => ({ task: orchestrator.resume(paramId(request.params)) }));
  app.post("/api/tasks/:id/approve", async (request) => ({ task: orchestrator.approve(paramId(request.params)) }));
  app.post("/api/tasks/:id/complete", async (request) => ({ task: orchestrator.complete(paramId(request.params)) }));

  app.post("/api/tasks/:id/review", async (request, reply) => {
    const done = orchestrator.requestReview(paramId(request.params));
    done.catch((error) => app.log.error({ err: error }, "review failed"));
    return reply.code(202).send({ ok: true });
  });

  app.post("/api/tasks/:id/feedback", async (request, reply) => {
    const text = stringField(record(request.body), "text");
    orchestrator.prepareFeedback(paramId(request.params), text);
    const done = orchestrator.run(paramId(request.params));
    done.catch((error) => app.log.error({ err: error }, "feedback failed"));
    return reply.code(202).send({ ok: true });
  });

  app.get("/api/projects", async () => {
    const now = new Date().toISOString();
    return { projects: store.listProjects().map((project) => projectView(project, now)) };
  });

  app.post("/api/projects", async (request, reply) => {
    const body = record(request.body);
    const scope = stringField(body, "scope") === "personal" ? "personal" : "work";
    const project = store.createProject({
      name: stringField(body, "name"),
      scope,
      goal: stringField(body, "goal"),
      currentState: stringField(body, "currentState"),
      nextAction: stringField(body, "nextAction"),
      definitionOfDone: stringField(body, "definitionOfDone"),
      stages: stagesFrom(body.stages),
    }, new Date().toISOString());
    return reply.code(201).send({ project: projectView(project, project.updatedAt) });
  });

  app.patch("/api/projects/:id", async (request) => {
    const id = paramId(request.params, "PROJECT");
    const current = store.listProjects().find((project) => project.id === id);
    if (!current) throw new WorkflowError(`Проект ${id} не найден`);
    const body = record(request.body);
    const next = {
      ...current,
      name: stringField(body, "name") || current.name,
      goal: body.goal === undefined ? current.goal : stringField(body, "goal"),
      currentState: body.currentState === undefined ? current.currentState : stringField(body, "currentState"),
      nextAction: body.nextAction === undefined ? current.nextAction : stringField(body, "nextAction"),
      definitionOfDone: body.definitionOfDone === undefined ? current.definitionOfDone : stringField(body, "definitionOfDone"),
      stages: body.stages === undefined ? current.stages : stagesFrom(body.stages),
      updatedAt: new Date().toISOString(),
    };
    store.saveProject(next);
    return { project: projectView(next, next.updatedAt) };
  });

  const dist = path.join(root, "apps", "web", "dist");
  if (fs.existsSync(path.join(dist, "index.html"))) {
    await app.register(fastifyStatic, { root: dist });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api")) {
        return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Не найдено" } });
      }
      return reply.type("text/html").send(fs.readFileSync(path.join(dist, "index.html")));
    });
  }

  return app;
}

export function findRoot(start: string): string {
  let current = path.resolve(start);
  while (true) {
    const manifest = path.join(current, "package.json");
    if (fs.existsSync(manifest)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(manifest, "utf8")) as { name?: string };
        if (pkg.name === "taskos") return current;
      } catch {
        // keep walking
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(start);
    current = parent;
  }
}

function paramId(params: unknown, prefix: "TASK" | "PROJECT" = "TASK"): string {
  const id = stringField(record(params), "id");
  if (!new RegExp(`^${prefix}-\\d+$`).test(id)) throw new AppError(400, "ID", "Некорректный идентификатор");
  return id;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  return value as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === "string" ? value : "";
}

function queryString(query: unknown, key: string): string {
  return stringField(record(query), key);
}

function optionalQuality(value: unknown): QualityMode | undefined {
  if (value === "fast" || value === "verified" || value === "deep") return value;
  return undefined;
}

function optionalType(value: unknown): TaskType | undefined {
  const allowed: TaskType[] = ["development", "research", "content", "design", "data", "personal", "other"];
  return allowed.find((item) => item === value);
}

function optionalCodeMode(value: unknown): "auto" | "yes" | "no" | undefined {
  if (value === "auto" || value === "yes" || value === "no") return value;
  return undefined;
}

function stagesFrom(value: unknown): ProjectStage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const title = stringField(row, "title").trim();
    if (!title) return [];
    const status = row.status === "doing" || row.status === "done" ? row.status : "todo";
    return [{ id: stringField(row, "id") || String(index + 1).padStart(2, "0"), title, status }];
  });
}

function commandExists(command: string): Promise<boolean> {
  if (path.isAbsolute(command)) return Promise.resolve(fs.existsSync(command));
  const which = process.platform === "win32" ? "where.exe" : "which";
  return new Promise((resolve) => {
    execFile(which, [command], { windowsHide: true }, (error) => resolve(!error));
  });
}
