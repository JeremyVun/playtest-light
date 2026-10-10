import { positiveNumber, type CommandArgs } from '../cli.ts';
import { projectFromArgs } from '../project.ts';
import { DEFAULT_EXPLORE_STEPS, explore } from '../run/explore.ts';
import { openView } from './view.ts';
import { exploreSummary } from '../run/findings.ts';

export async function run(args: CommandArgs): Promise<number> {
  const project = projectFromArgs(args, args.positionals[0]);
  const steps = positiveNumber(args.values.steps, DEFAULT_EXPLORE_STEPS, 'steps', true);
  const json = args.values.json === true;
  const goal = typeof args.values.goal === 'string' && args.values.goal.trim() ? args.values.goal.trim() : undefined;
  if (!json) console.log(`exploring for up to ${steps} actions${goal ? `, focus: ${goal}` : ''}`);
  const r = await explore(project, {
    goal,
    video: args.values.video === true,
    steps,
    progress: json ? undefined : (line) => console.log(line),
  });
  if (json) {
    const { session, findings, painPoints, noted, replay, markdown, savedFindings, view, video, videoSkipped } = r;
    console.log(JSON.stringify({ runDir: session.runDir, url: session.app, seeded: Boolean(session.seedCommand), markdown, savedFindings, view, video, videoSkipped, error: session.error, outcome: session.outcome, stats: session.stats, findings: findings.map(({ story, ...f }) => f), painPoints, noted, replay }));
  } else {
    for (const line of exploreSummary(r.session, r, r.markdown)) console.log(line);
    console.log(`saved findings ${r.savedFindings}`);
    console.log(`view ${r.view}`);
    if (r.video) console.log(`video ${r.video}`);
    if (r.videoSkipped) console.log(r.videoSkipped);
  }
  if (args.values.view && !json) await openView(r.view).catch((error) => console.error(`Could not open view: ${error.message}. Open ${r.view} in a browser.`));
  return r.session.error ? 2 : 0;
}
