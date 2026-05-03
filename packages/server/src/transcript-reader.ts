export type TranscriptLine = Record<string, unknown>;

export async function readTranscript(path: string): Promise<TranscriptLine[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  const text = await file.text();
  const lines: TranscriptLine[] = [];
  for (const raw of text.split("\n")) {
    if (raw.length === 0) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed !== null && typeof parsed === "object") {
        lines.push(parsed as TranscriptLine);
      }
    } catch {
      // Skip malformed lines; transcripts can be partially flushed.
    }
  }
  return lines;
}
