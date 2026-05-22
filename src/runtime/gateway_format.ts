export function chunkTelegramMessage(content: string, maxChars: number): string[] {
  if (maxChars <= 0) {
    throw new Error("messageChunkChars must be positive.");
  }
  if (content.length <= maxChars) {
    return [content || " "];
  }
  const chunks: string[] = [];
  let remaining = content;
  while (remaining.length > maxChars) {
    const cut = findChunkBoundary(remaining, maxChars);
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length) {
    chunks.push(remaining);
  }
  if (chunks.length <= 1) {
    return chunks;
  }
  return chunks.map((chunk, index) => index === 0 ? chunk : `[continued ${index + 1}/${chunks.length}]\n${chunk}`);
}

function findChunkBoundary(content: string, maxChars: number): number {
  const window = content.slice(0, maxChars);
  const paragraph = window.lastIndexOf("\n\n");
  if (paragraph > maxChars * 0.4) {
    return paragraph + 2;
  }
  const line = window.lastIndexOf("\n");
  if (line > maxChars * 0.4) {
    return line + 1;
  }
  return maxChars;
}
