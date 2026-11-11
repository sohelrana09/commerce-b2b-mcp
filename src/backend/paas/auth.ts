import { ToolError } from "../../errors.js";
import { AuthExpiredError, graphql, type HttpOptions } from "./http.js";

/**
 * Supplies the company user's customer token. Never an admin token.
 *
 * - `static`: a token issued to the user elsewhere (preferred: no password on disk).
 * - `password`: exchanges email + password with generateCustomerToken, and
 *   fetches a fresh token when the store reports the old one expired.
 */
export type CustomerAuth =
  | { kind: "static"; token: string; /** Shown when the token stops working. */ expiredHint?: string }
  | { kind: "password"; email: string; password: string };

const LOGIN = "mutation Login($email: String!, $password: String!) { generateCustomerToken(email: $email, password: $password) { token } }";

/** Exchange a company user's email and password for a customer token. Throws FORBIDDEN on bad credentials. */
export async function generateCustomerToken(http: HttpOptions, email: string, password: string): Promise<string> {
  try {
    const data = await graphql<{ generateCustomerToken: { token: string } }>(http, LOGIN, { email, password }, null);
    return data.generateCustomerToken.token;
  } catch (err) {
    if (err instanceof ToolError && err.code !== "INVALID_INPUT" && err.code !== "FORBIDDEN") throw err;
    throw new ToolError("FORBIDDEN", "The store rejected the company user's credentials.");
  }
}

/**
 * Revoke a customer token at the store. A token the store already rejects (expired or revoked) counts as done.
 * Any other failure (store down, timeout) throws, so the caller can retry and report it.
 */
export async function revokeCustomerToken(http: HttpOptions, token: string): Promise<void> {
  try {
    await graphql(http, "mutation { revokeCustomerToken { result } }", {}, token);
  } catch (err) {
    if (err instanceof AuthExpiredError) return;
    throw err;
  }
}

export class CustomerTokenProvider {
  private token: string | null;

  constructor(
    private readonly http: HttpOptions,
    private readonly auth: CustomerAuth,
  ) {
    this.token = auth.kind === "static" ? auth.token : null;
  }

  private async login(): Promise<string> {
    if (this.auth.kind !== "password") {
      throw new ToolError(
        "FORBIDDEN",
        "The customer token has expired or was revoked.",
        this.auth.expiredHint ?? "Issue a new customer token and update COMMERCE_CUSTOMER_TOKEN.",
      );
    }
    return generateCustomerToken(this.http, this.auth.email, this.auth.password);
  }

  /** Run `fn` with a valid token, re-authenticating once if the token expired. */
  async withToken<T>(fn: (token: string) => Promise<T>): Promise<T> {
    if (!this.token) this.token = await this.login();
    try {
      return await fn(this.token);
    } catch (err) {
      if (!(err instanceof AuthExpiredError)) throw err;
      this.token = null;
      this.token = await this.login();
      try {
        return await fn(this.token);
      } catch (retryErr) {
        if (retryErr instanceof AuthExpiredError) {
          throw new ToolError("FORBIDDEN", "The store rejected the company user's session.");
        }
        throw retryErr;
      }
    }
  }
}
