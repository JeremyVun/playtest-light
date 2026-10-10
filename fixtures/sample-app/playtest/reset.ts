const url = process.env.PLAYTEST_URL;
if (!url) throw new Error('PLAYTEST_URL is required');
const response = await fetch(new URL('/__test/reset', url), { method: 'POST' });
if (!response.ok) throw new Error(`reset failed: HTTP ${response.status}`);
await response.arrayBuffer();
