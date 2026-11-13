/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { createSession } from "./lib/auth";
import { setIssueCompletion } from "./lib/completions";
import { boardLanes, inIssueTab, issueTabCounts, newestCompletedFirst, type IssueTab } from "../lib/issue-view";
import { isDraftColumn } from "../lib/origin-columns";
import { issueKey } from "../lib/github-references";
import type { IssueWebhookPayload } from "../lib/issue-webhook";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

// Fake timers keep queued webhook deliveries pending so the test can read them; a deployment-wide webhook is set.
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("ORIGIN_ISSUE_WEBHOOK_URL", "https://hooks.test/completed");
  vi.stubEnv("ORIGIN_ISSUE_WEBHOOK_SECRET", "s".repeat(40));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

async function fixture() {
  const t = convexTest(schema, modules);
  const email = "owner@completed.test";
  const { userId, sessionToken } = await t.run(async ctx => {
    const userId = await ctx.db.insert("users", { name: "Owner", email, role: "user", status: "active", passwordHash: "unused", salt: "unused", iterations: 1, createdAt: 1, updatedAt: 1 });
    return { userId, sessionToken: await createSession(ctx, userId) };
  });
  const { teamId } = await t.mutation(api.workspaces.create, { sessionToken, name: "Completed" });
  const projectId = await t.mutation(api.projects.create, { sessionToken, teamId, name: "Board", githubRepo: "later" });
  const scope = { sessionToken, projectId };
  const columns = (await t.query(api.tasks.board, scope)).columns;
  const column = (title: string) => columns.find(c => c.title === title)!._id;
  // A system Done column and a legacy one (titled "done", no flag): both hidden, both may hold completed issues.
  const doneColumn = await t.run(ctx => ctx.db.insert("columns", { projectId, title: "Done", isDone: true, order: 10, createdAt: 1, updatedAt: 1 }));
  const legacyDone = await t.run(ctx => ctx.db.insert("columns", { projectId, title: "done", order: 11, createdAt: 1, updatedAt: 1 }));
  const create = (title: string, columnId: Id<"columns">) => t.mutation(api.tasks.createTask, { ...scope, columnId, title, priority: "medium", assignedToEmail: email });
  const token = (await t.mutation(api.mcp.createToken, { sessionToken, teamId, name: "OpenBot", write: true })).token;
  const task = async (taskId: Id<"tasks">) => (await t.query(api.tasks.details, { ...scope, taskId })).task;
  const openCount = async () => (await t.query(api.projects.get, scope)).openIssueCount ?? 0;
  const updates = async () => (await t.run(ctx => ctx.db.system.query("_scheduled_functions").collect()))
    .filter(job => job.name.includes("issueWebhooks") && job.state.kind === "pending")
    .map(job => JSON.parse((job.args[0] as { body: string }).body) as IssueWebhookPayload)
    .filter(payload => payload.type === "issue.updated");
  return { t, userId, email, sessionToken, teamId, projectId, scope, column, doneColumn, legacyDone, create, token, task, openCount, updates };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** What each view of the board shows, computed the way components/project-issues.tsx does from tasks.board. */
async function views(f: Fixture) {
  const board = await f.t.query(api.tasks.board, f.scope);
  const lanes = boardLanes(board.columns);
  const draft = (task: Doc<"tasks">) => {
    const lane = lanes.visible.find(c => c._id === lanes.laneOf(task));
    return Boolean(lane && isDraftColumn(lane));
  };
  const titles = (tab: IssueTab) => board.tasks.filter(task => inIssueTab(task, draft(task), tab)).map(task => task.title).sort();
  return {
    lanes: Object.fromEntries(lanes.visible.map(c => [c.title, lanes.tasksIn(board.tasks, c._id).map(task => task.title)])),
    all: titles("all"), active: titles("active"), backlog: titles("backlog"),
    completed: newestCompletedFirst(board.tasks).map(task => task.title),
    counts: issueTabCounts(board.tasks, task => draft(task as Doc<"tasks">)),
  };
}

describe("completed issues leave the board and open lists", () => {
  test("columns, All issues, Active and Backlog show open issues only; Completed shows the rest, newest first", async () => {
    const f = await fixture();
    await f.create("Open todo", f.column("Todo"));
    await f.create("Open backlog", f.column("Backlog"));
    const doneTodo = await f.create("Done in Todo", f.column("Todo"));
    const doneBacklog = await f.create("Done in Backlog", f.column("Backlog"));
    await f.t.mutation(api.tasks.updateTask, { ...f.scope, taskId: doneBacklog, done: true });
    vi.advanceTimersByTime(1000);
    await f.create("Done in Done column", f.doneColumn);
    vi.advanceTimersByTime(1000);
    await f.create("Done in legacy done column", f.legacyDone);
    vi.advanceTimersByTime(1000);
    await f.t.mutation(api.tasks.updateTask, { ...f.scope, taskId: doneTodo, done: true });

    const v = await views(f);
    expect(v.lanes).toEqual({ Backlog: ["Open backlog"], Todo: ["Open todo"], "In progress": [] });
    expect(v.all).toEqual(["Open backlog", "Open todo"]);
    expect(v.active).toEqual(["Open todo"]);
    expect(v.backlog).toEqual(["Open backlog"]);
    expect(v.completed).toEqual(["Done in Todo", "Done in legacy done column", "Done in Done column", "Done in Backlog"]);
    expect(v.counts).toEqual({ all: 2, active: 1, backlog: 1, completed: 4 });
    // The sidebar badge and project counts are open issues only.
    expect(await f.openCount()).toBe(2);
    const listed = await f.t.query(api.projects.listForUser, { sessionToken: f.sessionToken, teamId: f.teamId });
    expect(listed.find(p => p._id === f.projectId)?.openIssueCount).toBe(2);
  });

  test("inbox, Assigned to me, workspace issue lists and MCP open lists exclude completed issues", async () => {
    const f = await fixture();
    await f.create("Still open", f.column("Todo"));
    const finished = await f.create("Finished", f.column("Todo"));
    await f.t.mutation(api.tasks.updateTask, { ...f.scope, taskId: finished, done: true });
    const page = { numItems: 50, cursor: null };
    const list = async (mine: boolean, done: boolean) => (await f.t.query(api.inbox.list, { sessionToken: f.sessionToken, teamId: f.teamId, mine, done, paginationOpts: page })).page.map(row => row.title);
    expect(await list(true, false)).toEqual(["Still open"]);
    expect(await list(false, false)).toEqual(["Still open"]);
    expect(await list(true, true)).toEqual(["Finished"]);
    expect((await f.t.query(api.tasks.inbox, { sessionToken: f.sessionToken, teamId: f.teamId })).map(row => row.title)).toEqual(["Still open"]);
    expect((await f.t.query(api.tasks.assignedToMe, f.scope)).map(row => row.title)).toEqual(["Still open"]);
    expect((await f.t.query(api.workspaceSearch.issues, { sessionToken: f.sessionToken, teamId: f.teamId, text: "", done: false })).map(row => row.title)).toEqual(["Still open"]);
    const inbox = JSON.parse(await f.t.query(api.mcp.inbox, { token: f.token }));
    expect(inbox.assigned.map((issue: { title: string }) => issue.title)).toEqual(["Still open"]);
    const open = JSON.parse(await f.t.query(api.mcp.issues, { token: f.token, project: "Board" }));
    expect(open.issues.map((issue: { title: string }) => issue.title)).toEqual(["Still open"]);
    const completed = JSON.parse(await f.t.query(api.mcp.issues, { token: f.token, project: "Board", status: "completed" }));
    expect(completed.issues.map((issue: { title: string; status: string }) => [issue.title, issue.status])).toEqual([["Finished", "completed"]]);
  });
});

describe("reopening", () => {
  test("goes back to the column the issue was in, and counts it as open again", async () => {
    const f = await fixture();
    const taskId = await f.create("Review me", f.column("In progress"));
    await f.t.mutation(api.tasks.updateTask, { ...f.scope, taskId, done: true });
    expect(await f.openCount()).toBe(0);
    await f.t.mutation(api.tasks.updateTask, { ...f.scope, taskId, done: false });
    expect(await f.task(taskId)).toMatchObject({ done: false, columnId: f.column("In progress") });
    expect((await f.task(taskId)).completedAt).toBeUndefined();
    expect(await f.openCount()).toBe(1);
    expect((await views(f)).lanes["In progress"]).toEqual(["Review me"]);
  });

  test("an issue a completion moved into Done goes back to its previous column", async () => {
    const f = await fixture();
    const taskId = await f.create("Merged", f.column("In progress"));
    // What a merged pull request does: complete and move to the project's Done column.
    await f.t.run(async ctx => { await setIssueCompletion(ctx, (await ctx.db.get(taskId))!, true, { actor: { name: "GitHub" }, columnId: f.doneColumn, fromGitHub: true }); });
    expect(await f.task(taskId)).toMatchObject({ done: true, columnId: f.doneColumn, completedFromColumnId: f.column("In progress"), completedByName: "GitHub" });
    await f.t.mutation(api.tasks.updateTask, { ...f.scope, taskId, done: false });
    expect(await f.task(taskId)).toMatchObject({ done: false, columnId: f.column("In progress") });
    expect((await f.task(taskId)).completedFromColumnId).toBeUndefined();
  });

  test("an issue sitting in a Done column with no previous column goes to the first column after Backlog", async () => {
    const f = await fixture();
    const legacy = await f.create("Legacy done", f.legacyDone);
    const system = await f.create("System done", f.doneColumn);
    await f.t.mutation(api.tasks.updateTask, { ...f.scope, taskId: legacy, done: false });
    await f.t.mutation(api.tasks.updateTask, { ...f.scope, taskId: system, done: false });
    expect((await f.task(legacy)).columnId).toBe(f.column("Todo"));
    expect((await f.task(system)).columnId).toBe(f.column("Todo"));
    expect((await views(f)).lanes.Todo).toEqual(["Legacy done", "System done"]);
  });

  test("a previous column that was deleted falls back to the first column after Backlog", async () => {
    const f = await fixture();
    const taskId = await f.create("Orphan", f.column("In progress"));
    await f.t.run(async ctx => { await setIssueCompletion(ctx, (await ctx.db.get(taskId))!, true, { columnId: f.doneColumn }); });
    await f.t.run(ctx => ctx.db.delete(f.column("In progress")));
    await f.t.mutation(api.tasks.updateTask, { ...f.scope, taskId, done: false });
    expect((await f.task(taskId)).columnId).toBe(f.column("Todo"));
  });
});

describe("completing through MCP", () => {
  test("move_issue completed: true completes, get_issue reads it back, completed: false reopens", async () => {
    const f = await fixture();
    const taskId = await f.create("Agent work", f.column("Todo"));
    const key = issueKey(taskId);
    const done = JSON.parse(await f.t.mutation(api.mcp.moveIssue, { token: f.token, issueId: key, completed: true }));
    expect(done).toMatchObject({ key, status: "completed", completedBy: "Owner via OpenBot" });
    const read = JSON.parse(await f.t.query(api.mcp.issue, { token: f.token, issueId: key }));
    expect(read).toMatchObject({ status: "completed", completedBy: "Owner via OpenBot" });
    expect(Date.parse(read.completedAt)).toBeGreaterThan(0);
    expect(await f.openCount()).toBe(0);
    expect((await views(f)).completed).toEqual(["Agent work"]);
    expect((await views(f)).all).toEqual([]);

    const reopened = JSON.parse(await f.t.mutation(api.mcp.moveIssue, { token: f.token, issueId: key, completed: false }));
    expect(reopened).toMatchObject({ status: "open", column: "Todo" });
    expect(reopened.completedAt).toBeUndefined();
    expect(await f.openCount()).toBe(1);
  });

  test("completing assigns and delegates nobody and sends issue.updated once with changes.completed", async () => {
    const f = await fixture();
    const taskId = await f.create("Quiet completion", f.column("Todo"));
    const before = await f.task(taskId);
    const notifications = async () => (await f.t.run(ctx => ctx.db.query("notifications").collect())).length;
    const notified = await notifications();
    expect(await f.updates()).toEqual([]);

    await f.t.mutation(api.mcp.moveIssue, { token: f.token, issueId: taskId, completed: true });
    const after = await f.task(taskId);
    expect(after).toMatchObject({ done: true, assignedToEmail: before.assignedToEmail, columnId: before.columnId });
    expect(after.delegateGrantId).toBeUndefined();
    expect(await notifications()).toBe(notified);
    const sent = await f.updates();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.changes).toEqual({ completed: { from: false, to: true } });
    expect(sent[0]!.issue).toMatchObject({ completed: true, status: "Todo", assignee: { email: f.email } });
    // Completing again changes nothing and sends nothing.
    await f.t.mutation(api.mcp.moveIssue, { token: f.token, issueId: taskId, completed: true });
    expect(await f.updates()).toHaveLength(1);
    const scheduled = (await f.t.run(ctx => ctx.db.system.query("_scheduled_functions").collect())).map(job => job.args[0] as { event?: string });
    expect(scheduled.filter(job => job.event === "issue.delegated")).toEqual([]);
  });

  test("the board, connectors and MCP share one path: a linked GitHub issue closes on completion and is asked to reopen", async () => {
    const f = await fixture();
    const taskId = await f.create("Mirrored", f.column("Todo"));
    await f.t.run(ctx => ctx.db.patch(taskId, { githubIssueNumber: 3, githubIssueUrl: "https://github.com/acme/board/issues/3", githubIssueState: "open" }));
    await f.t.mutation(api.tasks.updateTask, { ...f.scope, taskId, done: true });
    expect((await f.task(taskId)).githubIssueReopenRequested).toBeUndefined();
    await f.t.mutation(api.mcp.moveIssue, { token: f.token, issueId: taskId, completed: false });
    expect(await f.task(taskId)).toMatchObject({ done: false, githubIssueReopenRequested: true });
    const changes = (await f.updates()).map(payload => payload.changes);
    expect(changes).toEqual([{ completed: { from: false, to: true } }, { completed: { from: true, to: false } }]);
  });
});
