/** Domain types. Field names are snake_case because rows are read straight out of SQLite. */

export type EventKind =
  | "issue_opened"
  | "issue_commented"
  | "review_requested"
  | "ci_failed"
  | "mentioned";

/** An event as produced by an event source, before ingestion. */
export interface SourcedEvent {
  /** Stable identifier within the source, used for de-duplication across polls. */
  id: string;
  source: string;
  kind: EventKind;
  /** owner/name */
  repo: string;
  /** owner/name#123 - the routing key for thread subscription. */
  thread: string;
  actor: string;
  title: string;
  body?: string;
  url?: string;
  labels?: string[];
  /** Source-specific hints forwarded into the task payload (never rendered). */
  meta?: Record<string, unknown>;
  at: number;
}

export interface EventRow {
  seq: number;
  id: string;
  source: string;
  kind: EventKind;
  repo: string;
  thread: string;
  actor: string;
  title: string;
  body: string | null;
  url: string | null;
  labels: string; // JSON array
  meta: string; // JSON object, source-specific routing hints
  at: number;
  ingested_at: number;
  status: "new" | "ignored" | "routed";
}

export type TaskState =
  | "queued"
  | "dispatching"
  | "running"
  | "blocked"
  | "done"
  | "failed"
  | "dead"
  | "cancelled";

export interface Task {
  id: string;
  thread: string;
  repo: string;
  title: string;
  kind: EventKind;
  job: string;
  payload: string; // JSON
  state: TaskState;
  priority: number;
  attempts: number;
  max_attempts: number;
  /** Epoch ms before which the task must not be dispatched (retry backoff). */
  next_attempt_at: number;
  /** How many times a worker was declared stalled on this task. */
  stalls: number;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
  heartbeat_at: number | null;
  worker_id: string | null;
  pid: number | null;
  summary: string | null;
  last_error: string | null;
  origin_event: string;
}

export type DecisionAction = "create_task" | "route_to_task" | "ignore" | "defer";

export interface Decision {
  seq: number;
  event_seq: number;
  event_id: string;
  thread: string;
  action: DecisionAction;
  reason: string;
  task_id: string | null;
  at: number;
}

export interface RunRecord {
  seq: number;
  task_id: string;
  worker_id: string;
  attempt: number;
  pid: number | null;
  exit_code: number | null;
  started_at: number;
  finished_at: number | null;
  note: string | null;
  inline_chars: number;
  spill_chars: number;
}

export interface MemoryRecord {
  seq: number;
  thread: string;
  kind: "summary" | "artifact" | "event";
  level: "inline" | "spill";
  content: string;
  ref: string | null;
  task_id: string | null;
  created_at: number;
}

export interface WorkerRecord {
  id: string;
  task_id: string;
  pid: number | null;
  started_at: number;
  heartbeat_at: number;
  state: "alive" | "exited" | "killed";
}

/** Result a job returns to the worker runtime. */
export interface JobResult {
  summary: string;
  artifacts?: { name: string; content: string }[];
  checklist?: string[];
}

export interface JobContext {
  task: Task;
  signal: AbortSignal;
  log: (message: string) => void;
  /** Inline context assembled by the memory layer before the job runs. */
  context: {
    inline: string[];
    spillRefs: { ref: string; chars: number; label: string }[];
    inlineChars: number;
    spillChars: number;
  };
}

export interface TickSummary {
  polled: number;
  ingested: number;
  ignored: number;
  routed: number;
  created: number;
  dispatched: number;
  recovered: number;
  decisions: number;
}

export interface WatchdogIncident {
  task_id: string;
  thread: string;
  action: "requeued" | "failed" | "killed" | "dead";
  detail: string;
  at: number;
}
