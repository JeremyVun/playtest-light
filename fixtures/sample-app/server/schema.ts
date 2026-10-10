import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
export const DATA_DIR = join(ROOT, 'data');
export const TEMPLATE_PATH = join(DATA_DIR, 'template.sqlite');
export const DB_PATH = process.env.DB_PATH ?? join(DATA_DIR, 'app.sqlite');

export const hashPassword = (password: string) =>
  createHash('sha256').update(`sample-app-salt:${password}`).digest('hex');

export const SCHEMA = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','member')),
  notifications INTEGER NOT NULL DEFAULT 1,
  digest TEXT NOT NULL DEFAULT 'weekly'
);
CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id)
);
CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  name TEXT NOT NULL UNIQUE,
  key TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('active','paused','archived')),
  created_at TEXT NOT NULL
);
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'normal',
  estimate REAL,
  due TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX tasks_project ON tasks(project_id);
CREATE TABLE billing (id INTEGER PRIMARY KEY CHECK (id = 1), plan TEXT NOT NULL, seats INTEGER NOT NULL, card_last4 TEXT);
`;
