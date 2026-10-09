import path from "node:path";
import { createApp, findRoot } from "./app.js";

const root = process.env.TASKOS_ROOT ? path.resolve(process.env.TASKOS_ROOT) : findRoot(process.cwd());
const ai = process.env.TASKOS_AI === "fake" ? "fake" : "grok";
const app = await createApp({ root, ai, logger: true });
const port = Number(process.env.PORT || 8787);
await app.listen({ host: "127.0.0.1", port });
console.log(`TaskOS http://127.0.0.1:${port}`);
