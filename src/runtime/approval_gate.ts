import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export async function approveOverwrite(filePath: string): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(`Overwrite existing file ${filePath}? [y/N] `);
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}
