/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { createSession } from "./lib/auth";
import type { Id, TableNames } from "./_generated/dataModel";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
/** More than one purge step's write budget (250), so deletion has to resume itself. */
const BULK_TASKS = 300;

type Test = ReturnType<typeof convexTest>;
type Sent = { url: string; event: string | null };

let sent: Sent[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  // Every outgoing request is recorded: webhook deliveries, and any GitHub call the purge must never make.
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    sent.push({ url: request.url, event: request.headers.get("x-origin-event") });
    return new Response("{}", { status: 200 });
  });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const useGlobalWebhook = () => { vi.stubEnv("ORIGIN_ISSUE_WEBHOOK_URL", "https://hooks.test/global"); vi.stubEnv("ORIGIN_ISSUE_WEBHOOK_SECRET", "d".repeat(40)); };

/** Fills a project with a row in every kind of table a project owns, plus files, so the purge has real work. */
async function seedProject(t: Test, sessionToken: string, ownerId: Id<"users">, teamId: Id<"teams">, projectId: Id<"projects">, repo: string) {
  const scope = { sessionToken, projectId };
  await t.run(ctx => ctx.db.patch(projectId, { repoUrl: `https://github.com/acme/${repo}`, githubWorkspaceAccess: true }));
  const columnId = (await t.query(api.tasks.board, scope)).columns[1]!._id;
  const taskId = await t.mutation(api.tasks.createTask, { ...scope, columnId, title: "Ship it", priority: "high" });
  const otherTaskId = await t.mutation(api.tasks.createTask, { ...scope, columnId, title: "Then this", priority: "low" });
  await t.mutation(api.tasks.addComment, { ...scope, taskId, body: "On it" });
  await t.mutation(api.credentials.create, { ...scope, title: "Vault entry", ciphertext: "c", iv: "i", salt: "s", iterations: 600000, kdf: "PBKDF2" });
  await t.mutation(api.wiki.create, { ...scope, title: "Notes", content: "Body", type: "wiki", tags: [] });
  await t.mutation(api.design.createToken, { ...scope, type: "color", name: "Accent", value: "#123456" });
  await t.mutation(api.projects.sendChatMessage, { ...scope, body: "Hello" });
  return t.run(async ctx => {
    const now = Date.now();
    const file = async (scopeOf: { kind: "project"; projectId: Id<"projects"> } | { kind: "workspace"; teamId: Id<"teams"> }) => {
      const storageId = await ctx.storage.store(new Blob([`${repo}-${Math.random()}`]));
      const key = scopeOf.kind === "project" ? `project:${scopeOf.projectId}` : `workspace:${scopeOf.teamId}`;
      await ctx.db.insert("storageAdmissions", { storageId, scopeKey: key, scope: scopeOf, createdAt: now });
      return storageId;
    };
    const iconId = await file({ kind: "project", projectId });
    await ctx.db.patch(projectId, { iconType: "image", iconStorageId: iconId });
    const assetId = await file({ kind: "project", projectId });
    await ctx.db.insert("designAssets", { projectId, type: "image", name: "Logo", storageId: assetId, createdAt: now, updatedAt: now });
    // An issue attachment: a workspace-channel chat file tied to the issue through taskAssets.localFileId.
    const fileId = crypto.randomUUID();
    const attachmentId = await file({ kind: "project", projectId });
    await ctx.db.insert("teamChatFiles", { teamId, conversation: "", fileId, author: ownerId, storageId: attachmentId, payload: JSON.stringify({ id: fileId, name: "spec.pdf", size: 3, contentType: "application/pdf", projectId }) });
    await ctx.db.insert("taskAssets", { projectId, taskId, type: "file", name: "spec.pdf", url: "", localFileId: fileId, authorUserId: ownerId, createdAt: now });
    await ctx.db.insert("taskRelations", { teamId, fromTaskId: taskId, toTaskId: otherTaskId, kind: "blocks" });
    const canvasId = await ctx.db.insert("canvases", { teamId, projectId, name: "Board", archived: false, createdAt: now, updatedAt: now });
    await ctx.db.insert("canvasComments", { teamId, canvasId, x: 0, y: 0, authorId: ownerId, authorName: "Owner", body: "Here", mentions: [], resolved: false, createdAt: now });
    await ctx.db.insert("drawingElements", { teamId, canvasId, elementId: "el1", version: 1, nonce: 1, data: "{}", updatedAt: now });
    const drawingId = await file({ kind: "project", projectId });
    await ctx.db.insert("drawingFiles", { teamId, canvasId, fileId: `drawing-${repo}`, storageId: drawingId, mimeType: "image/png" });
    await ctx.db.insert("notifications", { teamId, userId: ownerId, actorId: ownerId, kind: "comment", eventId: `comment:${projectId}`, projectId, taskId, read: false, createdAt: now });
    await ctx.db.insert("projectPresence", { teamId, userId: ownerId, clientId: `client-${repo}`, projectId, sequence: 1, updatedAt: now });
    await ctx.db.insert("savedViews", { teamId, userId: ownerId, name: "Mine here", mine: true, done: false, projectId });
    await ctx.db.insert("workspaceInvites", { teamId, projectId, token: `invite-${repo}`, role: "member", createdBy: ownerId, expiresAt: now + 60_000, revoked: false, createdAt: now });
    // Queued GitHub work: an issue mirror, a pending close of a deleted issue, and a repository job. None may run.
    await ctx.db.insert("githubIssueMirrors", { projectId, taskId, pending: true, revision: 1, attempts: 0, nextAt: now, updatedAt: now });
    await ctx.db.insert("githubIssueMirrors", { projectId, taskId: otherTaskId, pending: true, revision: 1, attempts: 0, nextAt: now, deleted: { repoUrl: `https://github.com/acme/${repo}`, number: 7 }, updatedAt: now });
    await ctx.db.insert("githubIssueWork", { projectId, taskId, repoUrl: `https://github.com/acme/${repo}`, title: "Ship it", description: "", done: false, deleted: false, revision: 1, state: "pending", attempts: 0, nextAt: now, updatedAt: now });
    await ctx.db.insert("githubRepoJobs", { projectId, startedAt: now, state: "working" });
    await ctx.db.insert("githubProjectConnections", { projectId, repo: `acme/${repo}`, login: "acme", sealed: "sealed", connectedBy: ownerId, updatedAt: now });
    for (let index = 0; index < BULK_TASKS; index++) {
      await ctx.db.insert("tasks", { teamId, projectId, columnId, title: `Bulk ${index}`, priority: "low", done: false, order: index + 10, createdAt: now, updatedAt: now });
    }
    return { taskId, files: [iconId, assetId, attachmentId, drawingId] };
  });
}

async function fixture() {
  const t = convexTest(schema, modules);
  const people = await t.run(async ctx => {
    const users: Record<string, { id: Id<"users">; email: string; token: string }> = {};
    for (const name of ["owner", "admin", "member", "lead", "outsider"]) {
      const id = await ctx.db.insert("users", { name, email: `${name}@projectdelete.test`, role: "user", status: "active", passwordHash: "unused", salt: "unused", iterations: 1, createdAt: 1, updatedAt: 1 });
      users[name] = { id, email: `${name}@projectdelete.test`, token: await createSession(ctx, id) };
    }
    return users as Record<"owner" | "admin" | "member" | "lead" | "outsider", { id: Id<"users">; email: string; token: string }>;
  });
  const { teamId } = await t.mutation(api.workspaces.create, { sessionToken: people.owner.token, name: "Acme" });
  for (const [person, role] of [[people.admin, "admin"], [people.member, "member"], [people.lead, "member"]] as const) {
    await t.run(ctx => ctx.db.insert("teamMembers", { teamId, userId: person.id, email: person.email, name: role, role, status: "active", createdAt: 1, updatedAt: 1 }));
  }
  const create = (name: string) => t.mutation(api.projects.create, { sessionToken: people.owner.token, teamId, name, githubRepo: "later" });
  const doomedId = await create("Doomed");
  const keptId = await create("Kept");
  for (const projectId of [doomedId, keptId]) {
    await t.mutation(api.members.addWorkspaceMember, { sessionToken: people.owner.token, projectId, email: people.member.email, role: "member" });
  }
  await t.mutation(api.members.addWorkspaceMember, { sessionToken: people.owner.token, projectId: doomedId, email: people.lead.email, role: "admin" });
  const doomed = await seedProject(t, people.owner.token, people.owner.id, teamId, doomedId, "doomed");
  const kept = await seedProject(t, people.owner.token, people.owner.id, teamId, keptId, "kept");
  // Lists elsewhere in the workspace that name both projects.
  await t.run(ctx => ctx.db.insert("notificationPreferences", { teamId, userId: people.member.id, assignments: true, comments: true, mentions: true, mutedProjects: [doomedId, keptId], quietStart: "", quietEnd: "", timeZone: "UTC" }));
  return { t, ...people, teamId, doomedId, keptId, doomed, kept };
}

/** Every row anywhere in the database whose fields name one of `ids`. */
async function rowsNaming(t: Test, ids: readonly string[]) {
  return t.run(async ctx => {
    const found: string[] = [];
    for (const table of Object.keys(schema.tables) as TableNames[]) {
      for (const row of await ctx.db.query(table).collect()) {
        const fields = JSON.stringify({ ...row, _id: undefined });
        if (ids.some(id => row._id === id || fields.includes(`"${id}"`))) found.push(`${table}:${row._id}`);
      }
    }
    return found.sort();
  });
}

const storedFiles = (t: Test) => t.run(async ctx => (await ctx.db.system.query("_storage").collect()).map(file => file._id as string));
const pendingEvents = async (t: Test) => (await t.run(ctx => ctx.db.system.query("_scheduled_functions").collect()))
  .filter(job => job.name.includes("issueWebhooks") && job.state.kind === "pending").map(job => (job.args[0] as { event: string }).event);
const runScheduled = (t: Test) => t.finishAllScheduledFunctions(vi.runAllTimers);

describe("deleting a project", () => {
  test("only a workspace or project owner/admin who types the exact name can delete it", async () => {
    const f = await fixture();
    const remove = (token: string, confirmName = "Doomed") => f.t.mutation(api.projects.deleteProject, { sessionToken: token, projectId: f.doomedId, confirmName });
    await expect(remove(f.member.token)).rejects.toThrow("Only admins can do this");
    await expect(remove(f.outsider.token)).rejects.toThrow("You don't have access to this project");
    await expect(remove(f.admin.token, "doomed")).rejects.toThrow("Type the project name exactly");
    await expect(remove(f.admin.token, "Kept")).rejects.toThrow("Type the project name exactly");
    expect(await f.t.run(ctx => ctx.db.get(f.doomedId))).toMatchObject({ status: "active" });
    // A project admin who is only a member of the workspace may delete it too.
    await remove(f.lead.token, " Doomed ");
    expect(await f.t.run(ctx => ctx.db.get(f.doomedId))).toMatchObject({ deletingAt: expect.any(Number), status: "inactive", deletedBy: { userId: f.lead.id, email: f.lead.email } });
  });

  test("the project is hidden from every list and query at once, before the purge runs", async () => {
    const f = await fixture();
    const mcpToken = (await f.t.mutation(api.mcp.createToken, { sessionToken: f.member.token, teamId: f.teamId, name: "bot", write: true })).token;
    expect(await f.t.query(api.mcp.workspace, { token: mcpToken })).toContain(f.doomedId);
    await f.t.mutation(api.projects.deleteProject, { sessionToken: f.owner.token, projectId: f.doomedId, confirmName: "Doomed" });
    expect(await f.t.run(ctx => ctx.db.get(f.doomedId))).not.toBeNull();
    for (const person of [f.owner, f.admin, f.member, f.lead]) {
      expect((await f.t.query(api.projects.listForUser, { sessionToken: person.token, teamId: f.teamId })).map(project => project.name)).toEqual(person === f.lead ? [] : ["Kept"]);
      expect((await f.t.query(api.projects.listForUser, { sessionToken: person.token })).map(project => project.name)).not.toContain("Doomed");
      await expect(f.t.query(api.projects.get, { sessionToken: person.token, projectId: f.doomedId })).rejects.toThrow("Project not found");
      await expect(f.t.query(api.tasks.board, { sessionToken: person.token, projectId: f.doomedId })).rejects.toThrow("Project not found");
      const found = await f.t.query(api.workspaceSearch.issues, { sessionToken: person.token, teamId: f.teamId, text: "Ship" });
      expect(found.map(row => row.projectId)).not.toContain(f.doomedId);
      const inbox = await f.t.query(api.inbox.list, { sessionToken: person.token, teamId: f.teamId, mine: false, done: false, paginationOpts: { numItems: 400, cursor: null } });
      expect(inbox.page.some(row => JSON.stringify(row).includes(f.doomedId))).toBe(false);
    }
    expect(await f.t.query(api.mcp.workspace, { token: mcpToken })).not.toContain(f.doomedId);
    await expect(f.t.mutation(api.projects.update, { sessionToken: f.owner.token, projectId: f.doomedId, status: "active" })).rejects.toThrow("Project not found");
    // GitHub sync and integration ticks skip it.
    expect(await f.t.query(internal.integrations.pending, {})).not.toContain(f.doomedId);
    expect(await f.t.query(internal.taskPRs.repositoryProjects, { repoUrl: "https://github.com/acme/doomed" })).not.toContain(f.doomedId);
  });

  test("every row and file of the project goes, in several bounded steps; the other project and the workspace stay", async () => {
    const f = await fixture();
    const keptBefore = await rowsNaming(f.t, [f.keptId]);
    const filesBefore = await storedFiles(f.t);
    expect((await rowsNaming(f.t, [f.doomedId])).length).toBeGreaterThan(BULK_TASKS + 20);

    await f.t.mutation(api.projects.deleteProject, { sessionToken: f.admin.token, projectId: f.doomedId, confirmName: "Doomed" });
    // One step cannot finish a project this size: the project is still there, partly purged, with a step queued.
    await f.t.mutation(internal.projectDeletion.purge, { projectId: f.doomedId });
    const afterOneStep = await rowsNaming(f.t, [f.doomedId]);
    expect(await f.t.run(ctx => ctx.db.get(f.doomedId))).not.toBeNull();
    expect(afterOneStep.length).toBeGreaterThan(0);
    expect(afterOneStep.length).toBeLessThan(BULK_TASKS + 20);

    await runScheduled(f.t);
    expect(await rowsNaming(f.t, [f.doomedId])).toEqual([]);
    expect(await rowsNaming(f.t, [f.keptId])).toEqual(keptBefore);
    expect(await f.t.run(ctx => ctx.db.get(f.teamId))).not.toBeNull();
    expect(await f.t.run(ctx => ctx.db.query("notificationPreferences").first())).toMatchObject({ mutedProjects: [f.keptId] });
    const filesAfter = await storedFiles(f.t);
    expect(filesAfter).toEqual(filesBefore.filter(id => !(f.doomed.files as string[]).includes(id)));
    for (const id of f.kept.files) expect(filesAfter).toContain(id);
    expect((await f.t.query(api.projects.listForUser, { sessionToken: f.member.token, teamId: f.teamId })).map(project => project.name)).toEqual(["Kept"]);
    expect((await f.t.query(api.tasks.board, { sessionToken: f.member.token, projectId: f.keptId })).tasks.length).toBe(BULK_TASKS + 2);
  });

  test("deleting again, and repeating or resuming a purge, is harmless", async () => {
    useGlobalWebhook();
    const f = await fixture();
    await runScheduled(f.t);
    await f.t.mutation(api.projects.deleteProject, { sessionToken: f.owner.token, projectId: f.doomedId, confirmName: "Doomed" });
    await f.t.mutation(api.projects.deleteProject, { sessionToken: f.admin.token, projectId: f.doomedId, confirmName: "Doomed" });
    await expect(f.t.mutation(api.projects.deleteProject, { sessionToken: f.member.token, projectId: f.doomedId, confirmName: "Doomed" })).rejects.toThrow("Project not found");
    expect((await pendingEvents(f.t)).filter(event => event === "project.deleted")).toHaveLength(1);
    // A purge step that failed leaves the project marked; the cron restarts it once it looks stalled.
    await f.t.mutation(internal.projectDeletion.purge, { projectId: f.doomedId });
    await f.t.run(ctx => ctx.db.patch(f.doomedId, { deletingAt: Date.now() - 60 * 60_000 }));
    await f.t.mutation(internal.projectDeletion.resume, {});
    await runScheduled(f.t);
    expect(await rowsNaming(f.t, [f.doomedId])).toEqual([]);
    await f.t.mutation(internal.projectDeletion.purge, { projectId: f.doomedId });
    await f.t.mutation(internal.projectDeletion.resume, {});
    await expect(f.t.mutation(api.projects.deleteProject, { sessionToken: f.owner.token, projectId: f.doomedId, confirmName: "Doomed" })).rejects.toThrow("Project not found");
  });

  test("GitHub is left alone and no issue events are sent for the issues it removes", async () => {
    useGlobalWebhook();
    const f = await fixture();
    await runScheduled(f.t);
    sent = [];
    await f.t.mutation(api.projects.deleteProject, { sessionToken: f.owner.token, projectId: f.doomedId, confirmName: "Doomed" });
    await runScheduled(f.t);
    expect(sent.filter(request => /github\.com/.test(request.url))).toEqual([]);
    expect(sent).toEqual([{ url: "https://hooks.test/global", event: "project.deleted" }]);
    // Nothing queued a close or delete of the repository's issues.
    expect(await f.t.run(ctx => ctx.db.query("githubIssueMirrors").collect())).toSatisfy(rows => (rows as Array<{ projectId: string }>).every(row => row.projectId === f.keptId));
  });

  test("deleting the workspace while a project is being deleted removes both", async () => {
    const f = await fixture();
    await f.t.mutation(api.projects.deleteProject, { sessionToken: f.owner.token, projectId: f.doomedId, confirmName: "Doomed" });
    expect((await f.t.query(api.workspaces.deletionSummary, { sessionToken: f.owner.token, teamId: f.teamId })).projects).toEqual(["Kept"]);
    await f.t.mutation(api.workspaces.remove, { sessionToken: f.owner.token, teamId: f.teamId, confirmName: "Acme" });
    await runScheduled(f.t);
    // Members' deleted-workspace notices outlive the workspace on purpose (convex/workspaceDeletion.ts).
    expect((await rowsNaming(f.t, [f.teamId, f.doomedId, f.keptId])).filter(row => !row.startsWith("deletedWorkspaces:"))).toEqual([]);
  });
});
