import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import type { AuthStatusPayload } from '../src/types/graph.ts';

// Ephemeral in-memory fallback signing key if SLABGRAPH_SESSION_SECRET is not set
const SESSION_SECRET =
  process.env.SLABGRAPH_SESSION_SECRET?.trim() ||
  crypto.randomBytes(32).toString('hex');

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function hashPasscode(passcode: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(passcode, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyScryptHash(passcode: string, stored: string): boolean {
  const parts = stored.split(':');
  if (parts.length !== 2) return false;
  const [salt, expectedHex] = parts;
  const derived = crypto.scryptSync(passcode, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

function safeEqualText(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function issueSessionToken(): { token: string; expiresAt: string } {
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ role: 'operator', exp })).toString(
    'base64url'
  );
  const sig = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(payload)
    .digest('base64url');
  return {
    token: `${payload}.${sig}`,
    expiresAt: new Date(exp).toISOString(),
  };
}

export function verifySessionToken(authHeader?: string): boolean {
  if (!authHeader) return false;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const token = match[1].trim();
  const dotIdx = token.indexOf('.');
  if (dotIdx <= 0) return false;

  const payload = token.slice(0, dotIdx);
  const sig = token.slice(dotIdx + 1);
  const expectedSig = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(payload)
    .digest('base64url');

  if (!safeEqualText(sig, expectedSig)) return false;

  try {
    const decoded = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf-8')
    ) as { exp?: number };
    return typeof decoded.exp === 'number' && decoded.exp > Date.now();
  } catch {
    return false;
  }
}

export function createOperatorAuthManager(
  getClaimedHash: () => string | null,
  saveClaimedHash: (hash: string) => void
) {
  function getEnvPasscode(): string | null {
    const v = process.env.SLABGRAPH_ADMIN_PASSCODE?.trim();
    return v && v.length > 0 ? v : null;
  }

  function isLockEnabled(): boolean {
    return Boolean(getEnvPasscode() || getClaimedHash());
  }

  function getStatus(authHeader?: string): AuthStatusPayload {
    const envSet = Boolean(getEnvPasscode());
    const claimed = Boolean(getClaimedHash());
    const locked = envSet || claimed;
    const authenticated = !locked || verifySessionToken(authHeader);
    return {
      locked,
      source: envSet ? 'env' : claimed ? 'claimed' : 'open',
      authenticated,
    };
  }

  function claimInitialPasscode(passcode: string): {
    token: string;
    expiresAt: string;
  } {
    if (isLockEnabled()) {
      throw new Error(
        'Operator passcode is already configured. Sign in with the existing passcode.'
      );
    }
    const clean = passcode.trim();
    if (clean.length < 8) {
      throw new Error('Operator passcode must be at least 8 characters.');
    }
    const hashed = hashPasscode(clean);
    saveClaimedHash(hashed);
    return issueSessionToken();
  }

  function login(passcode: string): { token: string; expiresAt: string } {
    const envPass = getEnvPasscode();
    if (envPass) {
      if (!safeEqualText(passcode, envPass)) {
        throw new Error('Invalid operator passcode.');
      }
      return issueSessionToken();
    }

    const claimedHash = getClaimedHash();
    if (!claimedHash) {
      return issueSessionToken();
    }

    if (!verifyScryptHash(passcode, claimedHash)) {
      throw new Error('Invalid operator passcode.');
    }
    return issueSessionToken();
  }

  function verifyBridgeToken(authHeader?: string): boolean {
    const configured = process.env.HERMES_BRIDGE_TOKEN?.trim();
    if (!configured || !authHeader) return false;
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) return false;
    return safeEqualText(match[1].trim(), configured);
  }

  function requireAuth(req: Request, res: Response, next: NextFunction): void {
    if (!isLockEnabled()) {
      next();
      return;
    }
    if (
      !verifySessionToken(req.headers.authorization) &&
      !verifyBridgeToken(req.headers.authorization)
    ) {
      res.status(401).json({
        error: 'Operator authentication required. Unlock the terminal with your server passcode or pass HERMES_BRIDGE_TOKEN.',
      });
      return;
    }
    next();
  }

  return {
    isLockEnabled,
    getStatus,
    claimInitialPasscode,
    login,
    requireAuth,
  };
}
