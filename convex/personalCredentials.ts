import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireUser } from "./lib/auth";
import { credentialKindValidator } from "./lib/validators";
import { serviceOf } from "./lib/vaultService";
import { legacyEnvelope, openVaultValue, personalVaultPurpose, sealedVaultValue, vaultListItem } from "./lib/vaultSealing";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

// A person's own Vault. Only its owner lists, reveals, changes or converts an item; values are sealed by the server
// (convex/lib/vaultSealing.ts) under the owner's user id. List queries never carry a value.

async function ownItem(ctx: QueryCtx | MutationCtx, userId: Id<"users">, itemId: Id<"personalCredentials">) {
  const item = await ctx.db.get(itemId);
  if (!item || item.userId !== userId) throw new ConvexError("Credential not found");
  return item;
}

const ownRows = (ctx: QueryCtx | MutationCtx, userId: Id<"users">) =>
  ctx.db.query("personalCredentials").withIndex("by_userId", (q) => q.eq("userId", userId)).take(500);

export const list = query({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx, args.sessionToken);
    return (await ownRows(ctx, user._id)).sort((a, b) => b.updatedAt - a.updatedAt).map(vaultListItem);
  },
});

/** The plain value of one of the caller's items, for Reveal and Copy. */
export const reveal = mutation({
  args: { sessionToken: v.string(), itemId: v.id("personalCredentials") },
  returns: v.string(),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx, args.sessionToken);
    return await openVaultValue(await ownItem(ctx, user._id, args.itemId), personalVaultPurpose(user._id));
  },
});

export const create = mutation({
  args: {
    sessionToken: v.string(),
    kind: v.optional(credentialKindValidator),
    service: v.optional(v.string()),
    title: v.string(),
    username: v.optional(v.string()),
    url: v.optional(v.string()),
    secret: v.string(),
  },
  returns: v.id("personalCredentials"),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx, args.sessionToken);
    const title = args.title.trim();
    if (!title) throw new ConvexError("Enter a name");
    const kind = args.kind ?? "password";
    const now = Date.now();
    return await ctx.db.insert("personalCredentials", {
      userId: user._id,
      kind,
      service: serviceOf(kind, args.service),
      title,
      username: args.username?.trim() || undefined,
      url: args.url?.trim() || undefined,
      ...await sealedVaultValue(args.secret, personalVaultPurpose(user._id)),
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const update = mutation({
  args: {
    sessionToken: v.string(),
    itemId: v.id("personalCredentials"),
    kind: v.optional(credentialKindValidator),
    service: v.optional(v.string()),
    title: v.optional(v.string()),
    username: v.optional(v.string()),
    url: v.optional(v.string()),
    secret: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx, args.sessionToken);
    const item = await ownItem(ctx, user._id, args.itemId);
    const patch: Partial<Doc<"personalCredentials">> = { updatedAt: Date.now() };
    if (args.kind !== undefined || args.service !== undefined) {
      patch.kind = args.kind ?? item.kind;
      patch.service = serviceOf(patch.kind, args.service ?? item.service);
    }
    if (args.title !== undefined) {
      patch.title = args.title.trim();
      if (!patch.title) throw new ConvexError("Enter a name");
    }
    if (args.username !== undefined) patch.username = args.username.trim() || undefined;
    if (args.url !== undefined) patch.url = args.url.trim() || undefined;
    if (args.secret !== undefined) Object.assign(patch, await sealedVaultValue(args.secret, personalVaultPurpose(user._id)));
    await ctx.db.patch(args.itemId, patch);
    return null;
  },
});

export const remove = mutation({
  args: { sessionToken: v.string(), itemId: v.id("personalCredentials") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx, args.sessionToken);
    await ownItem(ctx, user._id, args.itemId);
    await ctx.db.delete(args.itemId);
    return null;
  },
});

/** Whether the owner's agents may read this item over MCP (vault_get). */
export const setAgentUse = mutation({
  args: { sessionToken: v.string(), itemId: v.id("personalCredentials"), agentUse: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx, args.sessionToken);
    await ownItem(ctx, user._id, args.itemId);
    await ctx.db.patch(args.itemId, { agentUse: args.agentUse || undefined, updatedAt: Date.now() });
    return null;
  },
});

/** The caller's legacy items with their password-encrypted values, which the browser opens with the old password. */
export const legacyItems = query({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx, args.sessionToken);
    return (await ownRows(ctx, user._id)).flatMap((row) => legacyEnvelope(row) ?? []);
  },
});

/** The one-time conversion of the caller's legacy items: decrypted in the browser, sealed here, legacy fields dropped. */
export const convertLegacy = mutation({
  args: { sessionToken: v.string(), items: v.array(v.object({ itemId: v.id("personalCredentials"), secret: v.string() })) },
  returns: v.number(),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx, args.sessionToken);
    if (args.items.length > 500) throw new ConvexError("Convert at most 500 items at a time");
    let converted = 0;
    for (const { itemId, secret } of args.items) {
      if (!legacyEnvelope(await ownItem(ctx, user._id, itemId))) continue;
      await ctx.db.patch(itemId, await sealedVaultValue(secret, personalVaultPurpose(user._id)));
      converted += 1;
    }
    return converted;
  },
});
