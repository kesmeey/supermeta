/**
 * Retry policy, borrowed from the queue world: exponential growth with a cap
 * and full-jitter spread, so a failing dependency does not get hammered by
 * every worker at the same instant.
 *
 * Sources of the shape:
 *  - BullMQ `backoff: { type: "exponential", delay }`
 *  - Sidekiq `sidekiq_retry_in`
 *  - Temporal `RetryPolicy` (`initial_interval`, `backoff_coefficient`,
 *    `maximum_interval`)
 */
export interface RetryPolicy {
  base_ms: number;
  factor: number;
  max_ms: number;
  /** Fraction of the delay used as +/- jitter. 0 disables it. */
  jitter: number;
}

/**
 * Delay before attempt `attempt + 1`. Attempt 1 means "the first retry".
 * `random` is injectable so tests can pin the jitter.
 */
export function backoffDelay(attempt: number, policy: RetryPolicy, random: () => number = Math.random): number {
  const step = Math.max(1, attempt);
  const raw = Math.min(policy.max_ms, policy.base_ms * policy.factor ** (step - 1));
  if (policy.jitter <= 0) return Math.round(raw);
  const spread = raw * policy.jitter * (random() * 2 - 1);
  return Math.max(0, Math.round(raw + spread));
}

/** Human-readable form used by the CLI, e.g. "42s", "5m". */
export function describeDelay(ms: number): string {
  if (ms <= 0) return "now";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}
