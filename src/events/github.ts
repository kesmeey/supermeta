import type { Config } from "../config.ts";
import type { EventKind, SourcedEvent } from "../types.ts";
import { fetchJson } from "../net.ts";
import type { EventSource } from "./source.ts";

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: string;
  comments: number;
  updated_at: string;
  user: { login: string } | null;
  labels: ({ name?: string } | string)[];
  pull_request?: unknown;
}

interface GitHubNotification {
  id: string;
  updated_at: string;
  reason: string;
  subject: { title: string; url: string | null; type: string };
  repository: { full_name: string };
}

/**
 * Polls GitHub for work. Two modes:
 *  - watch.repos non-empty: poll each repo's open issues (cheap, no notification
 *    scope required, works unauthenticated for public repos);
 *  - watch.repos empty: poll /notifications (needs a token with `notifications`).
 */
export class GitHubSource implements EventSource {
  readonly name = "github";
  readonly #config: Config;
  readonly #token: string | undefined;
  readonly #etags = new Map<string, string>();
  readonly #seen = new Set<string>();
  readonly #commentCounts = new Map<string, number>();

  constructor(config: Config) {
    this.#config = config;
    this.#token = process.env[config.github.token_env];
  }

  async poll(): Promise<SourcedEvent[]> {
    if (this.#config.watch.repos.length === 0) {
      if (!this.#token) {
        throw new Error(
          `no repositories configured: set watch.repos in config.json, or export ${this.#config.github.token_env} to use notifications`,
        );
      }
      return this.#pollNotifications();
    }
    const out: SourcedEvent[] = [];
    for (const repo of this.#config.watch.repos) {
      out.push(...(await this.#pollRepo(repo)));
    }
    return out;
  }

  async #pollRepo(repo: string): Promise<SourcedEvent[]> {
    const url =
      `${this.#config.github.api_base}/repos/${repo}/issues` +
      `?state=open&sort=updated&direction=desc&per_page=${this.#config.github.per_page}`;
    const response = await fetchJson<GitHubIssue[]>(url, {
      token: this.#token,
      etag: this.#etags.get(url) ?? null,
    });
    if (response.notModified || !response.data) return [];
    if (response.etag) this.#etags.set(url, response.etag);

    const events: SourcedEvent[] = [];
    for (const issue of response.data) {
      if (issue.pull_request) continue;
      const thread = `${repo}#${issue.number}`;
      const labels = issue.labels
        .map((label) => (typeof label === "string" ? label : label.name ?? ""))
        .filter((name) => name.length > 0);

      if (!this.#seen.has(thread)) {
        this.#seen.add(thread);
        this.#commentCounts.set(thread, issue.comments);
        events.push({
          id: `issue:${thread}`,
          source: "github",
          kind: "issue_opened",
          repo,
          thread,
          actor: issue.user?.login ?? "unknown",
          title: issue.title,
          body: issue.body ?? "",
          url: issue.html_url,
          labels,
          at: Date.parse(issue.updated_at) || Date.now(),
        });
        continue;
      }

      const previous = this.#commentCounts.get(thread) ?? 0;
      if (issue.comments > previous) {
        this.#commentCounts.set(thread, issue.comments);
        events.push({
          id: `comment:${thread}:${issue.comments}`,
          source: "github",
          kind: "issue_commented",
          repo,
          thread,
          actor: "thread",
          title: `Re: ${issue.title}`,
          body: `${issue.comments - previous} new comment(s)`,
          url: issue.html_url,
          labels,
          at: Date.now(),
        });
      }
    }
    return events;
  }

  async #pollNotifications(): Promise<SourcedEvent[]> {
    const url = `${this.#config.github.api_base}/notifications?all=false&per_page=${this.#config.github.per_page}`;
    const response = await fetchJson<GitHubNotification[]>(url, {
      token: this.#token,
      etag: this.#etags.get(url) ?? null,
    });
    if (response.notModified || !response.data) return [];
    if (response.etag) this.#etags.set(url, response.etag);

    const events: SourcedEvent[] = [];
    for (const item of response.data) {
      const repo = item.repository.full_name;
      const number = extractNumber(item.subject.url ?? "");
      if (number === null) continue;
      const thread = `${repo}#${number}`;
      const id = `notif:${item.id}:${item.updated_at}`;
      if (this.#seen.has(id)) continue;
      this.#seen.add(id);

      const kind: EventKind =
        item.reason === "review_requested"
          ? "review_requested"
          : item.reason === "mention"
            ? "mentioned"
            : "issue_commented";

      events.push({
        id,
        source: "github",
        kind,
        repo,
        thread,
        actor: item.reason,
        title: item.subject.title,
        url: `https://github.com/${repo}/issues/${number}`,
        labels: [],
        at: Date.parse(item.updated_at) || Date.now(),
      });
    }
    return events;
  }
}

function extractNumber(url: string): number | null {
  const match = /\/issues\/(\d+)$|\/pulls\/(\d+)$/.exec(url);
  if (!match) return null;
  const raw = match[1] ?? match[2];
  return raw ? Number(raw) : null;
}

export async function fetchIssue(
  config: Config,
  repo: string,
  number: number,
): Promise<GitHubIssue | null> {
  const token = process.env[config.github.token_env];
  const url = `${config.github.api_base}/repos/${repo}/issues/${number}`;
  const response = await fetchJson<GitHubIssue>(url, { token });
  return response.data;
}
