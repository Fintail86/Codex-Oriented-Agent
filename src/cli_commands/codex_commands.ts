import type { Command } from "commander";
import { readText, resolveExistingInside } from "../runtime/fs_utils.js";
import {
  CodexAmendmentLedger,
  formatCodexAmendmentApplied,
  formatCodexAmendmentDetail,
  formatCodexAmendmentList,
  formatCodexAmendmentPreview,
  formatCodexCheck
} from "../runtime/codex_amendment.js";
import { main } from "./shared.js";

export function registerCodexCommands(program: Command): void {
  const codex = program.command("codex").description("Inspect and amend protected Codex law files.");

  codex
    .command("show")
    .option("--path <path>", "Protected Codex source or mirror path to show.")
    .description("Show protected Codex law files or one protected file.")
    .action(async (options: { path?: string }) => {
      await main(async (workspaceRoot) => {
        console.log(await new CodexAmendmentLedger(workspaceRoot).readProtectedFile(options.path));
      });
    });

  codex
    .command("check")
    .description("Check protected Codex law files, policy mirror state, and amendment queue.")
    .action(async () => {
      await main(async (workspaceRoot) => {
        console.log(formatCodexCheck(await new CodexAmendmentLedger(workspaceRoot).check()));
      });
    });

  const amendment = codex.command("amendment").description("Preview, review, and apply Codex law amendments.");

  amendment
    .command("list")
    .option("--all", "Show non-pending amendments too.", false)
    .description("List Codex amendment records.")
    .action(async (options: { all: boolean }) => {
      await main(async (workspaceRoot) => {
        console.log(formatCodexAmendmentList(new CodexAmendmentLedger(workspaceRoot).list({ all: options.all })));
      });
    });

  amendment
    .command("show")
    .argument("<id>", "Codex amendment id.")
    .description("Show one Codex amendment.")
    .action(async (id: string) => {
      await main(async (workspaceRoot) => {
        const item = new CodexAmendmentLedger(workspaceRoot).get(id);
        if (!item) {
          throw new Error(`Codex amendment not found: ${id}`);
        }
        console.log(formatCodexAmendmentDetail(item));
      });
    });

  amendment
    .command("propose")
    .requiredOption("--path <path>", "Protected Codex source path.")
    .option("--content <text>", "Full proposed file content.")
    .option("--content-file <path>", "Workspace file containing the full proposed content.")
    .requiredOption("--reason <reason>", "Reason for this Codex amendment.")
    .description("Create a pending Codex amendment preview without changing files.")
    .action(async (options: { path: string; content?: string; contentFile?: string; reason: string }) => {
      await main(async (workspaceRoot) => {
        const content = await resolveProposedContent(workspaceRoot, options);
        const item = await new CodexAmendmentLedger(workspaceRoot).propose({
          targetPath: options.path,
          proposedContent: content,
          reason: options.reason,
          sourceChannel: "cli"
        });
        console.log(formatCodexAmendmentPreview(item));
      });
    });

  amendment
    .command("apply")
    .argument("<id>", "Codex amendment id.")
    .option("--yes", "Apply the amendment. Without this, only show the pending preview.", false)
    .description("Apply a pending Codex amendment.")
    .action(async (id: string, options: { yes: boolean }) => {
      await main(async (workspaceRoot) => {
        const ledger = new CodexAmendmentLedger(workspaceRoot);
        const item = ledger.get(id);
        if (!item) {
          throw new Error(`Codex amendment not found: ${id}`);
        }
        if (!options.yes) {
          console.log(formatCodexAmendmentPreview(item));
          console.log("");
          console.log(`Re-run with: cosia codex amendment apply ${id} --yes`);
          return;
        }
        console.log(formatCodexAmendmentApplied(await ledger.apply(id)));
      });
    });

  amendment
    .command("reject")
    .argument("<id>", "Codex amendment id.")
    .requiredOption("--reason <reason>", "Reject reason.")
    .description("Reject a pending Codex amendment without deleting evidence.")
    .action(async (id: string, options: { reason: string }) => {
      await main(async (workspaceRoot) => {
        const item = new CodexAmendmentLedger(workspaceRoot).reject(id, options.reason);
        console.log(`[SUCCESS] Codex amendment rejected: ${item.id}`);
        console.log(`Reason: ${item.failureReason}`);
      });
    });

  amendment
    .command("cancel")
    .argument("<id>", "Codex amendment id.")
    .requiredOption("--reason <reason>", "Cancel reason.")
    .description("Cancel a pending Codex amendment without deleting evidence.")
    .action(async (id: string, options: { reason: string }) => {
      await main(async (workspaceRoot) => {
        const item = new CodexAmendmentLedger(workspaceRoot).cancel(id, options.reason);
        console.log(`[SUCCESS] Codex amendment cancelled: ${item.id}`);
        console.log(`Reason: ${item.failureReason}`);
      });
    });
}

async function resolveProposedContent(
  workspaceRoot: string,
  options: { content?: string; contentFile?: string }
): Promise<string> {
  if (options.content !== undefined && options.contentFile !== undefined) {
    throw new Error("Use either --content or --content-file, not both.");
  }
  if (options.content !== undefined) {
    return options.content;
  }
  if (options.contentFile !== undefined) {
    return readText(await resolveExistingInside(workspaceRoot, options.contentFile));
  }
  throw new Error("Use --content or --content-file to provide full proposed content.");
}
