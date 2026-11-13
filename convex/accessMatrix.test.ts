/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { createSession } from "./lib/auth";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const paginationOpts = { numItems: 20, cursor: null };
const SEALING_KEY = btoa(String.fromCharCode(...new Array(32).fill(7)));

beforeEach(() => { vi.stubEnv("ORIGIN_SEALING_KEY", SEALING_KEY); });
afterEach(() => { vi.unstubAllEnvs(); });

async function fixture() {
  const t = convexTest(schema, modules);
  const people = await t.run(async ctx => {
    const users = [];
    for (const name of ["owner", "member", "viewer", "outsider"]) {
      const id = await ctx.db.insert("users", { name, email: `${name}@matrix.test`, role: "user", status: "active", passwordHash: "unused", salt: "unused", iterations: 1, createdAt: 1, updatedAt: 1 });
      users.push({ id, email: `${name}@matrix.test`, token: await createSession(ctx, id) });
    }
    return { owner: users[0]!, member: users[1]!, viewer: users[2]!, outsider: users[3]! };
  });
  const sessionToken = people.owner.token;
  const { teamId } = await t.mutation(api.workspaces.create, { sessionToken, name: "Matrix" });
  for (const [person, role] of [[people.member, "member"], [people.viewer, "viewer"]] as const) {
    await t.run(ctx => ctx.db.insert("teamMembers", { teamId, userId: person.id, email: person.email, name: role, role, status: "active", createdAt: 1, updatedAt: 1 }));
  }
  const sharedId = await t.mutation(api.projects.create, { sessionToken, teamId, name: "Shared" });
  const privateId = await t.mutation(api.projects.create, { sessionToken, teamId, name: "Private" });
  for (const person of [people.member, people.viewer]) await t.mutation(api.members.addWorkspaceMember, { sessionToken, projectId: sharedId, email: person.email, role: "member" });
  const records = [];
  for (const projectId of [sharedId, privateId]) {
    const scope = { sessionToken, projectId };
    const columnId = (await t.query(api.tasks.board, scope)).columns[1]!._id;
    const taskId = await t.mutation(api.tasks.createTask, { ...scope, columnId, title: "Sensitive issue", priority: "medium", assignedToEmail: people.owner.email, dueDate: "2026-12-31" });
    const credentialId = await t.mutation(api.credentials.create, { ...scope, title: "Vault entry", secret: "Confidential secret" });
    const pageId = await t.mutation(api.wiki.create, { ...scope, title: "Sensitive document", content: "Confidential", type: "wiki", tags: [] });
    await t.mutation(api.design.createToken, { ...scope, type: "color", name: "Accent", value: "#123456" });
    await t.mutation(api.design.createAsset, { ...scope, type: "image", name: "Asset", url: "https://example.test/image.png" });
    const design = await t.query(api.design.list, scope);
    await t.mutation(api.feedback.configure, { ...scope, teamId, title: "Feedback", description: "", enabled: true });
    const portal = (await t.query(api.feedback.portals, { sessionToken, teamId })).find(item => item.projectId === projectId)!;
    await t.mutation(internal.feedback.submit, { slug: portal.slug, title: "Bug", body: "Private report", kind: "bug" });
    const entryId = (await t.query(api.feedback.list, { sessionToken, teamId, portalId: portal._id }))[0]!._id;
    records.push({ projectId, columnId, taskId, credentialId, pageId, tokenId: design.tokens[0]!._id, assetId: design.assets[0]!._id, portalId: portal._id, entryId });
  }
  return { t, ...people, teamId, shared: records[0]!, private: records[1]! };
}

describe("backend resource access matrix", () => {
  test.each(["outsider", "member", "invalid"] as const)("%s cannot read a private project's feature namespaces", async actor => {
    const f = await fixture();
    const sessionToken = actor === "invalid" ? "invalid-token" : f[actor].token;
    const scope = { sessionToken, projectId: f.private.projectId };
    const calls: Array<[string, () => Promise<unknown>]> = [
      ["projects.get", () => f.t.query(api.projects.get, scope)],
      ["projects.stats", () => f.t.query(api.projects.stats, scope)],
      ["projects.listChatMessages", () => f.t.query(api.projects.listChatMessages, scope)],
      ["projects.listCallParticipants", () => f.t.query(api.projects.listCallParticipants, scope)],
      ["projects.listCallSignals", () => f.t.query(api.projects.listCallSignals, scope)],
      ["members.list", () => f.t.query(api.members.list, scope)],
      ["members.people", () => f.t.query(api.members.people, scope)],
      ["tasks.board", () => f.t.query(api.tasks.board, scope)],
      ["tasks.details", () => f.t.query(api.tasks.details, { ...scope, taskId: f.private.taskId })],
      ["credentials.list", () => f.t.query(api.credentials.list, scope)],
      ["design.list", () => f.t.query(api.design.list, scope)],
      ["wiki.list", () => f.t.query(api.wiki.list, scope)],
      ["documents.get", () => f.t.query(api.documents.get, { sessionToken, pageId: f.private.pageId })],
      ["documents.list", () => f.t.query(api.documents.list, { ...scope, teamId: f.teamId })],
      ["feedback.list", () => f.t.query(api.feedback.list, { sessionToken, teamId: f.teamId, portalId: f.private.portalId })],
      ["commits.list", () => f.t.query(api.commits.list, scope)],
      ["github.listPullRequests", () => f.t.query(api.github.listPullRequests, scope)],
      ["taskPRs.list", () => f.t.query(api.taskPRs.list, { sessionToken, taskId: f.private.taskId })],
      ["issueRelations.list", () => f.t.query(api.issueRelations.list, { sessionToken, taskId: f.private.taskId })],
      ["draw.canvases", () => f.t.query(api.draw.canvases, scope)],
      ["workspaceSearch.issues", () => f.t.query(api.workspaceSearch.issues, { ...scope, teamId: f.teamId, text: "Sensitive" })],
      ["inbox.list", () => f.t.query(api.inbox.list, { ...scope, teamId: f.teamId, done: false, mine: false, paginationOpts })],
    ];
    for (const [name, call] of calls) await expect(call(), name).rejects.toThrow();
  });

  test("an authorized project ID cannot authorize rows from a different project", async () => {
    const f = await fixture();
    const scope = { sessionToken: f.member.token, projectId: f.shared.projectId };
    const before = await f.t.query(api.tasks.details, { sessionToken: f.owner.token, projectId: f.private.projectId, taskId: f.private.taskId });
    const calls: Array<[string, () => Promise<unknown>]> = [
      ["tasks.details", () => f.t.query(api.tasks.details, { ...scope, taskId: f.private.taskId })],
      ["tasks.updateTask", () => f.t.mutation(api.tasks.updateTask, { ...scope, taskId: f.private.taskId, title: "Hijacked" })],
      ["tasks.moveTask", () => f.t.mutation(api.tasks.moveTask, { ...scope, taskId: f.shared.taskId, columnId: f.private.columnId })],
      ["tasks.addComment", () => f.t.mutation(api.tasks.addComment, { ...scope, taskId: f.private.taskId, body: "Hijacked" })],
      ["tasks.deleteTask", () => f.t.mutation(api.tasks.deleteTask, { ...scope, taskId: f.private.taskId })],
      ["credentials.update", () => f.t.mutation(api.credentials.update, { ...scope, credentialId: f.private.credentialId, secret: "Hijacked" })],
      ["credentials.remove", () => f.t.mutation(api.credentials.remove, { ...scope, credentialId: f.private.credentialId })],
      ["design.updateToken", () => f.t.mutation(api.design.updateToken, { ...scope, tokenId: f.private.tokenId, value: "Hijacked" })],
      ["design.removeToken", () => f.t.mutation(api.design.removeToken, { ...scope, tokenId: f.private.tokenId })],
      ["design.updateAsset", () => f.t.mutation(api.design.updateAsset, { ...scope, assetId: f.private.assetId, name: "Hijacked" })],
      ["design.removeAsset", () => f.t.mutation(api.design.removeAsset, { ...scope, assetId: f.private.assetId })],
      ["wiki.update", () => f.t.mutation(api.wiki.update, { ...scope, pageId: f.private.pageId, content: "Hijacked" })],
      ["wiki.remove", () => f.t.mutation(api.wiki.remove, { ...scope, pageId: f.private.pageId })],
      ["documents.rename", () => f.t.mutation(api.documents.rename, { sessionToken: f.member.token, pageId: f.private.pageId, title: "Hijacked" })],
      ["feedback.dismiss", () => f.t.mutation(api.feedback.dismiss, { sessionToken: f.member.token, teamId: f.teamId, entryId: f.private.entryId, dismissed: true })],
      ["feedback.convert", () => f.t.mutation(api.feedback.convert, { sessionToken: f.member.token, teamId: f.teamId, entryId: f.private.entryId, columnId: f.shared.columnId, assignedToEmail: f.member.email, dueDate: "2026-12-31" })],
      ["planning.assignMilestone", () => f.t.mutation(api.planning.assignMilestone, { sessionToken: f.member.token, teamId: f.teamId, taskId: f.private.taskId, milestoneId: null })],
      ["issueRelations.labels", () => f.t.mutation(api.issueRelations.labels, { sessionToken: f.member.token, taskId: f.private.taskId, labels: ["Hijacked"] })],
      ["issueRelations.connect", () => f.t.mutation(api.issueRelations.connect, { sessionToken: f.member.token, fromTaskId: f.shared.taskId, toTaskId: f.private.taskId, kind: "blocks" })],
    ];
    for (const [name, call] of calls) await expect(call(), name).rejects.toThrow();
    expect(await f.t.query(api.tasks.details, { sessionToken: f.owner.token, projectId: f.private.projectId, taskId: f.private.taskId })).toEqual(before);
    expect(await f.t.mutation(api.credentials.reveal, { sessionToken: f.owner.token, projectId: f.private.projectId, credentialId: f.private.credentialId })).toBe("Confidential secret");
    expect((await f.t.query(api.wiki.list, { sessionToken: f.owner.token, projectId: f.private.projectId }))[0]?.content).toBe("Confidential");
  });

  test("workspace viewers cannot write through their stronger project membership", async () => {
    const f = await fixture();
    const sessionToken = f.viewer.token;
    const scope = { sessionToken, projectId: f.shared.projectId };
    expect((await f.t.query(api.projects.get, scope)).memberRole).toBe("viewer");
    const calls: Array<[string, () => Promise<unknown>]> = [
      ["tasks.updateTask", () => f.t.mutation(api.tasks.updateTask, { ...scope, taskId: f.shared.taskId, title: "Hijacked" })],
      ["credentials.update", () => f.t.mutation(api.credentials.update, { ...scope, credentialId: f.shared.credentialId, secret: "Hijacked" })],
      ["design.updateToken", () => f.t.mutation(api.design.updateToken, { ...scope, tokenId: f.shared.tokenId, value: "Hijacked" })],
      ["wiki.update", () => f.t.mutation(api.wiki.update, { ...scope, pageId: f.shared.pageId, content: "Hijacked" })],
      ["documents.rename", () => f.t.mutation(api.documents.rename, { sessionToken, pageId: f.shared.pageId, title: "Hijacked" })],
      ["feedback.dismiss", () => f.t.mutation(api.feedback.dismiss, { sessionToken, teamId: f.teamId, entryId: f.shared.entryId, dismissed: true })],
      ["planning.assignMilestone", () => f.t.mutation(api.planning.assignMilestone, { sessionToken, teamId: f.teamId, taskId: f.shared.taskId, milestoneId: null })],
      ["issueRelations.labels", () => f.t.mutation(api.issueRelations.labels, { sessionToken, taskId: f.shared.taskId, labels: ["Hijacked"] })],
      ["connectors.createGrant", () => f.t.mutation(api.connectors.createGrant, { sessionToken, teamId: f.teamId, name: "Escalation", write: true })],
    ];
    for (const [name, call] of calls) await expect(call(), name).rejects.toThrow();
  });

  test("outsiders cannot enumerate workspace namespaces or revoke another member's connector", async () => {
    const f = await fixture();
    const sessionToken = f.outsider.token;
    const scope = { sessionToken, teamId: f.teamId };
    const grant = await f.t.mutation(api.connectors.createGrant, { sessionToken: f.member.token, teamId: f.teamId, name: "Member connector", write: true });
    const calls: Array<[string, () => Promise<unknown>]> = [
      ["workspaces.access", () => f.t.query(api.workspaces.access, scope)],
      ["workspaces.members", () => f.t.query(api.workspaces.members, scope)],
      ["teams.members", () => f.t.query(api.teams.members, scope)],
      ["integrations.status", () => f.t.query(api.integrations.status, scope)],
      ["preferences.notifications", () => f.t.query(api.preferences.notifications, scope)],
      ["memberProfiles.get", () => f.t.query(api.memberProfiles.get, { ...scope, email: f.member.email })],
      ["projectPresence.list", () => f.t.query(api.projectPresence.list, { ...scope, activeSince: 0 })],
      ["notifications.list", () => f.t.query(api.notifications.list, { ...scope, unreadOnly: false, paginationOpts })],
      ["planning.milestones", () => f.t.query(api.planning.milestones, { ...scope, paginationOpts })],
      ["planning.releases", () => f.t.query(api.planning.releases, { ...scope, paginationOpts })],
      ["feedback.portals", () => f.t.query(api.feedback.portals, scope)],
      ["connectors.listGrants", () => f.t.query(api.connectors.listGrants, scope)],
      ["connectors.revoke", () => f.t.mutation(api.connectors.revoke, { sessionToken: f.viewer.token, teamId: f.teamId, grantId: grant.grantId })],
    ];
    for (const [name, call] of calls) await expect(call(), name).rejects.toThrow();
    expect(await f.t.query(api.connectors.verify, { token: grant.token })).toMatchObject({ write: true, teamId: f.teamId });
  });
});
