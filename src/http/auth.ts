import { createHash, timingSafeEqual } from 'node:crypto';
import type { Credential } from '../config.js';
import type { Caller } from '../mcp/context.js';

/**
 * Bearer-token check. Only SHA-256 digests of the configured tokens are held;
 * the presented token is hashed and compared in constant time against each.
 */
export class Authenticator {
  private readonly digests: Array<{ cred: Credential; digest: Buffer }>;
  private readonly failures = new Map<string, number[]>();

  constructor(
    credentials: readonly Credential[],
    private readonly limit = { attempts: 20, windowMs: 5 * 60_000 },
  ) {
    this.digests = credentials.map((cred) => ({ cred, digest: Buffer.from(cred.sha256, 'hex') }));
  }

  verify(authorization: string | undefined): Caller | null {
    if (!authorization) return null;
    const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
    if (!match) return null;
    const presented = createHash('sha256').update(match[1]!).digest();
    let found: Credential | null = null;
    for (const { cred, digest } of this.digests) {
      // Compare against every credential so timing does not reveal which one matched.
      if (timingSafeEqual(presented, digest)) found = cred;
    }
    return found ? { clientId: found.name, scopes: found.scopes, guilds: found.guilds } : null;
  }

  /** True when this address has failed too often recently and should be refused outright. */
  throttled(address: string): boolean {
    const now = Date.now();
    const recent = (this.failures.get(address) ?? []).filter((t) => now - t < this.limit.windowMs);
    if (recent.length === 0) this.failures.delete(address);
    else this.failures.set(address, recent);
    return recent.length >= this.limit.attempts;
  }

  recordFailure(address: string): void {
    const list = this.failures.get(address) ?? [];
    list.push(Date.now());
    this.failures.set(address, list.slice(-this.limit.attempts));
    if (this.failures.size > 10_000) this.failures.delete(this.failures.keys().next().value!);
  }
}
