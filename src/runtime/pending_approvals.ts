import {
  CodexAmendmentLedger,
  formatCodexAmendmentApplied,
  formatCodexAmendmentPreview,
  type CodexAmendment
} from "./codex_amendment.js";
import {
  formatShellApprovalPreview,
  type ShellApproval,
  ShellApprovalLedger
} from "./shell_approval.js";

export type PendingApprovalSummary = {
  shellApprovals: ShellApproval[];
  codexAmendments: CodexAmendment[];
};

export type PendingApprovalActionResult = {
  ok: boolean;
  content: string;
};

export function getPendingApprovalSummary(workspaceRoot: string): PendingApprovalSummary {
  return {
    shellApprovals: new ShellApprovalLedger(workspaceRoot).list({ status: "pending" }),
    codexAmendments: new CodexAmendmentLedger(workspaceRoot).list()
  };
}

export function formatPendingApprovals(summary: PendingApprovalSummary): string {
  const lines = [
    "COSIA Pending Approvals",
    "",
    "Durable approval ledgers"
  ];
  if (!summary.shellApprovals.length && !summary.codexAmendments.length) {
    lines.push("  None.");
  } else {
    lines.push(`  Shell approvals: ${summary.shellApprovals.length}`);
    for (const approval of summary.shellApprovals) {
      lines.push(`    ${approval.id}  risk:${approval.risk}${approval.blocked ? " blocked" : ""}  expires:${approval.expiresAt}`);
      lines.push(`      Apply: cosia apply ${approval.id} --yes`);
      lines.push(`      Cancel: cosia cancel ${approval.id} --reason "<reason>"`);
    }
    lines.push(`  Codex amendments: ${summary.codexAmendments.length}`);
    for (const amendment of summary.codexAmendments) {
      lines.push(`    ${amendment.id}  ${amendment.targetPath}  created:${amendment.createdAt}`);
      lines.push(`      Apply: cosia apply ${amendment.id} --yes`);
      lines.push(`      Cancel: cosia cancel ${amendment.id} --reason "<reason>"`);
    }
  }
  lines.push(
    "",
    "Session/chat-local previews",
    "  REPL and Telegram previews can also live inside that session or chat.",
    "  Use /pending or #대기중인 작업 보여줘 there, then /apply or #적용 for the concrete preview.",
    "",
    "Plain text approval such as \"승인할게\" does not apply changes."
  );
  return lines.join("\n");
}

export async function applyPendingApproval(
  workspaceRoot: string,
  id: string,
  options: { yes?: boolean; confirm?: string } = {}
): Promise<PendingApprovalActionResult> {
  if (id.startsWith("shell_")) {
    const ledger = new ShellApprovalLedger(workspaceRoot);
    const approval = ledger.get(id);
    if (!approval) {
      throw new Error(`Pending shell approval not found: ${id}. Run \`cosia pending\`.`);
    }
    if (!options.yes) {
      return {
        ok: false,
        content: [
          formatShellApprovalPreview(approval),
          "",
          `Re-run with: cosia apply ${id} --yes`
        ].join("\n")
      };
    }
    const result = await ledger.apply(id, { confirm: options.confirm });
    return { ok: result.ok, content: result.content };
  }

  if (id.startsWith("amend_")) {
    const ledger = new CodexAmendmentLedger(workspaceRoot);
    const amendment = ledger.get(id);
    if (!amendment) {
      throw new Error(`Pending Codex amendment not found: ${id}. Run \`cosia pending\`.`);
    }
    if (!options.yes) {
      return {
        ok: false,
        content: [
          formatCodexAmendmentPreview(amendment),
          "",
          `Re-run with: cosia apply ${id} --yes`
        ].join("\n")
      };
    }
    const applied = await ledger.apply(id);
    return { ok: true, content: formatCodexAmendmentApplied(applied) };
  }

  throw new Error(`Unknown pending approval id: ${id}. Run \`cosia pending\`.`);
}

export function cancelPendingApproval(
  workspaceRoot: string,
  id: string,
  reason: string
): PendingApprovalActionResult {
  if (id.startsWith("shell_")) {
    const cancelled = new ShellApprovalLedger(workspaceRoot).cancel(id, reason);
    return {
      ok: true,
      content: [
        "Shell approval cancelled.",
        `Approval: ${cancelled.id}`,
        `Status: ${cancelled.status}`,
        `Reason: ${cancelled.failureReason ?? (reason.trim() || "Cancelled by user.")}`
      ].join("\n")
    };
  }
  if (id.startsWith("amend_")) {
    const cancelled = new CodexAmendmentLedger(workspaceRoot).cancel(id, reason);
    return {
      ok: true,
      content: [
        "Codex amendment cancelled.",
        `Amendment: ${cancelled.id}`,
        `Status: ${cancelled.status}`,
        `Path: ${cancelled.targetPath}`,
        `Reason: ${cancelled.failureReason ?? (reason.trim() || "Cancelled by user.")}`
      ].join("\n")
    };
  }
  throw new Error(`Unknown pending approval id: ${id}. Run \`cosia pending\`.`);
}
