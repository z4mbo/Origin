import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { seal, sealingConfigured, SEALING_MISSING, unseal } from "./sealing";

// Vault values are sealed by the server with ORIGIN_SEALING_KEY, like other Origin secrets: anyone the permission
// rules let read an item (project members for project items, only the owner for personal items) can reveal it
// without a password. The purpose binds each value to its owner, so a sealed value copied into another project's
// or person's row does not open. Values are never logged and never returned by list queries.

type VaultRow = Doc<"credentials"> | Doc<"personalCredentials">;

/** Values are passwords, keys and notes; this bounds the row well below Convex's document limit. */
export const MAX_VAULT_VALUE = 64 * 1024;

export const LEGACY_VAULT_ITEM = "This item uses the old Vault password. Convert old items in the Vault once (enter the old Vault password); after that it opens without a password.";

export const projectVaultPurpose = (projectId: Id<"projects">) => `vault:project:${projectId}`;
export const personalVaultPurpose = (userId: Id<"users">) => `vault:personal:${userId}`;

/** A legacy item: its value is still encrypted with the old Vault password and needs a one-time conversion. */
export function needsConversion(item: VaultRow) {
  return item.format !== "sealed" || item.sealedValue === undefined;
}

/** The fields a sealed value replaces; patching them with these clears the legacy envelope. */
export async function sealedVaultValue(value: string, purpose: string) {
  if (!sealingConfigured()) throw new ConvexError(SEALING_MISSING);
  if (!value) throw new ConvexError("Enter a value");
  if (value.length > MAX_VAULT_VALUE) throw new ConvexError("This value is too long for the Vault");
  return {
    format: "sealed" as const,
    sealedValue: await seal(value, purpose),
    ciphertext: undefined, iv: undefined, salt: undefined, iterations: undefined, kdf: undefined,
  };
}

export async function openVaultValue(item: VaultRow, purpose: string): Promise<string> {
  if (needsConversion(item)) throw new ConvexError(LEGACY_VAULT_ITEM);
  if (!sealingConfigured()) throw new ConvexError(SEALING_MISSING);
  try {
    return await unseal(item.sealedValue!, purpose);
  } catch {
    throw new ConvexError("This Vault item could not be opened. It may have been sealed with a different ORIGIN_SEALING_KEY.");
  }
}

/** What list queries return: everything but the value, sealed or legacy. */
export function vaultListItem<T extends VaultRow>(item: T) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { sealedValue, ciphertext, iv, salt, iterations, kdf, format, ...summary } = item;
  return { ...summary, needsConversion: needsConversion(item) };
}

/** What the one-time conversion needs for a legacy item: its password-encrypted envelope (useless without the password). */
export function legacyEnvelope<T extends VaultRow>(item: T): { id: T["_id"]; title: string; ciphertext: string; iv: string; salt: string; iterations: number; kdf: string } | null {
  if (!needsConversion(item) || !item.ciphertext || !item.iv || !item.salt || !item.iterations || !item.kdf) return null;
  return { id: item._id as T["_id"], title: item.title, ciphertext: item.ciphertext, iv: item.iv, salt: item.salt, iterations: item.iterations, kdf: item.kdf };
}
