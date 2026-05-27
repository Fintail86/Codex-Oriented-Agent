import type { GatewayActivity, GatewayReplyTarget, GatewayRiskFlags } from "./gateway_runtime.js";

export type GatewaySessionTurn = {
  turnId?: string;
  workspaceRoot: string;
  connector: string;
  sessionId: string;
  activity?: GatewayActivity;
  replyTarget?: GatewayReplyTarget;
  riskFlags?: GatewayRiskFlags;
  enqueuedAt?: string;
  run: () => Promise<void>;
};

export type GatewaySessionSchedulerOptions = {
  maxConcurrentSessions?: number;
  maxPendingTurnsPerSession?: number;
  onUnhandledError?: (error: unknown, turn: GatewaySessionTurn) => void;
};

export type GatewaySessionEnqueueResult =
  | { accepted: true; pendingAhead: number }
  | { accepted: false; reason: "queue_full"; pendingCount: number };

export type GatewaySessionSchedulerSnapshot = {
  running: Array<{ connector: string; sessionId: string; pendingTurns: number; turnId?: string; enqueuedAt?: string }>;
  queued: Array<{ connector: string; sessionId: string; pendingTurns: number; turnId?: string; enqueuedAt?: string }>;
  runningCount: number;
  queuedCount: number;
};

type QueuedTurn = GatewaySessionTurn & {
  key: string;
};

const defaultMaxConcurrentSessions = 4;
const defaultMaxPendingTurnsPerSession = 10;

export class GatewaySessionScheduler {
  private readonly queues = new Map<string, QueuedTurn[]>();
  private readonly active = new Map<string, QueuedTurn>();
  private runningCount = 0;
  private readonly maxConcurrentSessions: number;
  private readonly maxPendingTurnsPerSession: number;
  private readonly onUnhandledError?: (error: unknown, turn: GatewaySessionTurn) => void;

  constructor(options: GatewaySessionSchedulerOptions = {}) {
    this.maxConcurrentSessions = Math.max(1, options.maxConcurrentSessions ?? defaultMaxConcurrentSessions);
    this.maxPendingTurnsPerSession = Math.max(1, options.maxPendingTurnsPerSession ?? defaultMaxPendingTurnsPerSession);
    this.onUnhandledError = options.onUnhandledError;
  }

  enqueue(turn: GatewaySessionTurn): GatewaySessionEnqueueResult {
    const key = gatewaySessionTurnKey(turn);
    const queue = this.queues.get(key) ?? [];
    if (queue.length >= this.maxPendingTurnsPerSession) {
      return { accepted: false, reason: "queue_full", pendingCount: queue.length };
    }
    queue.push(Object.freeze({
      ...turn,
      enqueuedAt: turn.enqueuedAt ?? new Date().toISOString(),
      key
    }));
    this.queues.set(key, queue);
    queueMicrotask(() => this.drain());
    return { accepted: true, pendingAhead: queue.length - 1 };
  }

  snapshot(filter: { workspaceRoot?: string } = {}): GatewaySessionSchedulerSnapshot {
    const running = [...this.active.values()]
      .filter((turn) => !filter.workspaceRoot || turn.workspaceRoot === filter.workspaceRoot)
      .map((turn) => ({
        connector: turn.connector,
        sessionId: turn.sessionId,
        pendingTurns: this.queues.get(turn.key)?.length ?? 0,
        turnId: turn.turnId,
        enqueuedAt: turn.enqueuedAt
      }));
    const queued = [...this.queues.entries()]
      .flatMap(([, queue]) => {
        const first = queue[0];
        if (!first || (filter.workspaceRoot && first.workspaceRoot !== filter.workspaceRoot)) {
          return [];
        }
        if (this.active.has(first.key)) {
          return [];
        }
        return [{
          connector: first.connector,
          sessionId: first.sessionId,
          pendingTurns: queue.length,
          turnId: first.turnId,
          enqueuedAt: first.enqueuedAt
        }];
      });
    return {
      running,
      queued,
      runningCount: running.length,
      queuedCount: queued.reduce((sum, item) => sum + item.pendingTurns, 0)
    };
  }

  clearQueued(filter: { workspaceRoot?: string } = {}): number {
    let cleared = 0;
    for (const [key, queue] of [...this.queues.entries()]) {
      const first = queue[0];
      if (!first || (filter.workspaceRoot && first.workspaceRoot !== filter.workspaceRoot)) {
        continue;
      }
      cleared += queue.length;
      this.queues.delete(key);
    }
    return cleared;
  }

  private drain(): void {
    while (this.runningCount < this.maxConcurrentSessions) {
      const next = this.nextRunnableTurn();
      if (!next) {
        return;
      }
      this.active.set(next.key, next);
      this.runningCount += 1;
      void this.runTurn(next);
    }
  }

  private nextRunnableTurn(): QueuedTurn | undefined {
    for (const [key, queue] of this.queues.entries()) {
      if (this.active.has(key)) {
        continue;
      }
      const next = queue.shift();
      if (!next) {
        this.queues.delete(key);
        continue;
      }
      if (!queue.length) {
        this.queues.delete(key);
      }
      return next;
    }
    return undefined;
  }

  private async runTurn(turn: QueuedTurn): Promise<void> {
    try {
      await turn.run();
    } catch (error) {
      this.onUnhandledError?.(error, turn);
    } finally {
      this.active.delete(turn.key);
      this.runningCount = Math.max(0, this.runningCount - 1);
      this.drain();
    }
  }
}

const defaultGatewaySessionScheduler = new GatewaySessionScheduler();

export function getGatewaySessionScheduler(): GatewaySessionScheduler {
  return defaultGatewaySessionScheduler;
}

export function resetGatewaySessionSchedulerForTests(): void {
  defaultGatewaySessionScheduler.clearQueued();
}

function gatewaySessionTurnKey(turn: GatewaySessionTurn): string {
  return `${turn.workspaceRoot}:${turn.connector}:${turn.sessionId}`;
}
