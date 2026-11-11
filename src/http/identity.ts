import { timingSafeEqual, createHash } from "node:crypto";
import { generateCustomerToken, revokeCustomerToken } from "../backend/paas/auth.js";
import { PaasBackend, paasHttp, type PaasOptions } from "../backend/paas/paas-backend.js";
import { USERS } from "../backend/mock/fixtures.js";
import type { IdentityProvider, SignedInUser } from "./oauth.js";

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Demo only: fixture users share one password set by the operator. */
export function mockIdentity(password: string): IdentityProvider {
  const expected = digest(password);
  return {
    async signIn(email, given) {
      const user = USERS.find((u) => u.email.toLowerCase() === email.toLowerCase());
      if (!timingSafeEqual(digest(given), expected) || !user) throw new Error("rejected");
      return { email: user.email };
    },
    async signOut() {},
  };
}

/**
 * The store checks the password (generateCustomerToken), then we confirm the
 * token's owner is an active member of a B2B company before issuing anything.
 * The customer token never leaves the server.
 */
export function paasIdentity(opts: Omit<PaasOptions, "auth">): IdentityProvider {
  const http = paasHttp(opts);
  return {
    async signIn(email, password): Promise<SignedInUser> {
      const token = await generateCustomerToken(http, email, password);
      try {
        const ctx = await new PaasBackend({ ...opts, auth: { kind: "static", token } }).getCompanyContext({ email });
        return { email: ctx.user.email, customerToken: token };
      } catch (err) {
        await revokeCustomerToken(http, token).catch(() => undefined); // keep the original reason for refusing
        throw err;
      }
    },
    async signOut(user) {
      if (user.customerToken) await revokeCustomerToken(http, user.customerToken);
    },
  };
}
