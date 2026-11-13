/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { createSession } from "./lib/auth";
import type { Id } from "./_generated/dataModel";
import { signIssueWebhook, type ProjectWebhookPayload } from "../lib/issue-webhook";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const SEALING_KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, index) => index + 5)));
const GLOBAL_SECRET = "p".repeat(40);

// Fake timers keep queued deliveries pending (convex-test would otherwise run them at once) so tests can read them.
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("ORIGIN_SEALING_KEY", SEALING_KEY);
  vi.stubEnv("ORIGIN_PUBLIC_URL", "https://origin.test");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const useGlobalWebhook = () => { vi.stubEnv("ORIGIN_ISSUE_WEBHOOK_URL", "https://hooks.test/global"); vi.stubEnv("ORIGIN_ISSUE_WEBHOOK_SECRET", GLOBAL_SECRET); };

type Delivery = { teamId: Id<"teams">; event: "issue.created" | "issue.updated" | "issue.delegated" | "project.created" | "project.deleted"; deliveryId: string; body: string; attempt?: number };

async function fixture() {
  const t = convexTest(schema, modules);
  const owner = await t.run(async ctx => {
    const userId = await ctx.db.insert("users", { name: "Ada Owner", email: "ada@projecthooks.test", role: "user", status: "active", passwordHash: "unused", salt: "unused", iterations: 1, createdAt: 1, updatedAt: 1 });
    return { userId, session: await createSession(ctx, userId) };
  });
  const { teamId } = await t.mutation(api.workspaces.create, { sessionToken: owner.session, name: "Project Hooks" });
  const deliveries = async () => (await t.run(ctx => ctx.db.system.query("_scheduled_functions").collect()))
    .filter(job => job.name.includes("issueWebhooks") && job.state.kind === "pending")
    .map(job => job.args[0] as Delivery);
  const projectEvents = async () => (await deliveries()).filter(job => job.event.startsWith("project."));
  const create = (name: string, description?: string) => t.mutation(api.projects.create, { sessionToken: owner.session, teamId, name, description, githubRepo: "later" });
  return { t, owner, teamId, deliveries, projectEvents, create };
}

describe("project lifecycle webhooks", () => {
  test("nothing is queued when neither the workspace nor the deployment has a webhook", async () => {
    const f = await fixture();
    const projectId = await f.create("Quiet");
    await f.t.mutation(api.projects.deleteProject, { sessionToken: f.owner.session, projectId, confirmName: "Quiet" });
    expect(await f.deliveries()).toEqual([]);
  });

  test("project.created carries the documented payload with its actor", async () => {
    useGlobalWebhook();
    const f = await fixture();
    const projectId = await f.create("Web", "Marketing site");
    const [job] = await f.projectEvents();
    expect(job).toMatchObject({ teamId: f.teamId, event: "project.created" });
    const payload = JSON.parse(job!.body) as ProjectWebhookPayload;
    expect(job!.deliveryId).toBe(payload.id);
    expect(job!.body).toBe(JSON.stringify(payload));
    const [team, project] = await f.t.run(async ctx => [await ctx.db.get(f.teamId), await ctx.db.get(projectId)] as const);
    expect(payload).toEqual({
      id: expect.stringMatching(/^evt_/), type: "project.created", occurredAt: expect.any(String),
      workspace: { id: f.teamId, name: "Project Hooks", slug: team!.slug },
      project: { id: projectId, name: "Web", description: "Marketing site", repo: null, repoUrl: null, url: `https://origin.test/${team!.slug}?project=${projectId}`, createdAt: new Date(project!.createdAt).toISOString() },
      actor: { name: "Ada Owner", email: "ada@projecthooks.test" },
    });
  });

  test("project.created is sent by every creation path: the app, connectors, and imports into a workspace", async () => {
    useGlobalWebhook();
    const f = await fixture();
    const grant = await f.t.mutation(api.connectors.createGrant, { sessionToken: f.owner.session, teamId: f.teamId, name: "Router", write: true });
    await f.t.mutation(api.connectors.write, { token: grant.token, requestId: "project-created-1", change: { kind: "create_project", name: "From connector" } });
    await f.create("From UI");
    const names = (await f.projectEvents()).map(job => (JSON.parse(job.body) as ProjectWebhookPayload).project.name);
    expect(names.sort()).toEqual(["From UI", "From connector"]);
    // importRepos makes projects outside any workspace; there is no workspace webhook for them, so it sends nothing.
    await f.t.mutation(api.projects.importRepos, { sessionToken: f.owner.session, repos: [{ name: "Imported", repoUrl: "https://github.com/acme/imported" }] });
    expect((await f.projectEvents()).length).toBe(2);
  });

  test("project.deleted is queued once, when deletion starts, with the deleter and the repository", async () => {
    useGlobalWebhook();
    const f = await fixture();
    const projectId = await f.create("Doomed");
    await f.t.run(ctx => ctx.db.patch(projectId, { repoUrl: "https://github.com/acme/doomed" }));
    await f.t.mutation(api.projects.deleteProject, { sessionToken: f.owner.session, projectId, confirmName: "Doomed" });
    await f.t.mutation(api.projects.deleteProject, { sessionToken: f.owner.session, projectId, confirmName: "Doomed" });
    const deleted = (await f.projectEvents()).filter(job => job.event === "project.deleted");
    expect(deleted).toHaveLength(1);
    expect(JSON.parse(deleted[0]!.body)).toMatchObject({
      type: "project.deleted",
      project: { id: projectId, name: "Doomed", repo: "acme/doomed", repoUrl: "https://github.com/acme/doomed" },
      actor: { name: "Ada Owner", email: "ada@projecthooks.test" },
    });
  });

  test("an OpenBot URL gets the { type, occurredAt, data } envelope and X-OpenBot signature", async () => {
    const f = await fixture();
    const secret = "o".repeat(36);
    await f.t.mutation(api.issueWebhooks.save, { sessionToken: f.owner.session, teamId: f.teamId, url: "https://signal.openbot.run/v1/webhooks/routine1", secret });
    await f.create("Agent home");
    const [job] = await f.projectEvents();
    const sent: Request[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => { sent.push(new Request(input, init)); return new Response("ok"); });
    await f.t.action(internal.issueWebhooks.deliver, job!);
    expect(sent).toHaveLength(1);
    const request = sent[0]!;
    expect(request.url).toBe("https://signal.openbot.run/v1/webhooks/routine1");
    const body = await request.text();
    const payload = JSON.parse(job!.body) as ProjectWebhookPayload;
    expect(JSON.parse(body)).toEqual({ type: "project.created", occurredAt: payload.occurredAt, data: payload });
    const timestamp = request.headers.get("x-openbot-timestamp")!;
    expect(request.headers.get("x-origin-event")).toBe("project.created");
    expect(request.headers.get("x-openbot-delivery-id")).toBe(job!.deliveryId);
    expect(request.headers.get("x-openbot-signature")).toBe(await signIssueWebhook(`${timestamp}.${job!.deliveryId}.${body}`, secret));
  });

  test("another URL gets the GitHub-style signed body, and failures retry like issue events", async () => {
    const f = await fixture();
    const secret = "h".repeat(36);
    await f.t.mutation(api.issueWebhooks.save, { sessionToken: f.owner.session, teamId: f.teamId, url: "https://hooks.test/team", secret });
    await f.create("Plain");
    const [job] = await f.projectEvents();
    const sent: Request[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => { sent.push(new Request(input, init)); return new Response("down", { status: 503 }); });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await f.t.action(internal.issueWebhooks.deliver, job!);
    const body = await sent[0]!.text();
    expect(body).toBe(job!.body);
    expect(sent[0]!.headers.get("x-origin-event")).toBe("project.created");
    expect(sent[0]!.headers.get("x-origin-signature")).toBe(await signIssueWebhook(body, secret));
    expect((await f.projectEvents()).find(retry => retry.deliveryId === job!.deliveryId && retry.attempt === 2)).toBeTruthy();
  });

  test("deleting the workspace sends no project.deleted for its projects", async () => {
    useGlobalWebhook();
    const f = await fixture();
    await f.create("One");
    await f.create("Two");
    const before = (await f.projectEvents()).length;
    await f.t.mutation(api.workspaces.remove, { sessionToken: f.owner.session, teamId: f.teamId, confirmName: "Project Hooks" });
    expect((await f.projectEvents()).length).toBe(before);
  });
});
