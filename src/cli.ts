#!/usr/bin/env node
import { createCliProgram } from "./cli_program.js";

const program = createCliProgram();

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
