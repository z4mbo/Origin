import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { repositoryUrl } from "./repository";
import { liveProject } from "./permissions";

export function hasCurrentMergeReceipt(task: Doc<"tasks">, project: Doc<"projects">) {
  const receipt = task.completionPullRequest;
  const repoUrl = repositoryUrl(project.repoUrl)?.toLowerCase();
  return Boolean(receipt && repoUrl && receipt.repoUrl.toLowerCase() === repoUrl
    && receipt.issueNumber === task.githubIssueNumber && task.githubIssueUrl?.toLowerCase() === `${repoUrl}/issues/${receipt.issueNumber}`);
}

export async function recordCompletion(ctx: MutationCtx, task: Doc<"tasks">, done: boolean, completedAt = Date.now()) {
  if (!done || task.done || task.completedAt) return;
  const project = await liveProject(ctx, task.projectId);
  await ctx.db.patch(task._id, { completedAt });
  if (!project?.teamId) return;
  const existing = await ctx.db.query("taskCompletions").withIndex("by_taskId", q => q.eq("taskId", task._id)).unique();
  if (!existing) await ctx.db.insert("taskCompletions", {
    teamId: project.teamId, projectId: project._id, taskId: task._id,
    assignedToEmail: task.assignedToEmail, completedAt,
  });
}
