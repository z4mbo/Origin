import { ConvexError, v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { mutation, query, internalMutation, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { getActiveTeamMember, projectMember, requireTeamMember, liveProject } from "./lib/permissions";
import { projectIconTypeValidator } from "./lib/validators";

export async function notify(ctx: MutationCtx, a: { teamId: Id<"teams">; email: string; actorId: Id<"users">; kind: "assignment" | "comment" | "mention"; eventId: string; projectId?: Id<"projects">; taskId?: Id<"tasks">; messageId?: string; conversation?: string; agentThreadId?: Id<"agentThreads">; preview?: string }) {
  const user = await ctx.db.query("users").withIndex("by_email", q => q.eq("email", a.email)).unique();
  if (!user || user.status !== "active" || user._id === a.actorId || !await getActiveTeamMember(ctx, a.teamId, user.email)) return;
  if (a.projectId) {
    const project = await liveProject(ctx, a.projectId);
    if (!project || project.teamId !== a.teamId || project.status !== "active" || !await projectMember(ctx, project, user)) return;
  }
  const preferences = await ctx.db.query("notificationPreferences").withIndex("by_teamId_and_userId", q => q.eq("teamId", a.teamId).eq("userId", user._id)).unique();
  if (preferences && ((a.kind === "assignment" && !preferences.assignments) || (a.kind === "comment" && !preferences.comments) || (a.kind === "mention" && !preferences.mentions) || (a.projectId && preferences.mutedProjects.includes(a.projectId)))) return;
  if (await ctx.db.query("notifications").withIndex("by_user_event", q => q.eq("userId", user._id).eq("eventId", a.eventId)).first()) return;
  const { email: _email, ...data } = a;
  await ctx.db.insert("notifications", { ...data, userId: user._id, read: false, createdAt: Date.now() });
}

/** The name people see for whoever caused a notification: full name, then username, then the email's local part. */
function actorDisplayName(actor: { name?: string; username?: string; email?: string } | null) {
  return actor?.name?.trim() || actor?.username?.trim() || actor?.email?.split("@")[0] || "Teammate";
}

const scope = { sessionToken: v.string(), teamId: v.id("teams") };
export const summary = query({
  args: scope, returns: v.object({ unread: v.number(), more: v.boolean(), latest: v.union(v.string(), v.null()) }),
  handler: async (ctx, a) => {
    const { user } = await requireTeamMember(ctx, a.teamId, a.sessionToken);
    const rows = await ctx.db.query("notifications").withIndex("by_user_team_read", q => q.eq("userId", user._id).eq("teamId", a.teamId).eq("read", false)).order("desc").take(100);
    const visible = [];
    for (const row of rows) {
      if (row.kind === "lead") continue;
      const project = row.projectId ? await liveProject(ctx, row.projectId) : null;
      if (!row.projectId || (project?.status === "active" && await projectMember(ctx, project, user))) visible.push(row);
    }
    const recent = await ctx.db.query("notifications").withIndex("by_user_team", q => q.eq("userId", user._id).eq("teamId", a.teamId)).order("desc").take(100);
    let latest: string | null = null;
    for (const row of recent) {
      if (row.kind === "lead") continue;
      const project = row.projectId ? await liveProject(ctx, row.projectId) : null;
      if (!row.projectId || (project?.status === "active" && await projectMember(ctx, project, user))) { latest = row._id; break; }
    }
    return { unread: Math.min(visible.length, 99), more: visible.length === 100, latest };
  },
});
export const list = query({
  args: { ...scope, unreadOnly: v.boolean(), paginationOpts: paginationOptsValidator },
  returns: v.object({ isDone: v.boolean(), continueCursor: v.string(), page: v.array(v.object({
    _id: v.id("notifications"), kind: v.union(v.literal("assignment"), v.literal("comment"), v.literal("mention"), v.literal("digest")), digestId: v.optional(v.id("standupDigests")), read: v.boolean(), createdAt: v.number(), snoozedUntil: v.optional(v.number()),
    projectId: v.optional(v.id("projects")), taskId: v.optional(v.id("tasks")), messageId: v.optional(v.string()), conversation: v.optional(v.string()), agentThreadId: v.optional(v.id("agentThreads")), preview: v.optional(v.string()),
    actorName: v.string(), actorAvatar: v.union(v.string(), v.null()), projectName: v.optional(v.string()), taskTitle: v.optional(v.string()), available: v.boolean(),
    iconType: v.optional(projectIconTypeValidator), iconValue: v.optional(v.string()), iconUrl: v.union(v.string(), v.null()),
  })) }),
  handler: async (ctx, a) => {
    const { user } = await requireTeamMember(ctx, a.teamId, a.sessionToken);
    const query = a.unreadOnly ? ctx.db.query("notifications").withIndex("by_user_team_read", q => q.eq("userId", user._id).eq("teamId", a.teamId).eq("read", false)) : ctx.db.query("notifications").withIndex("by_user_team", q => q.eq("userId", user._id).eq("teamId", a.teamId));
    const page = await query.order("desc").paginate({ ...a.paginationOpts, numItems: Math.min(a.paginationOpts.numItems, 50) });
    const visible = await Promise.all(page.page.map(async row => {
      const actor = await ctx.db.get(row.actorId), project = row.projectId ? await liveProject(ctx, row.projectId) : null, task = row.taskId ? await ctx.db.get(row.taskId) : null;
      const digest = row.digestId ? await ctx.db.get(row.digestId) : null;
      if (row.kind === "lead") return null;
      if (row.projectId && (!project || !await projectMember(ctx, project, user) || (a.unreadOnly && project.status !== "active"))) return null;
      return { _id: row._id, kind: row.kind, ...(row.digestId ? { digestId: row.digestId } : {}), read: row.read, createdAt: row.createdAt, snoozedUntil: row.snoozedUntil, projectId: row.projectId, taskId: row.taskId, messageId: row.messageId, conversation: row.conversation, agentThreadId: row.agentThreadId, preview: row.preview, actorName: digest?.chiefName ?? actorDisplayName(actor), actorAvatar: !digest && actor?.avatarStorageId ? await ctx.storage.getUrl(actor.avatarStorageId) : null,
        projectName: project?.name, taskTitle: task?.title, available: Boolean(row.messageId) || Boolean(digest) || Boolean(task && project?.teamId === a.teamId),
        iconType: project?.iconType, iconValue: project?.iconValue, iconUrl: project?.iconStorageId ? await ctx.storage.getUrl(project.iconStorageId) : null };
    }));
    return { isDone: page.isDone, continueCursor: page.continueCursor, page: visible.filter((row): row is NonNullable<typeof row> => row !== null) };
  },
});
export const markRead = mutation({
  args: { ...scope, id: v.id("notifications"), read: v.boolean() }, returns: v.null(),
  handler: async (ctx, a) => {
    const { user } = await requireTeamMember(ctx, a.teamId, a.sessionToken);
    const row = await ctx.db.get(a.id);
    if (!row || row.userId !== user._id || row.teamId !== a.teamId) throw new ConvexError("Notification not found");
    await ctx.db.patch(row._id, { read: a.read, snoozedUntil: undefined }); return null;
  },
});
export const snooze = mutation({
  args: { ...scope, id: v.id("notifications"), until: v.number() }, returns: v.null(),
  handler: async (ctx, args) => {
    const { user } = await requireTeamMember(ctx, args.teamId, args.sessionToken);
    const row = await ctx.db.get(args.id);
    if (!row || row.userId !== user._id || row.teamId !== args.teamId) throw new ConvexError("Notification not found");
    if (!Number.isFinite(args.until) || args.until <= Date.now() || args.until > Date.now() + 30 * 86400000) throw new ConvexError("Choose a time within the next 30 days");
    await ctx.db.patch(row._id, { read: true, snoozedUntil: args.until });
    await ctx.scheduler.runAt(args.until, internal.notifications.wake, { id: row._id, until: args.until });
    return null;
  },
});
export const wake = internalMutation({
  args: { id: v.id("notifications"), until: v.number() }, returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (row?.snoozedUntil === args.until) await ctx.db.patch(row._id, { read: false, snoozedUntil: undefined });
    return null;
  },
});
export const markAll = mutation({
  args: scope, returns: v.null(),
  handler: async (ctx, a) => {
    const { user } = await requireTeamMember(ctx, a.teamId, a.sessionToken);
    const newest = await ctx.db.query("notifications").withIndex("by_user_team_read", q => q.eq("userId", user._id).eq("teamId", a.teamId).eq("read", false)).order("desc").first();
    if (newest) await readBatch(ctx, a.teamId, user._id, newest._creationTime);
    return null;
  },
});
async function readBatch(ctx: MutationCtx, teamId: Id<"teams">, userId: Id<"users">, before: number) {
  const rows = await ctx.db.query("notifications").withIndex("by_user_team_read", q => q.eq("userId", userId).eq("teamId", teamId).eq("read", false).lte("_creationTime", before)).take(100);
  for (const row of rows) await ctx.db.patch(row._id, { read: true });
  if (rows.length === 100) await ctx.scheduler.runAfter(0, internal.notifications.readMore, { teamId, userId, before });
}
export const readMore = internalMutation({ args: { teamId: v.id("teams"), userId: v.id("users"), before: v.number() }, returns: v.null(), handler: async (ctx, a) => { await readBatch(ctx, a.teamId, a.userId, a.before); return null; } });

const PREVIEW_MAX = 140;
const clip = (text: string) => { const line = text.replace(/\s+/g, " ").trim(); return line.length > PREVIEW_MAX ? `${line.slice(0, PREVIEW_MAX - 1)}…` : line; };

/** "" is the workspace channel, "project:<id>" a project's chat, "dm:<a>:<b>" a conversation between two members. */
function chatTarget(ctx: MutationCtx, conversation: string | undefined): { projectId?: Id<"projects">; members?: string[] } | null {
  if (!conversation) return {};
  const project = /^project:([a-z0-9]{10,64})$/.exec(conversation);
  if (project) { const projectId = ctx.db.normalizeId("projects", project[1]!); return projectId ? { projectId } : null; }
  const dm = /^dm:([a-z0-9]{1,64}):([a-z0-9]{1,64})$/.exec(conversation);
  return dm ? { members: [dm[1]!, dm[2]!] } : null;
}

export const chatMentions = internalMutation({
  args: { teamId: v.id("teams"), actorId: v.id("users"), messageId: v.string(), userIds: v.array(v.id("users")), conversation: v.optional(v.string()), preview: v.optional(v.string()) }, returns: v.null(),
  handler: async (ctx, a) => {
    const actor = await ctx.db.get(a.actorId);
    if (a.userIds.length > 20 || a.messageId.length > 80) throw new ConvexError("Invalid mention");
    const target = chatTarget(ctx, a.conversation);
    if (!target) throw new ConvexError("Invalid mention");
    if (target.members && !target.members.includes(a.actorId)) throw new ConvexError("Invalid mention");
    if (target.projectId && (await liveProject(ctx, target.projectId))?.teamId !== a.teamId) return null;
    if (!actor || actor.status !== "active" || !await getActiveTeamMember(ctx, a.teamId, actor.email)) return null;
    const located = a.conversation === undefined ? {} : { conversation: a.conversation, ...(target.projectId ? { projectId: target.projectId } : {}) };
    const preview = a.preview ? clip(a.preview) : "";
    for (const id of new Set(a.userIds)) {
      if (target.members && !target.members.includes(id)) continue;
      const user = await ctx.db.get(id);
      if (user) await notify(ctx, { teamId: a.teamId, actorId: a.actorId, email: user.email, kind: "mention", eventId: `chat:${a.messageId}`, messageId: a.messageId, ...located, ...(preview ? { preview } : {}) });
    }
    return null;
  },
});
