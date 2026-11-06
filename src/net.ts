export interface JsonResponse<T> {
  status: number;
  data: T | null;
  etag: string | null;
  notModified: boolean;
}

export interface FetchOptions {
  token?: string | undefined;
  etag?: string | null;
  timeoutMs?: number;
  /** Client-side ceiling for this host, per process. 0 disables throttling. */
  perMinute?: number;
  /** Extra retries after a rate-limit response. */
  retries?: number;
}

const USER_AGENT = "supermeta/0.1 (+https://github.com/kesmeey/supermeta)";

/**
 * Token bucket per host, borrowed from how API clients (Octokit's throttling
 * plugin, Renovate's hostRules) keep themselves under a server quota instead of
 * discovering the limit by getting throttled.
 */
const buckets = new Map<string, { tokens: number; updatedAt: number }>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquire(host: string, perMinute: number): Promise<void> {
  if (perMinute <= 0) return;
  const capacity = Math.max(1, perMinute);
  const refillPerMs = capacity / 60_000;
  for (;;) {
    const now = Date.now();
    const bucket = buckets.get(host) ?? { tokens: capacity, updatedAt: now };
    const tokens = Math.min(capacity, bucket.tokens + (now - bucket.updatedAt) * refillPerMs);
    if (tokens >= 1) {
      buckets.set(host, { tokens: tokens - 1, updatedAt: now });
      return;
    }
    buckets.set(host, { tokens, updatedAt: now });
    await sleep(Math.max(25, Math.ceil((1 - tokens) / refillPerMs)));
  }
}

/** Retry-after / x-ratelimit-reset, in ms, capped so a bad header cannot stall a run. */
function rateLimitWaitMs(response: Response, now = Date.now()): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter && /^\d+$/.test(retryAfter)) return Math.min(60_000, Number(retryAfter) * 1000);
  const reset = response.headers.get("x-ratelimit-reset");
  if (reset && /^\d+$/.test(reset)) return Math.min(60_000, Math.max(0, Number(reset) * 1000 - now));
  return 1_000;
}

export async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<JsonResponse<T>> {
  const host = new URL(url).host;
  const retries = options.retries ?? 1;

  for (let attempt = 0; ; attempt += 1) {
    await acquire(host, options.perMinute ?? 60);

    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "user-agent": USER_AGENT,
      "x-github-api-version": "2022-11-28",
    };
    if (options.token) headers["authorization"] = `Bearer ${options.token}`;
    if (options.etag) headers["if-none-match"] = options.etag;

    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });

    if (response.status === 304) {
      return { status: 304, data: null, etag: options.etag ?? null, notModified: true };
    }

    const throttled = response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0");
    if (throttled && attempt < retries) {
      await sleep(rateLimitWaitMs(response));
      continue;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`GET ${url} -> ${response.status} ${body.slice(0, 160)}`);
    }
    const data = (await response.json()) as T;
    return { status: response.status, data, etag: response.headers.get("etag"), notModified: false };
  }
}
