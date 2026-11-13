# Security

Origin is early-stage software, not an independently audited security product. Avoid storing regulated or highly sensitive data until you have reviewed your deployment and threat model.

Do not disclose vulnerabilities, credentials, personal information, or private workspace content in public issues. Use the repository's **Security > Report a vulnerability** private-reporting feature when available. If it is unavailable, open a minimal issue asking for a private reporting channel without technical exploit details or private data.

Include the affected version, prerequisites, impact, and a minimal synthetic reproduction in a private report. Do not test another person's workspace, access data without permission, or run disruptive scans against the hosted service.

## Operator Responsibilities

- Use HTTPS, unique secrets, a protected persistent volume, and a trusted reverse proxy.
- Keep Convex deployment credentials and integration secrets out of client bundles and Git history.
- Review GitHub permissions and revoke stale workspace connections and MCP grants.
- Restrict server and TURN access; never expose the local data directory or database files.
- Apply dependency and host updates and verify authorization after changes.

Built-in accounts use salted password derivation and revocable sessions. This release does not provide email verification, self-service account recovery, enterprise SSO, or a compliance guarantee. Workspace access checks do not make the service end-to-end encrypted. Vault entries are not end-to-end encrypted: like GitHub credentials and webhook secrets, their values are sealed by the server with `ORIGIN_SEALING_KEY` (AES-256-GCM, bound to the owning project or person), and anyone with access to the project can reveal its Vault items; personal Vault items are readable only by their owner. Whoever controls the deployment and its sealing key can read them.
