import { api, type TranscriptLine } from "../api.ts";
import { usePolledResource } from "./usePolledResource.ts";

const EMPTY: readonly TranscriptLine[] = [];

export function useTranscript(sessionId: string | null): readonly TranscriptLine[] {
  const poll = usePolledResource(
    () => (sessionId === null ? Promise.resolve(EMPTY) : api.getTranscript(sessionId)),
    [sessionId],
  );
  return poll.data ?? EMPTY;
}
