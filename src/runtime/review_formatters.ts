import type {
  ReviewBatchDiscardResult,
  ReviewCleanupResult,
  ReviewInbox,
  ReviewInboxItem,
  ReviewStats
} from "./review_inbox.js";

export function formatReviewInbox(inbox: ReviewInbox, title = "Review Inbox"): string {
  const lines = [
    title,
    `Pending: ${inbox.totalPending} (${inbox.memoryPending} memory, ${inbox.skillPending} skill)`
  ];
  if (inbox.items.length !== inbox.totalPending) {
    lines.push(`Showing: ${inbox.items.length}`);
  }
  if (!inbox.items.length) {
    lines.push("No pending review items.");
    return lines.join("\n");
  }
  lines.push("");
  lines.push(`${pad("#", 4)} ${pad("Type", 6)} ${pad("ID", 10)} ${pad("Risk", 6)} ${pad("Conf", 5)} Summary`);
  for (const item of inbox.items) {
    lines.push(`${pad(String(item.index), 4)} ${pad(item.type, 6)} ${pad(item.idPrefix, 10)} ${pad(item.risk, 6)} ${pad(String(item.conflictCount), 5)} ${item.summary}`);
  }
  lines.push("");
  lines.push("Tip: indexes are temporary. Prefer id prefixes, e.g. `/review show abc12345`.");
  return lines.join("\n");
}

export function formatReviewNext(item: ReviewInboxItem | undefined): string {
  if (!item) {
    return "No pending review items.";
  }
  return [
    `Next review item: ${item.index} ${item.type} ${item.idPrefix}`,
    `Risk: ${item.risk}`,
    `Conflicts: ${item.conflictCount}`,
    `Summary: ${item.summary}`,
    "",
    `Show: /review show ${item.idPrefix}`,
    item.type === "memory" && item.conflictCount ? `Conflicts: /review conflicts ${item.idPrefix}` : undefined,
    `Promote: /review promote ${item.idPrefix}${item.type === "skill" ? " --yes" : ""}`,
    `Discard: /review discard ${item.idPrefix} --reason "<reason>"`,
    "Tip: indexes are temporary. Prefer id prefixes."
  ].filter(Boolean).join("\n");
}

export function formatReviewUpdate(inbox: ReviewInbox): string {
  const lines = [
    `Review updated. Remaining pending: ${inbox.totalPending} (${inbox.memoryPending} memory, ${inbox.skillPending} skill)`
  ];
  if (inbox.items.length) {
    lines.push("Next items:");
    for (const item of inbox.items.slice(0, 3)) {
      lines.push(`- ${item.idPrefix} ${item.type} ${item.risk} conflicts:${item.conflictCount} ${item.summary}`);
    }
  }
  lines.push("Tip: indexes are temporary. Prefer id prefixes.");
  return lines.join("\n");
}

export function formatReviewBatchDiscard(result: ReviewBatchDiscardResult): string {
  const lines = [
    result.applied ? "Discarded conflicting memory candidates." : "Conflict discard preview. Re-run with --yes to apply.",
    `Applied: ${result.applied}`,
    `Matched: ${result.matched}`,
    `Discarded: ${result.discarded}`,
    `Reason: ${result.reason}`
  ];
  if (result.items.length) {
    lines.push("Targets:");
    for (const item of result.items.slice(0, 10)) {
      lines.push(`- ${item.idPrefix} ${item.risk} conflicts:${item.conflictCount} ${item.summary}`);
    }
    if (result.items.length > 10) {
      lines.push(`- ... ${result.items.length - 10} more`);
    }
  }
  return lines.join("\n");
}

export function formatReviewStats(stats: ReviewStats): string {
  const lines = [
    "Review Queue Stats",
    `Pending: ${stats.pending}`,
    `Promoted: ${stats.promoted}`,
    `Discarded: ${stats.discarded}`,
    `Auto-promoted: ${stats.autoPromoted}`,
    `Reverted: ${stats.reverted}`,
    "",
    `Memory: ${formatCounts(stats.memory)}`,
    `Skill: ${formatCounts(stats.skill)}`,
    `Oldest pending age: ${stats.oldestPendingAgeDays ?? "none"} day(s)`,
    `Old pending >${stats.pendingWarningDays}d: ${stats.pendingOlderThanWarning}`,
    `Cleanup eligible discarded >${stats.discardedRetentionDays}d: ${stats.cleanupEligibleDiscarded}`,
    "",
    "Recommended:",
    stats.pending ? "  cosia review" : "  No pending review items.",
    stats.cleanupEligibleDiscarded ? "  cosia review cleanup" : "  No cleanup needed."
  ];
  return lines.join("\n");
}

export function formatReviewCleanup(result: ReviewCleanupResult): string {
  const totalEligible = result.memory.eligible + result.skill.eligible;
  return [
    result.applied ? "Review cleanup applied." : "Review cleanup preview. Re-run with --yes to apply.",
    `Applied: ${result.applied}`,
    `Retention days: ${result.olderThanDays}`,
    `Memory discarded eligible: ${result.memory.eligible}`,
    `Skill discarded eligible: ${result.skill.eligible}`,
    `Memory discarded removed: ${result.memory.deleted}`,
    `Skill discarded removed: ${result.skill.deleted}`,
    `Total ${result.applied ? "removed" : "eligible"}: ${totalEligible}`,
    `Retained discarded memory: ${result.memory.retainedDiscarded}`,
    `Retained discarded skill: ${result.skill.retainedDiscarded}`
  ].join("\n");
}

export function formatReviewInboxCompact(inbox: ReviewInbox, title = "Review Inbox"): string {
  const lines = [
    title,
    `Pending: ${inbox.totalPending} (${inbox.memoryPending} memory, ${inbox.skillPending} skill)`
  ];
  for (const item of inbox.items.slice(0, 8)) {
    lines.push(`${item.index}. ${item.type} ${item.idPrefix} ${item.risk} c:${item.conflictCount} ${item.summary}`);
  }
  if (inbox.items.length > 8) {
    lines.push(`... ${inbox.items.length - 8} more`);
  }
  lines.push("Tip: use id prefixes. /review refreshes the inbox.");
  return lines.join("\n");
}

function formatCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort(([left], [right]) => left.localeCompare(right));
  return entries.length ? entries.map(([status, count]) => `${status}:${count}`).join(", ") : "none";
}

function pad(value: string, length: number): string {
  return value.length >= length ? value : `${value}${" ".repeat(length - value.length)}`;
}
