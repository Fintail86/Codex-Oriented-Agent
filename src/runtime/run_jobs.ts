import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathExists } from "./fs_utils.js";
import { gatewayRoot } from "./gateway_locks.js";

export type RunJobStatus =
  | "queued"
  | "running"
  | "waiting_for_provider"
  | "waiting_for_tool"
  | "waiting_for_approval"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export type RunJobFailureKind =
  | "provider_error"
  | "tool_error"
  | "timeout"
  | "gateway_stopped"
  | "unknown";

export type RunJobSource = {
  channel: "telegram" | "repl" | "cli";
  chatId?: string;
  chatType?: string;
  messageThreadId?: number | string;
  userId?: string;
  username?: string;
  firstName?: string;
};

export type RunJobRecord = {
  id: string;
  sessionId: string;
  providerId?: string;
  source: RunJobSource;
  request: string;
  status: RunJobStatus;
  currentStep?: string;
  cancelRequestedAt?: string;
  failureKind?: RunJobFailureKind;
  finalOutputSummary?: string;
  errorSummary?: string;
  lastToolResultSummary?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

type RunJobStore = {
  version: 1;
  jobs: RunJobRecord[];
};

export type RunJobCreateInput = {
  sessionId: string;
  providerId?: string;
  source: RunJobSource;
  request: string;
};

export type RunJobUpdateInput = Partial<Omit<RunJobRecord, "id" | "createdAt">>;

const terminalStatuses = new Set<RunJobStatus>(["succeeded", "failed", "cancelled", "interrupted"]);
const summaryMaxChars = 4000;

export class RunJobLedger {
  constructor(private readonly workspaceRoot: string) {}

  async create(input: RunJobCreateInput): Promise<RunJobRecord> {
    const now = new Date().toISOString();
    const job: RunJobRecord = {
      id: newRunJobId(),
      sessionId: input.sessionId,
      providerId: input.providerId,
      source: input.source,
      request: input.request,
      status: "queued",
      currentStep: "queued",
      createdAt: now,
      updatedAt: now
    };
    const store = await this.loadStore();
    store.jobs.push(job);
    await this.saveStore(store);
    return job;
  }

  async get(jobId: string): Promise<RunJobRecord | undefined> {
    return (await this.loadStore()).jobs.find((job) => job.id === jobId);
  }

  async list(filter: {
    chatId?: string;
    sessionId?: string;
    includeTerminal?: boolean;
  } = {}): Promise<RunJobRecord[]> {
    const jobs = (await this.loadStore()).jobs.filter((job) => {
      if (filter.chatId && job.source.chatId !== filter.chatId) return false;
      if (filter.sessionId && job.sessionId !== filter.sessionId) return false;
      if (!filter.includeTerminal && terminalStatuses.has(job.status)) return false;
      return true;
    });
    return jobs.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async nextQueuedForSession(sessionId: string): Promise<RunJobRecord | undefined> {
    return (await this.list({ sessionId, includeTerminal: true }))
      .find((job) => job.status === "queued");
  }

  async update(jobId: string, input: RunJobUpdateInput): Promise<RunJobRecord> {
    const store = await this.loadStore();
    const index = store.jobs.findIndex((job) => job.id === jobId);
    if (index < 0) {
      throw new Error(`Run job not found: ${jobId}`);
    }
    const now = new Date().toISOString();
    const current = store.jobs[index];
    const status = input.status ?? current.status;
    const completedAt = terminalStatuses.has(status)
      ? input.completedAt ?? current.completedAt ?? now
      : input.completedAt ?? current.completedAt;
    const updated: RunJobRecord = {
      ...current,
      ...input,
      status,
      lastToolResultSummary: truncateSummary(input.lastToolResultSummary ?? current.lastToolResultSummary),
      finalOutputSummary: truncateSummary(input.finalOutputSummary ?? current.finalOutputSummary),
      errorSummary: truncateSummary(input.errorSummary ?? current.errorSummary),
      completedAt,
      updatedAt: now
    };
    store.jobs[index] = updated;
    await this.saveStore(store);
    return updated;
  }

  async requestCancel(jobId: string): Promise<RunJobRecord> {
    const job = await this.get(jobId);
    if (!job) {
      throw new Error(`Run job not found: ${jobId}`);
    }
    if (terminalStatuses.has(job.status)) {
      return job;
    }
    const now = new Date().toISOString();
    if (job.status === "queued") {
      return this.update(jobId, {
        status: "cancelled",
        currentStep: "cancelled before execution",
        cancelRequestedAt: now,
        completedAt: now
      });
    }
    return this.update(jobId, {
      cancelRequestedAt: job.cancelRequestedAt ?? now,
      currentStep: "cancel requested"
    });
  }

  async interruptActiveJobs(reason = "gateway_stopped"): Promise<RunJobRecord[]> {
    const store = await this.loadStore();
    const interrupted: RunJobRecord[] = [];
    for (const job of store.jobs) {
      if (terminalStatuses.has(job.status)) {
        continue;
      }
      interrupted.push(await this.update(job.id, {
        status: "interrupted",
        failureKind: "gateway_stopped",
        currentStep: reason,
        errorSummary: "Job interrupted by gateway stop/restart. Resume is not supported in v0.52."
      }));
    }
    return interrupted;
  }

  private async loadStore(): Promise<RunJobStore> {
    const path = runJobsPath(this.workspaceRoot);
    if (!(await pathExists(path))) {
      return { version: 1, jobs: [] };
    }
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<RunJobStore>;
    return {
      version: 1,
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  }

  private async saveStore(store: RunJobStore): Promise<void> {
    await mkdir(gatewayRoot(this.workspaceRoot), { recursive: true });
    await writeFile(runJobsPath(this.workspaceRoot), `${JSON.stringify(store, null, 2)}\n`, "utf8");
  }
}

export function formatRunJobAccepted(job: RunJobRecord): string {
  return [
    "작업을 시작했어.",
    `Job: ${job.id}`,
    `상태 보기: /job ${job.id}`,
    `취소: /cancel ${job.id}`
  ].join("\n");
}

export function formatRunJobList(jobs: RunJobRecord[]): string {
  if (!jobs.length) {
    return "No active run jobs.";
  }
  return [
    "Run jobs",
    ...jobs.map((job) => `${job.id}\t${job.status}\t${job.currentStep ?? "-"}\t${previewLine(job.request, 80)}`)
  ].join("\n");
}

export function formatRunJobDetail(job: RunJobRecord): string {
  return [
    `Run job: ${job.id}`,
    `Status: ${job.status}`,
    `Session: ${job.sessionId}`,
    job.source.chatId ? `Chat: ${job.source.chatId}` : undefined,
    job.source.userId ? `User: ${job.source.userId}` : undefined,
    `Request: ${job.request}`,
    job.currentStep ? `Current step: ${job.currentStep}` : undefined,
    job.cancelRequestedAt ? `Cancel requested at: ${job.cancelRequestedAt}` : undefined,
    job.failureKind ? `Failure kind: ${job.failureKind}` : undefined,
    job.lastToolResultSummary ? `Last tool result:\n${job.lastToolResultSummary}` : undefined,
    job.finalOutputSummary ? `Final summary:\n${job.finalOutputSummary}` : undefined,
    job.errorSummary ? `Error:\n${job.errorSummary}` : undefined,
    `Created: ${job.createdAt}`,
    `Updated: ${job.updatedAt}`,
    job.completedAt ? `Completed: ${job.completedAt}` : undefined
  ].filter(Boolean).join("\n");
}

export function formatRunJobCancel(job: RunJobRecord): string {
  if (job.status === "cancelled") {
    return `Run job cancelled: ${job.id}`;
  }
  if (terminalStatuses.has(job.status)) {
    return `Run job is already ${job.status}: ${job.id}`;
  }
  return [
    `Cancel requested for run job: ${job.id}`,
    "If a provider/tool call is already in flight, COSIA will suppress the final Telegram response when it returns."
  ].join("\n");
}

export function runJobsPath(workspaceRoot: string): string {
  return join(gatewayRoot(workspaceRoot), "run_jobs.json");
}

export function isRunJobTerminal(status: RunJobStatus): boolean {
  return terminalStatuses.has(status);
}

export function truncateSummary(value: string | undefined): string | undefined {
  if (!value) return value;
  const normalized = redactSummary(value.replace(/\r\n/g, "\n").trim());
  if (normalized.length <= summaryMaxChars) return normalized;
  return `${normalized.slice(0, summaryMaxChars)}\n[COSIA: summary truncated, originalChars=${normalized.length}]`;
}

function redactSummary(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[REDACTED_SECRET]")
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^"'\s]+/gi, "$1=[REDACTED_SECRET]");
}

function newRunJobId(): string {
  return `job_${randomBytes(4).toString("hex")}`;
}

function previewLine(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars)}...`;
}
