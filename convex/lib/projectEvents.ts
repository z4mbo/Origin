import type { MutationCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { projectWebhookPayload, type ProjectWebhookEvent } from "../../lib/issue-webhook";
import { webhookConfigured } from "./issueEvents";

// Project webhooks: project.created after a project is inserted (createProjectRecord, importRepos) and project.deleted
// when its deletion starts (convex/projectDeletion.ts). They go through the same `deliver` as issue events, so the
// receiver (an OpenBot router, for one) gets the same signature, retries and envelope. Projects outside a workspace,
// and workspaces being deleted, send nothing: there is no workspace webhook to send to.

export type ProjectActor = Pick<Doc<"users">, "name" | "email">;

async function schedule(ctx: MutationCtx, type: ProjectWebhookEvent, project: Doc<"projects">, actor: ProjectActor | null) {
  const team = project.teamId ? await ctx.db.get(project.teamId) : null;
  if (!team || team.deletingAt !== undefined || !await webhookConfigured(ctx, team._id)) return;
  const payload = projectWebhookPayload({
    type, occurredAt: Date.now(),
    workspace: { id: team._id, name: team.name, slug: team.slug ?? team._id },
    project: { id: project._id, name: project.name, description: project.description, repoUrl: project.repoUrl, createdAt: project.createdAt },
    actor: actor ? { name: actor.name, email: actor.email } : null,
    origin: process.env.ORIGIN_PUBLIC_URL,
  });
  await ctx.scheduler.runAfter(0, internal.issueWebhooks.deliver, { teamId: team._id, event: type, deliveryId: payload.id, body: JSON.stringify(payload) });
}

export async function projectCreated(ctx: MutationCtx, project: Doc<"projects">, actor: ProjectActor | null) {
  await schedule(ctx, "project.created", project, actor);
}

/** Called with the project as it was when deletion started; the purge itself sends nothing. */
export async function projectDeleted(ctx: MutationCtx, project: Doc<"projects">, actor: ProjectActor | null) {
  await schedule(ctx, "project.deleted", project, actor);
}
