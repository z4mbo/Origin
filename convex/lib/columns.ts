import { ConvexError } from "convex/values";
import { DRAFT_COLUMN_TITLE, isDraftColumn, isLegacyIdeaColumn, normalizedColumnTitle } from "../../lib/origin-columns";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { liveProject } from "./permissions";

export { compareWorkflowColumns, DEFAULT_WORKFLOW_COLUMNS, isDoneColumn, isDraftColumn, normalizedColumnTitle as normalizeColumnTitle } from "../../lib/origin-columns";

export async function projectDraftStatus(ctx: QueryCtx, projectId: Id<"projects">): Promise<"present" | "absent" | "unresolved"> {
  const flagged = await ctx.db.query("columns").withIndex("by_projectId_and_isDraft_and_order", q => q.eq("projectId", projectId).eq("isDraft", true)).first();
  if (flagged) return "present";
  const columns = await ctx.db.query("columns").withIndex("by_project_order", q => q.eq("projectId", projectId)).take(101);
  if (columns.some(isDraftColumn)) return "present";
  return columns.length > 100 ? "unresolved" : "absent";
}

export function compareStoredColumns(a: Doc<"columns">, b: Doc<"columns">): number {
  return a.order - b.order || a._creationTime - b._creationTime || (a._id < b._id ? -1 : a._id === b._id ? 0 : 1);
}

export async function ensureDraftColumn(ctx: MutationCtx, projectId: Id<"projects">, options?: { completeLegacyScan: true }): Promise<{ column: Doc<"columns">; created: boolean; changed: boolean; adopted: boolean }> {
  const [project, flagged, first, legacy] = await Promise.all([
    liveProject(ctx, projectId),
    ctx.db.query("columns").withIndex("by_projectId_and_isDraft_and_order", q => q.eq("projectId", projectId).eq("isDraft", true)).first(),
    ctx.db.query("columns").withIndex("by_project_order", q => q.eq("projectId", projectId)).first(),
    ctx.db.query("columns").withIndex("by_project_order", q => q.eq("projectId", projectId)).take(101),
  ]);
  if (!project) throw new ConvexError("Project not found");
  const saved = project.draftIdeaCandidateId ? await ctx.db.get(project.draftIdeaCandidateId) : null;
  const ideas = [...legacy.filter(isLegacyIdeaColumn), ...(saved?.projectId === projectId && isLegacyIdeaColumn(saved) ? [saved] : [])];
  const draft = [...(flagged ? [flagged] : []), ...legacy.filter(isDraftColumn)].sort(compareStoredColumns)[0];
  if (!draft && legacy.length > 100 && !options?.completeLegacyScan) throw new ConvexError("Workflow repair required before editing this large legacy workflow");
  const candidate = draft ?? ideas.sort(compareStoredColumns)[0];
  const clearedCandidate = project.draftIdeaCandidateId !== undefined;
  if (clearedCandidate) await ctx.db.patch(projectId, { draftIdeaCandidateId: undefined });
  const now = Date.now();
  if (!candidate) {
    const id = await ctx.db.insert("columns", { projectId, title: DRAFT_COLUMN_TITLE, isDraft: true, isDone: false, order: first ? first.order - 1 : 0, createdAt: now, updatedAt: now });
    return { column: (await ctx.db.get(id))!, created: true, changed: true, adopted: false };
  }
  const patch: Partial<Doc<"columns">> = {};
  if (!draft) patch.title = DRAFT_COLUMN_TITLE;
  if (candidate.isDraft !== true) patch.isDraft = true;
  if (candidate.isDone !== false) patch.isDone = false;
  if (first && first._id !== candidate._id) patch.order = first.order - 1;
  const columnChanged = Object.keys(patch).length > 0;
  if (columnChanged) await ctx.db.patch(candidate._id, { ...patch, updatedAt: now });
  return { column: { ...candidate, ...patch }, created: false, changed: columnChanged || clearedCandidate, adopted: !draft };
}
