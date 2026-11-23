import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { hashPassword } from './auth.ts';
import { db, UPLOAD_DIR } from './db.ts';

function isoDayOffset(days: number): string {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function isoHourOffset(hours: number): string {
  const d = new Date();
  d.setHours(d.getHours() + hours);
  return d.toISOString();
}

export const SYSTEM_TEMPLATES = [
  {
    id: 'tpl-website-dev',
    name: 'Website Development',
    category: 'Design & Web',
    description: 'End-to-end site architecture, CMS migration, QA passes, and launch checklist.',
    color: '#1B3B2B',
    columns: [
      { name: 'Backlog', status_key: 'backlog', color: '#64748B' },
      { name: 'To Do', status_key: 'todo', color: '#3B82F6' },
      { name: 'In Progress', status_key: 'in_progress', color: '#C99A4E' },
      { name: 'In Review', status_key: 'in_review', color: '#8B5CF6' },
      { name: 'Completed', status_key: 'completed', color: '#16A34A' },
    ],
    sample_tasks: [
      { title: 'Information architecture & sitemap sign-off', status_key: 'completed', priority: 'high', labels: ['Strategy'], estimated_minutes: 120 },
      { title: 'Wireframe homepage and pricing matrix', status_key: 'in_review', priority: 'high', labels: ['Design'], estimated_minutes: 240 },
      { title: 'Build responsive navigation & keyboard menu', status_key: 'in_progress', priority: 'urgent', labels: ['Engineering'], estimated_minutes: 180 },
      { title: 'Migrate blog content to structured CMS', status_key: 'todo', priority: 'medium', labels: ['Content'], estimated_minutes: 150 },
      { title: 'Cross-browser Safari & mobile QA pass', status_key: 'backlog', priority: 'medium', labels: ['QA'], estimated_minutes: 90 },
    ],
  },
  {
    id: 'tpl-software-dev',
    name: 'Software Development',
    category: 'Engineering',
    description: 'Sprint-ready engineering workflow with backlog triage, review, and release gates.',
    color: '#1E40AF',
    columns: [
      { name: 'Backlog', status_key: 'backlog', color: '#64748B' },
      { name: 'To Do', status_key: 'todo', color: '#3B82F6' },
      { name: 'In Progress', status_key: 'in_progress', color: '#C99A4E' },
      { name: 'In Review', status_key: 'in_review', color: '#8B5CF6' },
      { name: 'Completed', status_key: 'completed', color: '#16A34A' },
    ],
    sample_tasks: [
      { title: 'Draft API schema & auth token rotation RFC', status_key: 'completed', priority: 'high', labels: ['Backend'], estimated_minutes: 180 },
      { title: 'Implement rate-limiting middleware', status_key: 'in_progress', priority: 'urgent', labels: ['Security'], estimated_minutes: 240 },
      { title: 'Write integration test suite for webhooks', status_key: 'todo', priority: 'medium', labels: ['Testing'], estimated_minutes: 150 },
      { title: 'Optimize database query indexes', status_key: 'backlog', priority: 'low', labels: ['Performance'], estimated_minutes: 120 },
    ],
  },
  {
    id: 'tpl-marketing-campaign',
    name: 'Marketing Campaign',
    category: 'Marketing',
    description: 'Coordinate creative briefs, ad assets, lifecycle emails, and launch attribution.',
    color: '#9333EA',
    columns: [
      { name: 'Backlog', status_key: 'backlog', color: '#64748B' },
      { name: 'To Do', status_key: 'todo', color: '#3B82F6' },
      { name: 'In Progress', status_key: 'in_progress', color: '#C99A4E' },
      { name: 'In Review', status_key: 'in_review', color: '#8B5CF6' },
      { name: 'Completed', status_key: 'completed', color: '#16A34A' },
    ],
    sample_tasks: [
      { title: 'Finalize Q4 campaign messaging & positioning', status_key: 'completed', priority: 'high', labels: ['Copy'], estimated_minutes: 120 },
      { title: 'Produce social launch video cutdowns', status_key: 'in_progress', priority: 'high', labels: ['Creative'], estimated_minutes: 300 },
      { title: 'Configure UTM tracking & landing conversion goals', status_key: 'todo', priority: 'medium', labels: ['Analytics'], estimated_minutes: 90 },
    ],
  },
  {
    id: 'tpl-business-ops',
    name: 'Business Operations',
    category: 'Operations',
    description: 'Standard operating procedures, vendor reviews, compliance, and quarterly planning.',
    color: '#0F766E',
    columns: [
      { name: 'Backlog', status_key: 'backlog', color: '#64748B' },
      { name: 'To Do', status_key: 'todo', color: '#3B82F6' },
      { name: 'In Progress', status_key: 'in_progress', color: '#C99A4E' },
      { name: 'In Review', status_key: 'in_review', color: '#8B5CF6' },
      { name: 'Completed', status_key: 'completed', color: '#16A34A' },
    ],
    sample_tasks: [
      { title: 'Annual software vendor renewal audit', status_key: 'in_progress', priority: 'high', labels: ['Finance'], estimated_minutes: 180 },
      { title: 'Update employee onboarding handbook', status_key: 'todo', priority: 'medium', labels: ['People'], estimated_minutes: 120 },
    ],
  },
  {
    id: 'tpl-product-launch',
    name: 'Product Launch',
    category: 'Product',
    description: 'Cross-functional launch tracker uniting product, engineering, docs, and GTM.',
    color: '#B45309',
    columns: [
      { name: 'Backlog', status_key: 'backlog', color: '#64748B' },
      { name: 'To Do', status_key: 'todo', color: '#3B82F6' },
      { name: 'In Progress', status_key: 'in_progress', color: '#C99A4E' },
      { name: 'In Review', status_key: 'in_review', color: '#8B5CF6' },
      { name: 'Completed', status_key: 'completed', color: '#16A34A' },
    ],
    sample_tasks: [
      { title: 'Publish changelog & customer release notes', status_key: 'todo', priority: 'high', labels: ['Docs'], estimated_minutes: 90 },
      { title: 'Coordinate beta customer feedback interviews', status_key: 'in_progress', priority: 'high', labels: ['Research'], estimated_minutes: 180 },
    ],
  },
  {
    id: 'tpl-event-planning',
    name: 'Event Planning',
    category: 'Events',
    description: 'Manage venue logistics, speaker outreach, catering, and attendee check-in.',
    color: '#BE123C',
    columns: [
      { name: 'Backlog', status_key: 'backlog', color: '#64748B' },
      { name: 'To Do', status_key: 'todo', color: '#3B82F6' },
      { name: 'In Progress', status_key: 'in_progress', color: '#C99A4E' },
      { name: 'In Review', status_key: 'in_review', color: '#8B5CF6' },
      { name: 'Completed', status_key: 'completed', color: '#16A34A' },
    ],
    sample_tasks: [
      { title: 'Confirm keynote speaker travel & AV requirements', status_key: 'in_progress', priority: 'urgent', labels: ['Logistics'], estimated_minutes: 120 },
      { title: 'Send calendar invites and registration confirmation', status_key: 'todo', priority: 'medium', labels: ['Comms'], estimated_minutes: 60 },
    ],
  },
  {
    id: 'tpl-content-calendar',
    name: 'Content Calendar',
    category: 'Editorial',
    description: 'Editorial pipeline from pitch and outline to editing, SEO review, and publish.',
    color: '#4338CA',
    columns: [
      { name: 'Backlog', status_key: 'backlog', color: '#64748B' },
      { name: 'To Do', status_key: 'todo', color: '#3B82F6' },
      { name: 'In Progress', status_key: 'in_progress', color: '#C99A4E' },
      { name: 'In Review', status_key: 'in_review', color: '#8B5CF6' },
      { name: 'Completed', status_key: 'completed', color: '#16A34A' },
    ],
    sample_tasks: [
      { title: 'Write Q4 customer case study: Northstar', status_key: 'in_progress', priority: 'high', labels: ['Editorial'], estimated_minutes: 210 },
      { title: 'Design social preview graphics', status_key: 'todo', priority: 'medium', labels: ['Design'], estimated_minutes: 90 },
    ],
  },
  {
    id: 'tpl-personal-prod',
    name: 'Personal Productivity',
    category: 'Personal',
    description: 'Keep weekly priorities, deep work blocks, and personal goals cleanly organized.',
    color: '#15803D',
    columns: [
      { name: 'Backlog', status_key: 'backlog', color: '#64748B' },
      { name: 'To Do', status_key: 'todo', color: '#3B82F6' },
      { name: 'In Progress', status_key: 'in_progress', color: '#C99A4E' },
      { name: 'In Review', status_key: 'in_review', color: '#8B5CF6' },
      { name: 'Completed', status_key: 'completed', color: '#16A34A' },
    ],
    sample_tasks: [
      { title: 'Weekly planning & inbox zero review', status_key: 'todo', priority: 'medium', labels: ['Routine'], estimated_minutes: 45 },
      { title: 'Read architectural design specification', status_key: 'in_progress', priority: 'low', labels: ['Focus'], estimated_minutes: 60 },
    ],
  },
];

export function seedSystemTemplates(): void {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO project_templates (id, workspace_id, name, category, description, color, columns_json, sample_tasks_json, is_system, created_by, created_at)
    VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 1, NULL, ?)
  `);
  for (const t of SYSTEM_TEMPLATES) {
    stmt.run(
      t.id,
      t.name,
      t.category,
      t.description,
      t.color,
      JSON.stringify(t.columns),
      JSON.stringify(t.sample_tasks),
      now,
    );
  }
}

export function seedDemoDataIfEmpty(): void {
  seedSystemTemplates();

  const existingUsers = db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number };
  if (existingUsers.c > 0) return;

  const now = new Date().toISOString();
  const demoPasswordHash = hashPassword('TrellasDemo2026!');

  const users = [
    {
      id: 'usr-maya',
      email: 'maya@trellas.app',
      full_name: 'Maya Chen',
      avatar_url: '/src/assets/images/avatar_maya_chen_1795389987021.jpg',
      job_title: 'Head of Product Design',
      department: 'Design',
      bio: 'Designing calm, focused productivity software and leading design systems at Northstar Studio.',
      timezone: 'America/Los_Angeles',
    },
    {
      id: 'usr-julian',
      email: 'julian@trellas.app',
      full_name: 'Julian Wright',
      avatar_url: '/src/assets/images/avatar_julian_wright_1795389986590.jpg',
      job_title: 'Staff Frontend Engineer',
      department: 'Engineering',
      bio: 'Focused on web performance, accessible UI components, and real-time collaboration interfaces.',
      timezone: 'Europe/London',
    },
    {
      id: 'usr-priya',
      email: 'priya@trellas.app',
      full_name: 'Priya Rao',
      avatar_url: '/src/assets/images/avatar_priya_rao_1795389986691.jpg',
      job_title: 'Engineering Manager',
      department: 'Engineering',
      bio: 'Leading platform reliability, delivery cadence, and cross-functional engineering squads.',
      timezone: 'America/New_York',
    },
    {
      id: 'usr-theo',
      email: 'theo@trellas.app',
      full_name: 'Theo Silva',
      avatar_url: '/src/assets/images/avatar_theo_silva_1795389986722.jpg',
      job_title: 'Product Marketing Lead',
      department: 'Marketing',
      bio: 'Bringing clarity to product launches, customer storytelling, and GTM operations.',
      timezone: 'America/Chicago',
    },
  ];

  const insertUser = db.prepare(`
    INSERT INTO users (id, email, password_hash, full_name, avatar_url, job_title, department, bio, timezone, email_verified, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `);
  const insertPref = db.prepare(`
    INSERT INTO user_preferences (user_id, theme, language, date_format, time_format, notify_assignments, notify_mentions, notify_comments, notify_deadlines, notify_updates, sidebar_collapsed, pinned_pages, updated_at)
    VALUES (?, 'light', 'en-US', 'MMM d, yyyy', '12h', 1, 1, 1, 1, 1, 0, '["dashboard","my-tasks","projects","reports"]', ?)
  `);

  for (const u of users) {
    insertUser.run(u.id, u.email, demoPasswordHash, u.full_name, u.avatar_url, u.job_title, u.department, u.bio, u.timezone, now, now);
    insertPref.run(u.id, now);
  }

  // Two Workspaces for realistic multi-workspace switching
  db.prepare(`
    INSERT INTO workspaces (id, name, slug, description, logo_color, logo_initials, owner_id, plan, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'ws-northstar',
    'Northstar Studio',
    'northstar-studio',
    'Primary product, design, and engineering studio workspace.',
    '#1B3B2B',
    'NS',
    'usr-maya',
    'business',
    now,
    now,
  );

  db.prepare(`
    INSERT INTO workspaces (id, name, slug, description, logo_color, logo_initials, owner_id, plan, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'ws-personal',
    'Personal Focus',
    'personal-focus',
    'Maya personal planning and side-project sandbox.',
    '#3B5998',
    'PF',
    'usr-maya',
    'pro',
    now,
    now,
  );

  const insertWsMember = db.prepare(`
    INSERT INTO workspace_members (id, workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?, ?)
  `);
  insertWsMember.run('wm-1', 'ws-northstar', 'usr-maya', 'owner', now);
  insertWsMember.run('wm-2', 'ws-northstar', 'usr-priya', 'admin', now);
  insertWsMember.run('wm-3', 'ws-northstar', 'usr-julian', 'project_manager', now);
  insertWsMember.run('wm-4', 'ws-northstar', 'usr-theo', 'member', now);
  insertWsMember.run('wm-5', 'ws-personal', 'usr-maya', 'owner', now);

  // Sample pending workspace invitation
  db.prepare(`
    INSERT INTO workspace_invitations (id, workspace_id, email, role, invited_by, status, token, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run('inv-1', 'ws-northstar', 'elena.vance@northstar.io', 'member', 'usr-maya', crypto.randomBytes(12).toString('hex'), now);

  // 5 Realistic Projects in Northstar + 1 in Personal
  const projects = [
    {
      id: 'prj-website',
      workspace_id: 'ws-northstar',
      name: 'Website Redesign',
      description: 'Complete marketing site relaunch with calm editorial typography, updated pricing, and interactive product tours.',
      color: '#1B3B2B',
      category: 'Design & Web',
      status: 'in_progress',
      priority: 'urgent',
      owner_id: 'usr-maya',
      manager_id: 'usr-maya',
      start_date: isoDayOffset(-18),
      due_date: isoDayOffset(12),
      is_pinned: 1,
    },
    {
      id: 'prj-mobile',
      workspace_id: 'ws-northstar',
      name: 'Mobile Application Development',
      description: 'Native iOS and Android companion app supporting offline task capture, push alerts, and quick board triage.',
      color: '#2563EB',
      category: 'Engineering',
      status: 'in_progress',
      priority: 'high',
      owner_id: 'usr-priya',
      manager_id: 'usr-julian',
      start_date: isoDayOffset(-25),
      due_date: isoDayOffset(28),
      is_pinned: 1,
    },
    {
      id: 'prj-marketing',
      workspace_id: 'ws-northstar',
      name: 'Marketing Campaign',
      description: 'Q4 customer acquisition push across organic editorial, partner webinars, and lifecycle onboarding emails.',
      color: '#7C3AED',
      category: 'Marketing',
      status: 'in_progress',
      priority: 'high',
      owner_id: 'usr-theo',
      manager_id: 'usr-theo',
      start_date: isoDayOffset(-10),
      due_date: isoDayOffset(18),
      is_pinned: 0,
    },
    {
      id: 'prj-launch',
      workspace_id: 'ws-northstar',
      name: 'Product Launch',
      description: 'Coordinated v2.4 workspace release across customer docs, changelog announcements, and beta migration.',
      color: '#C99A4E',
      category: 'Product',
      status: 'planning',
      priority: 'medium',
      owner_id: 'usr-maya',
      manager_id: 'usr-priya',
      start_date: isoDayOffset(-4),
      due_date: isoDayOffset(35),
      is_pinned: 0,
    },
    {
      id: 'prj-ops',
      workspace_id: 'ws-northstar',
      name: 'Business Operations',
      description: 'SOC2 readiness documentation, quarterly vendor audits, and new-hire workspace onboarding playbooks.',
      color: '#0F766E',
      category: 'Operations',
      status: 'completed',
      priority: 'low',
      owner_id: 'usr-priya',
      manager_id: 'usr-priya',
      start_date: isoDayOffset(-45),
      due_date: isoDayOffset(-3),
      is_pinned: 0,
    },
    {
      id: 'prj-personal-1',
      workspace_id: 'ws-personal',
      name: 'Q4 Reading & Deep Work',
      description: 'Personal research notes, design book highlights, and weekly reflection routines.',
      color: '#1B3B2B',
      category: 'Personal',
      status: 'in_progress',
      priority: 'medium',
      owner_id: 'usr-maya',
      manager_id: 'usr-maya',
      start_date: isoDayOffset(-7),
      due_date: isoDayOffset(21),
      is_pinned: 1,
    },
  ];

  const insertProject = db.prepare(`
    INSERT INTO projects (id, workspace_id, name, description, color, category, status, priority, owner_id, manager_id, start_date, due_date, is_pinned, is_archived, is_demo, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)
  `);
  const insertProjMember = db.prepare(`
    INSERT INTO project_members (id, project_id, user_id, role, added_at) VALUES (?, ?, ?, ?, ?)
  `);
  const insertBoard = db.prepare(`
    INSERT INTO boards (id, project_id, name, created_at) VALUES (?, ?, 'Main Board', ?)
  `);
  const insertCol = db.prepare(`
    INSERT INTO board_columns (id, board_id, name, position, color, status_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const defaultCols = [
    { suffix: 'backlog', name: 'Backlog', pos: 0, color: '#64748B', status_key: 'backlog' },
    { suffix: 'todo', name: 'To Do', pos: 1, color: '#3B82F6', status_key: 'todo' },
    { suffix: 'in_progress', name: 'In Progress', pos: 2, color: '#C99A4E', status_key: 'in_progress' },
    { suffix: 'in_review', name: 'In Review', pos: 3, color: '#8B5CF6', status_key: 'in_review' },
    { suffix: 'completed', name: 'Completed', pos: 4, color: '#16A34A', status_key: 'completed' },
  ];

  const colLookup: Record<string, Record<string, string>> = {};

  for (const p of projects) {
    insertProject.run(
      p.id, p.workspace_id, p.name, p.description, p.color, p.category,
      p.status, p.priority, p.owner_id, p.manager_id, p.start_date, p.due_date,
      p.is_pinned, now, now,
    );
    const boardId = `brd-${p.id}`;
    insertBoard.run(boardId, p.id, now);
    colLookup[p.id] = {};
    for (const c of defaultCols) {
      const colId = `col-${p.id}-${c.suffix}`;
      insertCol.run(colId, boardId, c.name, c.pos, c.color, c.status_key, now);
      colLookup[p.id][c.status_key] = colId;
    }

    if (p.workspace_id === 'ws-northstar') {
      insertProjMember.run(`pm-${p.id}-maya`, p.id, 'usr-maya', p.manager_id === 'usr-maya' ? 'lead' : 'member', now);
      insertProjMember.run(`pm-${p.id}-julian`, p.id, 'usr-julian', p.manager_id === 'usr-julian' ? 'lead' : 'member', now);
      insertProjMember.run(`pm-${p.id}-priya`, p.id, 'usr-priya', p.manager_id === 'usr-priya' ? 'lead' : 'member', now);
      insertProjMember.run(`pm-${p.id}-theo`, p.id, 'usr-theo', p.manager_id === 'usr-theo' ? 'lead' : 'member', now);
    } else {
      insertProjMember.run(`pm-${p.id}-maya`, p.id, 'usr-maya', 'lead', now);
    }
  }

  // Milestones
  const insertMilestone = db.prepare(`
    INSERT INTO project_milestones (id, project_id, title, description, due_date, completed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insertMilestone.run('ms-1', 'prj-website', 'Design System Freeze', 'Final sign-off on typography, color tokens, and landing components.', isoDayOffset(-3), 1, now);
  insertMilestone.run('ms-2', 'prj-website', 'Public Website Cutover', 'DNS switch, redirects verified, and production smoke test.', isoDayOffset(12), 0, now);
  insertMilestone.run('ms-3', 'prj-mobile', 'TestFlight Beta Release', 'Internal dogfooding build distributed to all team members.', isoDayOffset(9), 0, now);
  insertMilestone.run('ms-4', 'prj-marketing', 'Campaign Launch Day', 'Email sequences, landing pages, and social announcements live.', isoDayOffset(14), 0, now);

  // Project Discussions
  const insertDisc = db.prepare(`
    INSERT INTO project_discussions (id, project_id, user_id, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insertDisc.run(
    'disc-1',
    'prj-website',
    'usr-maya',
    'Editorial typography & contrast verification',
    'We settled on Fraunces for hero headlines paired with Plus Jakarta Sans for interface controls. Contrast ratios across both light ivory and dark charcoal modes pass 4.5:1.',
    isoHourOffset(-28),
    isoHourOffset(-28),
  );
  insertDisc.run(
    'disc-2',
    'prj-website',
    'usr-julian',
    'Redirect map for legacy /blog URLs',
    'All 48 legacy marketing URLs have been mapped to the new /journal routes. QA pass on Safari and mobile viewport will wrap up today.',
    isoHourOffset(-6),
    isoHourOffset(-6),
  );

  // Rich Tasks across Today, Upcoming, Overdue, Completed
  const tasks = [
    // Website Redesign
    {
      id: 'tsk-1', workspace_id: 'ws-northstar', project_id: 'prj-website',
      title: 'Migrate blog content to the new CMS',
      description: 'Export 42 existing editorial posts, normalize frontmatter tags, and verify canonical image paths in the new CMS.',
      status: 'todo', priority: 'medium', task_type: 'task', position: 0,
      start_date: isoDayOffset(-1), due_date: isoDayOffset(3), estimated_minutes: 180,
      labels: ['Content', 'CMS'], assignees: ['usr-theo', 'usr-maya'], created_by: 'usr-maya',
    },
    {
      id: 'tsk-2', workspace_id: 'ws-northstar', project_id: 'prj-website',
      title: 'QA pass on Safari and mobile',
      description: 'Test sticky navigation height, drawer transitions, and touch targets at 390px and 768px breakpoints.',
      status: 'todo', priority: 'high', task_type: 'bug', position: 1,
      start_date: isoDayOffset(-4), due_date: isoDayOffset(-1), estimated_minutes: 120,
      labels: ['Bug', 'QA'], assignees: ['usr-julian'], created_by: 'usr-priya',
    },
    {
      id: 'tsk-3', workspace_id: 'ws-northstar', project_id: 'prj-website',
      title: 'Build the responsive navigation',
      description: 'Implement collapsible mobile drawer, keyboard focus trap, and crisp single-line top bar contract.',
      status: 'in_progress', priority: 'urgent', task_type: 'feature', position: 0,
      start_date: isoDayOffset(-2), due_date: isoDayOffset(0), estimated_minutes: 240,
      labels: ['Engineering', 'UI'], assignees: ['usr-julian', 'usr-maya'], created_by: 'usr-maya',
    },
    {
      id: 'tsk-4', workspace_id: 'ws-northstar', project_id: 'prj-website',
      title: 'Set up the redirect map',
      description: 'Configure 301 redirect rules for legacy landing pages and verify zero 404 regressions.',
      status: 'in_progress', priority: 'low', task_type: 'task', position: 1,
      start_date: isoDayOffset(-1), due_date: isoDayOffset(2), estimated_minutes: 90,
      labels: ['Engineering', 'SEO'], assignees: ['usr-priya'], created_by: 'usr-julian',
    },
    {
      id: 'tsk-5', workspace_id: 'ws-northstar', project_id: 'prj-website',
      title: 'Wireframe homepage and pricing',
      description: 'Finalize hero interactive preview layout, pricing tier comparison table, and FAQ accordion copy.',
      status: 'in_review', priority: 'high', task_type: 'feature', position: 0,
      start_date: isoDayOffset(-5), due_date: isoDayOffset(0), estimated_minutes: 210,
      labels: ['Design'], assignees: ['usr-maya'], created_by: 'usr-maya',
    },
    {
      id: 'tsk-6', workspace_id: 'ws-northstar', project_id: 'prj-website',
      title: 'Audit Core Web Vitals & font loading',
      description: 'Preconnect Google Fonts, eliminate layout shift on hero card render, and verify <1.2s LCP.',
      status: 'completed', priority: 'medium', task_type: 'task', position: 0,
      start_date: isoDayOffset(-8), due_date: isoDayOffset(-2), estimated_minutes: 120,
      labels: ['Performance'], assignees: ['usr-julian'], created_by: 'usr-priya',
    },
    {
      id: 'tsk-7', workspace_id: 'ws-northstar', project_id: 'prj-website',
      title: 'Draft privacy & cookie preference modal',
      description: 'Create calm, accessible consent banner matching the warm ivory visual language.',
      status: 'backlog', priority: 'low', task_type: 'task', position: 0,
      start_date: isoDayOffset(4), due_date: isoDayOffset(9), estimated_minutes: 90,
      labels: ['Legal', 'UI'], assignees: ['usr-theo'], created_by: 'usr-maya',
    },

    // Mobile Application Development
    {
      id: 'tsk-8', workspace_id: 'ws-northstar', project_id: 'prj-mobile',
      title: 'Implement offline SQLite task cache sync',
      description: 'Queue optimistic task status changes while offline and reconcile with server timestamps upon reconnect.',
      status: 'in_progress', priority: 'urgent', task_type: 'feature', position: 0,
      start_date: isoDayOffset(-3), due_date: isoDayOffset(0), estimated_minutes: 360,
      labels: ['Mobile', 'Sync'], assignees: ['usr-julian', 'usr-priya'], created_by: 'usr-priya',
    },
    {
      id: 'tsk-9', workspace_id: 'ws-northstar', project_id: 'prj-mobile',
      title: 'Design swipe-to-complete gesture interactions',
      description: 'Prototype tactile card swipe physics and haptic confirmation thresholds for iOS and Android.',
      status: 'in_review', priority: 'high', task_type: 'feature', position: 0,
      start_date: isoDayOffset(-6), due_date: isoDayOffset(-2), estimated_minutes: 180,
      labels: ['Design', 'Mobile'], assignees: ['usr-maya'], created_by: 'usr-maya',
    },
    {
      id: 'tsk-10', workspace_id: 'ws-northstar', project_id: 'prj-mobile',
      title: 'Configure APNs & FCM push notification keys',
      description: 'Provision notification certificates and test deep linking directly into task detail drawers.',
      status: 'todo', priority: 'high', task_type: 'task', position: 0,
      start_date: isoDayOffset(1), due_date: isoDayOffset(5), estimated_minutes: 150,
      labels: ['Infra', 'Mobile'], assignees: ['usr-priya'], created_by: 'usr-priya',
    },
    {
      id: 'tsk-11', workspace_id: 'ws-northstar', project_id: 'prj-mobile',
      title: 'App Store & Play Store screenshot kit',
      description: 'Render device showcase frames highlighting Board, Calendar, and Inbox views.',
      status: 'backlog', priority: 'medium', task_type: 'task', position: 0,
      start_date: isoDayOffset(6), due_date: isoDayOffset(15), estimated_minutes: 180,
      labels: ['Design', 'Marketing'], assignees: ['usr-maya', 'usr-theo'], created_by: 'usr-theo',
    },

    // Marketing Campaign
    {
      id: 'tsk-12', workspace_id: 'ws-northstar', project_id: 'prj-marketing',
      title: 'Publish customer spotlight interview series',
      description: 'Edit and schedule 3 founder stories showing how small studios replaced 5 tools with Trellas.',
      status: 'in_progress', priority: 'high', task_type: 'story', position: 0,
      start_date: isoDayOffset(-2), due_date: isoDayOffset(1), estimated_minutes: 240,
      labels: ['Content', 'Campaign'], assignees: ['usr-theo'], created_by: 'usr-theo',
    },
    {
      id: 'tsk-13', workspace_id: 'ws-northstar', project_id: 'prj-marketing',
      title: 'Set up lifecycle onboarding email drip',
      description: 'Write 4 concise emails guiding new workspace owners from template setup to first team invite.',
      status: 'todo', priority: 'medium', task_type: 'task', position: 0,
      start_date: isoDayOffset(0), due_date: isoDayOffset(4), estimated_minutes: 150,
      labels: ['Email', 'Growth'], assignees: ['usr-theo', 'usr-maya'], created_by: 'usr-maya',
    },
    {
      id: 'tsk-14', workspace_id: 'ws-northstar', project_id: 'prj-marketing',
      title: 'Review Q4 paid search keyword exclusions',
      description: 'Eliminate low-intent broad match terms and reallocate budget to project template queries.',
      status: 'completed', priority: 'medium', task_type: 'task', position: 0,
      start_date: isoDayOffset(-10), due_date: isoDayOffset(-4), estimated_minutes: 90,
      labels: ['Analytics'], assignees: ['usr-theo'], created_by: 'usr-theo',
    },

    // Product Launch
    {
      id: 'tsk-15', workspace_id: 'ws-northstar', project_id: 'prj-launch',
      title: 'Prepare v2.4 release notes & migration guide',
      description: 'Document new Gantt timeline dragging, bulk task actions, and workspace role permissions.',
      status: 'todo', priority: 'high', task_type: 'task', position: 0,
      start_date: isoDayOffset(2), due_date: isoDayOffset(8), estimated_minutes: 120,
      labels: ['Docs', 'Launch'], assignees: ['usr-maya', 'usr-theo'], created_by: 'usr-priya',
    },
    {
      id: 'tsk-16', workspace_id: 'ws-northstar', project_id: 'prj-launch',
      title: 'Run load test on real-time board endpoints',
      description: 'Verify P95 latency stays below 80ms under 500 concurrent board updates.',
      status: 'in_progress', priority: 'medium', task_type: 'task', position: 0,
      start_date: isoDayOffset(-1), due_date: isoDayOffset(6), estimated_minutes: 180,
      labels: ['Engineering', 'QA'], assignees: ['usr-priya', 'usr-julian'], created_by: 'usr-priya',
    },

    // Business Operations
    {
      id: 'tsk-17', workspace_id: 'ws-northstar', project_id: 'prj-ops',
      title: 'Complete Q4 SaaS vendor cost review',
      description: 'Consolidate duplicate subscriptions and archive unused team seats.',
      status: 'completed', priority: 'medium', task_type: 'task', position: 0,
      start_date: isoDayOffset(-20), due_date: isoDayOffset(-7), estimated_minutes: 120,
      labels: ['Finance'], assignees: ['usr-priya'], created_by: 'usr-priya',
    },
    {
      id: 'tsk-18', workspace_id: 'ws-northstar', project_id: 'prj-ops',
      title: 'Update security incident response checklist',
      description: 'Verify escalation contacts and quarterly tabletop drill schedule.',
      status: 'completed', priority: 'high', task_type: 'task', position: 1,
      start_date: isoDayOffset(-15), due_date: isoDayOffset(-5), estimated_minutes: 90,
      labels: ['Security'], assignees: ['usr-priya', 'usr-julian'], created_by: 'usr-priya',
    },

    // Personal workspace task
    {
      id: 'tsk-19', workspace_id: 'ws-personal', project_id: 'prj-personal-1',
      title: 'Summarize notes from Designing Calm Interfaces',
      description: 'Extract top 5 typography and spacing heuristics for next studio critique.',
      status: 'in_progress', priority: 'medium', task_type: 'task', position: 0,
      start_date: isoDayOffset(0), due_date: isoDayOffset(3), estimated_minutes: 60,
      labels: ['Reading'], assignees: ['usr-maya'], created_by: 'usr-maya',
    },
  ];

  const insertTask = db.prepare(`
    INSERT INTO tasks (id, workspace_id, project_id, board_id, column_id, parent_task_id, title, description, status, priority, task_type, position, start_date, due_date, estimated_minutes, labels, is_demo, is_archived, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?)
  `);
  const insertTaskAssignee = db.prepare(`
    INSERT INTO task_assignees (id, task_id, user_id, is_primary, assigned_at) VALUES (?, ?, ?, ?, ?)
  `);

  for (const t of tasks) {
    const colId = colLookup[t.project_id][t.status];
    insertTask.run(
      t.id, t.workspace_id, t.project_id, `brd-${t.project_id}`, colId,
      t.title, t.description, t.status, t.priority, t.task_type, t.position,
      t.start_date, t.due_date, t.estimated_minutes, JSON.stringify(t.labels),
      t.created_by, now, now,
    );
    t.assignees.forEach((uid, idx) => {
      insertTaskAssignee.run(`ta-${t.id}-${uid}`, t.id, uid, idx === 0 ? 1 : 0, now);
    });
  }

  // Subtasks & Checklists
  const insertSubtask = db.prepare(`
    INSERT INTO subtasks (id, task_id, title, completed, assignee_id, due_date, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertSubtask.run('sub-1', 'tsk-3', 'Implement desktop mega-menu keyboard Escape handler', 1, 'usr-julian', isoDayOffset(0), 0, now);
  insertSubtask.run('sub-2', 'tsk-3', 'Verify mobile slide-over drawer scroll lock', 1, 'usr-maya', isoDayOffset(0), 1, now);
  insertSubtask.run('sub-3', 'tsk-3', 'Add reduced-motion transition fallback', 0, 'usr-julian', isoDayOffset(0), 2, now);
  insertSubtask.run('sub-4', 'tsk-5', 'Export updated hero preview snapshot', 1, 'usr-maya', isoDayOffset(0), 0, now);
  insertSubtask.run('sub-5', 'tsk-5', 'Finalize Business vs Enterprise plan copy', 0, 'usr-theo', isoDayOffset(1), 1, now);

  const insertChecklist = db.prepare(`
    INSERT INTO checklists (id, task_id, title, position, created_at) VALUES (?, ?, ?, ?, ?)
  `);
  const insertChecklistItem = db.prepare(`
    INSERT INTO checklist_items (id, checklist_id, text, completed, position, created_at) VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertChecklist.run('chk-1', 'tsk-3', 'Accessibility & Viewport Checks', 0, now);
  insertChecklistItem.run('ci-1', 'chk-1', '44px minimum touch target on mobile menu toggle', 1, 0, now);
  insertChecklistItem.run('ci-2', 'chk-1', 'Visible focus-visible outline on all nav links', 1, 1, now);
  insertChecklistItem.run('ci-3', 'chk-1', 'Zero horizontal overflow at 375px width', 0, 2, now);

  insertChecklist.run('chk-2', 'tsk-5', 'Pricing Section Readiness', 0, now);
  insertChecklistItem.run('ci-4', 'chk-2', 'Display Free, Pro, Business, and Enterprise tiers', 1, 0, now);
  insertChecklistItem.run('ci-5', 'chk-2', 'Verify FAQ accordion contrast in dark mode', 1, 1, now);

  // Dependencies
  db.prepare(`
    INSERT INTO task_dependencies (id, task_id, related_task_id, dependency_type, created_at) VALUES (?, ?, ?, ?, ?)
  `).run('dep-1', 'tsk-2', 'tsk-3', 'blocked_by', now);
  db.prepare(`
    INSERT INTO task_dependencies (id, task_id, related_task_id, dependency_type, created_at) VALUES (?, ?, ?, ?, ?)
  `).run('dep-2', 'tsk-3', 'tsk-2', 'blocking', now);
  db.prepare(`
    INSERT INTO task_dependencies (id, task_id, related_task_id, dependency_type, created_at) VALUES (?, ?, ?, ?, ?)
  `).run('dep-3', 'tsk-1', 'tsk-4', 'related_to', now);

  // Comments & Reactions
  const insertComment = db.prepare(`
    INSERT INTO comments (id, task_id, user_id, parent_comment_id, body, mentions, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)
  `);
  insertComment.run(
    'cmt-1', 'tsk-3', 'usr-maya',
    '@Julian Wright the spacing on the top navigation bar looks super clean now. Let us double check the mobile drawer backdrop opacity.',
    JSON.stringify(['usr-julian']), isoHourOffset(-5), isoHourOffset(-5),
  );
  insertComment.run(
    'cmt-2', 'tsk-3', 'usr-julian',
    'Updated the backdrop blur and reduced-motion preference check. Ready for final look @Maya Chen.',
    JSON.stringify(['usr-maya']), isoHourOffset(-2), isoHourOffset(-2),
  );
  insertComment.run(
    'cmt-3', 'tsk-5', 'usr-theo',
    'Reviewed the Enterprise plan wording — feels clear and grounded.',
    JSON.stringify([]), isoHourOffset(-3), isoHourOffset(-3),
  );

  db.prepare(`
    INSERT INTO comment_reactions (id, comment_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?, ?)
  `).run('cr-1', 'cmt-2', 'usr-maya', '👍', isoHourOffset(-1));

  // Sample attachment file on disk
  const sampleDocName = 'sample_website_architecture_brief.txt';
  const storedName = 'seed-website-brief.txt';
  fs.writeFileSync(
    path.join(UPLOAD_DIR, storedName),
    'Trellas Website Redesign — Architecture Brief\n\n1. Warm alabaster canvas (#FAF9F6) with deep forest emerald primary accents (#1B3B2B).\n2. Fraunces editorial headlines paired with Plus Jakarta Sans UI controls.\n3. Full keyboard accessibility and dark mode parity.\n',
    'utf-8',
  );
  db.prepare(`
    INSERT INTO attachments (id, workspace_id, project_id, task_id, comment_id, uploaded_by, original_name, stored_name, mime_type, size_bytes, created_at)
    VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
  `).run('att-1', 'ws-northstar', 'prj-website', 'tsk-5', 'usr-maya', sampleDocName, storedName, 'text/plain', 268, isoHourOffset(-12));

  // Time entries
  const insertTime = db.prepare(`
    INSERT INTO time_entries (id, workspace_id, project_id, task_id, user_id, description, duration_seconds, started_at, ended_at, is_running, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
  `);
  insertTime.run('te-1', 'ws-northstar', 'prj-website', 'tsk-3', 'usr-julian', 'Implemented responsive navigation drawer', 5400, isoHourOffset(-8), isoHourOffset(-6), now);
  insertTime.run('te-2', 'ws-northstar', 'prj-website', 'tsk-5', 'usr-maya', 'Hero layout & pricing table refinement', 4500, isoHourOffset(-14), isoHourOffset(-12), now);
  insertTime.run('te-3', 'ws-northstar', 'prj-mobile', 'tsk-8', 'usr-priya', 'Reviewed offline sync conflict strategy', 3600, isoHourOffset(-24), isoHourOffset(-23), now);

  // Notifications for Maya
  const insertNotif = db.prepare(`
    INSERT INTO notifications (id, workspace_id, user_id, actor_id, category, title, message, link_type, link_id, is_read, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertNotif.run('ntf-1', 'ws-northstar', 'usr-maya', 'usr-julian', 'mention', 'Julian Wright mentioned you', 'Mentioned you on "Build the responsive navigation"', 'task', 'tsk-3', 0, isoHourOffset(-2));
  insertNotif.run('ntf-2', 'ws-northstar', 'usr-maya', 'usr-theo', 'comment', 'New comment on Wireframe homepage', 'Theo Silva commented on "Wireframe homepage and pricing"', 'task', 'tsk-5', 0, isoHourOffset(-3));
  insertNotif.run('ntf-3', 'ws-northstar', 'usr-maya', 'usr-priya', 'deadline', 'Task due today', '"Build the responsive navigation" is scheduled for today', 'task', 'tsk-3', 0, isoHourOffset(-5));
  insertNotif.run('ntf-4', 'ws-northstar', 'usr-maya', 'usr-priya', 'assignment', 'Assigned to Product Launch task', 'Priya Rao assigned you to "Prepare v2.4 release notes & migration guide"', 'task', 'tsk-15', 1, isoHourOffset(-20));

  // Activity Logs
  const insertAct = db.prepare(`
    INSERT INTO activity_logs (id, workspace_id, project_id, task_id, user_id, action, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertAct.run('act-1', 'ws-northstar', 'prj-website', 'tsk-3', 'usr-julian', 'commented', 'Posted an update on "Build the responsive navigation"', isoHourOffset(-2));
  insertAct.run('act-2', 'ws-northstar', 'prj-website', 'tsk-5', 'usr-theo', 'commented', 'Reviewed pricing tier copy on "Wireframe homepage and pricing"', isoHourOffset(-3));
  insertAct.run('act-3', 'ws-northstar', 'prj-website', 'tsk-6', 'usr-julian', 'completed_task', 'Marked "Audit Core Web Vitals & font loading" as Completed', isoHourOffset(-10));
  insertAct.run('act-4', 'ws-northstar', 'prj-ops', 'tsk-18', 'usr-priya', 'completed_project', 'Completed project "Business Operations"', isoHourOffset(-24));
  insertAct.run('act-5', 'ws-northstar', 'prj-launch', null, 'usr-maya', 'created_project', 'Created project "Product Launch"', isoHourOffset(-36));
}
