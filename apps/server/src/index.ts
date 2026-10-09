import path from "node:path";
import { InstanceLock, TaskStore } from "@taskos/core";
import { createApp, findRoot } from "./app.js";
import { probeGrok } from "./grok-probe.js";

const root = process.env.TASKOS_ROOT ? path.resolve(process.env.TASKOS_ROOT) : findRoot(process.cwd());
const ai = process.env.TASKOS_AI === "fake" ? "fake" : "grok";
const store = new TaskStore(root);
store.ensure();
const instance = new InstanceLock(path.join(store.localDir, "taskos.pid"));
try {
  instance.acquire();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
const release = () => instance.release();
process.on("exit", release);
process.on("SIGINT", () => {
  release();
  process.exit(0);
});
process.on("SIGTERM", () => {
  release();
  process.exit(0);
});
const grokProbe = ai === "grok" ? await probeGrok(store.getConfig().grokCommand) : null;
if (grokProbe && !grokProbe.compatible) console.error(grokProbe.message);
const app = await createApp({ root, ai, logger: true, grokProbe });
const port = Number(process.env.PORT || 8787);
await app.listen({ host: "127.0.0.1", port });
console.log(`TaskOS http://127.0.0.1:${port}`);
