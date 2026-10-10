import { setTimeout as delay } from 'node:timers/promises';

export async function waitUntil(check: () => Promise<boolean>, timeoutMs: number, signal: AbortSignal): Promise<{ ok: boolean; waitMs: number; error?: string }> {
  const started = performance.now();
  const deadline = new AbortController();
  const combined = AbortSignal.any([signal, deadline.signal]);
  const timer = setTimeout(() => deadline.abort(new Error('Wait timed out; the requested condition was not observed.')), timeoutMs);
  const ended = Promise.withResolvers<never>();
  const abort = () => ended.reject(combined.reason);
  combined.addEventListener('abort', abort, { once: true });
  if (combined.aborted) abort();
  try {
    const poll = async () => {
      let previous = false;
      for (;;) {
        combined.throwIfAborted();
        const matched = await check();
        combined.throwIfAborted();
        if (matched && previous) return { ok: true, waitMs: Math.round(performance.now() - started) };
        previous = matched;
        await delay(Math.min(250, timeoutMs), undefined, { signal: combined });
      }
    };
    return await Promise.race([poll(), ended.promise]);
  } catch (error) {
    return { ok: false, waitMs: Math.round(performance.now() - started), error: String((combined.aborted ? combined.reason : error)?.message ?? error) };
  } finally {
    clearTimeout(timer);
    combined.removeEventListener('abort', abort);
    ended.promise.catch(() => {});
  }
}
