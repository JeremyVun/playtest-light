import { join } from 'node:path';
import { startSampleApp } from '../tools/spike-replay.ts';
import type { Project } from '../src/types.ts';

export function sampleTargets() {
  const apps = new Map<string, Awaited<ReturnType<typeof startSampleApp>>>();
  return {
    async use(project: Project, env: Record<string, string> = {}) {
      const key = JSON.stringify(Object.entries(env).sort());
      let app = apps.get(key);
      if (!app) { app = await startSampleApp(env); apps.set(key, app); }
      project.config.url = app.baseUrl + '/';
      project.config.seed = `node '${join(import.meta.dirname, '../fixtures/sample-app/playtest/reset.ts')}'`;
      return app;
    },
    async close() { await Promise.all([...apps.values()].map((app) => app.stop())); },
  };
}
