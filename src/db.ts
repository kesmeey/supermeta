import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  Decision,
  DecisionAction,
  EventKind,
  EventRow,
  MemoryRecord,
  RunRecord,
  SourcedEvent,
  Task,
  TaskState,
  WatchdogIncident,
  WorkerRecord,
} from "./types.ts";
import { shortId } from "./util.ts";

const SCHEMA = `
create table if not exists meta (
  key text primary key,
  value text not null
);

create table if not exists events (
  seq integer primary key autoincrement,
  id text not null unique,
  source text not null,
  kind text not null,
  repo text not null,
  thread text not null,
  actor text not null,
  title text not null,
  body text,
  url text,
  labels text not null default '[]',
  meta text not null default '{}',
  at integer not null,
  ingested_at integer not null,
  status text not null default 'new'
);
create index if not exists idx_events_thread on events(thread);

create table if not exists tasks (
  id text primary key,
  thread text not null,
  repo text not null,
  title text not null,
  kind text not null,
  job text not null,
  payload text not null default '{}',
  state text not null,
  priority integer not null default 0,
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  created_at integer not null,
  updated_at integer not null,
  started_at integer,
  finished_at integer,
  heartbeat_at integer,
  worker_id text,
  pid integer,
  summary text,
  last_error text,
  origin_event text not null
);
create index if not exists idx_tasks_state on tasks(state);
create index if not exists idx_tasks_thread on tasks(thread);

create table if not exists decisions (
  seq integer primary key autoincrement,
  event_seq integer not null,
  event_id text not null,
  thread text not null,
  action text not null,
  reason text not null,
  task_id text,
  at integer not null
);

create table if not exists runs (
  seq integer primary key autoincrement,
  task_id text not null,
  worker_id text not null,
  attempt integer not null,
  pid integer,
  exit_code integer,
  started_at integer not null,
  finished_at integer,
  note text,
  inline_chars integer not null default 0,
  spill_chars integer not null default 0
);

create table if not exists memory (
  seq integer primary key autoincrement,
  thread text not null,
  kind text not null,
  level text not null,
  content text not null,
  ref text,
  task_id text,
  created_at integer not null
);
create index if not exists idx_memory_thread on memory(thread, level);

create table if not exists workers (
  id text primary key,
  task_id text not null,
  pid integer,
  started_at integer not null,
  heartbeat_at integer not null,
  state text not null
);
`;

export interface CreateTaskInput {
  thread: string;
  repo: string;
  title: string;
  kind: EventKind;
  job: string;
  payload: Record<string, unknown>;
  priority: number;
  max_attempts: number;
  origin_event: string;
}

export interface ReportMetrics {
  events: number;
  events_ignored: number;
  events_routed: number;
  decisions: number;
  tasks: number;
  tasks_done: number;
  tasks_failed: number;
  tasks_queued: number;
  tasks_running: number;
  attempts: number;
  recoveries: number;
  inline_chars: number;
  spill_chars: number;
  durations_ms: number[];
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("pragma journal_mode = WAL");
    this.db.exec("pragma busy_timeout = 5000");
    this.db.exec("pragma foreign_keys = on");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Additive migrations only: v0.x must be able to open an older state.db. */
  private migrate(): void {
    const columns = this.db.prepare("pragma table_info(events)").all() as unknown as { name: string }[];
    if (!columns.some((column) => column.name === "meta")) {
      this.db.exec("alter table events add column meta text not null default '{}'");
    }
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- meta

  getMeta(key: string): string | null {
    const row = this.db.prepare("select value from meta where key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare("insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value")
      .run(key, value);
  }

  // -------------------------------------------------------------- events

  /** Returns true when the event is new; duplicates from overlapping polls are dropped. */
  ingestEvent(event: SourcedEvent): boolean {
    const info = this.db
      .prepare(
        `insert or ignore into events
           (id, source, kind, repo, thread, actor, title, body, url, labels, meta, at, ingested_at, status)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')`,
      )
      .run(
        event.id,
        event.source,
        event.kind,
        event.repo,
        event.thread,
        event.actor,
        event.title,
        event.body ?? null,
        event.url ?? null,
        JSON.stringify(event.labels ?? []),
        JSON.stringify(event.meta ?? {}),
        event.at,
        Date.now(),
      );
    return Number(info.changes) > 0;
  }

  setEventStatus(seq: number, status: EventRow["status"]): void {
    this.db.prepare("update events set status = ? where seq = ?").run(status, seq);
  }

  listEvents(limit = 20): EventRow[] {
    return this.db
      .prepare("select * from events order by seq desc limit ?")
      .all(limit) as unknown as EventRow[];
  }

  getEventBySeq(seq: number): EventRow | null {
    const row = this.db.prepare("select * from events where seq = ?").get(seq) as
      | EventRow
      | undefined;
    return row ?? null;
  }

  getEventById(id: string): EventRow | null {
    const row = this.db.prepare("select * from events where id = ?").get(id) as
      | EventRow
      | undefined;
    return row ?? null;
  }

  // --------------------------------------------------------------- tasks

  createTask(input: CreateTaskInput): Task {
    const now = Date.now();
    const id = shortId("t");
    this.db
      .prepare(
        `insert into tasks
           (id, thread, repo, title, kind, job, payload, state, priority, attempts, max_attempts,
            created_at, updated_at, origin_event)
         values (?, ?, ?, ?, ?, ?, ?, 'queued', ?, 0, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.thread,
        input.repo,
        input.title,
        input.kind,
        input.job,
        JSON.stringify(input.payload),
        input.priority,
        input.max_attempts,
        now,
        now,
        input.origin_event,
      );
    const task = this.getTask(id);
    if (!task) throw new Error("task insert failed");
    return task;
  }

  getTask(id: string): Task | null {
    const row = this.db.prepare("select * from tasks where id = ?").get(id) as Task | undefined;
    return row ?? null;
  }

  listTasks(opts: { state?: TaskState | undefined; limit?: number } = {}): Task[] {
    const limit = opts.limit ?? 50;
    if (opts.state) {
      return this.db
        .prepare("select * from tasks where state = ? order by created_at desc limit ?")
        .all(opts.state, limit) as unknown as Task[];
    }
    return this.db
      .prepare("select * from tasks order by created_at desc limit ?")
      .all(limit) as unknown as Task[];
  }

  /** Thread subscription key: any live task that already owns this conversation. */
  findActiveTaskByThread(thread: string): Task | null {
    const row = this.db
      .prepare(
        `select * from tasks
          where thread = ? and state in ('queued', 'dispatching', 'running', 'blocked')
          order by created_at desc limit 1`,
      )
      .get(thread) as Task | undefined;
    return row ?? null;
  }

  countActive(): number {
    const row = this.db
      .prepare("select count(*) as c from tasks where state in ('queued', 'dispatching', 'running')")
      .get() as { c: number };
    return Number(row.c);
  }

  countRunning(): number {
    const row = this.db
      .prepare("select count(*) as c from tasks where state in ('dispatching', 'running')")
      .get() as { c: number };
    return Number(row.c);
  }

  listRunnable(limit: number): Task[] {
    return this.db
      .prepare("select * from tasks where state = 'queued' order by priority desc, created_at asc limit ?")
      .all(limit) as unknown as Task[];
  }

  /** queued -> dispatching. Attempts are counted at dispatch time, never at completion time. */
  beginDispatch(id: string, workerId: string): Task | null {
    const now = Date.now();
    const info = this.db
      .prepare(
        `update tasks
            set state = 'dispatching', worker_id = ?, attempts = attempts + 1, updated_at = ?
          where id = ? and state = 'queued'`,
      )
      .run(workerId, now, id);
    return Number(info.changes) > 0 ? this.getTask(id) : null;
  }

  attachWorker(id: string, pid: number | null): void {
    this.db
      .prepare("update tasks set pid = ?, updated_at = ? where id = ?")
      .run(pid, Date.now(), id);
  }

  /** dispatching -> running, once the worker process has actually started. */
  markRunning(id: string, workerId: string): boolean {
    const now = Date.now();
    const info = this.db
      .prepare(
        `update tasks
            set state = 'running', worker_id = ?, started_at = coalesce(started_at, ?),
                heartbeat_at = ?, updated_at = ?
          where id = ? and state in ('queued', 'dispatching')`,
      )
      .run(workerId, now, now, now, id);
    return Number(info.changes) > 0;
  }

  heartbeat(id: string): void {
    const now = Date.now();
    this.db
      .prepare("update tasks set heartbeat_at = ?, updated_at = ? where id = ?")
      .run(now, now, id);
  }

  finishTask(
    id: string,
    patch: { state: TaskState; summary?: string | null; error?: string | null },
  ): void {
    const now = Date.now();
    this.db
      .prepare(
        `update tasks
            set state = ?, summary = coalesce(?, summary), last_error = ?,
                finished_at = ?, updated_at = ?, pid = null
          where id = ?`,
      )
      .run(patch.state, patch.summary ?? null, patch.error ?? null, now, now, id);
  }

  requeueTask(id: string, error: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `update tasks
            set state = 'queued', last_error = ?, worker_id = null, pid = null,
                heartbeat_at = null, updated_at = ?
          where id = ?`,
      )
      .run(error, now, id);
  }

  /** Tasks that claim to be executing but have stopped reporting. */
  listStale(now: number, staleMs: number, graceMs: number): Task[] {
    const rows = this.db
      .prepare("select * from tasks where state in ('dispatching', 'running')")
      .all() as unknown as Task[];
    return rows.filter((task) => {
      const reference = task.heartbeat_at ?? task.updated_at;
      const limit = task.state === "dispatching" ? graceMs : staleMs;
      return now - reference > limit;
    });
  }

  // ----------------------------------------------------------- decisions

  recordDecision(input: {
    event_seq: number;
    event_id: string;
    thread: string;
    action: DecisionAction;
    reason: string;
    task_id: string | null;
  }): void {
    this.db
      .prepare(
        `insert into decisions (event_seq, event_id, thread, action, reason, task_id, at)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.event_seq,
        input.event_id,
        input.thread,
        input.action,
        input.reason,
        input.task_id,
        Date.now(),
      );
  }

  listDecisions(limit = 30): Decision[] {
    return this.db
      .prepare("select * from decisions order by seq desc limit ?")
      .all(limit) as unknown as Decision[];
  }

  countDecisions(): number {
    const row = this.db.prepare("select count(*) as c from decisions").get() as { c: number };
    return Number(row.c);
  }

  // ---------------------------------------------------------------- runs

  startRun(taskId: string, workerId: string, attempt: number, pid: number | null): number {
    const info = this.db
      .prepare(
        `insert into runs (task_id, worker_id, attempt, pid, started_at)
         values (?, ?, ?, ?, ?)`,
      )
      .run(taskId, workerId, attempt, pid, Date.now());
    return Number(info.lastInsertRowid);
  }

  finishRun(
    seq: number,
    patch: { exit_code: number | null; note: string | null; inline_chars: number; spill_chars: number },
  ): void {
    this.db
      .prepare(
        `update runs
            set exit_code = ?, note = ?, inline_chars = ?, spill_chars = ?, finished_at = ?
          where seq = ?`,
      )
      .run(patch.exit_code, patch.note, patch.inline_chars, patch.spill_chars, Date.now(), seq);
  }

  listRuns(taskId: string): RunRecord[] {
    return this.db
      .prepare("select * from runs where task_id = ? order by seq asc")
      .all(taskId) as unknown as RunRecord[];
  }

  listOpenRuns(taskId: string): RunRecord[] {
    return this.db
      .prepare("select * from runs where task_id = ? and finished_at is null order by seq asc")
      .all(taskId) as unknown as RunRecord[];
  }

  /** Close an attempt that will never report back because its process died. */
  closeRunStale(seq: number, note: string): void {
    this.db
      .prepare("update runs set finished_at = ?, exit_code = null, note = ? where seq = ? and finished_at is null")
      .run(Date.now(), note, seq);
  }

  // -------------------------------------------------------------- memory

  addMemory(input: {
    thread: string;
    kind: MemoryRecord["kind"];
    level: MemoryRecord["level"];
    content: string;
    ref?: string | null;
    task_id?: string | null;
  }): void {
    this.db
      .prepare(
        `insert into memory (thread, kind, level, content, ref, task_id, created_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.thread,
        input.kind,
        input.level,
        input.content,
        input.ref ?? null,
        input.task_id ?? null,
        Date.now(),
      );
  }

  listMemory(thread: string, opts: { level?: MemoryRecord["level"]; limit?: number } = {}): MemoryRecord[] {
    const limit = opts.limit ?? 20;
    if (opts.level) {
      return this.db
        .prepare(
          "select * from memory where thread = ? and level = ? order by seq asc limit ?",
        )
        .all(thread, opts.level, limit) as unknown as MemoryRecord[];
    }
    return this.db
      .prepare("select * from memory where thread = ? order by seq asc limit ?")
      .all(thread, limit) as unknown as MemoryRecord[];
  }

  /** Inline summaries are what a worker actually carries; spill records are only referenced. */
  contextChars(thread: string): { inline: number; spill: number } {
    const row = this.db
      .prepare(
        `select
           coalesce(sum(case when level = 'inline' then length(content) else 0 end), 0) as inline,
           coalesce(sum(case when level = 'spill' then length(content) else 0 end), 0) as spill
         from memory where thread = ?`,
      )
      .get(thread) as { inline: number; spill: number };
    return { inline: Number(row.inline), spill: Number(row.spill) };
  }

  // ------------------------------------------------------------- workers

  registerWorker(worker: WorkerRecord): void {
    this.db
      .prepare(
        `insert into workers (id, task_id, pid, started_at, heartbeat_at, state)
         values (?, ?, ?, ?, ?, ?)
         on conflict(id) do update set heartbeat_at = excluded.heartbeat_at, state = excluded.state`,
      )
      .run(worker.id, worker.task_id, worker.pid, worker.started_at, worker.heartbeat_at, worker.state);
  }

  touchWorker(id: string): void {
    this.db
      .prepare("update workers set heartbeat_at = ?, state = 'alive' where id = ?")
      .run(Date.now(), id);
  }

  closeWorker(id: string, state: WorkerRecord["state"]): void {
    this.db.prepare("update workers set state = ? where id = ?").run(state, id);
  }

  listWorkers(): WorkerRecord[] {
    return this.db.prepare("select * from workers order by started_at desc").all() as unknown as WorkerRecord[];
  }

  // -------------------------------------------------------------- report

  metrics(): ReportMetrics {
    const scalar = (sql: string): number => {
      const row = this.db.prepare(sql).get() as Record<string, number> | undefined;
      const value = row ? Object.values(row)[0] : 0;
      return Number(value ?? 0);
    };
    const durations = this.db
      .prepare(
        `select (finished_at - started_at) as d from tasks
          where finished_at is not null and started_at is not null and state = 'done'`,
      )
      .all() as unknown as { d: number }[];

    return {
      events: scalar("select count(*) from events"),
      events_ignored: scalar("select count(*) from events where status = 'ignored'"),
      events_routed: scalar("select count(*) from events where status = 'routed'"),
      decisions: scalar("select count(*) from decisions"),
      tasks: scalar("select count(*) from tasks"),
      tasks_done: scalar("select count(*) from tasks where state = 'done'"),
      tasks_failed: scalar("select count(*) from tasks where state = 'failed'"),
      tasks_queued: scalar("select count(*) from tasks where state in ('queued', 'dispatching')"),
      tasks_running: scalar("select count(*) from tasks where state = 'running'"),
      attempts: scalar("select count(*) from runs"),
      recoveries: scalar("select count(*) from runs where note like 'stale%'"),
      inline_chars: scalar("select coalesce(sum(inline_chars), 0) from runs"),
      spill_chars: scalar("select coalesce(sum(spill_chars), 0) from runs"),
      durations_ms: durations.map((row) => Number(row.d)).filter((value) => value > 0),
    };
  }

  recordIncident(incident: WatchdogIncident): void {
    this.addMemory({
      thread: incident.thread,
      kind: "event",
      level: "inline",
      content: `watchdog ${incident.action}: ${incident.detail}`,
      task_id: incident.task_id,
    });
  }
}
