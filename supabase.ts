import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SignJWT } from "jose";
import { getProject, IntegrationError, type CallContext, type TableOp } from "./config.js";

/**
 * Builds a Supabase client that always runs as the `authenticated` role under a
 * JWT, so every query is subject to RLS. The service-role key is never used.
 *
 * Token source, in order:
 *  1. ctx.accessToken -> a real user session JWT (pass-through)
 *  2. minted          -> short-lived JWT signed with the project's JWT secret,
 *                        sub = userId (or agentId), scopes from the agent profile
 */
export async function clientFor(ctx: CallContext): Promise<SupabaseClient> {
  const project = getProject(ctx.project);
  const token = ctx.accessToken ?? (await mintToken(ctx, project.jwtSecret));

  return createClient(project.url, project.anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

async function mintToken(ctx: CallContext, secret?: string): Promise<string> {
  if (!secret) {
    throw new IntegrationError(
      "no_credentials",
      `Project "${ctx.project}" has no jwtSecret configured; pass access_token instead`,
    );
  }
  return new SignJWT({
    role: "authenticated",
    app_metadata: { agent_id: ctx.agent.agentId, scopes: ctx.agent.scopes },
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(ctx.userId ?? ctx.agent.agentId) // auth.uid() casts this to uuid
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(secret));
}

/** Defense in depth for the generic db_* tools. RLS remains the real gate. */
export function assertTableAllowed(ctx: CallContext, table: string, op: TableOp) {
  const allowed = getProject(ctx.project).tables[table];
  if (!allowed?.includes(op)) {
    throw new IntegrationError("table_not_allowed", `"${op}" on "${table}" is not enabled for this project`, 403);
  }
}
