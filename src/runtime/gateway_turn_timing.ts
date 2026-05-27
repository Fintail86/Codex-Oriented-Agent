import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { gatewayRoot } from "./gateway_locks.js";
import type { RunProgressEvent } from "./runner.js";

export type GatewayTurnTimingSummary = {
  turnId?: string;
  connector: string;
  sessionId?: string;
  startedAt: string;
  intakeToEnqueueMs?: number;
  queueWaitMs?: number;
  runStartToProviderMs?: number;
  providerDurationMs?: number;
  toolDurationMs?: number;
  sendDurationMs?: number;
  totalTurnDurationMs: number;
  toolCount: number;
};

export class GatewayTurnTimer {
  private readonly startedAtNs: bigint;
  private readonly startedAtIso: string;
  private enqueuedAtNs?: bigint;
  private runStartedAtNs?: bigint;
  private firstProviderAtNs?: bigint;
  private providerStartedAtNs?: bigint;
  private toolStartedAtNs?: bigint;
  private providerDurationNs = 0n;
  private toolDurationNs = 0n;
  private sendDurationNs = 0n;
  private toolCount = 0;

  constructor(
    private readonly meta: { turnId?: string; connector: string; sessionId?: string },
    private readonly nowNs: () => bigint = () => process.hrtime.bigint()
  ) {
    this.startedAtNs = this.nowNs();
    this.startedAtIso = new Date().toISOString();
  }

  markEnqueued(): void {
    this.enqueuedAtNs = this.nowNs();
  }

  markRunStarted(): void {
    this.runStartedAtNs = this.nowNs();
  }

  markSendStarted(): () => void {
    const started = this.nowNs();
    return () => {
      this.sendDurationNs += this.nowNs() - started;
    };
  }

  observeProgress(event: RunProgressEvent): void {
    const now = this.nowNs();
    if (event.status === "waiting_for_provider") {
      this.closeTool(now);
      this.providerStartedAtNs = now;
      this.firstProviderAtNs ??= now;
      return;
    }
    if (event.status === "waiting_for_tool") {
      this.closeProvider(now);
      this.toolStartedAtNs = now;
      this.toolCount += 1;
      return;
    }
    if (event.status === "running" || event.status === "waiting_for_approval") {
      this.closeTool(now);
    }
  }

  summary(): GatewayTurnTimingSummary {
    const now = this.nowNs();
    this.closeProvider(now);
    this.closeTool(now);
    return {
      ...this.meta,
      startedAt: this.startedAtIso,
      intakeToEnqueueMs: nsDeltaMs(this.startedAtNs, this.enqueuedAtNs),
      queueWaitMs: this.enqueuedAtNs && this.runStartedAtNs ? nsToMs(this.runStartedAtNs - this.enqueuedAtNs) : undefined,
      runStartToProviderMs: this.runStartedAtNs && this.firstProviderAtNs ? nsToMs(this.firstProviderAtNs - this.runStartedAtNs) : undefined,
      providerDurationMs: nsToMs(this.providerDurationNs),
      toolDurationMs: nsToMs(this.toolDurationNs),
      sendDurationMs: nsToMs(this.sendDurationNs),
      totalTurnDurationMs: nsToMs(now - this.startedAtNs),
      toolCount: this.toolCount
    };
  }

  private closeProvider(now: bigint): void {
    if (!this.providerStartedAtNs) return;
    this.providerDurationNs += now - this.providerStartedAtNs;
    this.providerStartedAtNs = undefined;
  }

  private closeTool(now: bigint): void {
    if (!this.toolStartedAtNs) return;
    this.toolDurationNs += now - this.toolStartedAtNs;
    this.toolStartedAtNs = undefined;
  }
}

export async function appendGatewayTurnTiming(workspaceRoot: string, summary: GatewayTurnTimingSummary): Promise<void> {
  try {
    await mkdir(gatewayRoot(workspaceRoot), { recursive: true });
    await appendFile(join(gatewayRoot(workspaceRoot), "turn_timing.jsonl"), `${JSON.stringify(summary)}\n`, "utf8");
  } catch {
    // Timing is diagnostic only and must never fail Gateway request handling.
  }
}

function nsDeltaMs(from: bigint, to: bigint | undefined): number | undefined {
  return to === undefined ? undefined : nsToMs(to - from);
}

function nsToMs(value: bigint): number {
  return Number(value) / 1_000_000;
}
