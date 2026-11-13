import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { all, projectSteps, purger, type Purger } from "./workspaceDeletion";
import { projectDeleted } from "./lib/projectEvents";

// Deleting one project: startProjectDeletion marks it (projects.deletingAt), which hides it from every list, query,
// connector, MCP tool and GitHub job at once (lib/permissions.ts liveProject and projectMember), sends project.deleted,
// and schedules `purge`, which removes its rows and files in bounded steps with the same steps workspace deletion
// uses. The GitHub repository, its issues and pull requests are never touched: queued mirror work is dropped, not run.

const STALLED_AFTER_MS = 15 * 60_000;
/** Workspace rows that list projects among other things; bounded by the workspace's member and host counts. */
const LISTS_SCANNED = 1000;

type Deleter = Pick<Doc<"users">, "_id" | "name" | "email">;

/** Idempotent: a project already being deleted keeps its first deleter and sends no second event. */
export async function startProjectDeletion(ctx: MutationCtx, project: Doc<"projects">, deletedBy: Deleter) {
  if (project.deletingAt !== undefined) return;
  // Inactive as well, so anything that only checks status already leaves the project alone.
  await ctx.db.patch(project._id, { deletingAt: Date.now(), deletedBy: { userId: deletedBy._id, name: deletedBy.name, email: deletedBy.email }, status: "inactive" });
  await projectDeleted(ctx, project, deletedBy);
  await ctx.scheduler.runAfter(0, internal.projectDeletion.purge, { projectId: project._id });
}

/** Takes the project out of lists other rows keep: muted projects and model sources' project scopes. */
async function scrubLists(ctx: MutationCtx, { write }: Purger, project: Doc<"projects">) {
  const teamId = project.teamId;
  if (!teamId) return true;
  const preferences = await ctx.db.query("notificationPreferences").withIndex("by_teamId_and_userId", q => q.eq("teamId", teamId)).take(LISTS_SCANNED);
  for (const row of preferences) {
    if (row.mutedProjects.includes(project._id)) await write(() => ctx.db.patch(row._id, { mutedProjects: row.mutedProjects.filter(id => id !== project._id) }));
  }
  const sources = await ctx.db.query("modelHostSources").withIndex("by_teamId_and_enabled", q => q.eq("teamId", teamId)).take(LISTS_SCANNED);
  for (const row of sources) {
    if (row.projectIds.includes(project._id)) await write(() => ctx.db.patch(row._id, { projectIds: row.projectIds.filter(id => id !== project._id) }));
  }
  return true;
}

/** Project invites into the workspace can no longer be accepted; workspace invites stay. */
function invites(ctx: MutationCtx, { drain }: Purger, project: Doc<"projects">) {
  const teamId = project.teamId;
  if (!teamId) return Promise.resolve(true);
  return drain(n => ctx.db.query("workspaceInvites").withIndex("by_teamId", q => q.eq("teamId", teamId)).filter(q => q.eq(q.field("projectId"), project._id)).take(n));
}

/** Removes one bounded step of the project; true once the project itself is gone. */
async function purgeProject(ctx: MutationCtx, project: Doc<"projects">) {
  const purge = purger(ctx, scope => scope.kind === "project" && scope.projectId === project._id);
  const done = await all([
    () => projectSteps(ctx, purge, project),
    () => invites(ctx, purge, project),
    () => scrubLists(ctx, purge, project),
  ]);
  if (!done) return false;
  await ctx.db.delete(project._id);
  await purge.releaseFile(project.iconStorageId);
  return true;
}

export const purge = internalMutation({
  args: { projectId: v.id("projects") },
  returns: v.null(),
  handler: async (ctx, { projectId }) => {
    const project = await ctx.db.get(projectId);
    if (!project || project.deletingAt === undefined) return null;
    if (!await purgeProject(ctx, project)) await ctx.scheduler.runAfter(0, internal.projectDeletion.purge, { projectId });
    return null;
  },
});

/** Restarts a deletion whose scheduled step failed, so an interrupted project never stays half deleted. */
export const resume = internalMutation({
  args: {},
  returns: v.null(),
  handler: async ctx => {
    const stalled = await ctx.db.query("projects").withIndex("by_deletingAt", q => q.gt("deletingAt", 0).lt("deletingAt", Date.now() - STALLED_AFTER_MS)).take(20);
    for (const project of stalled) await ctx.scheduler.runAfter(0, internal.projectDeletion.purge, { projectId: project._id });
    return null;
  },
});
