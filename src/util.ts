import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

export function shortId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

/** "owner/name#123" -> "owner__name__123", filesystem safe. */
export function slugThread(thread: string): string {
  return thread.replace(/[^a-zA-Z0-9._-]+/g, "__").replace(/^_+|_+$/g, "");
}

export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

export function iso(ms: number | null | undefined): string {
  if (!ms) return "-";
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

export function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank] ?? 0;
}

/** Keep the head and tail of long text so a summary stays inside a fixed budget. */
export function clamp(text: string, max = 400): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const head = flat.slice(0, Math.floor(max * 0.7));
  const tail = flat.slice(-Math.floor(max * 0.25));
  return `${head} ... ${tail}`;
}

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
