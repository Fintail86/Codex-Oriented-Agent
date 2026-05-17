#!/usr/bin/env node

const originalEmitWarning = process.emitWarning.bind(process) as (...args: unknown[]) => void;

process.emitWarning = ((...args: unknown[]) => {
  if (shouldSuppressNodeSqliteWarning(args)) {
    return;
  }
  originalEmitWarning(...args);
}) as typeof process.emitWarning;

await import("./cli.js");

function shouldSuppressNodeSqliteWarning(args: unknown[]): boolean {
  const warning = args[0];
  const message = warning instanceof Error ? warning.message : String(warning ?? "");
  const type = warning instanceof Error
    ? warning.name
    : typeof args[1] === "string"
      ? args[1]
      : typeof args[1] === "object" && args[1] !== null && "type" in args[1]
        ? String((args[1] as { type?: unknown }).type)
        : "";

  return type === "ExperimentalWarning" && message.includes("SQLite is an experimental feature");
}
