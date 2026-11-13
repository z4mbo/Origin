/**
 * Service sign-ins: a Vault item of kind "service" holds the tokens a service's command line reads from its
 * environment, sealed by the server as one JSON object of environment variable name to value. When the item is
 * marked usable by agents, agents read those variables over MCP (vault_get), so `vercel deploy` or `npx convex deploy` run signed in without the token ever being typed into chat.
 */

interface VaultServiceField {
  env: string;
  label: string;
  /** Identifiers such as an account id are not secrets and may be short. */
  secret: boolean;
  optional?: boolean;
  multiline?: boolean;
}

export interface VaultService {
  id: string;
  label: string;
  /** Where the person creates the token. */
  tokenUrl: string;
  fields: readonly VaultServiceField[];
}

const CUSTOM_SERVICE = "custom";

const VAULT_SERVICES: readonly VaultService[] = [
  { id: "convex", label: "Convex", tokenUrl: "https://dashboard.convex.dev", fields: [{ env: "CONVEX_DEPLOY_KEY", label: "Deploy key", secret: true }] },
  { id: "vercel", label: "Vercel", tokenUrl: "https://vercel.com/account/tokens", fields: [
    { env: "VERCEL_TOKEN", label: "Access token", secret: true },
    { env: "VERCEL_ORG_ID", label: "Team ID", secret: false, optional: true },
  ] },
  { id: "apple", label: "Apple App Store Connect", tokenUrl: "https://appstoreconnect.apple.com/access/integrations/api", fields: [
    { env: "APP_STORE_CONNECT_API_KEY_KEY_ID", label: "Key ID", secret: false },
    { env: "APP_STORE_CONNECT_API_KEY_ISSUER_ID", label: "Issuer ID", secret: false },
    { env: "APP_STORE_CONNECT_API_KEY_KEY", label: "Private key (.p8 contents)", secret: true, multiline: true },
  ] },
  { id: "netlify", label: "Netlify", tokenUrl: "https://app.netlify.com/user/applications#personal-access-tokens", fields: [{ env: "NETLIFY_AUTH_TOKEN", label: "Personal access token", secret: true }] },
  { id: "cloudflare", label: "Cloudflare", tokenUrl: "https://dash.cloudflare.com/profile/api-tokens", fields: [
    { env: "CLOUDFLARE_API_TOKEN", label: "API token", secret: true },
    { env: "CLOUDFLARE_ACCOUNT_ID", label: "Account ID", secret: false, optional: true },
  ] },
  { id: "supabase", label: "Supabase", tokenUrl: "https://supabase.com/dashboard/account/tokens", fields: [{ env: "SUPABASE_ACCESS_TOKEN", label: "Access token", secret: true }] },
  { id: "expo", label: "Expo", tokenUrl: "https://expo.dev/settings/access-tokens", fields: [{ env: "EXPO_TOKEN", label: "Access token", secret: true }] },
  { id: "npm", label: "npm", tokenUrl: "https://www.npmjs.com/settings/~/tokens", fields: [{ env: "NPM_TOKEN", label: "Access token", secret: true }] },
  { id: "fly", label: "Fly.io", tokenUrl: "https://fly.io/user/personal_access_tokens", fields: [{ env: "FLY_API_TOKEN", label: "Access token", secret: true }] },
  { id: CUSTOM_SERVICE, label: "Other service", tokenUrl: "", fields: [] },
];

export function vaultService(id: string | undefined): VaultService | undefined {
  return VAULT_SERVICES.find((service) => service.id === id);
}
