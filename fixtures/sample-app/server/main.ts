import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, DB_PATH, ROOT, TEMPLATE_PATH, hashPassword } from './schema.ts';

const PORT = Number(process.env.PORT ?? 5310);
const TEST_MODE = process.env.TEST_MODE === '1';
const list = (v?: string) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const BUGS = list(process.env.BUGS);
const VARIANTS = list(process.env.VARIANT);
const LATENCY_MS = Number(process.env.LATENCY_MS ?? 0);
const TEST_NOW = process.env.TEST_NOW;
if (TEST_NOW && Number.isNaN(Date.parse(TEST_NOW))) throw new Error(`TEST_NOW is not an ISO instant: ${TEST_NOW}`);
const PAGE_SIZE = 10;
const DIST = join(ROOT, 'dist');

const nowIso = () => (TEST_NOW ? new Date(TEST_NOW).toISOString() : new Date().toISOString());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(TEMPLATE_PATH)) throw new Error('No template database: run `npm run seed` first.');
mkdirSync(DATA_DIR, { recursive: true });
let db: DatabaseSync;
function restore() {
  db?.close();
  copyFileSync(TEMPLATE_PATH, DB_PATH);
  db = new DatabaseSync(DB_PATH);
}
restore();

type Row = Record<string, any>;
const all = (sql: string, ...p: any[]) => db.prepare(sql).all(...p) as Row[];
const get = (sql: string, ...p: any[]) => db.prepare(sql).get(...p) as Row | undefined;
const run = (sql: string, ...p: any[]) => db.prepare(sql).run(...p);

class HttpError extends Error {
  status: number;
  errors?: Record<string, string>;
  constructor(status: number, message: string, errors?: Record<string, string>) {
    super(message);
    this.status = status;
    this.errors = errors;
  }
}

const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
};

const readBody = async (req: IncomingMessage): Promise<Row> => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
};

const publicUser = (u: Row) => ({
  id: u.id, email: u.email, name: u.name, role: u.role,
  notifications: Boolean(u.notifications), digest: u.digest,
});

function sessionUser(req: IncomingMessage): Row | undefined {
  const m = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie ?? '');
  if (!m) return undefined;
  return get('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?', m[1]);
}

const requireUser = (req: IncomingMessage) => {
  const u = sessionUser(req);
  if (!u) throw new HttpError(401, 'Not signed in');
  return u;
};
const requireAdmin = (req: IncomingMessage) => {
  const u = requireUser(req);
  if (u.role !== 'admin') throw new HttpError(403, 'Only admins can do that');
  return u;
};

const taskOut = (t: Row) => ({
  id: t.id, projectId: t.project_id, title: t.title, notes: t.notes, priority: t.priority,
  estimate: t.estimate, due: t.due, done: Boolean(t.done), createdAt: t.created_at,
});
const projectOut = (p: Row) => ({
  id: p.id, name: p.name, key: p.key, description: p.description, status: p.status,
  createdAt: p.created_at, openTasks: p.open_tasks, totalTasks: p.total_tasks,
});
const PROJECT_SELECT = `SELECT p.*,
  (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.done = 0) AS open_tasks,
  (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS total_tasks FROM projects p`;

function validateTask(b: Row) {
  const errors: Record<string, string> = {};
  const title = String(b.title ?? '').trim();
  if (!title) errors.title = 'Title is required';
  else if (title.length > 120) errors.title = 'Title must be 120 characters or fewer';
  if (!['low', 'normal', 'high'].includes(b.priority ?? 'normal')) errors.priority = 'Pick a priority';
  if (b.due && !/^\d{4}-\d{2}-\d{2}$/.test(b.due)) errors.due = 'Use the YYYY-MM-DD format';
  if (b.estimate !== undefined && b.estimate !== null && b.estimate !== '' && !(Number(b.estimate) >= 0 && Number(b.estimate) <= 999))
    errors.estimate = 'Estimate must be between 0 and 999 hours';
  if (Object.keys(errors).length) throw new HttpError(422, 'Please fix the highlighted fields', errors);
  return {
    title, notes: String(b.notes ?? '').trim(), priority: b.priority ?? 'normal',
    due: b.due || null,
    estimate: b.estimate === undefined || b.estimate === null || b.estimate === '' ? null : Number(b.estimate),
  };
}

type Handler = (ctx: { req: IncomingMessage; res: ServerResponse; params: string[]; url: URL }) => Promise<unknown> | unknown;
const routes: { method: string; re: RegExp; fn: Handler }[] = [];
const route = (method: string, path: string, fn: Handler) =>
  routes.push({ method, re: new RegExp(`^${path}$`), fn });

route('GET', '/api/bootstrap', ({ req }) => {
  const u = sessionUser(req);
  return {
    config: { bugs: BUGS, variants: VARIANTS, testMode: TEST_MODE },
    now: nowIso(),
    user: u ? publicUser(u) : null,
  };
});

route('POST', '/api/login', async ({ req, res }) => {
  const b = await readBody(req);
  const email = String(b.email ?? '').trim().toLowerCase();
  const u = get('SELECT * FROM users WHERE email = ?', email);
  if (!u || u.password_hash !== hashPassword(String(b.password ?? '')))
    throw new HttpError(401, 'Incorrect email or password');
  run("UPDATE counters SET value = value + 1 WHERE name = 'session'");
  const n = get("SELECT value FROM counters WHERE name = 'session'")!.value;
  const token = createHash('sha256').update(`session:${u.id}:${n}`).digest('hex').slice(0, 32);
  run('INSERT INTO sessions (token, user_id) VALUES (?, ?)', token, u.id);
  res.setHeader('set-cookie', `sid=${token}; Path=/; HttpOnly; SameSite=Lax`);
  return { user: publicUser(u) };
});

route('POST', '/api/logout', ({ req, res }) => {
  const m = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie ?? '');
  if (m) run('DELETE FROM sessions WHERE token = ?', m[1]);
  res.setHeader('set-cookie', 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  return { ok: true };
});

route('GET', '/api/projects', ({ req, url }) => {
  requireUser(req);
  const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
  const status = url.searchParams.get('status') ?? 'all';
  const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1);
  const where: string[] = [];
  const params: any[] = [];
  if (q) { where.push("LOWER(p.name) LIKE ? ESCAPE '\\'"); params.push(`%${q.replace(/[\\%_]/g, '\\$&')}%`); }
  if (['active', 'paused', 'archived'].includes(status)) { where.push('p.status = ?'); params.push(status); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = get(`SELECT COUNT(*) AS n FROM projects p ${clause}`, ...params)!.n as number;
  const items = all(`${PROJECT_SELECT} ${clause} ORDER BY p.seq LIMIT ? OFFSET ?`, ...params, PAGE_SIZE, (page - 1) * PAGE_SIZE);
  return { items: items.map(projectOut), total, page, pageSize: PAGE_SIZE, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
});

route('POST', '/api/projects', async ({ req }) => {
  requireUser(req);
  const b = await readBody(req);
  const errors: Record<string, string> = {};
  const name = String(b.name ?? '').trim();
  const key = String(b.key ?? '').trim();
  if (name.length < 3 || name.length > 60) errors.name = 'Name must be 3 to 60 characters';
  if (!/^[A-Z]{2,5}$/.test(key)) errors.key = 'Key must be 2 to 5 capital letters';
  if (Object.keys(errors).length) throw new HttpError(422, 'Please fix the highlighted fields', errors);
  if (get('SELECT 1 FROM projects WHERE LOWER(name) = ?', name.toLowerCase()))
    errors.name = 'A project with this name already exists';
  if (key === 'API') errors.key = 'The key API is reserved';
  if (Object.keys(errors).length) throw new HttpError(422, 'Could not create the project', errors);
  const seq = (get('SELECT MAX(seq) AS m FROM projects')!.m as number) + 1;
  const id = `prj-${String(seq).padStart(3, '0')}`;
  run('INSERT INTO projects (id,seq,name,key,description,status,created_at) VALUES (?,?,?,?,?,?,?)',
    id, seq, name, key, String(b.description ?? '').trim(), 'active', nowIso());
  return projectOut(get(`${PROJECT_SELECT} WHERE p.id = ?`, id)!);
});

route('GET', '/api/projects/([^/]+)', ({ req, params }) => {
  requireUser(req);
  const p = get(`${PROJECT_SELECT} WHERE p.id = ?`, params[0]);
  if (!p) throw new HttpError(404, 'Project not found');
  return projectOut(p);
});

route('GET', '/api/projects/([^/]+)/tasks', async ({ req, params }) => {
  requireUser(req);
  if (BUGS.includes('slow')) await sleep(3000);
  if (!get('SELECT 1 FROM projects WHERE id = ?', params[0])) throw new HttpError(404, 'Project not found');
  if (params[0] === 'prj-031') throw new HttpError(500, 'The task feed for this project is unavailable');
  return { items: all('SELECT * FROM tasks WHERE project_id = ? ORDER BY id', params[0]).map(taskOut) };
});

route('POST', '/api/projects/([^/]+)/tasks', async ({ req, params }) => {
  requireUser(req);
  if (BUGS.includes('save-500')) throw new HttpError(500, 'Internal server error');
  const v = validateTask(await readBody(req));
  if (!get('SELECT 1 FROM projects WHERE id = ?', params[0])) throw new HttpError(404, 'Project not found');
  const r = run('INSERT INTO tasks (project_id,title,notes,priority,estimate,due,done,created_at) VALUES (?,?,?,?,?,?,0,?)',
    params[0], v.title, v.notes, v.priority, v.estimate, v.due, nowIso());
  return taskOut(get('SELECT * FROM tasks WHERE id = ?', Number(r.lastInsertRowid))!);
});

route('PATCH', '/api/tasks/(\\d+)', async ({ req, params }) => {
  requireUser(req);
  const t = get('SELECT * FROM tasks WHERE id = ?', Number(params[0]));
  if (!t) throw new HttpError(404, 'Task not found');
  const b = await readBody(req);
  if (BUGS.includes('save-500') && !('done' in b && Object.keys(b).length === 1)) throw new HttpError(500, 'Internal server error');
  if ('done' in b && Object.keys(b).length === 1) {
    run('UPDATE tasks SET done = ? WHERE id = ?', b.done ? 1 : 0, t.id);
  } else {
    const v = validateTask({ ...taskOut(t), ...b });
    run('UPDATE tasks SET title=?, notes=?, priority=?, estimate=?, due=? WHERE id=?',
      v.title, v.notes, v.priority, v.estimate, v.due, t.id);
  }
  return taskOut(get('SELECT * FROM tasks WHERE id = ?', t.id)!);
});

route('DELETE', '/api/tasks/(\\d+)', ({ req, params }) => {
  requireAdmin(req);
  const r = run('DELETE FROM tasks WHERE id = ?', Number(params[0]));
  if (!r.changes) throw new HttpError(404, 'Task not found');
  return { ok: true };
});

route('PATCH', '/api/settings', async ({ req }) => {
  const u = requireUser(req);
  const b = await readBody(req);
  const name = String(b.name ?? '').trim();
  if (!name) throw new HttpError(422, 'Please fix the highlighted fields', { name: 'Name is required' });
  if (name.length > 60) throw new HttpError(422, 'Please fix the highlighted fields', { name: 'Name must be 60 characters or fewer' });
  const digest = ['daily', 'weekly', 'never'].includes(b.digest) ? b.digest : u.digest;
  run('UPDATE users SET name = ?, notifications = ?, digest = ? WHERE id = ?', name, b.notifications ? 1 : 0, digest, u.id);
  return publicUser(get('SELECT * FROM users WHERE id = ?', u.id)!);
});

route('GET', '/api/plan', ({ req }) => {
  requireUser(req);
  const b = get('SELECT * FROM billing WHERE id = 1')!;
  return { plan: b.plan, seats: b.seats, cardLast4: b.card_last4 };
});

route('POST', '/api/plan/upgrade', async ({ req }) => {
  requireAdmin(req);
  const b = await readBody(req);
  const errors: Record<string, string> = {};
  if (!['free', 'team', 'business'].includes(b.plan)) errors.plan = 'Choose a plan';
  if (!String(b.billingName ?? '').trim()) errors.billingName = 'Billing name is required';
  if (!/^\S+@\S+\.\S+$/.test(String(b.email ?? ''))) errors.email = 'Enter a valid email address';
  const digits = String(b.card ?? '').replace(/\s/g, '');
  if (!/^\d{16}$/.test(digits)) errors.card = 'Card number must be 16 digits';
  if (!(Number(b.seats) >= 1 && Number(b.seats) <= 100)) errors.seats = 'Seats must be between 1 and 100';
  if (Object.keys(errors).length) throw new HttpError(422, 'Please fix the highlighted fields', errors);
  if (digits === '4000000000000002') throw new HttpError(402, 'Your card was declined', { card: 'This card was declined' });
  run('UPDATE billing SET plan = ?, seats = ?, card_last4 = ? WHERE id = 1', b.plan, Number(b.seats), digits.slice(-4));
  return { plan: b.plan, seats: Number(b.seats), cardLast4: digits.slice(-4) };
});

if (TEST_MODE) {
  route('POST', '/__test/reset', () => {
    restore();
    return { ok: true };
  });
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.map': 'application/json',
};

function serveStatic(url: URL, res: ServerResponse) {
  let file = normalize(join(DIST, decodeURIComponent(url.pathname)));
  const insideDist = file.startsWith(DIST);
  if (!insideDist || !existsSync(file) || !statSync(file).isFile()) {
    if (extname(url.pathname)) return send(res, 404, { error: 'Not found' });
    file = join(DIST, 'index.html');
  }
  if (!existsSync(file)) return send(res, 503, { error: 'Client not built: run `npm run build`' });
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  res.end(readFileSync(file));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const isApi = url.pathname.startsWith('/api/') || url.pathname.startsWith('/__test/');
  if (!isApi) return serveStatic(url, res);
  try {
    const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
    if (!r) throw new HttpError(404, 'Unknown endpoint');
    if (LATENCY_MS) await sleep(LATENCY_MS);
    const params = r.re.exec(url.pathname)!.slice(1).map(decodeURIComponent);
    send(res, 200, await r.fn({ req, res, params, url }));
  } catch (e) {
    if (e instanceof HttpError) send(res, e.status, { error: e.message, errors: e.errors });
    else {
      console.error(e);
      send(res, 500, { error: 'Internal server error' });
    }
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`sample-app listening on http://127.0.0.1:${(server.address() as { port: number }).port}` +
    ` (test=${TEST_MODE ? 1 : 0} bugs=[${BUGS}] variants=[${VARIANTS}] now=${TEST_NOW ?? 'real'})`);
});
