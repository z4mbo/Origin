/** What convex/mcp.ts vaultItem returns for an item agents may use: its summary and its value, unsealed by the server. */
export type VaultItemValue = { kind: string; service: string | null; env: string[]; value: string } & Record<string, unknown>;

/**
 * Shapes a Vault item for vault_get. Values are sealed by the server, so no password is involved here; legacy items
 * still on the old Vault password are refused by Convex before they get here. Service sign-ins hold a JSON object of
 * environment variables and come back as `env` and `values`; every other kind comes back as `value`.
 */
export function openVaultItem(item: VaultItemValue) {
  const { value, ...summary } = item;
  if (item.kind === "service") {
    let env: Record<string, string> | null = null;
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.values(parsed).every(entry => typeof entry === "string")) env = parsed as Record<string, string>;
    } catch { /* Not a service object; returned as a plain value below. */ }
    if (env) return { ...summary, env: Object.keys(env), values: env };
  }
  return { ...summary, value };
}
