import "dotenv/config";
import { existsSync } from "node:fs";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./server/app.js";
import { depsFromEnv } from "./server/deps.js";

const deps = depsFromEnv();
const app = createApp(deps);
if (existsSync("web/dist")) {
  app.use("/*", serveStatic({ root: "./web/dist" }));
  app.get("*", serveStatic({ path: "./web/dist/index.html" }));
}
const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port });
console.log(`Even Steven on http://localhost:${port}  (gateway: ${deps.gateway.name}, agent: ${deps.model ? "llm" : "rules"})`);
