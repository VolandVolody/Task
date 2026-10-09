import { spawn, type ChildProcess } from "node:child_process";
import { AppError } from "./errors.js";

export interface RunRequest {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onLine?: (stream: "stdout" | "stderr", line: string) => void;
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  cancelled: boolean;
  timedOut: boolean;
  spawnError: string | null;
}

export class ProcessRunner {
  private active = new Map<string, ChildProcess>();

  async run(key: string, request: RunRequest): Promise<RunResult> {
    if (this.active.has(key)) {
      throw new AppError(409, "LOCKED", "Эта задача уже выполняется");
    }
    const stdout: string[] = [];
    const stderr: string[] = [];
    let timedOut = false;
    let cancelled = false;
    let spawnError: string | null = null;

    const child = launch(request.command, request.args, request.cwd);
    this.active.set(key, child);

    const stop = (mode: "cancel" | "timeout") => {
      if (mode === "timeout") timedOut = true;
      else cancelled = true;
      if (child.pid) killTree(child.pid);
    };
    const onAbort = () => stop("cancel");
    request.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => stop("timeout"), request.timeoutMs);

    collect(child.stdout, "stdout", stdout, request.onLine);
    collect(child.stderr, "stderr", stderr, request.onLine);

    const code = await new Promise<number | null>((resolve) => {
      child.once("error", (error) => {
        spawnError = error.message;
        resolve(null);
      });
      child.once("close", (exitCode) => resolve(exitCode));
    });

    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onAbort);
    this.active.delete(key);

    return {
      exitCode: code,
      stdout: cap(stdout.join("\n")),
      stderr: cap(stderr.join("\n")),
      cancelled,
      timedOut,
      spawnError,
    };
  }

  cancel(key: string): void {
    const child = this.active.get(key);
    if (child?.pid) killTree(child.pid);
  }
}

function collect(
  stream: NodeJS.ReadableStream | null,
  name: "stdout" | "stderr",
  bucket: string[],
  onLine?: (stream: "stdout" | "stderr", line: string) => void,
): void {
  if (!stream) return;
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() ?? "";
    for (const line of parts) {
      bucket.push(line);
      onLine?.(name, line);
    }
  });
  stream.on("end", () => {
    if (!buffer) return;
    bucket.push(buffer);
    onLine?.(name, buffer);
    buffer = "";
  });
}

function launch(command: string, args: string[], cwd: string): ChildProcess {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const lower = command.toLowerCase();
  // cmd.exe is required for .cmd shims; the prompt itself is passed by file, not by this string.
  if (process.platform === "win32" && (lower.endsWith(".cmd") || lower.endsWith(".bat"))) {
    const line = [command, ...args].map(quoteCmd).join(" ");
    return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", line], { cwd, windowsHide: true, env });
  }
  return spawn(command, args, { cwd, windowsHide: true, env });
}

function quoteCmd(arg: string): string {
  if (arg.length === 0) return '""';
  if (!/[\s"&|<>^]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

function killTree(pid: number): void {
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true });
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // already gone
  }
}

function cap(text: string): string {
  const limit = 2_000_000;
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…обрезано…`;
}
