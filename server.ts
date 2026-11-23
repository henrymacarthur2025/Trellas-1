import crypto from 'crypto';
import dotenv from 'dotenv';
import express from 'express';
import fs from 'fs';
import multer from 'multer';
import path from 'path';
import {
  type AuthedRequest,
  canAdminWorkspace,
  canEditWorkspaceContent,
  canManageProjects,
  clearSessionCookie,
  createSession,
  generateToken,
  getWorkspaceRole,
  hashPassword,
  requireAuth,
  setSessionCookie,
  verifyPassword,
} from './server/auth.ts';
import { db, initSchema, UPLOAD_DIR } from './server/db.ts';
import { seedDemoDataIfEmpty, SYSTEM_TEMPLATES } from './server/seed.ts';
import { registerSupabaseAdminRoutes } from './server/supabaseAdmin.ts';

dotenv.config();
initSchema();
seedDemoDataIfEmpty();

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
registerSupabaseAdminRoutes(app);

// Allowed file upload extensions & MIME types
const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/png',
  'image/jpeg',
  'image/svg+xml',
  'application/zip',
  'application/x-zip-compressed',
  'text/plain',
  'text/csv',
  'text/markdown',
]);

const ALLOWED_EXTS = new Set([
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.png', '.jpg', '.jpeg', '.svg', '.zip', '.txt', '.csv', '.md',
]);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTS.has(ext) && !ALLOWED_MIME_TYPES.has(file.mimetype)) {
      cb(new Error('Unsupported file type. Allowed: PDF, DOC/X, XLS/X, PPT/X, PNG, JPG, SVG, ZIP, TXT, CSV, MD'));
      return;
    }
    cb(null, true);
  },
});

function sanitizeUser(row: Record<string, unknown>) {
  const { password_hash: _ph, verification_token: _vt, reset_token: _rt, reset_expires_at: _re, ...safe } = row;
  return safe;
}

function logActivity(
  workspaceId: string,
  userId: string,
  action: string,
  details: string,
  projectId: string | null = null,
  taskId: string | null = null,
) {
  db.prepare(`
    INSERT INTO activity_logs (id, workspace_id, project_id, task_id, user_id, action, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), workspaceId, projectId, taskId, userId, action, details, new Date().toISOString());
}

function createNotification(
  workspaceId: string,
  userId: string,
  actorId: string | null,
  category: string,
  title: string,
  message: string,
  linkType: string | null = null,
  linkId: string | null = null,
) {
  if (actorId && actorId === userId) return;
  db.prepare(`
    INSERT INTO notifications (id, workspace_id, user_id, actor_id, category, title, message, link_type, link_id, is_read, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
  `).run(crypto.randomUUID(), workspaceId, userId, actorId, category, title, message, linkType, linkId, new Date().toISOString());
}

function getHydratedTasks(workspaceId: string, filters: {
  projectId?: string;
  includeArchived?: boolean;
  onlyTrash?: boolean;
} = {}) {
  const conditions = ['t.workspace_id = ?'];
  const params: unknown[] = [workspaceId];

  if (filters.onlyTrash) {
    conditions.push('t.deleted_at IS NOT NULL');
  } else {
    conditions.push('t.deleted_at IS NULL');
    if (!filters.includeArchived) {
      conditions.push('t.is_archived = 0');
    }
  }
  if (filters.projectId) {
    conditions.push('t.project_id = ?');
    params.push(filters.projectId);
  }

  const rows = db.prepare(`
    SELECT t.*, p.name as project_name, p.color as project_color,
      (SELECT COUNT(*) FROM comments c WHERE c.task_id = t.id) as comment_count,
      (SELECT COUNT(*) FROM attachments a WHERE a.task_id = t.id) as attachment_count,
      (SELECT COUNT(*) FROM subtasks s WHERE s.task_id = t.id) as subtask_total,
      (SELECT COUNT(*) FROM subtasks s WHERE s.task_id = t.id AND s.completed = 1) as subtask_completed,
      (SELECT COUNT(*) FROM checklist_items ci JOIN checklists ch ON ch.id = ci.checklist_id WHERE ch.task_id = t.id) as checklist_total,
      (SELECT COUNT(*) FROM checklist_items ci JOIN checklists ch ON ch.id = ci.checklist_id WHERE ch.task_id = t.id AND ci.completed = 1) as checklist_completed,
      (SELECT COALESCE(SUM(te.duration_seconds), 0) FROM time_entries te WHERE te.task_id = t.id) as actual_seconds
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY t.position ASC, t.created_at DESC
  `).all(...params) as Array<Record<string, unknown>>;

  const taskIds = rows.map((r) => String(r.id));
  const assigneesMap: Record<string, Array<Record<string, unknown>>> = {};

  if (taskIds.length > 0) {
    const placeholders = taskIds.map(() => '?').join(',');
    const aRows = db.prepare(`
      SELECT ta.task_id, ta.user_id, ta.is_primary, u.full_name, u.avatar_url, u.job_title
      FROM task_assignees ta
      JOIN users u ON u.id = ta.user_id
      WHERE ta.task_id IN (${placeholders})
      ORDER BY ta.is_primary DESC, u.full_name ASC
    `).all(...taskIds) as Array<Record<string, unknown>>;

    for (const ar of aRows) {
      const tid = String(ar.task_id);
      if (!assigneesMap[tid]) assigneesMap[tid] = [];
      assigneesMap[tid].push({
        user_id: ar.user_id,
        full_name: ar.full_name,
        avatar_url: ar.avatar_url,
        job_title: ar.job_title,
        is_primary: ar.is_primary,
      });
    }
  }

  return rows.map((r) => ({
    ...r,
    labels: JSON.parse(String(r.labels || '[]')),
    assignees: assigneesMap[String(r.id)] || [],
  }));
}

// ==========================================
// AUTHENTICATION ROUTES
// ==========================================

app.post('/api/auth/register', (req, res) => {
  const { full_name, email, password, confirm_password, accepted_terms, workspace_name, include_sample_data } = req.body || {};

  if (!full_name || typeof full_name !== 'string' || full_name.trim().length < 2) {
    res.status(400).json({ error: 'Full name must be at least 2 characters.' });
    return;
  }
  if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    res.status(400).json({ error: 'Please enter a valid email address.' });
    return;
  }
  if (!password || typeof password !== 'string' || password.length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters.' });
    return;
  }
  if (password !== confirm_password) {
    res.status(400).json({ error: 'Passwords do not match.' });
    return;
  }
  if (!accepted_terms) {
    res.status(400).json({ error: 'You must accept the Terms and Conditions.' });
    return;
  }

  const normEmail = email.trim().toLowerCase();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normEmail);
  if (existing) {
    res.status(409).json({ error: 'An account with this email already exists.' });
    return;
  }

  const userId = crypto.randomUUID();
  const now = new Date().toISOString();
  const verificationToken = generateToken().slice(0, 24);
  const passwordHash = hashPassword(password);

  db.transaction(() => {
    db.prepare(`
      INSERT INTO users (id, email, password_hash, full_name, avatar_url, job_title, department, bio, timezone, email_verified, verification_token, created_at, updated_at)
      VALUES (?, ?, ?, ?, NULL, 'Workspace Owner', 'Product', '', 'America/Los_Angeles', 0, ?, ?, ?)
    `).run(userId, normEmail, passwordHash, full_name.trim(), verificationToken, now, now);

    db.prepare(`
      INSERT INTO user_preferences (user_id, updated_at) VALUES (?, ?)
    `).run(userId, now);

    // Create default personal/team workspace for the new user
    const wsId = crypto.randomUUID();
    const wsName = (typeof workspace_name === 'string' && workspace_name.trim()) ? workspace_name.trim() : `${full_name.trim().split(' ')[0]}'s Workspace`;
    const initials = wsName.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || '').join('') || 'TR';
    const slug = wsName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workspace';

    db.prepare(`
      INSERT INTO workspaces (id, name, slug, description, logo_color, logo_initials, owner_id, plan, created_at, updated_at)
      VALUES (?, ?, ?, 'Organized project & task workspace', '#1B3B2B', ?, ?, 'free', ?, ?)
    `).run(wsId, wsName, `${slug}-${wsId.slice(0, 4)}`, initials, userId, now, now);

    db.prepare(`
      INSERT INTO workspace_members (id, workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, 'owner', ?)
    `).run(crypto.randomUUID(), wsId, userId, now);

    // Optionally scaffold a clean starter project from template
    if (include_sample_data !== false) {
      const tpl = SYSTEM_TEMPLATES[0];
      const prjId = crypto.randomUUID();
      const brdId = crypto.randomUUID();
      const today = new Date().toISOString().slice(0, 10);
      const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

      db.prepare(`
        INSERT INTO projects (id, workspace_id, name, description, color, category, status, priority, owner_id, manager_id, start_date, due_date, is_pinned, is_demo, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'in_progress', 'medium', ?, ?, ?, ?, 1, 1, ?, ?)
      `).run(prjId, wsId, 'Getting Started Project', tpl.description, tpl.color, tpl.category, userId, userId, today, nextWeek, now, now);

      db.prepare(`INSERT INTO project_members (id, project_id, user_id, role, added_at) VALUES (?, ?, ?, 'lead', ?)`).run(crypto.randomUUID(), prjId, userId, now);
      db.prepare(`INSERT INTO boards (id, project_id, name, created_at) VALUES (?, ?, 'Main Board', ?)`).run(brdId, prjId, now);

      const colMap: Record<string, string> = {};
      tpl.columns.forEach((col, i) => {
        const cid = crypto.randomUUID();
        colMap[col.status_key] = cid;
        db.prepare(`INSERT INTO board_columns (id, board_id, name, position, color, status_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          cid, brdId, col.name, i, col.color, col.status_key, now,
        );
      });

      tpl.sample_tasks.slice(0, 3).forEach((st, idx) => {
        const tid = crypto.randomUUID();
        db.prepare(`
          INSERT INTO tasks (id, workspace_id, project_id, board_id, column_id, title, description, status, priority, task_type, position, start_date, due_date, estimated_minutes, labels, is_demo, created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'Sample starter task — edit or replace anytime.', ?, ?, 'task', ?, ?, ?, ?, ?, 1, ?, ?, ?)
        `).run(tid, wsId, prjId, brdId, colMap[st.status_key], st.title, st.status_key, st.priority, idx, today, nextWeek, st.estimated_minutes, JSON.stringify(st.labels), userId, now, now);
        db.prepare(`INSERT INTO task_assignees (id, task_id, user_id, is_primary, assigned_at) VALUES (?, ?, ?, 1, ?)`).run(crypto.randomUUID(), tid, userId, now);
      });
    }

    // Accept any pending invitations sent to this email
    const invites = db.prepare(`SELECT * FROM workspace_invitations WHERE email = ? AND status = 'pending'`).all(normEmail) as Array<Record<string, unknown>>;
    for (const inv of invites) {
      db.prepare(`INSERT OR IGNORE INTO workspace_members (id, workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?, ?)`).run(
        crypto.randomUUID(), inv.workspace_id, userId, inv.role, now,
      );
      db.prepare(`UPDATE workspace_invitations SET status = 'accepted' WHERE id = ?`).run(inv.id);
    }
  })();

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as Record<string, unknown>;
  const prefs = db.prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(userId) as Record<string, unknown>;
  const session = createSession(userId, true, req.headers['user-agent'] || '', req.ip || '');
  setSessionCookie(res, req, session.token, true);

  res.status(201).json({
    token: session.token,
    user: sanitizeUser(user),
    preferences: { ...prefs, pinned_pages: JSON.parse(String(prefs.pinned_pages || '[]')) },
    verification_token: verificationToken,
  });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password, remember_me } = req.body || {};
  if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
    res.status(400).json({ error: 'Email and password are required.' });
    return;
  }
  const normEmail = email.trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(normEmail) as Record<string, unknown> | undefined;
  if (!user || !verifyPassword(password, String(user.password_hash))) {
    res.status(401).json({ error: 'Invalid email or password.' });
    return;
  }

  const remember = Boolean(remember_me);
  const session = createSession(String(user.id), remember, req.headers['user-agent'] || '', req.ip || '');
  setSessionCookie(res, req, session.token, remember);
  const prefs = db.prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(user.id) as Record<string, unknown>;

  res.json({
    token: session.token,
    user: sanitizeUser(user),
    preferences: { ...prefs, pinned_pages: JSON.parse(String(prefs.pinned_pages || '[]')) },
  });
});

app.post('/api/auth/logout', requireAuth, (req: AuthedRequest, res) => {
  if (req.sessionId) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(req.sessionId);
  }
  clearSessionCookie(res, req);
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req: AuthedRequest, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId) as Record<string, unknown> | undefined;
  if (!user) {
    res.status(401).json({ error: 'User not found' });
    return;
  }
  const prefs = db.prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(req.userId) as Record<string, unknown>;
  res.json({
    user: sanitizeUser(user),
    preferences: { ...prefs, pinned_pages: JSON.parse(String(prefs.pinned_pages || '[]')) },
  });
});

app.post('/api/auth/verify-email', (req, res) => {
  const { email, token } = req.body || {};
  if (!email && !token) {
    res.status(400).json({ error: 'Verification token or email is required.' });
    return;
  }
  let user: Record<string, unknown> | undefined;
  if (token) {
    user = db.prepare('SELECT * FROM users WHERE verification_token = ?').get(String(token)) as Record<string, unknown> | undefined;
  } else if (email) {
    user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).trim().toLowerCase()) as Record<string, unknown> | undefined;
  }
  if (!user) {
    res.status(404).json({ error: 'Invalid verification token.' });
    return;
  }
  db.prepare('UPDATE users SET email_verified = 1, verification_token = NULL, updated_at = ? WHERE id = ?').run(
    new Date().toISOString(),
    user.id,
  );
  res.json({ ok: true, email: user.email });
});

app.post('/api/auth/forgot-password', (req, res) => {
  const { email } = req.body || {};
  if (!email || typeof email !== 'string') {
    res.status(400).json({ error: 'Email address is required.' });
    return;
  }
  const normEmail = email.trim().toLowerCase();
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(normEmail) as { id: string } | undefined;
  let resetToken: string | null = null;
  if (user) {
    resetToken = generateToken().slice(0, 16).toUpperCase();
    const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE users SET reset_token = ?, reset_expires_at = ? WHERE id = ?').run(resetToken, expires, user.id);
  }
  // In self-contained preview without external SMTP, return a confirmation + preview reset code when user exists
  res.json({
    ok: true,
    message: 'If an account matches that email, a password reset code has been generated.',
    preview_reset_code: resetToken,
  });
});

app.post('/api/auth/reset-password', (req, res) => {
  const { email, reset_code, new_password, confirm_password } = req.body || {};
  if (!email || !reset_code || !new_password) {
    res.status(400).json({ error: 'Email, reset code, and new password are required.' });
    return;
  }
  if (String(new_password).length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters.' });
    return;
  }
  if (new_password !== confirm_password) {
    res.status(400).json({ error: 'Passwords do not match.' });
    return;
  }
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).trim().toLowerCase()) as Record<string, unknown> | undefined;
  if (!user || !user.reset_token || user.reset_token !== String(reset_code).trim()) {
    res.status(400).json({ error: 'Invalid or expired reset code.' });
    return;
  }
  if (user.reset_expires_at && new Date(String(user.reset_expires_at)).getTime() < Date.now()) {
    res.status(400).json({ error: 'Reset code has expired.' });
    return;
  }

  const newHash = hashPassword(String(new_password));
  db.prepare('UPDATE users SET password_hash = ?, reset_token = NULL, reset_expires_at = NULL, updated_at = ? WHERE id = ?').run(
    newHash,
    new Date().toISOString(),
    user.id,
  );
  // Revoke other active sessions on password reset
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  res.json({ ok: true });
});

// ==========================================
// PROFILE, PREFERENCES & SESSIONS
// ==========================================

app.patch('/api/account/profile', requireAuth, (req: AuthedRequest, res) => {
  const { full_name, email, job_title, department, bio, timezone, avatar_url } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId) as Record<string, unknown>;
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  const nextEmail = typeof email === 'string' && email.trim() ? email.trim().toLowerCase() : String(user.email);
  if (nextEmail !== user.email) {
    const conflict = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(nextEmail, req.userId);
    if (conflict) {
      res.status(409).json({ error: 'Email address is already in use.' });
      return;
    }
  }
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE users SET full_name = ?, email = ?, job_title = ?, department = ?, bio = ?, timezone = ?, avatar_url = ?, updated_at = ? WHERE id = ?
  `).run(
    typeof full_name === 'string' && full_name.trim() ? full_name.trim() : user.full_name,
    nextEmail,
    typeof job_title === 'string' ? job_title.trim() : user.job_title,
    typeof department === 'string' ? department.trim() : user.department,
    typeof bio === 'string' ? bio.trim() : user.bio,
    typeof timezone === 'string' ? timezone.trim() : user.timezone,
    avatar_url !== undefined ? avatar_url : user.avatar_url,
    now,
    req.userId,
  );
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId) as Record<string, unknown>;
  res.json({ user: sanitizeUser(updated) });
});

app.patch('/api/account/preferences', requireAuth, (req: AuthedRequest, res) => {
  const allowed = [
    'theme', 'language', 'date_format', 'time_format',
    'notify_assignments', 'notify_mentions', 'notify_comments',
    'notify_deadlines', 'notify_updates', 'sidebar_collapsed',
  ];
  const current = db.prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(req.userId) as Record<string, unknown>;
  const updates: Record<string, unknown> = { ...current };

  for (const k of allowed) {
    if (req.body[k] !== undefined) updates[k] = req.body[k];
  }
  if (Array.isArray(req.body.pinned_pages)) {
    updates.pinned_pages = JSON.stringify(req.body.pinned_pages);
  }
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE user_preferences
    SET theme = ?, language = ?, date_format = ?, time_format = ?,
        notify_assignments = ?, notify_mentions = ?, notify_comments = ?,
        notify_deadlines = ?, notify_updates = ?, sidebar_collapsed = ?,
        pinned_pages = ?, updated_at = ?
    WHERE user_id = ?
  `).run(
    updates.theme, updates.language, updates.date_format, updates.time_format,
    updates.notify_assignments ? 1 : 0, updates.notify_mentions ? 1 : 0, updates.notify_comments ? 1 : 0,
    updates.notify_deadlines ? 1 : 0, updates.notify_updates ? 1 : 0, updates.sidebar_collapsed ? 1 : 0,
    typeof updates.pinned_pages === 'string' ? updates.pinned_pages : JSON.stringify(updates.pinned_pages),
    now, req.userId,
  );
  const next = db.prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(req.userId) as Record<string, unknown>;
  res.json({ preferences: { ...next, pinned_pages: JSON.parse(String(next.pinned_pages || '[]')) } });
});

app.post('/api/account/change-password', requireAuth, (req: AuthedRequest, res) => {
  const { current_password, new_password, confirm_password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId) as Record<string, unknown>;
  if (!verifyPassword(String(current_password || ''), String(user.password_hash))) {
    res.status(400).json({ error: 'Current password is incorrect.' });
    return;
  }
  if (!new_password || String(new_password).length < 8) {
    res.status(400).json({ error: 'New password must be at least 8 characters.' });
    return;
  }
  if (new_password !== confirm_password) {
    res.status(400).json({ error: 'New passwords do not match.' });
    return;
  }
  db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
    hashPassword(String(new_password)),
    new Date().toISOString(),
    req.userId,
  );
  res.json({ ok: true });
});

app.get('/api/account/sessions', requireAuth, (req: AuthedRequest, res) => {
  const rows = db.prepare(`
    SELECT id, user_agent, ip_address, created_at, last_active_at, expires_at
    FROM sessions WHERE user_id = ? ORDER BY last_active_at DESC
  `).all(req.userId) as Array<Record<string, unknown>>;
  res.json({
    sessions: rows.map((r) => ({ ...r, is_current: r.id === req.sessionId })),
  });
});

app.delete('/api/account/sessions/:sessionId', requireAuth, (req: AuthedRequest, res) => {
  db.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').run(req.params.sessionId, req.userId);
  res.json({ ok: true });
});

app.delete('/api/account', requireAuth, (req: AuthedRequest, res) => {
  const ownedWorkspaces = db.prepare('SELECT id FROM workspaces WHERE owner_id = ? AND deleted_at IS NULL').all(req.userId) as Array<{ id: string }>;
  for (const ws of ownedWorkspaces) {
    db.prepare('UPDATE workspaces SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), ws.id);
  }
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.userId);
  clearSessionCookie(res, req);
  res.json({ ok: true });
});

// ==========================================
// WORKSPACE MANAGEMENT
// ==========================================

app.get('/api/workspaces', requireAuth, (req: AuthedRequest, res) => {
  const rows = db.prepare(`
    SELECT w.*, wm.role,
      (SELECT COUNT(*) FROM workspace_members m WHERE m.workspace_id = w.id) as member_count,
      (SELECT COUNT(*) FROM projects p WHERE p.workspace_id = w.id AND p.deleted_at IS NULL AND p.is_archived = 0) as project_count
    FROM workspaces w
    JOIN workspace_members wm ON wm.workspace_id = w.id
    WHERE wm.user_id = ? AND w.deleted_at IS NULL
    ORDER BY w.created_at ASC
  `).all(req.userId);
  res.json({ workspaces: rows });
});

app.post('/api/workspaces', requireAuth, (req: AuthedRequest, res) => {
  const { name, description, logo_color, plan } = req.body || {};
  if (!name || typeof name !== 'string' || name.trim().length < 2) {
    res.status(400).json({ error: 'Workspace name must be at least 2 characters.' });
    return;
  }
  const wsId = crypto.randomUUID();
  const now = new Date().toISOString();
  const cleanName = name.trim();
  const initials = cleanName.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || '').join('') || 'WS';
  const slug = cleanName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workspace';

  db.transaction(() => {
    db.prepare(`
      INSERT INTO workspaces (id, name, slug, description, logo_color, logo_initials, owner_id, plan, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(wsId, cleanName, `${slug}-${wsId.slice(0, 4)}`, String(description || ''), String(logo_color || '#1B3B2B'), initials, req.userId, String(plan || 'pro'), now, now);

    db.prepare(`
      INSERT INTO workspace_members (id, workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, 'owner', ?)
    `).run(crypto.randomUUID(), wsId, req.userId, now);
  })();

  const created = db.prepare(`
    SELECT w.*, wm.role, 1 as member_count, 0 as project_count
    FROM workspaces w JOIN workspace_members wm ON wm.workspace_id = w.id
    WHERE w.id = ? AND wm.user_id = ?
  `).get(wsId, req.userId);
  res.status(201).json({ workspace: created });
});

app.patch('/api/workspaces/:workspaceId', requireAuth, (req: AuthedRequest, res) => {
  const { workspaceId } = req.params;
  const role = getWorkspaceRole(workspaceId, req.userId!);
  if (!canAdminWorkspace(role)) {
    res.status(403).json({ error: 'Only workspace owners and admins can edit workspace settings.' });
    return;
  }
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ? AND deleted_at IS NULL').get(workspaceId) as Record<string, unknown> | undefined;
  if (!ws) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }
  const { name, description, logo_color, plan } = req.body || {};
  const nextName = typeof name === 'string' && name.trim() ? name.trim() : String(ws.name);
  const initials = nextName.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || '').join('') || String(ws.logo_initials);

  db.prepare(`
    UPDATE workspaces SET name = ?, description = ?, logo_color = ?, logo_initials = ?, plan = ?, updated_at = ? WHERE id = ?
  `).run(
    nextName,
    description !== undefined ? String(description) : ws.description,
    logo_color !== undefined ? String(logo_color) : ws.logo_color,
    initials,
    plan !== undefined ? String(plan) : ws.plan,
    new Date().toISOString(),
    workspaceId,
  );
  const updated = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);
  res.json({ workspace: { ...(updated as object), role } });
});

app.delete('/api/workspaces/:workspaceId', requireAuth, (req: AuthedRequest, res) => {
  const { workspaceId } = req.params;
  const role = getWorkspaceRole(workspaceId, req.userId!);
  if (role !== 'owner') {
    res.status(403).json({ error: 'Only the workspace owner can delete a workspace.' });
    return;
  }
  db.prepare('UPDATE workspaces SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), workspaceId);
  res.json({ ok: true });
});

// ==========================================
// TEAM MEMBERS & INVITATIONS
// ==========================================

app.get('/api/workspaces/:workspaceId/members', requireAuth, (req: AuthedRequest, res) => {
  const { workspaceId } = req.params;
  const role = getWorkspaceRole(workspaceId, req.userId!);
  if (!role) {
    res.status(403).json({ error: 'Access denied' });
    return;
  }
  const members = db.prepare(`
    SELECT wm.*, u.full_name, u.email, u.avatar_url, u.job_title, u.department, u.bio,
      (SELECT COUNT(DISTINCT pm.project_id) FROM project_members pm JOIN projects p ON p.id = pm.project_id WHERE pm.user_id = u.id AND p.workspace_id = wm.workspace_id AND p.deleted_at IS NULL) as assigned_projects_count,
      (SELECT COUNT(*) FROM task_assignees ta JOIN tasks t ON t.id = ta.task_id WHERE ta.user_id = u.id AND t.workspace_id = wm.workspace_id AND t.deleted_at IS NULL AND t.is_archived = 0) as assigned_tasks_count,
      (SELECT COUNT(*) FROM task_assignees ta JOIN tasks t ON t.id = ta.task_id WHERE ta.user_id = u.id AND t.workspace_id = wm.workspace_id AND t.deleted_at IS NULL AND t.status = 'completed') as completed_tasks_count,
      (SELECT COALESCE(SUM(t.estimated_minutes), 0) FROM task_assignees ta JOIN tasks t ON t.id = ta.task_id WHERE ta.user_id = u.id AND t.workspace_id = wm.workspace_id AND t.deleted_at IS NULL AND t.status != 'completed') as active_workload_minutes
    FROM workspace_members wm
    JOIN users u ON u.id = wm.user_id
    WHERE wm.workspace_id = ?
    ORDER BY wm.joined_at ASC
  `).all(workspaceId);

  const invitations = db.prepare(`
    SELECT wi.*, u.full_name as invited_by_name
    FROM workspace_invitations wi
    JOIN users u ON u.id = wi.invited_by
    WHERE wi.workspace_id = ? AND wi.status = 'pending'
    ORDER BY wi.created_at DESC
  `).all(workspaceId);

  res.json({ members, invitations });
});

app.post('/api/workspaces/:workspaceId/invitations', requireAuth, (req: AuthedRequest, res) => {
  const { workspaceId } = req.params;
  const actorRole = getWorkspaceRole(workspaceId, req.userId!);
  if (!canAdminWorkspace(actorRole)) {
    res.status(403).json({ error: 'Only admins and owners can invite members.' });
    return;
  }
  const { email, role } = req.body || {};
  if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    res.status(400).json({ error: 'Valid email address is required.' });
    return;
  }
  const targetEmail = email.trim().toLowerCase();
  const targetRole = ['admin', 'project_manager', 'member', 'guest'].includes(role) ? role : 'member';
  const now = new Date().toISOString();

  // Check if user already exists on Trellas
  const existingUser = db.prepare('SELECT id, full_name FROM users WHERE email = ?').get(targetEmail) as { id: string; full_name: string } | undefined;
  if (existingUser) {
    const alreadyMember = db.prepare('SELECT id FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(workspaceId, existingUser.id);
    if (alreadyMember) {
      res.status(409).json({ error: 'This user is already a member of the workspace.' });
      return;
    }
    db.prepare('INSERT INTO workspace_members (id, workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?, ?)').run(
      crypto.randomUUID(), workspaceId, existingUser.id, targetRole, now,
    );
    createNotification(workspaceId, existingUser.id, req.userId!, 'invitation', 'Added to workspace', `You were added to a workspace as ${targetRole}.`, 'workspace', workspaceId);
    logActivity(workspaceId, req.userId!, 'member_added', `Added ${existingUser.full_name} to the workspace`);
    res.status(201).json({ status: 'added_directly', user_id: existingUser.id });
    return;
  }

  const invId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO workspace_invitations (id, workspace_id, email, role, invited_by, status, token, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(invId, workspaceId, targetEmail, targetRole, req.userId, generateToken().slice(0, 16), now);
  logActivity(workspaceId, req.userId!, 'member_invited', `Invited ${targetEmail} (${targetRole})`);
  res.status(201).json({ status: 'invited', id: invId });
});

app.patch('/api/workspaces/:workspaceId/members/:memberId', requireAuth, (req: AuthedRequest, res) => {
  const { workspaceId, memberId } = req.params;
  const actorRole = getWorkspaceRole(workspaceId, req.userId!);
  if (!canAdminWorkspace(actorRole)) {
    res.status(403).json({ error: 'Only admins and owners can update member roles.' });
    return;
  }
  const { role } = req.body || {};
  if (!['admin', 'project_manager', 'member', 'guest'].includes(role)) {
    res.status(400).json({ error: 'Invalid role.' });
    return;
  }
  const target = db.prepare('SELECT * FROM workspace_members WHERE id = ? AND workspace_id = ?').get(memberId, workspaceId) as { role: string; user_id: string } | undefined;
  if (!target) {
    res.status(404).json({ error: 'Member not found' });
    return;
  }
  if (target.role === 'owner') {
    res.status(400).json({ error: 'Cannot change the workspace owner role.' });
    return;
  }
  db.prepare('UPDATE workspace_members SET role = ? WHERE id = ?').run(role, memberId);
  res.json({ ok: true });
});

app.delete('/api/workspaces/:workspaceId/members/:memberId', requireAuth, (req: AuthedRequest, res) => {
  const { workspaceId, memberId } = req.params;
  const actorRole = getWorkspaceRole(workspaceId, req.userId!);
  if (!canAdminWorkspace(actorRole)) {
    res.status(403).json({ error: 'Only admins and owners can remove members.' });
    return;
  }
  const target = db.prepare('SELECT * FROM workspace_members WHERE id = ? AND workspace_id = ?').get(memberId, workspaceId) as { role: string } | undefined;
  if (!target) {
    res.status(404).json({ error: 'Member not found' });
    return;
  }
  if (target.role === 'owner') {
    res.status(400).json({ error: 'Cannot remove the workspace owner.' });
    return;
  }
  db.prepare('DELETE FROM workspace_members WHERE id = ? AND workspace_id = ?').run(memberId, workspaceId);
  res.json({ ok: true });
});

app.delete('/api/workspaces/:workspaceId/invitations/:invId', requireAuth, (req: AuthedRequest, res) => {
  const { workspaceId, invId } = req.params;
  if (!canAdminWorkspace(getWorkspaceRole(workspaceId, req.userId!))) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  db.prepare(`UPDATE workspace_invitations SET status = 'revoked' WHERE id = ? AND workspace_id = ?`).run(invId, workspaceId);
  res.json({ ok: true });
});

// ==========================================
// PROJECTS, BOARDS & COLUMNS
// ==========================================

app.get('/api/workspaces/:workspaceId/projects', requireAuth, (req: AuthedRequest, res) => {
  const { workspaceId } = req.params;
  if (!getWorkspaceRole(workspaceId, req.userId!)) {
    res.status(403).json({ error: 'Access denied' });
    return;
  }
  const includeArchived = req.query.archived === '1';
  const onlyTrash = req.query.trash === '1';

  const conds = ['p.workspace_id = ?'];
  if (onlyTrash) conds.push('p.deleted_at IS NOT NULL');
  else {
    conds.push('p.deleted_at IS NULL');
    if (!includeArchived) conds.push('p.is_archived = 0');
  }

  const projects = db.prepare(`
    SELECT p.*, u.full_name as manager_name, u.avatar_url as manager_avatar,
      (SELECT b.id FROM boards b WHERE b.project_id = p.id LIMIT 1) as board_id,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.is_archived = 0) as total_tasks,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.is_archived = 0 AND t.status = 'completed') as completed_tasks
    FROM projects p
    JOIN users u ON u.id = p.manager_id
    WHERE ${conds.join(' AND ')}
    ORDER BY p.is_pinned DESC, p.updated_at DESC
  `).all(workspaceId) as Array<Record<string, unknown>>;

  const projectIds = projects.map((p) => String(p.id));
  const membersByProject: Record<string, Array<Record<string, unknown>>> = {};
  if (projectIds.length > 0) {
    const placeholders = projectIds.map(() => '?').join(',');
    const mRows = db.prepare(`
      SELECT pm.*, u.full_name, u.email, u.avatar_url, u.job_title
      FROM project_members pm JOIN users u ON u.id = pm.user_id
      WHERE pm.project_id IN (${placeholders})
    `).all(...projectIds) as Array<Record<string, unknown>>;
    for (const m of mRows) {
      const pid = String(m.project_id);
      if (!membersByProject[pid]) membersByProject[pid] = [];
      membersByProject[pid].push(m);
    }
  }

  const hydrated = projects.map((p) => {
    const total = Number(p.total_tasks || 0);
    const done = Number(p.completed_tasks || 0);
    return {
      ...p,
      progress_pct: total > 0 ? Math.round((done / total) * 100) : 0,
      members: membersByProject[String(p.id)] || [],
    };
  });
  res.json({ projects: hydrated });
});

app.post('/api/workspaces/:workspaceId/projects', requireAuth, (req: AuthedRequest, res) => {
  const { workspaceId } = req.params;
  const role = getWorkspaceRole(workspaceId, req.userId!);
  if (!canEditWorkspaceContent(role)) {
    res.status(403).json({ error: 'Guests cannot create projects.' });
    return;
  }
  const { name, description, color, category, status, priority, manager_id, start_date, due_date, member_ids, template_id } = req.body || {};
  if (!name || typeof name !== 'string' || name.trim().length < 2) {
    res.status(400).json({ error: 'Project name is required.' });
    return;
  }

  const prjId = crypto.randomUUID();
  const brdId = crypto.randomUUID();
  const now = new Date().toISOString();
  const manager = manager_id || req.userId!;

  let columnsToCreate = [
    { name: 'Backlog', status_key: 'backlog', color: '#64748B' },
    { name: 'To Do', status_key: 'todo', color: '#3B82F6' },
    { name: 'In Progress', status_key: 'in_progress', color: '#C99A4E' },
    { name: 'In Review', status_key: 'in_review', color: '#8B5CF6' },
    { name: 'Completed', status_key: 'completed', color: '#16A34A' },
  ];
  let templateTasks: Array<{ title: string; status_key: string; priority: string; labels: string[]; estimated_minutes: number }> = [];

  if (template_id) {
    const tpl = db.prepare('SELECT * FROM project_templates WHERE id = ?').get(String(template_id)) as Record<string, unknown> | undefined;
    if (tpl) {
      columnsToCreate = JSON.parse(String(tpl.columns_json));
      templateTasks = JSON.parse(String(tpl.sample_tasks_json));
    }
  }

  db.transaction(() => {
    db.prepare(`
      INSERT INTO projects (id, workspace_id, name, description, color, category, status, priority, owner_id, manager_id, start_date, due_date, is_pinned, is_archived, is_demo, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)
    `).run(
      prjId, workspaceId, name.trim(), String(description || ''), String(color || '#1B3B2B'),
      String(category || 'Product'), String(status || 'planning'), String(priority || 'medium'),
      req.userId, manager, start_date || null, due_date || null, now, now,
    );

    const uniqueMembers = new Set<string>([req.userId!, manager, ...(Array.isArray(member_ids) ? member_ids : [])]);
    for (const uid of uniqueMembers) {
      db.prepare(`INSERT OR IGNORE INTO project_members (id, project_id, user_id, role, added_at) VALUES (?, ?, ?, ?, ?)`).run(
        crypto.randomUUID(), prjId, uid, uid === manager ? 'lead' : 'member', now,
      );
      if (uid !== req.userId) {
        createNotification(workspaceId, uid, req.userId!, 'project', 'Added to project', `You were added to "${name.trim()}"`, 'project', prjId);
      }
    }

    db.prepare(`INSERT INTO boards (id, project_id, name, created_at) VALUES (?, ?, 'Main Board', ?)`).run(brdId, prjId, now);
    const colMap: Record<string, string> = {};
    columnsToCreate.forEach((c, idx) => {
      const cid = crypto.randomUUID();
      colMap[c.status_key] = cid;
      db.prepare(`INSERT INTO board_columns (id, board_id, name, position, color, status_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        cid, brdId, c.name, idx, c.color, c.status_key, now,
      );
    });

    templateTasks.forEach((st, idx) => {
      const tid = crypto.randomUUID();
      const targetCol = colMap[st.status_key] || Object.values(colMap)[0];
      db.prepare(`
        INSERT INTO tasks (id, workspace_id, project_id, board_id, column_id, title, description, status, priority, task_type, position, start_date, due_date, estimated_minutes, labels, is_demo, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, 'task', ?, ?, ?, ?, ?, 0, ?, ?, ?)
      `).run(
        tid, workspaceId, prjId, brdId, targetCol, st.title, st.status_key, st.priority, idx,
        start_date || null, due_date || null, st.estimated_minutes || 60, JSON.stringify(st.labels || []),
        req.userId, now, now,
      );
    });

    logActivity(workspaceId, req.userId!, 'created_project', `Created project "${name.trim()}"`, prjId);
  })();

  res.status(201).json({ id: prjId });
});

app.get('/api/projects/:projectId', requireAuth, (req: AuthedRequest, res) => {
  const { projectId } = req.params;
  const project = db.prepare(`
    SELECT p.*, u.full_name as manager_name, u.avatar_url as manager_avatar
    FROM projects p JOIN users u ON u.id = p.manager_id
    WHERE p.id = ?
  `).get(projectId) as Record<string, unknown> | undefined;
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  const role = getWorkspaceRole(String(project.workspace_id), req.userId!);
  if (!role) {
    res.status(403).json({ error: 'Access denied' });
    return;
  }
  const board = db.prepare('SELECT * FROM boards WHERE project_id = ? LIMIT 1').get(projectId) as Record<string, unknown>;
  const columns = db.prepare('SELECT * FROM board_columns WHERE board_id = ? ORDER BY position ASC').all(board.id);
  const members = db.prepare(`
    SELECT pm.*, u.full_name, u.email, u.avatar_url, u.job_title
    FROM project_members pm JOIN users u ON u.id = pm.user_id
    WHERE pm.project_id = ?
  `).all(projectId);
  const milestones = db.prepare('SELECT * FROM project_milestones WHERE project_id = ? ORDER BY due_date ASC').all(projectId);
  const discussions = db.prepare(`
    SELECT d.*, u.full_name as author_name, u.avatar_url as author_avatar
    FROM project_discussions d JOIN users u ON u.id = d.user_id
    WHERE d.project_id = ? ORDER BY d.created_at DESC
  `).all(projectId);
  const tasks = getHydratedTasks(String(project.workspace_id), { projectId });

  res.json({
    project: { ...project, board_id: board.id, members },
    board,
    columns,
    tasks,
    milestones,
    discussions,
  });
});

app.patch('/api/projects/:projectId', requireAuth, (req: AuthedRequest, res) => {
  const { projectId } = req.params;
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Record<string, unknown> | undefined;
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  const role = getWorkspaceRole(String(project.workspace_id), req.userId!);
  if (!canEditWorkspaceContent(role)) {
    res.status(403).json({ error: 'Permission denied' });
    return;
  }

  const fields = ['name', 'description', 'color', 'category', 'status', 'priority', 'manager_id', 'start_date', 'due_date', 'is_pinned', 'is_archived'];
  const next: Record<string, unknown> = { ...project };
  for (const f of fields) {
    if (req.body[f] !== undefined) next[f] = req.body[f];
  }
  const now = new Date().toISOString();

  db.prepare(`
    UPDATE projects
    SET name = ?, description = ?, color = ?, category = ?, status = ?, priority = ?,
        manager_id = ?, start_date = ?, due_date = ?, is_pinned = ?, is_archived = ?, updated_at = ?
    WHERE id = ?
  `).run(
    next.name, next.description, next.color, next.category, next.status, next.priority,
    next.manager_id, next.start_date, next.due_date, next.is_pinned ? 1 : 0, next.is_archived ? 1 : 0, now, projectId,
  );

  if (Array.isArray(req.body.member_ids)) {
    db.prepare('DELETE FROM project_members WHERE project_id = ?').run(projectId);
    for (const uid of new Set<string>(req.body.member_ids)) {
      db.prepare('INSERT OR IGNORE INTO project_members (id, project_id, user_id, role, added_at) VALUES (?, ?, ?, ?, ?)').run(
        crypto.randomUUID(), projectId, uid, uid === next.manager_id ? 'lead' : 'member', now,
      );
    }
  }
  logActivity(String(project.workspace_id), req.userId!, 'updated_project', `Updated project "${next.name}"`, projectId);
  res.json({ ok: true });
});

app.post('/api/projects/:projectId/duplicate', requireAuth, (req: AuthedRequest, res) => {
  const { projectId } = req.params;
  const src = db.prepare('SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL').get(projectId) as Record<string, unknown> | undefined;
  if (!src) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  if (!canEditWorkspaceContent(getWorkspaceRole(String(src.workspace_id), req.userId!))) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  const newPrjId = crypto.randomUUID();
  const newBrdId = crypto.randomUUID();
  const now = new Date().toISOString();
  const srcBoard = db.prepare('SELECT * FROM boards WHERE project_id = ? LIMIT 1').get(projectId) as { id: string };
  const srcCols = db.prepare('SELECT * FROM board_columns WHERE board_id = ? ORDER BY position ASC').all(srcBoard.id) as Array<Record<string, unknown>>;
  const srcTasks = db.prepare('SELECT * FROM tasks WHERE project_id = ? AND deleted_at IS NULL').all(projectId) as Array<Record<string, unknown>>;
  const srcMembers = db.prepare('SELECT * FROM project_members WHERE project_id = ?').all(projectId) as Array<Record<string, unknown>>;

  db.transaction(() => {
    db.prepare(`
      INSERT INTO projects (id, workspace_id, name, description, color, category, status, priority, owner_id, manager_id, start_date, due_date, is_pinned, is_archived, is_demo, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'planning', ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)
    `).run(newPrjId, src.workspace_id, `${src.name} (Copy)`, src.description, src.color, src.category, src.priority, req.userId, src.manager_id, src.start_date, src.due_date, now, now);

    for (const m of srcMembers) {
      db.prepare('INSERT INTO project_members (id, project_id, user_id, role, added_at) VALUES (?, ?, ?, ?, ?)').run(
        crypto.randomUUID(), newPrjId, m.user_id, m.role, now,
      );
    }

    db.prepare(`INSERT INTO boards (id, project_id, name, created_at) VALUES (?, ?, 'Main Board', ?)`).run(newBrdId, newPrjId, now);
    const colMap: Record<string, string> = {};
    for (const c of srcCols) {
      const cid = crypto.randomUUID();
      colMap[String(c.id)] = cid;
      db.prepare(`INSERT INTO board_columns (id, board_id, name, position, color, status_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        cid, newBrdId, c.name, c.position, c.color, c.status_key, now,
      );
    }

    for (const t of srcTasks) {
      db.prepare(`
        INSERT INTO tasks (id, workspace_id, project_id, board_id, column_id, title, description, status, priority, task_type, position, start_date, due_date, estimated_minutes, labels, is_demo, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
      `).run(
        crypto.randomUUID(), src.workspace_id, newPrjId, newBrdId, colMap[String(t.column_id)],
        t.title, t.description, t.status, t.priority, t.task_type, t.position, t.start_date, t.due_date, t.estimated_minutes, t.labels, req.userId, now, now,
      );
    }
  })();

  res.status(201).json({ id: newPrjId });
});

app.delete('/api/projects/:projectId', requireAuth, (req: AuthedRequest, res) => {
  const { projectId } = req.params;
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Record<string, unknown> | undefined;
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  if (!canManageProjects(getWorkspaceRole(String(project.workspace_id), req.userId!))) {
    res.status(403).json({ error: 'Only project managers, admins, and owners can delete projects.' });
    return;
  }
  const permanent = req.query.permanent === '1';
  if (permanent) {
    db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
  } else {
    db.prepare('UPDATE projects SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), projectId);
  }
  res.json({ ok: true });
});

app.post('/api/projects/:projectId/restore', requireAuth, (req: AuthedRequest, res) => {
  const { projectId } = req.params;
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Record<string, unknown> | undefined;
  if (!project || !canEditWorkspaceContent(getWorkspaceRole(String(project.workspace_id), req.userId!))) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  db.prepare('UPDATE projects SET deleted_at = NULL, is_archived = 0 WHERE id = ?').run(projectId);
  res.json({ ok: true });
});

// Project Milestones & Discussions
app.post('/api/projects/:projectId/milestones', requireAuth, (req: AuthedRequest, res) => {
  const project = db.prepare('SELECT workspace_id FROM projects WHERE id = ?').get(req.params.projectId) as { workspace_id: string } | undefined;
  if (!project || !canEditWorkspaceContent(getWorkspaceRole(project.workspace_id, req.userId!))) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  const { title, description, due_date } = req.body || {};
  if (!title || !due_date) {
    res.status(400).json({ error: 'Title and due date required.' });
    return;
  }
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO project_milestones (id, project_id, title, description, due_date, completed, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)').run(
    id, req.params.projectId, String(title).trim(), String(description || ''), String(due_date), new Date().toISOString(),
  );
  res.status(201).json({ id });
});

app.patch('/api/milestones/:milestoneId', requireAuth, (req: AuthedRequest, res) => {
  const ms = db.prepare('SELECT m.*, p.workspace_id FROM project_milestones m JOIN projects p ON p.id = m.project_id WHERE m.id = ?').get(req.params.milestoneId) as { workspace_id: string } | undefined;
  if (!ms || !canEditWorkspaceContent(getWorkspaceRole(ms.workspace_id, req.userId!))) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  db.prepare('UPDATE project_milestones SET completed = ? WHERE id = ?').run(req.body.completed ? 1 : 0, req.params.milestoneId);
  res.json({ ok: true });
});

app.post('/api/projects/:projectId/discussions', requireAuth, (req: AuthedRequest, res) => {
  const project = db.prepare('SELECT workspace_id FROM projects WHERE id = ?').get(req.params.projectId) as { workspace_id: string } | undefined;
  if (!project || !canEditWorkspaceContent(getWorkspaceRole(project.workspace_id, req.userId!))) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  const { title, body } = req.body || {};
  if (!title || !body) {
    res.status(400).json({ error: 'Title and message are required.' });
    return;
  }
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO project_discussions (id, project_id, user_id, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id, req.params.projectId, req.userId, String(title).trim(), String(body).trim(), now, now,
  );
  logActivity(project.workspace_id, req.userId!, 'discussion_posted', `Posted discussion "${String(title).trim()}"`, req.params.projectId);
  res.status(201).json({ id });
});

// Board Columns CRUD & Reorder
app.post('/api/boards/:boardId/columns', requireAuth, (req: AuthedRequest, res) => {
  const board = db.prepare('SELECT b.*, p.workspace_id FROM boards b JOIN projects p ON p.id = b.project_id WHERE b.id = ?').get(req.params.boardId) as { workspace_id: string } | undefined;
  if (!board || !canEditWorkspaceContent(getWorkspaceRole(board.workspace_id, req.userId!))) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  const { name, color, status_key } = req.body || {};
  if (!name || typeof name !== 'string') {
    res.status(400).json({ error: 'Column name required.' });
    return;
  }
  const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) as m FROM board_columns WHERE board_id = ?').get(req.params.boardId) as { m: number };
  const id = crypto.randomUUID();
  const validStatus = ['backlog', 'todo', 'in_progress', 'in_review', 'completed'].includes(status_key) ? status_key : 'todo';
  db.prepare('INSERT INTO board_columns (id, board_id, name, position, color, status_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id, req.params.boardId, name.trim(), maxPos.m + 1, String(color || '#64748B'), validStatus, new Date().toISOString(),
  );
  res.status(201).json({ id });
});

app.patch('/api/columns/:columnId', requireAuth, (req: AuthedRequest, res) => {
  const col = db.prepare('SELECT c.*, p.workspace_id FROM board_columns c JOIN boards b ON b.id = c.board_id JOIN projects p ON p.id = b.project_id WHERE c.id = ?').get(req.params.columnId) as Record<string, unknown> | undefined;
  if (!col || !canEditWorkspaceContent(getWorkspaceRole(String(col.workspace_id), req.userId!))) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  db.prepare('UPDATE board_columns SET name = ?, color = ?, status_key = ? WHERE id = ?').run(
    req.body.name ? String(req.body.name).trim() : col.name,
    req.body.color ? String(req.body.color) : col.color,
    req.body.status_key ? String(req.body.status_key) : col.status_key,
    req.params.columnId,
  );
  res.json({ ok: true });
});

app.post('/api/boards/:boardId/columns/reorder', requireAuth, (req: AuthedRequest, res) => {
  const board = db.prepare('SELECT b.*, p.workspace_id FROM boards b JOIN projects p ON p.id = b.project_id WHERE b.id = ?').get(req.params.boardId) as { workspace_id: string } | undefined;
  if (!board || !canEditWorkspaceContent(getWorkspaceRole(board.workspace_id, req.userId!))) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  const { column_ids } = req.body || {};
  if (!Array.isArray(column_ids)) {
    res.status(400).json({ error: 'column_ids array required' });
    return;
  }
  db.transaction(() => {
    column_ids.forEach((cid: string, idx: number) => {
      db.prepare('UPDATE board_columns SET position = ? WHERE id = ? AND board_id = ?').run(idx, cid, req.params.boardId);
    });
  })();
  res.json({ ok: true });
});

app.delete('/api/columns/:columnId', requireAuth, (req: AuthedRequest, res) => {
  const col = db.prepare('SELECT c.*, p.workspace_id FROM board_columns c JOIN boards b ON b.id = c.board_id JOIN projects p ON p.id = b.project_id WHERE c.id = ?').get(req.params.columnId) as { board_id: string; workspace_id: string } | undefined;
  if (!col || !canEditWorkspaceContent(getWorkspaceRole(col.workspace_id, req.userId!))) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  const fallback = db.prepare('SELECT id, status_key FROM board_columns WHERE board_id = ? AND id != ? ORDER BY position ASC LIMIT 1').get(col.board_id, req.params.columnId) as { id: string; status_key: string } | undefined;
  if (!fallback) {
    res.status(400).json({ error: 'A board must keep at least one column.' });
    return;
  }
  db.transaction(() => {
    db.prepare('UPDATE tasks SET column_id = ?, status = ? WHERE column_id = ?').run(fallback.id, fallback.status_key, req.params.columnId);
    db.prepare('DELETE FROM board_columns WHERE id = ?').run(req.params.columnId);
  })();
  res.json({ ok: true });
});

// ==========================================
// TASKS, SUBTASKS, CHECKLISTS, COMMENTS, DEPENDENCIES
// ==========================================

app.get('/api/workspaces/:workspaceId/tasks', requireAuth, (req: AuthedRequest, res) => {
  const { workspaceId } = req.params;
  if (!getWorkspaceRole(workspaceId, req.userId!)) {
    res.status(403).json({ error: 'Access denied' });
    return;
  }
  const tasks = getHydratedTasks(workspaceId, {
    projectId: req.query.project_id ? String(req.query.project_id) : undefined,
    includeArchived: req.query.archived === '1',
    onlyTrash: req.query.trash === '1',
  });
  res.json({ tasks });
});

app.post('/api/workspaces/:workspaceId/tasks', requireAuth, (req: AuthedRequest, res) => {
  const { workspaceId } = req.params;
  if (!canEditWorkspaceContent(getWorkspaceRole(workspaceId, req.userId!))) {
    res.status(403).json({ error: 'Guests cannot create tasks.' });
    return;
  }
  const {
    project_id, column_id, title, description, status, priority, task_type,
    start_date, due_date, estimated_minutes, labels, assignee_ids, parent_task_id,
  } = req.body || {};

  if (!project_id || !title || typeof title !== 'string' || !title.trim()) {
    res.status(400).json({ error: 'Project and task title are required.' });
    return;
  }

  const project = db.prepare('SELECT id FROM projects WHERE id = ? AND workspace_id = ?').get(project_id, workspaceId);
  if (!project) {
    res.status(404).json({ error: 'Project not found in this workspace.' });
    return;
  }

  const board = db.prepare('SELECT id FROM boards WHERE project_id = ? LIMIT 1').get(project_id) as { id: string };
  let targetCol: { id: string; status_key: string } | undefined;

  if (column_id) {
    targetCol = db.prepare('SELECT id, status_key FROM board_columns WHERE id = ? AND board_id = ?').get(column_id, board.id) as { id: string; status_key: string } | undefined;
  }
  if (!targetCol && status) {
    targetCol = db.prepare('SELECT id, status_key FROM board_columns WHERE board_id = ? AND status_key = ? LIMIT 1').get(board.id, status) as { id: string; status_key: string } | undefined;
  }
  if (!targetCol) {
    targetCol = db.prepare('SELECT id, status_key FROM board_columns WHERE board_id = ? ORDER BY position ASC LIMIT 1').get(board.id) as { id: string; status_key: string };
  }

  const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) as m FROM tasks WHERE column_id = ?').get(targetCol.id) as { m: number };
  const taskId = crypto.randomUUID();
  const now = new Date().toISOString();
  const finalStatus = status || targetCol.status_key;

  db.transaction(() => {
    db.prepare(`
      INSERT INTO tasks (id, workspace_id, project_id, board_id, column_id, parent_task_id, title, description, status, priority, task_type, position, start_date, due_date, estimated_minutes, labels, is_demo, is_archived, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)
    `).run(
      taskId, workspaceId, project_id, board.id, targetCol!.id, parent_task_id || null,
      title.trim(), String(description || ''), finalStatus, String(priority || 'medium'),
      String(task_type || 'task'), maxPos.m + 1, start_date || null, due_date || null,
      Number(estimated_minutes || 0), JSON.stringify(Array.isArray(labels) ? labels : []),
      req.userId, now, now,
    );

    if (Array.isArray(assignee_ids)) {
      assignee_ids.forEach((uid: string, idx: number) => {
        db.prepare('INSERT OR IGNORE INTO task_assignees (id, task_id, user_id, is_primary, assigned_at) VALUES (?, ?, ?, ?, ?)').run(
          crypto.randomUUID(), taskId, uid, idx === 0 ? 1 : 0, now,
        );
        createNotification(workspaceId, uid, req.userId!, 'assignment', 'Assigned to task', `You were assigned to "${title.trim()}"`, 'task', taskId);
      });
    }

    logActivity(workspaceId, req.userId!, 'created_task', `Created task "${title.trim()}"`, project_id, taskId);
  })();

  res.status(201).json({ id: taskId });
});

app.get('/api/tasks/:taskId', requireAuth, (req: AuthedRequest, res) => {
  const { taskId } = req.params;
  const rows = db.prepare(`
    SELECT t.*, p.name as project_name, p.color as project_color,
      (SELECT COALESCE(SUM(te.duration_seconds), 0) FROM time_entries te WHERE te.task_id = t.id) as actual_seconds
    FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?
  `).get(taskId) as Record<string, unknown> | undefined;
  if (!rows) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  if (!getWorkspaceRole(String(rows.workspace_id), req.userId!)) {
    res.status(403).json({ error: 'Access denied' });
    return;
  }

  const assignees = db.prepare(`
    SELECT ta.user_id, ta.is_primary, u.full_name, u.avatar_url, u.job_title
    FROM task_assignees ta JOIN users u ON u.id = ta.user_id
    WHERE ta.task_id = ? ORDER BY ta.is_primary DESC
  `).all(taskId);

  const subtasks = db.prepare(`
    SELECT s.*, u.full_name as assignee_name
    FROM subtasks s LEFT JOIN users u ON u.id = s.assignee_id
    WHERE s.task_id = ? ORDER BY s.position ASC, s.created_at ASC
  `).all(taskId);

  const checklistsRaw = db.prepare('SELECT * FROM checklists WHERE task_id = ? ORDER BY position ASC').all(taskId) as Array<Record<string, unknown>>;
  const checklists = checklistsRaw.map((ch) => ({
    ...ch,
    items: db.prepare('SELECT * FROM checklist_items WHERE checklist_id = ? ORDER BY position ASC').all(ch.id),
  }));

  const dependencies = db.prepare(`
    SELECT d.id, d.task_id, d.related_task_id, d.dependency_type, t2.title as related_task_title, t2.status as related_task_status
    FROM task_dependencies d JOIN tasks t2 ON t2.id = d.related_task_id
    WHERE d.task_id = ?
  `).all(taskId);

  const commentsRaw = db.prepare(`
    SELECT c.*, u.full_name as author_name, u.avatar_url as author_avatar, u.job_title as author_job_title
    FROM comments c JOIN users u ON u.id = c.user_id
    WHERE c.task_id = ? ORDER BY c.created_at ASC
  `).all(taskId) as Array<Record<string, unknown>>;

  const comments = commentsRaw.map((c) => {
    const reactionsRaw = db.prepare(`
      SELECT emoji, COUNT(*) as count, MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END) as user_reacted
      FROM comment_reactions WHERE comment_id = ? GROUP BY emoji
    `).all(req.userId, c.id) as Array<{ emoji: string; count: number; user_reacted: number }>;
    const cAtts = db.prepare('SELECT * FROM attachments WHERE comment_id = ?').all(c.id);
    return {
      ...c,
      mentions: JSON.parse(String(c.mentions || '[]')),
      reactions: reactionsRaw.map((r) => ({ emoji: r.emoji, count: r.count, user_reacted: Boolean(r.user_reacted) })),
      attachments: cAtts,
    };
  });

  const attachments = db.prepare(`
    SELECT a.*, u.full_name as uploader_name
    FROM attachments a JOIN users u ON u.id = a.uploaded_by
    WHERE a.task_id = ? ORDER BY a.created_at DESC
  `).all(taskId);

  const timeEntries = db.prepare(`
    SELECT te.*, u.full_name as user_name
    FROM time_entries te JOIN users u ON u.id = te.user_id
    WHERE te.task_id = ? ORDER BY te.created_at DESC
  `).all(taskId);

  const activityLogs = db.prepare(`
    SELECT a.*, u.full_name as user_name, u.avatar_url as user_avatar
    FROM activity_logs a JOIN users u ON u.id = a.user_id
    WHERE a.task_id = ? ORDER BY a.created_at DESC LIMIT 30
  `).all(taskId);

  res.json({
    task: {
      ...rows,
      labels: JSON.parse(String(rows.labels || '[]')),
      assignees,
      subtasks,
      checklists,
      dependencies,
      comments,
      attachments,
      time_entries: timeEntries,
      activity_logs: activityLogs,
    },
  });
});

app.patch('/api/tasks/:taskId', requireAuth, (req: AuthedRequest, res) => {
  const { taskId } = req.params;
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined;
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  if (!canEditWorkspaceContent(getWorkspaceRole(String(task.workspace_id), req.userId!))) {
    res.status(403).json({ error: 'Permission denied' });
    return;
  }

  const now = new Date().toISOString();
  const next = { ...task };
  const editable = ['title', 'description', 'status', 'priority', 'task_type', 'column_id', 'position', 'start_date', 'due_date', 'estimated_minutes', 'is_archived'];
  for (const f of editable) {
    if (req.body[f] !== undefined) next[f] = req.body[f];
  }

  // Sync status <-> column_id cleanly when one changes
  if (req.body.column_id && !req.body.status) {
    const col = db.prepare('SELECT status_key FROM board_columns WHERE id = ?').get(req.body.column_id) as { status_key: string } | undefined;
    if (col) next.status = col.status_key;
  } else if (req.body.status && !req.body.column_id) {
    const col = db.prepare('SELECT id FROM board_columns WHERE board_id = ? AND status_key = ? LIMIT 1').get(task.board_id, req.body.status) as { id: string } | undefined;
    if (col) next.column_id = col.id;
  }

  const labelsJson = req.body.labels !== undefined
    ? JSON.stringify(Array.isArray(req.body.labels) ? req.body.labels : [])
    : String(task.labels);

  db.transaction(() => {
    db.prepare(`
      UPDATE tasks
      SET title = ?, description = ?, status = ?, priority = ?, task_type = ?, column_id = ?, position = ?,
          start_date = ?, due_date = ?, estimated_minutes = ?, labels = ?, is_archived = ?, updated_at = ?
      WHERE id = ?
    `).run(
      next.title, next.description, next.status, next.priority, next.task_type, next.column_id,
      Number(next.position || 0), next.start_date, next.due_date, Number(next.estimated_minutes || 0),
      labelsJson, next.is_archived ? 1 : 0, now, taskId,
    );

    if (Array.isArray(req.body.assignee_ids)) {
      const existing = db.prepare('SELECT user_id FROM task_assignees WHERE task_id = ?').all(taskId) as Array<{ user_id: string }>;
      const existingSet = new Set(existing.map((e) => e.user_id));
      db.prepare('DELETE FROM task_assignees WHERE task_id = ?').run(taskId);
      req.body.assignee_ids.forEach((uid: string, idx: number) => {
        db.prepare('INSERT OR IGNORE INTO task_assignees (id, task_id, user_id, is_primary, assigned_at) VALUES (?, ?, ?, ?, ?)').run(
          crypto.randomUUID(), taskId, uid, idx === 0 ? 1 : 0, now,
        );
        if (!existingSet.has(uid)) {
          createNotification(String(task.workspace_id), uid, req.userId!, 'assignment', 'Assigned to task', `You were assigned to "${next.title}"`, 'task', taskId);
        }
      });
    }

    if (next.status !== task.status) {
      const action = next.status === 'completed' ? 'completed_task' : 'updated_status';
      logActivity(String(task.workspace_id), req.userId!, action, `Moved "${next.title}" to ${String(next.status).replace('_', ' ')}`, String(task.project_id), taskId);
      const assignees = db.prepare('SELECT user_id FROM task_assignees WHERE task_id = ?').all(taskId) as Array<{ user_id: string }>;
      for (const a of assignees) {
        createNotification(String(task.workspace_id), a.user_id, req.userId!, 'status', 'Task status updated', `"${next.title}" moved to ${String(next.status).replace('_', ' ')}`, 'task', taskId);
      }
    } else if (next.due_date !== task.due_date) {
      logActivity(String(task.workspace_id), req.userId!, 'updated_deadline', `Updated deadline for "${next.title}"`, String(task.project_id), taskId);
    }
  })();

  res.json({ ok: true });
});

app.post('/api/workspaces/:workspaceId/tasks/bulk', requireAuth, (req: AuthedRequest, res) => {
  const { workspaceId } = req.params;
  if (!canEditWorkspaceContent(getWorkspaceRole(workspaceId, req.userId!))) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  const { task_ids, action, value } = req.body || {};
  if (!Array.isArray(task_ids) || task_ids.length === 0) {
    res.status(400).json({ error: 'task_ids required' });
    return;
  }
  const now = new Date().toISOString();

  db.transaction(() => {
    for (const tid of task_ids) {
      const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND workspace_id = ?').get(tid, workspaceId) as Record<string, unknown> | undefined;
      if (!task) continue;
      if (action === 'status') {
        const col = db.prepare('SELECT id FROM board_columns WHERE board_id = ? AND status_key = ? LIMIT 1').get(task.board_id, value) as { id: string } | undefined;
        db.prepare('UPDATE tasks SET status = ?, column_id = COALESCE(?, column_id), updated_at = ? WHERE id = ?').run(value, col?.id || null, now, tid);
      } else if (action === 'priority') {
        db.prepare('UPDATE tasks SET priority = ?, updated_at = ? WHERE id = ?').run(value, now, tid);
      } else if (action === 'due_date') {
        db.prepare('UPDATE tasks SET due_date = ?, updated_at = ? WHERE id = ?').run(value || null, now, tid);
      } else if (action === 'assign' && value) {
        db.prepare('INSERT OR IGNORE INTO task_assignees (id, task_id, user_id, is_primary, assigned_at) VALUES (?, ?, ?, 1, ?)').run(crypto.randomUUID(), tid, value, now);
      } else if (action === 'archive') {
        db.prepare('UPDATE tasks SET is_archived = 1, updated_at = ? WHERE id = ?').run(now, tid);
      } else if (action === 'delete') {
        db.prepare('UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, tid);
      }
    }
  })();

  res.json({ ok: true });
});

app.delete('/api/tasks/:taskId', requireAuth, (req: AuthedRequest, res) => {
  const { taskId } = req.params;
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined;
  if (!task || !canEditWorkspaceContent(getWorkspaceRole(String(task.workspace_id), req.userId!))) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  if (req.query.permanent === '1') {
    db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
  } else {
    db.prepare('UPDATE tasks SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), taskId);
  }
  res.json({ ok: true });
});

app.post('/api/tasks/:taskId/restore', requireAuth, (req: AuthedRequest, res) => {
  const task = db.prepare('SELECT workspace_id FROM tasks WHERE id = ?').get(req.params.taskId) as { workspace_id: string } | undefined;
  if (!task || !canEditWorkspaceContent(getWorkspaceRole(task.workspace_id, req.userId!))) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  db.prepare('UPDATE tasks SET deleted_at = NULL, is_archived = 0 WHERE id = ?').run(req.params.taskId);
  res.json({ ok: true });
});

// Subtasks
app.post('/api/tasks/:taskId/subtasks', requireAuth, (req: AuthedRequest, res) => {
  const task = db.prepare('SELECT workspace_id FROM tasks WHERE id = ?').get(req.params.taskId) as { workspace_id: string } | undefined;
  if (!task || !canEditWorkspaceContent(getWorkspaceRole(task.workspace_id, req.userId!))) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  const { title, assignee_id, due_date } = req.body || {};
  if (!title || !String(title).trim()) {
    res.status(400).json({ error: 'Subtask title required.' });
    return;
  }
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO subtasks (id, task_id, title, completed, assignee_id, due_date, position, created_at) VALUES (?, ?, ?, 0, ?, ?, 0, ?)').run(
    id, req.params.taskId, String(title).trim(), assignee_id || null, due_date || null, new Date().toISOString(),
  );
  res.status(201).json({ id });
});

app.patch('/api/subtasks/:subtaskId', requireAuth, (req: AuthedRequest, res) => {
  const sub = db.prepare('SELECT s.*, t.workspace_id FROM subtasks s JOIN tasks t ON t.id = s.task_id WHERE s.id = ?').get(req.params.subtaskId) as Record<string, unknown> | undefined;
  if (!sub || !canEditWorkspaceContent(getWorkspaceRole(String(sub.workspace_id), req.userId!))) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  db.prepare('UPDATE subtasks SET title = ?, completed = ?, assignee_id = ?, due_date = ? WHERE id = ?').run(
    req.body.title !== undefined ? String(req.body.title) : sub.title,
    req.body.completed !== undefined ? (req.body.completed ? 1 : 0) : sub.completed,
    req.body.assignee_id !== undefined ? req.body.assignee_id : sub.assignee_id,
    req.body.due_date !== undefined ? req.body.due_date : sub.due_date,
    req.params.subtaskId,
  );
  res.json({ ok: true });
});

app.delete('/api/subtasks/:subtaskId', requireAuth, (req: AuthedRequest, res) => {
  const sub = db.prepare('SELECT t.workspace_id FROM subtasks s JOIN tasks t ON t.id = s.task_id WHERE s.id = ?').get(req.params.subtaskId) as { workspace_id: string } | undefined;
  if (!sub || !canEditWorkspaceContent(getWorkspaceRole(sub.workspace_id, req.userId!))) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  db.prepare('DELETE FROM subtasks WHERE id = ?').run(req.params.subtaskId);
  res.json({ ok: true });
});

// Checklists & Items
app.post('/api/tasks/:taskId/checklists', requireAuth, (req: AuthedRequest, res) => {
  const task = db.prepare('SELECT workspace_id FROM tasks WHERE id = ?').get(req.params.taskId) as { workspace_id: string } | undefined;
  if (!task || !canEditWorkspaceContent(getWorkspaceRole(task.workspace_id, req.userId!))) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO checklists (id, task_id, title, position, created_at) VALUES (?, ?, ?, 0, ?)').run(
    id, req.params.taskId, String(req.body?.title || 'Checklist').trim(), new Date().toISOString(),
  );
  res.status(201).json({ id });
});

app.post('/api/checklists/:checklistId/items', requireAuth, (req: AuthedRequest, res) => {
  const ch = db.prepare('SELECT t.workspace_id FROM checklists c JOIN tasks t ON t.id = c.task_id WHERE c.id = ?').get(req.params.checklistId) as { workspace_id: string } | undefined;
  if (!ch || !canEditWorkspaceContent(getWorkspaceRole(ch.workspace_id, req.userId!))) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  const { text } = req.body || {};
  if (!text || !String(text).trim()) {
    res.status(400).json({ error: 'Checklist item text required.' });
    return;
  }
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO checklist_items (id, checklist_id, text, completed, position, created_at) VALUES (?, ?, ?, 0, 0, ?)').run(
    id, req.params.checklistId, String(text).trim(), new Date().toISOString(),
  );
  res.status(201).json({ id });
});

app.patch('/api/checklist-items/:itemId', requireAuth, (req: AuthedRequest, res) => {
  const ci = db.prepare('SELECT ci.*, t.workspace_id FROM checklist_items ci JOIN checklists c ON c.id = ci.checklist_id JOIN tasks t ON t.id = c.task_id WHERE ci.id = ?').get(req.params.itemId) as Record<string, unknown> | undefined;
  if (!ci || !canEditWorkspaceContent(getWorkspaceRole(String(ci.workspace_id), req.userId!))) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  db.prepare('UPDATE checklist_items SET completed = ?, text = ? WHERE id = ?').run(
    req.body.completed !== undefined ? (req.body.completed ? 1 : 0) : ci.completed,
    req.body.text !== undefined ? String(req.body.text) : ci.text,
    req.params.itemId,
  );
  res.json({ ok: true });
});

app.delete('/api/checklist-items/:itemId', requireAuth, (req: AuthedRequest, res) => {
  const ci = db.prepare('SELECT t.workspace_id FROM checklist_items ci JOIN checklists c ON c.id = ci.checklist_id JOIN tasks t ON t.id = c.task_id WHERE ci.id = ?').get(req.params.itemId) as { workspace_id: string } | undefined;
  if (!ci || !canEditWorkspaceContent(getWorkspaceRole(ci.workspace_id, req.userId!))) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  db.prepare('DELETE FROM checklist_items WHERE id = ?').run(req.params.itemId);
  res.json({ ok: true });
});

// Dependencies
app.post('/api/tasks/:taskId/dependencies', requireAuth, (req: AuthedRequest, res) => {
  const task = db.prepare('SELECT workspace_id FROM tasks WHERE id = ?').get(req.params.taskId) as { workspace_id: string } | undefined;
  if (!task || !canEditWorkspaceContent(getWorkspaceRole(task.workspace_id, req.userId!))) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  const { related_task_id, dependency_type } = req.body || {};
  if (!related_task_id || related_task_id === req.params.taskId) {
    res.status(400).json({ error: 'Select a different task to link.' });
    return;
  }
  const validType = ['blocking', 'blocked_by', 'related_to'].includes(dependency_type) ? dependency_type : 'related_to';
  const id = crypto.randomUUID();
  db.prepare('INSERT OR IGNORE INTO task_dependencies (id, task_id, related_task_id, dependency_type, created_at) VALUES (?, ?, ?, ?, ?)').run(
    id, req.params.taskId, related_task_id, validType, new Date().toISOString(),
  );
  res.status(201).json({ id });
});

app.delete('/api/dependencies/:depId', requireAuth, (req: AuthedRequest, res) => {
  const dep = db.prepare('SELECT t.workspace_id FROM task_dependencies d JOIN tasks t ON t.id = d.task_id WHERE d.id = ?').get(req.params.depId) as { workspace_id: string } | undefined;
  if (!dep || !canEditWorkspaceContent(getWorkspaceRole(dep.workspace_id, req.userId!))) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  db.prepare('DELETE FROM task_dependencies WHERE id = ?').run(req.params.depId);
  res.json({ ok: true });
});

// Comments & Reactions
app.post('/api/tasks/:taskId/comments', requireAuth, (req: AuthedRequest, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.taskId) as Record<string, unknown> | undefined;
  if (!task || !canEditWorkspaceContent(getWorkspaceRole(String(task.workspace_id), req.userId!))) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  const { body, parent_comment_id, mentions } = req.body || {};
  if (!body || !String(body).trim()) {
    res.status(400).json({ error: 'Comment text cannot be empty.' });
    return;
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const mentionList = Array.isArray(mentions) ? mentions : [];
  db.prepare('INSERT INTO comments (id, task_id, user_id, parent_comment_id, body, mentions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    id, req.params.taskId, req.userId, parent_comment_id || null, String(body).trim(), JSON.stringify(mentionList), now, now,
  );
  for (const uid of mentionList) {
    createNotification(String(task.workspace_id), uid, req.userId!, 'mention', 'Mentioned in comment', `Mentioned you on "${task.title}"`, 'task', req.params.taskId);
  }
  const assignees = db.prepare('SELECT user_id FROM task_assignees WHERE task_id = ?').all(req.params.taskId) as Array<{ user_id: string }>;
  for (const a of assignees) {
    if (!mentionList.includes(a.user_id)) {
      createNotification(String(task.workspace_id), a.user_id, req.userId!, 'comment', 'New task comment', `New comment on "${task.title}"`, 'task', req.params.taskId);
    }
  }
  logActivity(String(task.workspace_id), req.userId!, 'commented', `Commented on "${task.title}"`, String(task.project_id), req.params.taskId);
  res.status(201).json({ id });
});

app.patch('/api/comments/:commentId', requireAuth, (req: AuthedRequest, res) => {
  const c = db.prepare('SELECT * FROM comments WHERE id = ?').get(req.params.commentId) as { user_id: string } | undefined;
  if (!c || c.user_id !== req.userId) {
    res.status(403).json({ error: 'You can only edit your own comments.' });
    return;
  }
  db.prepare('UPDATE comments SET body = ?, updated_at = ? WHERE id = ?').run(String(req.body.body || '').trim(), new Date().toISOString(), req.params.commentId);
  res.json({ ok: true });
});

app.delete('/api/comments/:commentId', requireAuth, (req: AuthedRequest, res) => {
  const c = db.prepare('SELECT * FROM comments WHERE id = ?').get(req.params.commentId) as { user_id: string } | undefined;
  if (!c || c.user_id !== req.userId) {
    res.status(403).json({ error: 'You can only delete your own comments.' });
    return;
  }
  db.prepare('DELETE FROM comments WHERE id = ?').run(req.params.commentId);
  res.json({ ok: true });
});

app.post('/api/comments/:commentId/reactions', requireAuth, (req: AuthedRequest, res) => {
  const emoji = String(req.body?.emoji || '👍');
  const existing = db.prepare('SELECT id FROM comment_reactions WHERE comment_id = ? AND user_id = ? AND emoji = ?').get(req.params.commentId, req.userId, emoji) as { id: string } | undefined;
  if (existing) {
    db.prepare('DELETE FROM comment_reactions WHERE id = ?').run(existing.id);
  } else {
    db.prepare('INSERT INTO comment_reactions (id, comment_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?, ?)').run(
      crypto.randomUUID(), req.params.commentId, req.userId, emoji, new Date().toISOString(),
    );
  }
  res.json({ ok: true });
});

// ==========================================
// TIME TRACKING
// ==========================================

app.get('/api/workspaces/:workspaceId/time-entries', requireAuth, (req: AuthedRequest, res) => {
  const { workspaceId } = req.params;
  if (!getWorkspaceRole(workspaceId, req.userId!)) {
    res.status(403).json({ error: 'Access denied' });
    return;
  }
  const entries = db.prepare(`
    SELECT te.*, t.title as task_title, p.name as project_name, u.full_name as user_name
    FROM time_entries te
    JOIN tasks t ON t.id = te.task_id
    JOIN projects p ON p.id = te.project_id
    JOIN users u ON u.id = te.user_id
    WHERE te.workspace_id = ?
    ORDER BY te.created_at DESC
  `).all(workspaceId);
  res.json({ entries });
});

app.post('/api/tasks/:taskId/time-entries', requireAuth, (req: AuthedRequest, res) => {
  const task = db.prepare('SELECT workspace_id, project_id FROM tasks WHERE id = ?').get(req.params.taskId) as { workspace_id: string; project_id: string } | undefined;
  if (!task || !canEditWorkspaceContent(getWorkspaceRole(task.workspace_id, req.userId!))) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  const { description, duration_seconds, is_running } = req.body || {};
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO time_entries (id, workspace_id, project_id, task_id, user_id, description, duration_seconds, started_at, ended_at, is_running, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, task.workspace_id, task.project_id, req.params.taskId, req.userId,
    String(description || 'Focus session'), Number(duration_seconds || 0), now, is_running ? null : now, is_running ? 1 : 0, now,
  );
  res.status(201).json({ id });
});

app.patch('/api/time-entries/:entryId', requireAuth, (req: AuthedRequest, res) => {
  const entry = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(req.params.entryId) as Record<string, unknown> | undefined;
  if (!entry || entry.user_id !== req.userId) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  db.prepare('UPDATE time_entries SET duration_seconds = ?, is_running = ?, ended_at = ?, description = ? WHERE id = ?').run(
    req.body.duration_seconds !== undefined ? Number(req.body.duration_seconds) : entry.duration_seconds,
    req.body.is_running !== undefined ? (req.body.is_running ? 1 : 0) : entry.is_running,
    req.body.is_running === false ? new Date().toISOString() : entry.ended_at,
    req.body.description !== undefined ? String(req.body.description) : entry.description,
    req.params.entryId,
  );
  res.json({ ok: true });
});

app.delete('/api/time-entries/:entryId', requireAuth, (req: AuthedRequest, res) => {
  const entry = db.prepare('SELECT user_id FROM time_entries WHERE id = ?').get(req.params.entryId) as { user_id: string } | undefined;
  if (!entry || entry.user_id !== req.userId) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  db.prepare('DELETE FROM time_entries WHERE id = ?').run(req.params.entryId);
  res.json({ ok: true });
});

// ==========================================
// FILE ATTACHMENTS (WITH CONFINEMENT & VALIDATION)
// ==========================================

app.get('/api/workspaces/:workspaceId/files', requireAuth, (req: AuthedRequest, res) => {
  const { workspaceId } = req.params;
  if (!getWorkspaceRole(workspaceId, req.userId!)) {
    res.status(403).json({ error: 'Access denied' });
    return;
  }
  const files = db.prepare(`
    SELECT a.*, u.full_name as uploader_name, p.name as project_name, t.title as task_title
    FROM attachments a
    JOIN users u ON u.id = a.uploaded_by
    LEFT JOIN projects p ON p.id = a.project_id
    LEFT JOIN tasks t ON t.id = a.task_id
    WHERE a.workspace_id = ?
    ORDER BY a.created_at DESC
  `).all(workspaceId);
  res.json({ files });
});

app.post('/api/workspaces/:workspaceId/files', requireAuth, upload.single('file'), (req: AuthedRequest, res) => {
  const { workspaceId } = req.params;
  if (!canEditWorkspaceContent(getWorkspaceRole(workspaceId, req.userId!))) {
    if (req.file) fs.unlinkSync(req.file.path);
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  if (!req.file) {
    res.status(400).json({ error: 'No file uploaded.' });
    return;
  }
  const id = crypto.randomUUID();
  const projectId = req.body.project_id || null;
  const taskId = req.body.task_id || null;
  const commentId = req.body.comment_id || null;

  db.prepare(`
    INSERT INTO attachments (id, workspace_id, project_id, task_id, comment_id, uploaded_by, original_name, stored_name, mime_type, size_bytes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, workspaceId, projectId, taskId, commentId, req.userId,
    req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, new Date().toISOString(),
  );
  logActivity(workspaceId, req.userId!, 'uploaded_file', `Uploaded "${req.file.originalname}"`, projectId, taskId);
  res.status(201).json({ id, original_name: req.file.originalname, mime_type: req.file.mimetype, size_bytes: req.file.size });
});

app.get('/api/files/:fileId/download', requireAuth, (req: AuthedRequest, res) => {
  const att = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.fileId) as Record<string, unknown> | undefined;
  if (!att || !getWorkspaceRole(String(att.workspace_id), req.userId!)) {
    res.status(404).json({ error: 'File not found' });
    return;
  }
  const resolved = path.resolve(UPLOAD_DIR, path.basename(String(att.stored_name)));
  if (!resolved.startsWith(UPLOAD_DIR + path.sep) || !fs.existsSync(resolved)) {
    res.status(404).json({ error: 'File missing on disk' });
    return;
  }
  const inline = req.query.inline === '1';
  res.setHeader('Content-Type', String(att.mime_type || 'application/octet-stream'));
  res.setHeader(
    'Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename="${String(att.original_name).replace(/"/g, '')}"`,
  );
  res.sendFile(resolved);
});

app.patch('/api/files/:fileId', requireAuth, (req: AuthedRequest, res) => {
  const att = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.fileId) as Record<string, unknown> | undefined;
  if (!att || !canEditWorkspaceContent(getWorkspaceRole(String(att.workspace_id), req.userId!))) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  const nextName = String(req.body?.original_name || '').trim();
  if (!nextName) {
    res.status(400).json({ error: 'File name required.' });
    return;
  }
  db.prepare('UPDATE attachments SET original_name = ? WHERE id = ?').run(nextName, req.params.fileId);
  res.json({ ok: true });
});

app.delete('/api/files/:fileId', requireAuth, (req: AuthedRequest, res) => {
  const att = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.fileId) as Record<string, unknown> | undefined;
  if (!att || !canEditWorkspaceContent(getWorkspaceRole(String(att.workspace_id), req.userId!))) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  const resolved = path.resolve(UPLOAD_DIR, path.basename(String(att.stored_name)));
  if (resolved.startsWith(UPLOAD_DIR + path.sep) && fs.existsSync(resolved)) {
    fs.unlinkSync(resolved);
  }
  db.prepare('DELETE FROM attachments WHERE id = ?').run(req.params.fileId);
  res.json({ ok: true });
});

// ==========================================
// NOTIFICATIONS, ACTIVITY, TEMPLATES & SEARCH
// ==========================================

app.get('/api/workspaces/:workspaceId/notifications', requireAuth, (req: AuthedRequest, res) => {
  const { workspaceId } = req.params;
  if (!getWorkspaceRole(workspaceId, req.userId!)) {
    res.status(403).json({ error: 'Access denied' });
    return;
  }
  const notifications = db.prepare(`
    SELECT n.*, u.full_name as actor_name, u.avatar_url as actor_avatar
    FROM notifications n LEFT JOIN users u ON u.id = n.actor_id
    WHERE n.workspace_id = ? AND n.user_id = ?
    ORDER BY n.created_at DESC
  `).all(workspaceId, req.userId);
  res.json({ notifications });
});

app.patch('/api/notifications/:notifId/read', requireAuth, (req: AuthedRequest, res) => {
  db.prepare('UPDATE notifications SET is_read = ? WHERE id = ? AND user_id = ?').run(req.body?.is_read === false ? 0 : 1, req.params.notifId, req.userId);
  res.json({ ok: true });
});

app.post('/api/workspaces/:workspaceId/notifications/mark-all-read', requireAuth, (req: AuthedRequest, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE workspace_id = ? AND user_id = ?').run(req.params.workspaceId, req.userId);
  res.json({ ok: true });
});

app.delete('/api/notifications/:notifId', requireAuth, (req: AuthedRequest, res) => {
  db.prepare('DELETE FROM notifications WHERE id = ? AND user_id = ?').run(req.params.notifId, req.userId);
  res.json({ ok: true });
});

app.get('/api/workspaces/:workspaceId/activity', requireAuth, (req: AuthedRequest, res) => {
  const { workspaceId } = req.params;
  if (!getWorkspaceRole(workspaceId, req.userId!)) {
    res.status(403).json({ error: 'Access denied' });
    return;
  }
  const logs = db.prepare(`
    SELECT a.*, u.full_name as user_name, u.avatar_url as user_avatar, p.name as project_name, t.title as task_title
    FROM activity_logs a
    JOIN users u ON u.id = a.user_id
    LEFT JOIN projects p ON p.id = a.project_id
    LEFT JOIN tasks t ON t.id = a.task_id
    WHERE a.workspace_id = ?
    ORDER BY a.created_at DESC LIMIT 60
  `).all(workspaceId);
  res.json({ activity: logs });
});

app.get('/api/workspaces/:workspaceId/templates', requireAuth, (req: AuthedRequest, res) => {
  const { workspaceId } = req.params;
  if (!getWorkspaceRole(workspaceId, req.userId!)) {
    res.status(403).json({ error: 'Access denied' });
    return;
  }
  const rows = db.prepare(`
    SELECT * FROM project_templates WHERE is_system = 1 OR workspace_id = ? ORDER BY is_system DESC, created_at DESC
  `).all(workspaceId) as Array<Record<string, unknown>>;

  res.json({
    templates: rows.map((r) => ({
      id: r.id,
      workspace_id: r.workspace_id,
      name: r.name,
      category: r.category,
      description: r.description,
      color: r.color,
      columns: JSON.parse(String(r.columns_json)),
      sample_tasks: JSON.parse(String(r.sample_tasks_json)),
      is_system: r.is_system,
      created_at: r.created_at,
    })),
  });
});

app.post('/api/workspaces/:workspaceId/templates', requireAuth, (req: AuthedRequest, res) => {
  const { workspaceId } = req.params;
  if (!canEditWorkspaceContent(getWorkspaceRole(workspaceId, req.userId!))) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  const { project_id, name, category, description } = req.body || {};
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  let columns = SYSTEM_TEMPLATES[0].columns;
  let sampleTasks: Array<Record<string, unknown>> = [];
  let color = '#1B3B2B';

  if (project_id) {
    const p = db.prepare('SELECT * FROM projects WHERE id = ? AND workspace_id = ?').get(project_id, workspaceId) as Record<string, unknown> | undefined;
    if (p) {
      color = String(p.color);
      const board = db.prepare('SELECT id FROM boards WHERE project_id = ? LIMIT 1').get(project_id) as { id: string } | undefined;
      if (board) {
        const cols = db.prepare('SELECT name, status_key, color FROM board_columns WHERE board_id = ? ORDER BY position ASC').all(board.id) as typeof columns;
        if (cols.length > 0) columns = cols;
      }
      const pTasks = db.prepare('SELECT title, status as status_key, priority, labels, estimated_minutes FROM tasks WHERE project_id = ? AND deleted_at IS NULL LIMIT 10').all(project_id) as Array<Record<string, unknown>>;
      sampleTasks = pTasks.map((t) => ({
        title: t.title,
        status_key: t.status_key,
        priority: t.priority,
        labels: JSON.parse(String(t.labels || '[]')),
        estimated_minutes: t.estimated_minutes,
      }));
    }
  } else {
    if (Array.isArray(req.body.columns)) columns = req.body.columns;
    if (Array.isArray(req.body.sample_tasks)) sampleTasks = req.body.sample_tasks;
    if (req.body.color) color = String(req.body.color);
  }

  db.prepare(`
    INSERT INTO project_templates (id, workspace_id, name, category, description, color, columns_json, sample_tasks_json, is_system, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(
    id, workspaceId, String(name || 'Custom Template').trim(), String(category || 'Custom'),
    String(description || 'Saved custom project template'), color, JSON.stringify(columns), JSON.stringify(sampleTasks), req.userId, now,
  );
  res.status(201).json({ id });
});

app.get('/api/workspaces/:workspaceId/search', requireAuth, (req: AuthedRequest, res) => {
  const { workspaceId } = req.params;
  if (!getWorkspaceRole(workspaceId, req.userId!)) {
    res.status(403).json({ error: 'Access denied' });
    return;
  }
  const q = `%${String(req.query.q || '').trim().toLowerCase()}%`;
  if (q === '%%') {
    res.json({ projects: [], tasks: [], members: [], comments: [], files: [] });
    return;
  }

  const projects = db.prepare(`
    SELECT id, name, category, status, color FROM projects
    WHERE workspace_id = ? AND deleted_at IS NULL AND (LOWER(name) LIKE ? OR LOWER(description) LIKE ?) LIMIT 8
  `).all(workspaceId, q, q);

  const tasks = db.prepare(`
    SELECT t.id, t.title, t.status, t.priority, t.project_id, p.name as project_name
    FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE t.workspace_id = ? AND t.deleted_at IS NULL AND (LOWER(t.title) LIKE ? OR LOWER(t.description) LIKE ?) LIMIT 12
  `).all(workspaceId, q, q);

  const members = db.prepare(`
    SELECT u.id, u.full_name, u.email, u.job_title, u.avatar_url, wm.role
    FROM workspace_members wm JOIN users u ON u.id = wm.user_id
    WHERE wm.workspace_id = ? AND (LOWER(u.full_name) LIKE ? OR LOWER(u.email) LIKE ? OR LOWER(u.job_title) LIKE ?) LIMIT 8
  `).all(workspaceId, q, q, q);

  const comments = db.prepare(`
    SELECT c.id, c.task_id, c.body, t.title as task_title, u.full_name as author_name
    FROM comments c JOIN tasks t ON t.id = c.task_id JOIN users u ON u.id = c.user_id
    WHERE t.workspace_id = ? AND LOWER(c.body) LIKE ? LIMIT 8
  `).all(workspaceId, q);

  const files = db.prepare(`
    SELECT id, original_name, mime_type, size_bytes, project_id, task_id
    FROM attachments WHERE workspace_id = ? AND LOWER(original_name) LIKE ? LIMIT 8
  `).all(workspaceId, q);

  res.json({ projects, tasks, members, comments, files });
});

// Multer & global API error handler
app.use((err: Error, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err) {
    res.status(400).json({ error: err.message || 'Request failed' });
    return;
  }
  next();
});

// ==========================================
// VITE DEV / PRODUCTION STATIC SERVING
// ==========================================

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Trellas server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
