import { describe, expect, test } from "vitest";
import {
  isOpenBotWebhookUrl, issueWebhookChanges, issueWebhookPayload, issueWebhookRequest, issueWebhookUrlError, openBotWebhookRequest, repositorySlug, sampleIssueWebhookPayload, signIssueWebhook,
  ORIGIN_WEBHOOK_EVENTS, PROJECT_WEBHOOK_DESCRIPTION_MAX, projectWebhookPayload, sampleWebhookPayload,
} from "./issue-webhook";

const input = {
  id: "evt_1",
  type: "issue.created" as const,
  occurredAt: Date.UTC(2026, 10, 11, 9),
  workspace: { id: "team1", name: "Acme", slug: "acme" },
  project: { id: "project1", name: "Web", repoUrl: "https://github.com/acme/web.git" },
  issue: { id: "task1", key: "ORI-AB12", title: "Import CSV", status: "Draft", completed: false },
};

describe("issue webhook payload", () => {
  test("has the documented shape, key order and defaults", () => {
    const payload = issueWebhookPayload(input);
    expect(JSON.stringify(payload)).toBe(JSON.stringify({
      id: "evt_1", type: "issue.created", occurredAt: "2026-11-11T09:00:00.000Z",
      workspace: { id: "team1", name: "Acme", slug: "acme" },
      project: { id: "project1", name: "Web", repo: "acme/web" },
      issue: { id: "task1", key: "ORI-AB12", title: "Import CSV", description: "", labels: [], url: "/acme/issue/ORI-AB12", status: "Draft", completed: false, assignee: null, acceptanceCriteria: [] },
      changes: null,
    }));
  });

  test("absolutizes the issue url with the public origin and fills assignee, labels and criteria", () => {
    const payload = issueWebhookPayload({
      ...input, origin: "https://origin.example/", project: { id: "p", name: "No repo" },
      issue: { ...input.issue, description: "Body", labels: ["Needs spec"], assignee: { email: "a@b.c", name: "A" }, acceptanceCriteria: [{ text: "Works", checked: true }] },
    });
    expect(payload.issue).toMatchObject({ url: "https://origin.example/acme/issue/ORI-AB12", description: "Body", labels: ["Needs spec"], assignee: { email: "a@b.c", name: "A" }, acceptanceCriteria: [{ text: "Works", checked: true }] });
    expect(payload.project.repo).toBeNull();
    expect(issueWebhookPayload({ ...input, issue: { ...input.issue, assignee: { email: "x@y.z" } } }).issue.assignee).toEqual({ email: "x@y.z", name: "x@y.z" });
  });

  test("issue.created never carries changes; issue.updated carries only what changed", () => {
    expect(issueWebhookPayload({ ...input, changes: { completed: { from: false, to: true } } }).changes).toBeNull();
    expect(issueWebhookChanges({ status: "Draft", completed: false }, { status: "Todo", completed: false })).toEqual({ status: { from: "Draft", to: "Todo" } });
    expect(issueWebhookChanges({ status: "In review", completed: false }, { status: "Done", completed: true })).toEqual({ status: { from: "In review", to: "Done" }, completed: { from: false, to: true } });
    expect(issueWebhookChanges({ status: "Done", completed: true }, { status: "Done", completed: false })).toEqual({ completed: { from: true, to: false } });
    expect(issueWebhookChanges({ status: "Todo", completed: false }, { status: "Todo", completed: false })).toBeNull();
    const updated = issueWebhookPayload({ ...input, type: "issue.updated", changes: { status: { from: "Draft", to: "Todo" } } });
    expect(updated.changes).toEqual({ status: { from: "Draft", to: "Todo" } });
  });

  test("event ids are evt_ followed by random hex", () => {
    const { id } = issueWebhookPayload({ ...input, id: undefined });
    expect(id).toMatch(/^evt_[0-9a-f]{24}$/);
    expect(issueWebhookPayload({ ...input, id: undefined }).id).not.toBe(id);
  });

  test("reads owner/repo from GitHub URLs and shorthands only", () => {
    expect(repositorySlug("https://github.com/z4mbo/Origin")).toBe("z4mbo/Origin");
    expect(repositorySlug("github.com/z4mbo/Origin.git/")).toBe("z4mbo/Origin");
    expect(repositorySlug("z4mbo/Origin")).toBe("z4mbo/Origin");
    expect(repositorySlug("https://gitlab.com/a/b")).toBeNull();
    expect(repositorySlug(undefined)).toBeNull();
  });
});

describe("issue webhook signature", () => {
  test("is sha256= and the HMAC-SHA256 hex of the raw body", async () => {
    // RFC 4231-style known answer: HMAC-SHA256("key", "The quick brown fox jumps over the lazy dog").
    expect(await signIssueWebhook("The quick brown fox jumps over the lazy dog", "key")).toBe("sha256=f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");
  });

  test("a request signs exactly the body it sends, with the event and delivery headers", async () => {
    const payload = issueWebhookPayload(input);
    const secret = "s".repeat(32);
    const request = await issueWebhookRequest(payload, secret);
    expect(request.body).toBe(JSON.stringify(payload));
    expect(request.headers).toEqual({ "Content-Type": "application/json", "X-Origin-Event": "issue.created", "X-Origin-Delivery": "evt_1", "X-Origin-Signature": await signIssueWebhook(request.body, secret) });
    expect(request.headers["X-Origin-Signature"]).not.toBe(await signIssueWebhook(`${request.body} `, secret));
  });

  test("the test script's sample matches the payload shape", () => {
    const created = sampleIssueWebhookPayload("issue.created", "http://localhost:3000");
    expect(Object.keys(created)).toEqual(["id", "type", "occurredAt", "workspace", "project", "issue", "changes"]);
    expect(Object.keys(created.issue)).toEqual(["id", "key", "title", "description", "labels", "url", "status", "completed", "assignee", "acceptanceCriteria"]);
    expect(created).toMatchObject({ type: "issue.created", changes: null, issue: { url: "http://localhost:3000/sample/issue/ORI-AB12", labels: ["Needs spec"] } });
    expect(sampleIssueWebhookPayload("issue.updated").changes).toEqual({ status: { from: "Draft", to: "Todo" } });
  });

  test("webhook URLs are http(s) without credentials", () => {
    expect(issueWebhookUrlError("https://hooks.example/origin")).toBeNull();
    expect(issueWebhookUrlError("ftp://hooks.example")).toContain("http");
    expect(issueWebhookUrlError("https://user:pw@hooks.example")).toContain("credentials");
    expect(issueWebhookUrlError("nope")).toContain("URL");
  });
});

describe("OpenBot webhook delivery", () => {
  test("recognizes only OpenBot routine URLs", () => {
    expect(isOpenBotWebhookUrl("https://signal.openbot.run/v1/webhooks/abc")).toBe(true);
    expect(isOpenBotWebhookUrl("http://signal.openbot.run/v1/webhooks/abc")).toBe(false);
    expect(isOpenBotWebhookUrl("https://hooks.example/v1/webhooks/abc")).toBe(false);
    expect(isOpenBotWebhookUrl("nope")).toBe(false);
  });

  test("wraps the Origin payload as data and signs timestamp.delivery.body", async () => {
    const payload = issueWebhookPayload(input);
    const secret = "s".repeat(32);
    const now = Date.UTC(2026, 10, 12, 10);
    const request = await openBotWebhookRequest("issue.created", "evt_1", JSON.stringify(payload), secret, now);
    expect(JSON.parse(request.body)).toEqual({ type: "issue.created", occurredAt: payload.occurredAt, data: payload });
    const timestamp = String(now / 1000);
    expect(request.headers["X-OpenBot-Timestamp"]).toBe(timestamp);
    expect(request.headers["X-OpenBot-Delivery-Id"]).toBe("evt_1");
    expect(request.headers["X-OpenBot-Signature"]).toBe(await signIssueWebhook(`${timestamp}.evt_1.${request.body}`, secret));
  });
});

describe("project webhook payload", () => {
  const project = {
    id: "project_webhook_1", type: "project.created" as const, occurredAt: Date.UTC(2026, 10, 13, 9),
    workspace: { id: "team1", name: "Acme", slug: "acme" },
    project: { id: "project1", name: "Web", description: " Marketing site ", repoUrl: "https://github.com/acme/web.git", createdAt: Date.UTC(2026, 10, 1) },
    actor: { name: "Ada", email: "ada@acme.test" },
  };

  test("has the documented shape and key order, with an absolute project url", () => {
    const payload = projectWebhookPayload({ ...project, origin: "https://origin.example/" });
    expect(JSON.stringify(payload)).toBe(JSON.stringify({
      id: "project_webhook_1", type: "project.created", occurredAt: "2026-11-13T09:00:00.000Z",
      workspace: { id: "team1", name: "Acme", slug: "acme" },
      project: { id: "project1", name: "Web", description: " Marketing site ", repo: "acme/web", repoUrl: "https://github.com/acme/web.git", url: "https://origin.example/acme?project=project1", createdAt: "2026-11-01T00:00:00.000Z" },
      actor: { name: "Ada", email: "ada@acme.test" },
    }));
  });

  test("a project without a repository or known actor sends nulls; the url stays a path without an origin", () => {
    const payload = projectWebhookPayload({ ...project, type: "project.deleted", project: { ...project.project, repoUrl: undefined, description: undefined }, actor: null });
    expect(payload.project).toMatchObject({ description: "", repo: null, repoUrl: null, url: "/acme?project=project1" });
    expect(payload.actor).toBeNull();
    expect(payload.id).toBe("project_webhook_1");
    expect(projectWebhookPayload({ ...project, id: undefined }).id).toMatch(/^evt_[0-9a-f]{24}$/);
  });

  test("a huge description is cut so the body stays under 64 KB", () => {
    const payload = projectWebhookPayload({ ...project, project: { ...project.project, description: "x".repeat(200_000) } });
    expect(payload.project.description).toHaveLength(PROJECT_WEBHOOK_DESCRIPTION_MAX);
    expect(new TextEncoder().encode(JSON.stringify(payload)).length).toBeLessThan(64 * 1024);
  });

  test("OpenBot gets the project payload as data, signed like issue events", async () => {
    const payload = projectWebhookPayload(project);
    const secret = "s".repeat(32);
    const now = Date.UTC(2026, 10, 13, 10);
    const request = await openBotWebhookRequest("project.created", payload.id, JSON.stringify(payload), secret, now);
    expect(JSON.parse(request.body)).toEqual({ type: "project.created", occurredAt: payload.occurredAt, data: payload });
    expect(request.headers["X-Origin-Event"]).toBe("project.created");
    expect(request.headers["X-OpenBot-Signature"]).toBe(await signIssueWebhook(`${now / 1000}.${payload.id}.${request.body}`, secret));
  });

  test("the test script has a sample for every event", () => {
    for (const type of ORIGIN_WEBHOOK_EVENTS) expect(sampleWebhookPayload(type).type).toBe(type);
    expect(sampleWebhookPayload("project.deleted")).toMatchObject({ project: { repo: "z4mbo/Origin" }, actor: { email: "admin@example.com" } });
  });
});
