import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Guest credentials (spec §13): a private, server-generated identity. The token is the profile
 * id plus an HMAC signature; it doubles as the guest's recovery code, so the client stores it
 * locally and can export it. Tokens are never placed in room metadata or logs.
 */
const VERSION = "g1";

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function issueGuestToken(secret: string, profileId: string, issuedAt = Date.now()): string {
  const payload = `${VERSION}.${profileId}.${issuedAt.toString(36)}`;
  return `${payload}.${sign(secret, payload)}`;
}

export interface GuestIdentity {
  profileId: string;
  issuedAt: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function verifyGuestToken(secret: string, token: unknown): GuestIdentity | null {
  if (typeof token !== "string" || token.length > 200) return null;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  const [, profileId, issued, sig] = parts as [string, string, string, string];
  if (!UUID.test(profileId)) return null;
  const expected = Buffer.from(sign(secret, `${VERSION}.${profileId}.${issued}`));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const issuedAt = parseInt(issued, 36);
  if (!Number.isFinite(issuedAt)) return null;
  return { profileId, issuedAt };
}

export function bearer(header: string | undefined | null): string | null {
  if (!header || !header.startsWith("Bearer ")) return null;
  return header.slice(7).trim() || null;
}
