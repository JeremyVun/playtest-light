import { mkdirSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, SCHEMA, TEMPLATE_PATH, hashPassword } from '../server/schema.ts';

export const SEED_EPOCH = Date.parse('2026-03-02T09:00:00Z');
const DAY = 86_400_000;

const adjectives = ['Northern', 'Quiet', 'Rapid', 'Golden', 'Hidden', 'Modern', 'Steady', 'Bright'];
const nouns = ['Onboarding', 'Billing', 'Search', 'Mobile app', 'Analytics', 'Docs', 'Pricing', 'Checkout', 'Support', 'Migration', 'Portal'];
const taskTitles = [
  'Draft the kickoff brief', 'Review the API contract', 'Fix flaky nightly build', 'Write release notes',
  'Interview three customers', 'Audit permissions', 'Update the style guide', 'Plan the beta rollout',
  'Triage inbound feedback', 'Estimate the next milestone',
];
const priorities = ['low', 'normal', 'high'];

const iso = (ms: number) => new Date(ms).toISOString();
const pad = (n: number, w = 3) => String(n).padStart(w, '0');

export function seed(path = TEMPLATE_PATH) {
  mkdirSync(DATA_DIR, { recursive: true });
  for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(path + suffix, { force: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);

  const user = db.prepare('INSERT INTO users (id,email,password_hash,name,role,notifications,digest) VALUES (?,?,?,?,?,?,?)');
  user.run(1, 'admin@example.test', hashPassword('admin-pass-1'), 'Ada Admin', 'admin', 1, 'weekly');
  user.run(2, 'member@example.test', hashPassword('member-pass-1'), 'Max Member', 'member', 0, 'daily');

  db.prepare('INSERT INTO counters (name,value) VALUES (?,?)').run('session', 0);
  db.prepare('INSERT INTO billing (id,plan,seats,card_last4) VALUES (1,?,?,NULL)').run('free', 3);

  const project = db.prepare('INSERT INTO projects (id,seq,name,key,description,status,created_at) VALUES (?,?,?,?,?,?,?)');
  const task = db.prepare('INSERT INTO tasks (id,project_id,title,notes,priority,estimate,due,done,created_at) VALUES (?,?,?,?,?,?,?,?,?)');
  let taskId = 1;
  const total = 34;
  for (let i = 0; i < total; i++) {
    const id = `prj-${pad(i + 1)}`;
    let name = `${adjectives[i % 8]} ${nouns[i % 11]}`;
    let description = `Workstream ${i + 1} for the ${nouns[i % 11].toLowerCase()} team.`;
    if (i === 6) name = 'Cross-functional customer onboarding experience redesign and migration of legacy account data (phase two)';
    if (i === 30) name = 'Legacy import';
    if (i === 32) name = 'Greenfield kickoff';
    if (i === 30) description = 'Imports from the old system. Its task feed is known to fail.';
    if (i === 32) description = 'Nothing planned yet.';
    const status = i % 5 === 4 ? 'archived' : i % 4 === 1 ? 'paused' : 'active';
    const key = (nouns[i % 11].replace(/[^A-Za-z]/g, '').slice(0, 3) + 'X').toUpperCase().slice(0, 4);
    project.run(id, i + 1, name, key, description, status, iso(SEED_EPOCH - (total - i) * DAY));
    if (i === 32) continue;
    const count = i === 0 ? 7 : 3 + (i % 5);
    for (let t = 0; t < count; t++) {
      const n = i * 3 + t;
      task.run(
        taskId++, id, taskTitles[n % taskTitles.length], t % 3 === 0 ? 'Notes for this task.' : '',
        priorities[n % 3], t % 2 === 0 ? 2 + (n % 6) : null,
        iso(SEED_EPOCH + ((n % 21) - 7) * DAY).slice(0, 10), t % 3 === 1 ? 1 : 0,
        iso(SEED_EPOCH - (total - i) * DAY + t * 3_600_000),
      );
    }
  }
  db.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seed();
  console.log(`seeded ${TEMPLATE_PATH}`);
}
