export interface JsonResponse<T> {
  status: number;
  data: T | null;
  etag: string | null;
  notModified: boolean;
}

const USER_AGENT = "supermeta/0.1 (+https://github.com/kesmeey/Spuermeta)";

export async function fetchJson<T>(
  url: string,
  options: { token?: string | undefined; etag?: string | null; timeoutMs?: number } = {},
): Promise<JsonResponse<T>> {
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
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`GET ${url} -> ${response.status} ${body.slice(0, 160)}`);
  }
  const data = (await response.json()) as T;
  return { status: response.status, data, etag: response.headers.get("etag"), notModified: false };
}
