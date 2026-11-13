import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { repositoryUrl } from "./repository";
import { changeOpenIssueCount, liveProject, touchProject } from "./permissions";
import { compareWorkflowColumns, isDoneColumn, isDraftColumn } from "./columns";
import { issueStatusChanged } from "./issueEvents";

export function hasCurrentMergeReceipt(task: Doc<"tasks">, project: Doc<"projects">) {
  const receipt = task.completionPullRequest;
  const repoUrl = repositoryUrl(project.repoUrl)?.toLowerCase();
  return Boolean(receipt && repoUrl && receipt.repoUrl.toLowerCase() === repoUrl
    && receipt.issueNumber === task.githubIssueNumber && task.githubIssueUrl?.toLowerCase() === `${repoUrl}/issues/${receipt.issueNumber}`);
}

/** Who completed an issue: a person (UI, MCP token owner) or a named source such as "GitHub". */
export type CompletionActor = { userId?: Id<"users">; name?: string };

export type CompletionOptions = {
  actor?: CompletionActor;
  /** When the issue was completed (a merge time from GitHub); now by default. */
  completedAt?: number;
  /**
   * Completing: a column to move the issue into (the project's Done column for a merged pull request); the column it
   * leaves is remembered for a reopen. Reopening: the column to reopen into (a move to Backlog that reopens).
   */
  columnId?: Id<"columns">;
  /** The change came from GitHub, so the mirror must not be asked to reopen the GitHub issue again. */
  fromGitHub?: boolean;
  /** Leave issue.updated and the GitHub sync to the caller, which reports a column change in the same write. */
  quiet?: boolean;
};

/**
 * The column a reopened issue goes back to: the given one, else the column it was in before a completion moved it,
 * else its own column, else the first workflow column after Backlog. Done columns never qualify (they are hidden).
 */
export async function reopenColumn(ctx: MutationCtx, task: Doc<"tasks">, preferred?: Id<"columns">) {
  const columns = (await ctx.db.query("columns").withIndex("by_project_order", q => q.eq("projectId", task.projectId)).take(200)).sort(compareWorkflowColumns);
  const usable = (id?: Id<"columns">) => id ? columns.find(column => column._id === id && !isDoneColumn(column)) : undefined;
  return usable(preferred) ?? usable(task.completedFromColumnId) ?? usable(task.columnId)
    ?? columns.find(column => !isDoneColumn(column) && !isDraftColumn(column)) ?? columns.find(column => !isDoneColumn(column)) ?? null;
}

/**
 * The one way an issue is completed or reopened, from the board, the issue page, MCP (`move_issue` with `completed`),
 * connectors, merged pull requests and GitHub issue state. It sets `done`, records who and when, keeps the project's
 * open issue count, puts a reopened issue back in a visible column, and (unless `quiet`) sends issue.updated once and
 * queues the GitHub mirror, which closes or reopens the GitHub issue. Assignee and delegate are never touched.
 * Returns whether anything changed.
 */
export async function setIssueCompletion(ctx: MutationCtx, task: Doc<"tasks">, done: boolean, options: CompletionOptions = {}) {
  if (task.done === done) return false;
  const now = Date.now();
  if (done) {
    const completedAt = options.completedAt ?? now;
    const actorName = options.actor?.name ?? (options.actor?.userId ? (await ctx.db.get(options.actor.userId))?.name : undefined);
    const moving = options.columnId && options.columnId !== task.columnId;
    await ctx.db.patch(task._id, {
      done: true, completedAt, completedBy: options.actor?.userId, completedByName: actorName,
      githubIssueReopenRequested: undefined, updatedAt: now,
      ...(moving ? { columnId: options.columnId, completedFromColumnId: task.columnId } : { completedFromColumnId: undefined }),
    });
    const project = await liveProject(ctx, task.projectId);
    if (project?.teamId && !await ctx.db.query("taskCompletions").withIndex("by_taskId", q => q.eq("taskId", task._id)).unique()) {
      await ctx.db.insert("taskCompletions", { teamId: project.teamId, projectId: project._id, taskId: task._id, assignedToEmail: task.assignedToEmail, completedAt });
    }
    await changeOpenIssueCount(ctx, task.projectId, -1);
  } else {
    const column = await reopenColumn(ctx, task, options.columnId);
    let placement: { columnId: Id<"columns">; order: number } | null = null;
    if (column && column._id !== task.columnId) {
      const last = await ctx.db.query("tasks").withIndex("by_column_order", q => q.eq("columnId", column._id)).order("desc").first();
      placement = { columnId: column._id, order: last ? last.order + 1 : 0 };
    }
    await ctx.db.patch(task._id, {
      done: false, completedAt: undefined, completedBy: undefined, completedByName: undefined, completedFromColumnId: undefined,
      completionPullRequest: undefined, updatedAt: now,
      ...(task.githubIssueNumber && !options.fromGitHub ? { githubIssueReopenRequested: true } : {}),
      ...placement,
    });
    await changeOpenIssueCount(ctx, task.projectId, 1);
  }
  if (!options.quiet) {
    await issueStatusChanged(ctx, task);
    await touchProject(ctx, task.projectId);
  }
  return true;
}
