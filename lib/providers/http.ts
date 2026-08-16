/**
 * Shared HTTP for sports feeds.
 *
 * These are free, unauthenticated, best-effort endpoints. They rate limit,
 * occasionally 403 datacenter IPs, and sometimes just hang. Everything here
 * exists to keep one flaky upstream from taking down an ingest run.
 */

const DEFAULT_TIMEOUT_MS = 15_000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string
  ) {
    super(`HTTP ${status} for ${url}`);
    this.name = "HttpError";
  }
}

export async function getJson<T = unknown>(
  url: string,
  opts: { timeoutMs?: number; retries?: number } = {}
): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, retries = 2 } = opts;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        cache: "no-store",
      });
      if (!res.ok) {
        // 404 means "this player has no such record" — retrying won't help.
        if (res.status === 404) throw new HttpError(404, url);
        throw new HttpError(res.status, url);
      }
      return (await res.json()) as T;
    } catch (err) {
      lastError = err;
      if (err instanceof HttpError && err.status === 404) throw err;
      if (attempt < retries) {
        // Exponential backoff with jitter so a burst of failures doesn't
        // resynchronize into another burst.
        const backoff = 400 * 2 ** attempt + Math.random() * 300;
        await sleep(backoff);
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

export async function getText(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT },
      cache: "no-store",
    });
    if (!res.ok) throw new HttpError(res.status, url);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run tasks with bounded concurrency. Failures are captured rather than thrown
 * so one dead player id cannot abort an entire ingest.
 */
export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<Array<{ ok: true; value: R } | { ok: false; error: unknown; item: T }>> {
  const results: Array<{ ok: true; value: R } | { ok: false; error: unknown; item: T }> = new Array(
    items.length
  );
  let cursor = 0;

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = { ok: true, value: await fn(items[index], index) };
      } catch (error) {
        results[index] = { ok: false, error, item: items[index] };
      }
    }
  });

  await Promise.all(workers);
  return results;
}
