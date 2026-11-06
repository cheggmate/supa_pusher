import express, { type NextFunction, type Request, type Response } from "express";
import { zodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";
import { agents, IntegrationError, type AgentProfile, type CallContext } from "./config.js";
import { tools, toolsByName } from "./tools.js";

declare module "express-serve-static-core" {
  interface Request {
    agent?: AgentProfile;
  }
}

const CallBody = z.object({
  project: z.string().default("default"),
  /** End user the agent acts for (uuid). Omit to act as the agent itself. */
  user_id: z.string().uuid().optional(),
  /** Optional real Supabase user JWT; used instead of a minted token. */
  access_token: z.string().optional(),
  input: z.unknown().default({}),
});

export function createServer() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  // Agent authentication: API key -> profile (scopes live server-side, never in the request).
  app.use("/v1", (req: Request, _res: Response, next: NextFunction) => {
    const key = req.header("authorization")?.replace(/^Bearer\s+/i, "");
    const agent = key ? agents[key] : undefined;
    if (!agent) return next(new IntegrationError("unauthorized", "Invalid or missing API key", 401));
    req.agent = agent;
    next();
  });

  // Tool discovery: feed this straight into an agent's tool/function-calling config.
  app.get("/v1/tools", (_req, res) => {
    res.json({
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: zodToJsonSchema(t.input, { target: "openApi3", $refStrategy: "none" }),
      })),
    });
  });

  app.post("/v1/tools/:name", async (req, res, next) => {
    try {
      const tool = toolsByName.get(req.params.name);
      if (!tool) throw new IntegrationError("unknown_tool", `Unknown tool "${req.params.name}"`, 404);

      const body = CallBody.parse(req.body);
      const agent = req.agent!;
      if (agent.projects !== "*" && !agent.projects.includes(body.project)) {
        throw new IntegrationError("project_forbidden", `Agent may not use project "${body.project}"`, 403);
      }

      const input = tool.input.parse(body.input);
      const ctx: CallContext = {
        agent,
        project: body.project,
        userId: body.user_id,
        accessToken: body.access_token,
      };
      res.json({ ok: true, result: await tool.run(ctx, input) });
    } catch (err) {
      next(err);
    }
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError) {
      return res.status(422).json({
        ok: false,
        error: { code: "invalid_input", message: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") },
      });
    }
    if (err instanceof IntegrationError) {
      return res.status(err.status).json({ ok: false, error: { code: err.code, message: err.message } });
    }
    console.error(err);
    res.status(500).json({ ok: false, error: { code: "internal", message: "Internal error" } });
  });

  return app;
}
