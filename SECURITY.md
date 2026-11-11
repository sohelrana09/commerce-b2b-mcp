# Security policy

This server lets an AI agent act inside a B2B store, so security reports are especially welcome.

## Supported versions

Security fixes go into the latest release and `main`. Older releases don't get patches: update to the latest version.

## Reporting a vulnerability

Please **don't open a public issue** for a security problem.

Report it privately through GitHub instead: [Report a vulnerability](https://github.com/sohelrana09/commerce-b2b-mcp/security/advisories/new) (Security tab → Advisories → Report a vulnerability).

Include what you can of:

- what is affected (a tool, the OAuth flow, the sign-in page, the PaaS adapter, the quote assistant) and what an attacker could do with it;
- the steps to reproduce it, or a proof of concept;
- the version or commit you tested, and the transport (stdio or HTTP).

You'll get an answer within 7 days. Once a fix is released, the advisory is published and you're credited, unless you'd rather not be.

## Scope

In scope: the code in this repository. For example:

- **caller scoping:** reaching another company's prices, orders, quotes or lists, or acting as a different user than the one signed in;
- **confirmation tokens:** saving a quote without a matching preview, or reusing a token for a different input or caller;
- **the HTTP transport:** OAuth (client registration, PKCE, redirect URIs, revocation), session binding, the sign-in page and its lockout, Host checks;
- **prompt injection:** store content or an RFQ that makes the agent or the quote assistant call a tool, change a price or mark a wrong line ready;
- **secrets:** a token, password or key that reaches the client, the model, the audit log or the traces.

Out of scope:

- vulnerabilities in Adobe Commerce, the MCP SDK, MCP clients or the Anthropic API themselves: report those to the vendor;
- findings that need a leaked `.env`, an admin token or control of the server host;
- the mock backend's fixed demo users and password, which exist only for local demos;
- missing hardening headers or rate limits without a concrete attack.

Please test against the mock backend or your own store, never against a store you don't own.
