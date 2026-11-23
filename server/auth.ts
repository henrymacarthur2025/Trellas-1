import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { db } from './db.ts';

export const SESSION_COOKIE_NAME = 'trellas_session';

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, keyHex] = parts;
  const keyBuf = Buffer.from(keyHex, 'hex');
  const derived = crypto.scryptSync(password, salt, 64);
  if (keyBuf.length !== derived.length) return false;
  return crypto.timingSafeEqual(keyBuf, derived);
}

export function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function createSession(
  userId: string,
  rememberMe: boolean,
  userAgent: string,
  ipAddress: string,
): { token: string; sessionId: string; expiresAt: string } {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const sessionId = crypto.randomUUID();
  const now = new Date();
  const ttlMs = rememberMe ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

  db.prepare(`
    INSERT INTO sessions (id, user_id, token_hash, remember_me, user_agent, ip_address, expires_at, created_at, last_active_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    userId,
    tokenHash,
    rememberMe ? 1 : 0,
    userAgent.slice(0, 200),
    ipAddress.slice(0, 64),
    expiresAt,
    now.toISOString(),
    now.toISOString(),
  );

  return { token, sessionId, expiresAt };
}

export function setSessionCookie(res: Response, req: Request, token: string, rememberMe: boolean): void {
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const maxAgeSec = rememberMe ? 30 * 24 * 60 * 60 : 24 * 60 * 60;
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${maxAgeSec}`,
    'HttpOnly',
  ];
  if (isHttps) {
    parts.push('SameSite=None', 'Secure', 'Partitioned');
  } else {
    parts.push('SameSite=Lax');
  }
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(res: Response, req: Request): void {
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const parts = [`${SESSION_COOKIE_NAME}=`, 'Path=/', 'Max-Age=0', 'HttpOnly'];
  if (isHttps) {
    parts.push('SameSite=None', 'Secure', 'Partitioned');
  } else {
    parts.push('SameSite=Lax');
  }
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function parseCookieToken(req: Request): string | null {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  const items = cookieHeader.split(';');
  for (const item of items) {
    const idx = item.indexOf('=');
    if (idx === -1) continue;
    const key = item.slice(0, idx).trim();
    if (key === SESSION_COOKIE_NAME) {
      return decodeURIComponent(item.slice(idx + 1).trim());
    }
  }
  return null;
}

export interface AuthedRequest extends Request {
  userId?: string;
  sessionId?: string;
  workspaceRole?: string;
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  let token: string | null = null;
  let viaCookie = false;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  } else {
    token = parseCookieToken(req);
    viaCookie = Boolean(token);
  }

  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  if (viaCookie && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const xrw = req.headers['x-requested-with'];
    const origin = req.headers.origin;
    const host = (req.headers['x-forwarded-host'] as string) || req.headers.host;
    let originOk = false;
    if (origin && host) {
      try {
        originOk = new URL(origin).host === host;
      } catch {
        originOk = false;
      }
    }
    if (xrw !== 'XMLHttpRequest' && !originOk) {
      res.status(403).json({ error: 'Invalid request origin' });
      return;
    }
  }

  const tokenHash = hashToken(token);
  const session = db.prepare(`
    SELECT id, user_id, expires_at FROM sessions WHERE token_hash = ?
  `).get(tokenHash) as { id: string; user_id: string; expires_at: string } | undefined;

  if (!session || new Date(session.expires_at).getTime() < Date.now()) {
    if (session) {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
    }
    res.status(401).json({ error: 'Session expired or invalid' });
    return;
  }

  db.prepare('UPDATE sessions SET last_active_at = ? WHERE id = ?').run(new Date().toISOString(), session.id);
  req.userId = session.user_id;
  req.sessionId = session.id;
  next();
}

export function getWorkspaceRole(workspaceId: string, userId: string): string | null {
  const row = db.prepare(`
    SELECT wm.role FROM workspace_members wm
    JOIN workspaces w ON w.id = wm.workspace_id
    WHERE wm.workspace_id = ? AND wm.user_id = ? AND w.deleted_at IS NULL
  `).get(workspaceId, userId) as { role: string } | undefined;
  return row ? row.role : null;
}

export function canEditWorkspaceContent(role: string | null): boolean {
  return role === 'owner' || role === 'admin' || role === 'project_manager' || role === 'member';
}

export function canManageProjects(role: string | null): boolean {
  return role === 'owner' || role === 'admin' || role === 'project_manager';
}

export function canAdminWorkspace(role: string | null): boolean {
  return role === 'owner' || role === 'admin';
}
