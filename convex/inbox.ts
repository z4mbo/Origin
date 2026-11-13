import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { projectMember, requireMember, requireTeamMember, liveProject } from "./lib/permissions";
import { priorityValidator, projectIconTypeValidator } from "./lib/validators";
import { validDay } from "./lib/features";

const row = v.object({
  _id: v.id("tasks"), projectId: v.id("projects"), title: v.string(), priority: priorityValidator,
  done: v.boolean(), dueDate: v.optional(v.string()), assignedToName: v.optional(v.string()),
  githubIssueNumber: v.optional(v.number()),
  assignedToEmail: v.optional(v.string()), projectName: v.string(), accent: v.string(),
  iconType: v.optional(projectIconTypeValidator), iconValue: v.optional(v.string()), iconUrl: v.union(v.string(), v.null()),
});

export const list = query({
  args: { sessionToken: v.string(), teamId: v.id("teams"), mine: v.boolean(), done: v.boolean(),
    projectId: v.optional(v.id("projects")), priority: v.optional(priorityValidator), paginationOpts: paginationOptsValidator },
  returns: v.object({ page: v.array(row), isDone: v.boolean(), continueCursor: v.string() }),
  handler: async (ctx, a) => {
    const { user } = await requireTeamMember(ctx, a.teamId, a.sessionToken);
    if (a.projectId && (await liveProject(ctx, a.projectId))?.teamId !== a.teamId) throw new ConvexError("Project not found");
    if (a.projectId) await requireMember(ctx, a.projectId, a.sessionToken);
    const tasks = ctx.db.query("tasks");
    const query = a.projectId
      ? a.mine
        ? a.priority
          ? tasks.withIndex("by_projectId_and_done_and_assignedToEmail_and_priority", q => q.eq("projectId", a.projectId!).eq("done", a.done).eq("assignedToEmail", user.email).eq("priority", a.priority!))
          : tasks.withIndex("by_projectId_and_done_and_assignedToEmail", q => q.eq("projectId", a.projectId!).eq("done", a.done).eq("assignedToEmail", user.email))
        : a.priority
          ? tasks.withIndex("by_projectId_and_done_and_priority", q => q.eq("projectId", a.projectId!).eq("done", a.done).eq("priority", a.priority!))
          : tasks.withIndex("by_project_and_done", q => q.eq("projectId", a.projectId!).eq("done", a.done))
      : a.mine
        ? a.priority
          ? tasks.withIndex("by_teamId_and_done_and_assignedToEmail_and_priority", q => q.eq("teamId", a.teamId).eq("done", a.done).eq("assignedToEmail", user.email).eq("priority", a.priority!))
          : tasks.withIndex("by_teamId_and_done_and_assignedToEmail", q => q.eq("teamId", a.teamId).eq("done", a.done).eq("assignedToEmail", user.email))
        : a.priority
          ? tasks.withIndex("by_teamId_and_done_and_priority", q => q.eq("teamId", a.teamId).eq("done", a.done).eq("priority", a.priority!))
          : tasks.withIndex("by_teamId_and_done", q => q.eq("teamId", a.teamId).eq("done", a.done));
    const result = await query.order("desc").paginate({ ...a.paginationOpts, numItems: Math.min(100, a.paginationOpts.numItems) });
    const projects = new Map();
    for (const id of new Set(result.page.map(t => t.projectId))) {
      const p = await ctx.db.get(id);
      if (p?.teamId === a.teamId && (a.done || p.status === "active") && await projectMember(ctx, p, user)) projects.set(id, { name: p.name, accent: p.accent, iconType: p.iconType, iconValue: p.iconValue, iconUrl: p.iconStorageId ? await ctx.storage.getUrl(p.iconStorageId) : null });
    }
    return { isDone: result.isDone, continueCursor: result.continueCursor, page: result.page.flatMap(t => {
      const p = projects.get(t.projectId);
      return p ? [{ _id: t._id, projectId: t.projectId, title: t.title, priority: t.priority, done: t.done, dueDate: t.dueDate,
        assignedToName: t.assignedToName, assignedToEmail: t.assignedToEmail, githubIssueNumber: t.githubIssueNumber, projectName: p.name, accent: p.accent,
        iconType: p.iconType, iconValue: p.iconValue, iconUrl: p.iconUrl }] : [];
    }) };
  },
});

export const activity = query({
  args: { sessionToken: v.string(), teamId: v.id("teams"), mine: v.boolean(), since: v.number(), until: v.number() },
  returns: v.object({ events: v.array(v.object({ completedAt: v.number(), projectId: v.id("projects") })), truncated: v.boolean() }),
  handler: async (ctx, a) => {
    const { user } = await requireTeamMember(ctx, a.teamId, a.sessionToken);
    if (!Number.isFinite(a.since) || !Number.isFinite(a.until) || a.until < a.since || a.until - a.since > 367 * 86400000) throw new ConvexError("Invalid activity range");
    const query = a.mine
      ? ctx.db.query("taskCompletions").withIndex("by_teamId_and_assignedToEmail_and_completedAt", q => q.eq("teamId", a.teamId).eq("assignedToEmail", user.email).gte("completedAt", a.since).lt("completedAt", a.until))
      : ctx.db.query("taskCompletions").withIndex("by_teamId_and_completedAt", q => q.eq("teamId", a.teamId).gte("completedAt", a.since).lt("completedAt", a.until));
    const rows = await query.take(5001);
    const valid = new Set<string>();
    for (const id of new Set(rows.map(r => r.projectId))) {
      const project = await ctx.db.get(id);
      if (project?.teamId === a.teamId && await projectMember(ctx, project, user)) valid.add(id);
    }
    return { events: rows.slice(0, 5000).filter(r => valid.has(r.projectId)).map(r => ({ completedAt: r.completedAt, projectId: r.projectId })), truncated: rows.length > 5000 };
  },
});

export const calendar = query({
  args: { sessionToken: v.string(), teamId: v.id("teams"), start: v.string(), end: v.string(), mine: v.boolean() },
  returns: v.object({ tasks: v.array(v.object({ _id: v.id("tasks"), projectId: v.id("projects"), title: v.string(), dueDate: v.string(), done: v.boolean(), priority: priorityValidator, projectName: v.string() })), truncated: v.boolean() }),
  handler: async (ctx, args) => {
    const { user } = await requireTeamMember(ctx, args.teamId, args.sessionToken);
    validDay(args.start); validDay(args.end);
    const range = Date.parse(args.end) - Date.parse(args.start);
    if (range < 0 || range > 62 * 86400000) throw new ConvexError("Choose a range of up to 62 days");
    const rows = await ctx.db.query("tasks").withIndex("by_teamId_and_dueDate", q => q.eq("teamId", args.teamId).gte("dueDate", args.start).lte("dueDate", args.end)).take(501);
    const selected = rows.slice(0, 500).filter(task => !args.mine || task.assignedToEmail === user.email);
    const projects = new Map();
    for (const id of new Set(selected.map(task => task.projectId))) {
      const project = await ctx.db.get(id);
      if (project?.teamId === args.teamId && project.status === "active" && await projectMember(ctx, project, user)) projects.set(id, project.name);
    }
    return { tasks: selected.flatMap(task => projects.has(task.projectId) && task.dueDate ? [{ _id: task._id, projectId: task.projectId, title: task.title, dueDate: task.dueDate, done: task.done, priority: task.priority, projectName: projects.get(task.projectId) }] : []), truncated: rows.length > 500 };
  },
});

export const backfill = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) }, returns: v.null(),
  handler: async (ctx, args) => {
    const batch = await ctx.db.query("tasks").paginate({ cursor: args.cursor, numItems: 100 });
    for (const task of batch.page) {
      const project = await liveProject(ctx, task.projectId);
      if (project?.teamId && task.teamId !== project.teamId) await ctx.db.patch(task._id, { teamId: project.teamId });
    }
    if (!batch.isDone) await ctx.scheduler.runAfter(0, internal.inbox.backfill, { cursor: batch.continueCursor });
    return null;
  },
});
