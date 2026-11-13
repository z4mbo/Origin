import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { canEdit, requireMember, touchProject } from "./lib/permissions";
import { credentialKindValidator } from "./lib/validators";
import { serviceOf } from "./lib/vaultService";
import { legacyEnvelope, openVaultValue, projectVaultPurpose, sealedVaultValue, vaultListItem } from "./lib/vaultSealing";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

// A project's Vault. Values are sealed by the server (convex/lib/vaultSealing.ts): every project member can list and
// reveal items, editors add, change, delete and convert them. List queries never carry a value.

async function requireEditor(ctx: QueryCtx | MutationCtx, projectId: Id<"projects">, sessionToken: string) {
  const access = await requireMember(ctx, projectId, sessionToken);
  if (!canEdit(access.member)) throw new ConvexError("You have view-only access");
  return access;
}

async function projectItem(ctx: QueryCtx | MutationCtx, projectId: Id<"projects">, credentialId: Id<"credentials">) {
  const item = await ctx.db.get(credentialId);
  if (!item || item.projectId !== projectId) throw new ConvexError("Credential not found");
  return item;
}

export const list = query({
  args: { projectId: v.id("projects"), sessionToken: v.string() },
  handler: async (ctx, args) => {
    await requireMember(ctx, args.projectId, args.sessionToken);
    const rows = await ctx.db
      .query("credentials")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    return rows.sort((a, b) => b.updatedAt - a.updatedAt).map(vaultListItem);
  },
});

/** The plain value of one item, for Reveal and Copy. A mutation, so the value is never cached in a subscription. */
export const reveal = mutation({
  args: { projectId: v.id("projects"), sessionToken: v.string(), credentialId: v.id("credentials") },
  returns: v.string(),
  handler: async (ctx, args) => {
    await requireMember(ctx, args.projectId, args.sessionToken);
    const item = await projectItem(ctx, args.projectId, args.credentialId);
    return await openVaultValue(item, projectVaultPurpose(args.projectId));
  },
});

export const create = mutation({
  args: {
    projectId: v.id("projects"),
    sessionToken: v.string(),
    kind: v.optional(credentialKindValidator),
    service: v.optional(v.string()),
    title: v.string(),
    username: v.optional(v.string()),
    url: v.optional(v.string()),
    notes: v.optional(v.string()),
    secret: v.string(),
  },
  returns: v.id("credentials"),
  handler: async (ctx, args) => {
    await requireEditor(ctx, args.projectId, args.sessionToken);
    const title = args.title.trim();
    if (!title) throw new ConvexError("Enter a name");
    const now = Date.now();
    const kind = args.kind ?? "password";
    const value = await sealedVaultValue(args.secret, projectVaultPurpose(args.projectId));
    const id = await ctx.db.insert("credentials", {
      projectId: args.projectId,
      kind,
      service: serviceOf(kind, args.service),
      title,
      username: args.username?.trim() || undefined,
      url: args.url?.trim() || undefined,
      notes: args.notes?.trim() || undefined,
      ...value,
      createdAt: now,
      updatedAt: now,
    });
    await touchProject(ctx, args.projectId);
    return id;
  },
});

export const update = mutation({
  args: {
    projectId: v.id("projects"),
    sessionToken: v.string(),
    credentialId: v.id("credentials"),
    kind: v.optional(credentialKindValidator),
    service: v.optional(v.string()),
    title: v.optional(v.string()),
    username: v.optional(v.string()),
    url: v.optional(v.string()),
    notes: v.optional(v.string()),
    /** A new value; it replaces a legacy item's password-encrypted value too. */
    secret: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireEditor(ctx, args.projectId, args.sessionToken);
    const item = await projectItem(ctx, args.projectId, args.credentialId);
    const patch: Partial<Doc<"credentials">> = { updatedAt: Date.now() };
    if (args.kind !== undefined || args.service !== undefined) {
      patch.kind = args.kind ?? item.kind;
      patch.service = serviceOf(patch.kind ?? "password", args.service ?? item.service);
    }
    if (args.title !== undefined) {
      patch.title = args.title.trim();
      if (!patch.title) throw new ConvexError("Enter a name");
    }
    if (args.username !== undefined) patch.username = args.username.trim() || undefined;
    if (args.url !== undefined) patch.url = args.url.trim() || undefined;
    if (args.notes !== undefined) patch.notes = args.notes.trim() || undefined;
    if (args.secret !== undefined) Object.assign(patch, await sealedVaultValue(args.secret, projectVaultPurpose(args.projectId)));
    await ctx.db.patch(args.credentialId, patch);
    await touchProject(ctx, args.projectId);
    return null;
  },
});

export const remove = mutation({
  args: { projectId: v.id("projects"), sessionToken: v.string(), credentialId: v.id("credentials") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireEditor(ctx, args.projectId, args.sessionToken);
    await projectItem(ctx, args.projectId, args.credentialId);
    await ctx.db.delete(args.credentialId);
    await touchProject(ctx, args.projectId);
    return null;
  },
});

/** Legacy items an editor can convert, with their password-encrypted values, which the browser opens with the old password. */
export const legacyItems = query({
  args: { projectId: v.id("projects"), sessionToken: v.string() },
  handler: async (ctx, args) => {
    const { member } = await requireMember(ctx, args.projectId, args.sessionToken);
    if (!canEdit(member)) return [];
    const rows = await ctx.db
      .query("credentials")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    return rows.flatMap((row) => legacyEnvelope(row) ?? []);
  },
});

/** The one-time conversion: values the browser decrypted with the old password are sealed by the server and the legacy fields dropped. */
export const convertLegacy = mutation({
  args: { projectId: v.id("projects"), sessionToken: v.string(), items: v.array(v.object({ credentialId: v.id("credentials"), secret: v.string() })) },
  returns: v.number(),
  handler: async (ctx, args) => {
    await requireEditor(ctx, args.projectId, args.sessionToken);
    if (args.items.length > 500) throw new ConvexError("Convert at most 500 items at a time");
    let converted = 0;
    for (const { credentialId, secret } of args.items) {
      const item = await projectItem(ctx, args.projectId, credentialId);
      if (!legacyEnvelope(item)) continue;
      await ctx.db.patch(credentialId, await sealedVaultValue(secret, projectVaultPurpose(args.projectId)));
      converted += 1;
    }
    if (converted) await touchProject(ctx, args.projectId);
    return converted;
  },
});

/** Whether the project's agents may read this item over MCP (vault_get). */
export const setAgentUse = mutation({
  args: { projectId: v.id("projects"), sessionToken: v.string(), credentialId: v.id("credentials"), agentUse: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireEditor(ctx, args.projectId, args.sessionToken);
    await projectItem(ctx, args.projectId, args.credentialId);
    await ctx.db.patch(args.credentialId, { agentUse: args.agentUse || undefined, updatedAt: Date.now() });
    return null;
  },
});
