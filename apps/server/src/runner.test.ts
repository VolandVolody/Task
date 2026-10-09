import { describe, expect, it } from "vitest";
import { ProcessRunner } from "./runner.js";

describe("process runner", () => {
  it("keeps stdout, stderr and a non-zero exit", async () => {
    const runner = new ProcessRunner();
    const result = await runner.run("fail", {
      command: process.execPath,
      args: ["-e", "console.log('hello'); console.error('boom'); process.exit(3)"],
      cwd: process.cwd(),
      timeoutMs: 15000,
    });
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toContain("hello");
    expect(result.stderr).toContain("boom");
    expect(result.spawnError).toBeNull();
  });

  it("stops a process when the signal aborts", async () => {
    const runner = new ProcessRunner();
    const abort = new AbortController();
    const pending = runner.run("sleep", {
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 30000)"],
      cwd: process.cwd(),
      timeoutMs: 20000,
      signal: abort.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    abort.abort();
    const result = await pending;
    expect(result.cancelled).toBe(true);
  });

  it("reports a missing command", async () => {
    const runner = new ProcessRunner();
    const result = await runner.run("missing", {
      command: "taskos-missing-command",
      args: [],
      cwd: process.cwd(),
      timeoutMs: 5000,
    });
    expect(result.exitCode).toBeNull();
    expect(result.spawnError).toBeTruthy();
  });
});
