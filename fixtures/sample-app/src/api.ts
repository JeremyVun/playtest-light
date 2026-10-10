export type Role = 'admin' | 'member';
export interface User { id: number; email: string; name: string; role: Role; notifications: boolean; digest: string }
export interface Config { bugs: string[]; variants: string[]; testMode: boolean }
export interface Project {
  id: string; name: string; key: string; description: string; status: string;
  createdAt: string; openTasks: number; totalTasks: number;
}
export interface Task {
  id: number; projectId: string; title: string; notes: string; priority: string;
  estimate: number | null; due: string | null; done: boolean; createdAt: string;
}
export interface Page<T> { items: T[]; total: number; page: number; pageSize: number; pages: number }
export interface Plan { plan: string; seats: number; cardLast4: string | null }

export class ApiError extends Error {
  status: number;
  fields: Record<string, string>;
  constructor(status: number, message: string, fields: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? 'GET',
    headers: init?.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`, data.errors ?? {});
  return data as T;
}
