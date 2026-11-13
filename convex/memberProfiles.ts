import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { projectMember, requireTeamMember, liveProject } from "./lib/permissions";

async function memberInWorkspace(ctx: QueryCtx, args: { sessionToken: string; teamId: Id<"teams">; email: string }) {
  await requireTeamMember(ctx, args.teamId, args.sessionToken);
  const member = await ctx.db.query("teamMembers").withIndex("by_team_email", q => q.eq("teamId", args.teamId).eq("email", args.email)).unique();
  return member?.status === "active" ? member : null;
}

export const get = query({
  args: { sessionToken: v.string(), teamId: v.id("teams"), email: v.string() },
  returns: v.union(v.null(), v.object({ name: v.string(), email: v.string(), username: v.optional(v.string()), role: v.string(), avatarUrl: v.union(v.string(), v.null()), joinedAt: v.number() })),
  handler: async (ctx, args) => {
    const member = await memberInWorkspace(ctx, args);
    if (!member) return null;
    const user = member.userId ? await ctx.db.get(member.userId) : null;
    return { name: user?.name || member.name, email: member.email, username: user?.username, role: member.role, avatarUrl: user?.avatarStorageId ? await ctx.storage.getUrl(user.avatarStorageId) : null, joinedAt: member.joinedAt || member.createdAt };
  },
});

export const issues = query({
  args: { sessionToken: v.string(), teamId: v.id("teams"), email: v.string(), done: v.boolean(), paginationOpts: paginationOptsValidator },
  returns: v.object({ page: v.array(v.object({ _id: v.id("tasks"), projectId: v.id("projects"), title: v.string(), projectName: v.string(), accent: v.string(), priority: v.string(), dueDate: v.optional(v.string()), done: v.boolean() })), isDone: v.boolean(), continueCursor: v.string() }),
  handler: async (ctx, args) => {
    if (!await memberInWorkspace(ctx, args)) return { page: [], isDone: true, continueCursor: "" };
    const { user } = await requireTeamMember(ctx, args.teamId, args.sessionToken);
    const result = await ctx.db.query("tasks").withIndex("by_assignedToEmail_and_done", q => q.eq("assignedToEmail", args.email).eq("done", args.done)).order("desc").paginate({ ...args.paginationOpts, numItems: Math.min(args.paginationOpts.numItems, 50) });
    // Page by assignee, then authorize each project before returning any issue data.
    const rows = await Promise.all(result.page.map(async task => {
      const project = await liveProject(ctx, task.projectId);
      if (!project || project.teamId !== args.teamId || (!args.done && project.status !== "active") || !await projectMember(ctx, project, user)) return null;
      return { _id: task._id, projectId: task.projectId, title: task.title, projectName: project.name, accent: project.accent, priority: task.priority, dueDate: task.dueDate, done: task.done };
    }));
    return { page: rows.filter((row): row is NonNullable<typeof row> => row !== null), isDone: result.isDone, continueCursor: result.continueCursor };
  },
});
