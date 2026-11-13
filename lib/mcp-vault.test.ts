import { describe, expect, test } from "vitest";
import { openVaultItem } from "./mcp-vault";

const item = (kind: string, value: string) => ({ id: "c1", name: "Deploy", kind, service: kind === "service" ? "convex" : null, env: kind === "service" ? ["CONVEX_DEPLOY_KEY"] : [], value });

describe("vault_get", () => {
  test("returns the value with the summary, no password involved", () => {
    expect(openVaultItem(item("api_key", "sk-live-1"))).toEqual({ id: "c1", name: "Deploy", kind: "api_key", service: null, env: [], value: "sk-live-1" });
  });

  test("service sign-ins come back as environment variables", () => {
    const opened = openVaultItem(item("service", JSON.stringify({ CONVEX_DEPLOY_KEY: "prod:abc" })));
    expect(opened).toMatchObject({ kind: "service", env: ["CONVEX_DEPLOY_KEY"], values: { CONVEX_DEPLOY_KEY: "prod:abc" } });
    expect(opened).not.toHaveProperty("value");
  });

  test("a service item that is not a JSON object comes back as a plain value", () => {
    expect(openVaultItem(item("service", "not json"))).toMatchObject({ value: "not json" });
  });
});
