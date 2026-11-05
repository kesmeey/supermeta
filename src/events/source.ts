import type { SourcedEvent } from "../types.ts";

export interface EventSource {
  readonly name: string;
  /** Poll returns only events that are new since the last call. */
  poll(): Promise<SourcedEvent[]>;
  /** True when the source can no longer produce events (scripted sources). */
  exhausted?(): boolean;
}

export function threadOf(repo: string, number: number): string {
  return `${repo}#${number}`;
}
