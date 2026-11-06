import { z } from "zod";

const Op = z.enum(["select", "insert", "upsert", "update"]);

const ProjectSchema = z.object({
  url: z.string().url(),
  anonKey: z.string().min(1),
  jwtSecret: z.string().optional(),
  tables: z.record(z.array(Op)).default({}),
});

const AgentSchema = z.object({
  agentId: z.string().uuid(),
  scopes: z.array(z.string()).default([]),
  projects: z.union([z.literal("*"), z.array(z.string())]).default("*"),
});

export type ProjectConfig = z.infer<typeof ProjectSchema>;
export type AgentProfile = z.infer<typeof AgentSchema>;
export type TableOp = z.infer<typeof Op>;

export class IntegrationError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

function parseEnv<T extends z.ZodTypeAny>(name: string, schema: T): z.infer<T> {
  const raw = process.env[name];
  if (!raw) throw new Error(`Missing env var ${name}`);
  return schema.parse(JSON.parse(raw));
}

export const projects = parseEnv("SUPABASE_PROJECTS", z.record(ProjectSchema));
export const agents = parseEnv("INTEGRATION_AGENTS", z.record(AgentSchema));

export function getProject(name: string): ProjectConfig {
  const p = projects[name];
  if (!p) throw new IntegrationError("unknown_project", `Unknown project "${name}"`, 404);
  return p;
}

/** The caller context every tool receives. */
export interface CallContext {
  agent: AgentProfile;
  project: string;
  /** End user the agent acts for. Becomes `sub` in the minted JWT, so RLS sees that user. */
  userId?: string;
  /** Optional: a real Supabase user JWT, used instead of minting one. */
  accessToken?: string;
}
