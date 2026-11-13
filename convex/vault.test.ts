/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { createSession } from "./lib/auth";
import { decryptSecret, encryptSecret } from "../lib/vaultCrypto";

// The Vault without a password: values are sealed by the server (convex/lib/vaultSealing.ts), readable by project
// members (project items) or only the owner (personal items); legacy password-encrypted items convert once.

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const SEALING_KEY = btoa(String.fromCharCode(...new Array(32).fill(11)));

beforeEach(() => { vi.stubEnv("ORIGIN_SEALING_KEY", SEALING_KEY); });
afterEach(() => { vi.unstubAllEnvs(); });

async function fixture() {
  const t = convexTest(schema, modules);
  const people = await t.run(async ctx => {
    const rows: Record<string, { id: Awaited<ReturnType<typeof ctx.db.insert<"users">>>; email: string; session: string }> = {};
    for (const name of ["owner", "editor", "viewer", "outsider"]) {
      const email = `${name}@vault.test`;
      const id = await ctx.db.insert("users", { name, email, role: "user", status: "active", passwordHash: "unused", salt: "unused", iterations: 1, createdAt: 1, updatedAt: 1 });
      rows[name] = { id, email, session: await createSession(ctx, id) };
    }
    return rows as Record<"owner" | "editor" | "viewer" | "outsider", (typeof rows)[string]>;
  });
  const { teamId } = await t.mutation(api.workspaces.create, { sessionToken: people.owner.session, name: "Vault" });
  await t.run(async ctx => {
    for (const name of ["editor", "viewer", "outsider"] as const) {
      await ctx.db.insert("teamMembers", { teamId, userId: people[name].id, email: people[name].email, name, role: "member", status: "active", createdAt: 1, updatedAt: 1 });
    }
  });
  const projectId = await t.mutation(api.projects.create, { sessionToken: people.owner.session, teamId, name: "App" });
  const otherProjectId = await t.mutation(api.projects.create, { sessionToken: people.owner.session, teamId, name: "Other" });
  await t.mutation(api.members.addWorkspaceMember, { sessionToken: people.owner.session, projectId, email: people.editor.email, role: "member" });
  await t.mutation(api.members.addWorkspaceMember, { sessionToken: people.owner.session, projectId, email: people.viewer.email, role: "viewer" });
  const as = (name: keyof typeof people) => ({ projectId, sessionToken: people[name].session });
  return { t, people, projectId, otherProjectId, as };
}

describe("project vault", () => {
  test("create, list, reveal, update and delete without any password; lists never carry the value", async () => {
    const f = await fixture();
    const id = await f.t.mutation(api.credentials.create, { ...f.as("editor"), kind: "password", title: " Admin ", username: "root", url: "https://admin.test", secret: "hunter2" });
    const [listed] = await f.t.query(api.credentials.list, f.as("viewer"));
    expect(listed).toMatchObject({ _id: id, title: "Admin", username: "root", url: "https://admin.test", needsConversion: false });
    expect(JSON.stringify(listed)).not.toMatch(/hunter2|sealedValue|ciphertext|format/);
    const stored = await f.t.run(ctx => ctx.db.get(id));
    expect(stored).toMatchObject({ format: "sealed", sealedValue: expect.any(String) });
    expect(stored!.sealedValue).not.toContain("hunter2");
    expect(stored).not.toHaveProperty("ciphertext");

    expect(await f.t.mutation(api.credentials.reveal, { ...f.as("viewer"), credentialId: id })).toBe("hunter2");
    await f.t.mutation(api.credentials.update, { ...f.as("editor"), credentialId: id, title: "Admin login" });
    expect(await f.t.mutation(api.credentials.reveal, { ...f.as("owner"), credentialId: id })).toBe("hunter2");
    await f.t.mutation(api.credentials.update, { ...f.as("editor"), credentialId: id, secret: "correct horse" });
    expect(await f.t.mutation(api.credentials.reveal, { ...f.as("editor"), credentialId: id })).toBe("correct horse");
    expect((await f.t.query(api.credentials.list, f.as("editor")))[0]?.title).toBe("Admin login");

    await f.t.mutation(api.credentials.remove, { ...f.as("editor"), credentialId: id });
    expect(await f.t.query(api.credentials.list, f.as("editor"))).toEqual([]);
  });

  test("non-members cannot list or reveal; viewers read but cannot write", async () => {
    const f = await fixture();
    const id = await f.t.mutation(api.credentials.create, { ...f.as("owner"), kind: "api_key", title: "Key", secret: "sk-1" });
    await expect(f.t.query(api.credentials.list, f.as("outsider"))).rejects.toThrow("You don't have access to this project");
    await expect(f.t.mutation(api.credentials.reveal, { ...f.as("outsider"), credentialId: id })).rejects.toThrow("You don't have access to this project");
    // A member of another project cannot reach this item through it.
    await expect(f.t.mutation(api.credentials.reveal, { projectId: f.otherProjectId, sessionToken: f.people.owner.session, credentialId: id })).rejects.toThrow("Credential not found");
    for (const call of [
      () => f.t.mutation(api.credentials.create, { ...f.as("viewer"), title: "Nope", secret: "x" }),
      () => f.t.mutation(api.credentials.update, { ...f.as("viewer"), credentialId: id, secret: "x" }),
      () => f.t.mutation(api.credentials.remove, { ...f.as("viewer"), credentialId: id }),
      () => f.t.mutation(api.credentials.convertLegacy, { ...f.as("viewer"), items: [] }),
    ]) await expect(call()).rejects.toThrow("You have view-only access");
    expect(await f.t.mutation(api.credentials.reveal, { ...f.as("viewer"), credentialId: id })).toBe("sk-1");
  });

  test("a sealed value is bound to its project: copied into another project's row it does not open", async () => {
    const f = await fixture();
    const id = await f.t.mutation(api.credentials.create, { ...f.as("owner"), title: "Key", secret: "sk-1" });
    const copy = await f.t.run(async ctx => {
      const row = (await ctx.db.get(id))!;
      return ctx.db.insert("credentials", { projectId: f.otherProjectId, title: "Copy", format: "sealed", sealedValue: row.sealedValue, createdAt: 1, updatedAt: 1 });
    });
    await expect(f.t.mutation(api.credentials.reveal, { projectId: f.otherProjectId, sessionToken: f.people.owner.session, credentialId: copy })).rejects.toThrow("could not be opened");
  });

  test("without ORIGIN_SEALING_KEY nothing is stored, in plaintext or otherwise", async () => {
    const f = await fixture();
    vi.stubEnv("ORIGIN_SEALING_KEY", "");
    await expect(f.t.mutation(api.credentials.create, { ...f.as("owner"), title: "Key", secret: "sk-1" })).rejects.toThrow("ORIGIN_SEALING_KEY");
    await expect(f.t.mutation(api.personalCredentials.create, { sessionToken: f.people.owner.session, title: "Key", secret: "sk-1" })).rejects.toThrow("ORIGIN_SEALING_KEY");
    expect(await f.t.run(ctx => ctx.db.query("credentials").collect())).toEqual([]);
    expect(await f.t.run(ctx => ctx.db.query("personalCredentials").collect())).toEqual([]);
  });
});

describe("legacy conversion", () => {
  test("legacy items are listed with a marker, cannot be revealed, and convert once with the old password", async () => {
    const f = await fixture();
    const password = "old vault password";
    const legacyId = await f.t.run(async ctx => ctx.db.insert("credentials", { projectId: f.projectId, kind: "password", title: "Old login", username: "ada", ...await encryptSecret("s3cret", password), createdAt: 1, updatedAt: 1 }));
    expect((await f.t.query(api.credentials.list, f.as("viewer")))[0]).toMatchObject({ title: "Old login", username: "ada", needsConversion: true });
    await expect(f.t.mutation(api.credentials.reveal, { ...f.as("editor"), credentialId: legacyId })).rejects.toThrow("old Vault password");

    // Only editors get the envelopes to convert; viewers see the marker only.
    expect(await f.t.query(api.credentials.legacyItems, f.as("viewer"))).toEqual([]);
    const envelopes = await f.t.query(api.credentials.legacyItems, f.as("editor"));
    expect(envelopes.map(item => item.id)).toEqual([legacyId]);
    // What the browser does with the old password (components/project-library.tsx VaultConversion).
    const items = await Promise.all(envelopes.map(async item => ({ credentialId: item.id, secret: await decryptSecret(item, password) })));
    expect(await f.t.mutation(api.credentials.convertLegacy, { ...f.as("editor"), items })).toBe(1);

    const converted = await f.t.run(ctx => ctx.db.get(legacyId));
    expect(converted).toMatchObject({ format: "sealed", sealedValue: expect.any(String), title: "Old login", username: "ada" });
    for (const field of ["ciphertext", "iv", "salt", "iterations", "kdf"]) expect(converted).not.toHaveProperty(field);
    expect((await f.t.query(api.credentials.list, f.as("viewer")))[0]?.needsConversion).toBe(false);
    expect(await f.t.mutation(api.credentials.reveal, { ...f.as("viewer"), credentialId: legacyId })).toBe("s3cret");
    expect(await f.t.query(api.credentials.legacyItems, f.as("editor"))).toEqual([]);
    // Converting again changes nothing: the item is no longer legacy.
    expect(await f.t.mutation(api.credentials.convertLegacy, { ...f.as("editor"), items: [{ credentialId: legacyId, secret: "other" }] })).toBe(0);
    expect(await f.t.mutation(api.credentials.reveal, { ...f.as("viewer"), credentialId: legacyId })).toBe("s3cret");
  });

  test("setting a new value on a legacy item also converts it", async () => {
    const f = await fixture();
    const legacyId = await f.t.run(async ctx => ctx.db.insert("credentials", { projectId: f.projectId, title: "Old", ...await encryptSecret("x", "pw-pw-pw-pw"), createdAt: 1, updatedAt: 1 }));
    await f.t.mutation(api.credentials.update, { ...f.as("editor"), credentialId: legacyId, secret: "fresh" });
    expect(await f.t.mutation(api.credentials.reveal, { ...f.as("viewer"), credentialId: legacyId })).toBe("fresh");
    expect(await f.t.run(ctx => ctx.db.get(legacyId))).not.toHaveProperty("ciphertext");
  });

  test("personal legacy items convert for their owner only", async () => {
    const f = await fixture();
    const own = await f.t.run(async ctx => ctx.db.insert("personalCredentials", { userId: f.people.editor.id, kind: "api_key", title: "My npm", ...await encryptSecret("npm_1", "pw-pw-pw-pw"), createdAt: 1, updatedAt: 1 }));
    expect(await f.t.query(api.personalCredentials.legacyItems, { sessionToken: f.people.viewer.session })).toEqual([]);
    await expect(f.t.mutation(api.personalCredentials.convertLegacy, { sessionToken: f.people.viewer.session, items: [{ itemId: own, secret: "forged" }] })).rejects.toThrow("Credential not found");
    const [envelope] = await f.t.query(api.personalCredentials.legacyItems, { sessionToken: f.people.editor.session });
    expect(await f.t.mutation(api.personalCredentials.convertLegacy, { sessionToken: f.people.editor.session, items: [{ itemId: envelope!.id, secret: await decryptSecret(envelope!, "pw-pw-pw-pw") }] })).toBe(1);
    expect(await f.t.mutation(api.personalCredentials.reveal, { sessionToken: f.people.editor.session, itemId: own })).toBe("npm_1");
  });
});

describe("personal vault", () => {
  test("only the owner lists, reveals, updates and deletes; no password involved", async () => {
    const f = await fixture();
    const mine = { sessionToken: f.people.editor.session };
    const theirs = { sessionToken: f.people.viewer.session };
    const id = await f.t.mutation(api.personalCredentials.create, { ...mine, kind: "api_key", title: "GitHub token", secret: "ghp_1" });
    const [listed] = await f.t.query(api.personalCredentials.list, mine);
    expect(listed).toMatchObject({ _id: id, title: "GitHub token", needsConversion: false });
    expect(JSON.stringify(listed)).not.toMatch(/ghp_1|sealedValue/);
    expect(await f.t.mutation(api.personalCredentials.reveal, { ...mine, itemId: id })).toBe("ghp_1");

    expect(await f.t.query(api.personalCredentials.list, theirs)).toEqual([]);
    for (const call of [
      () => f.t.mutation(api.personalCredentials.reveal, { ...theirs, itemId: id }),
      () => f.t.mutation(api.personalCredentials.update, { ...theirs, itemId: id, secret: "x" }),
      () => f.t.mutation(api.personalCredentials.remove, { ...theirs, itemId: id }),
      () => f.t.mutation(api.personalCredentials.setAgentUse, { ...theirs, itemId: id, agentUse: true }),
    ]) await expect(call()).rejects.toThrow("Credential not found");

    await f.t.mutation(api.personalCredentials.update, { ...mine, itemId: id, title: "GitHub", secret: "ghp_2" });
    expect(await f.t.mutation(api.personalCredentials.reveal, { ...mine, itemId: id })).toBe("ghp_2");
    expect((await f.t.query(api.personalCredentials.list, mine))[0]?.title).toBe("GitHub");
    await f.t.mutation(api.personalCredentials.remove, { ...mine, itemId: id });
    expect(await f.t.query(api.personalCredentials.list, mine)).toEqual([]);
  });

  test("a personal value is bound to its owner: moved to another person it does not open", async () => {
    const f = await fixture();
    const id = await f.t.mutation(api.personalCredentials.create, { sessionToken: f.people.editor.session, title: "Mine", secret: "s" });
    await f.t.run(ctx => ctx.db.patch(id, { userId: f.people.viewer.id }));
    await expect(f.t.mutation(api.personalCredentials.reveal, { sessionToken: f.people.viewer.session, itemId: id })).rejects.toThrow("could not be opened");
  });
});
