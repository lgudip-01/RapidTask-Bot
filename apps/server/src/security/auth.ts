import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';

/** scrypt with explicit cost parameters (promisified by hand to keep the options argument). */
function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  opts: { N: number; r: number; p: number },
) {
  return new Promise<Buffer>((resolve, reject) =>
    scryptCb(password, salt, keylen, { ...opts, maxmem: 128 * opts.N * opts.r * 2 }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

const PARAMS = { N: 2 ** 15, r: 8, p: 1 };
const KEYLEN = 32;

/** "scrypt$N$r$p$salt$hash" (base64url). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, PARAMS);
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = encoded.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const key = await scrypt(password, Buffer.from(salt, 'base64url'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');
const mac = (secret: string, data: string) =>
  createHmac('sha256', secret).update(data).digest('base64url');

/** Stateless session token: base64url(JSON{v,iat,exp}).HMAC. Rotating the secret logs everyone out. */
export function signSession(secret: string, ttlMs: number, now = Date.now()): string {
  const payload = b64(JSON.stringify({ v: 1, iat: now, exp: now + ttlMs }));
  return `${payload}.${mac(secret, payload)}`;
}

export function verifySession(
  secret: string,
  token: string | undefined,
  now = Date.now(),
): boolean {
  if (!token) return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  const expected = Buffer.from(mac(secret, payload));
  const got = Buffer.from(sig);
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return false;
  try {
    const { v, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      v: number;
      exp: number;
    };
    return v === 1 && typeof exp === 'number' && exp > now;
  } catch {
    return false;
  }
}

/** Verifies the `Cf-Access-Jwt-Assertion` header against the team's published keys. */
export function cloudflareAccessVerifier(teamDomain: string, audience: string) {
  const issuer = `https://${teamDomain}`;
  const jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  return async (token: string | undefined): Promise<boolean> => {
    if (!token) return false;
    try {
      await jwtVerify(token, jwks, { issuer, audience });
      return true;
    } catch {
      return false;
    }
  };
}
