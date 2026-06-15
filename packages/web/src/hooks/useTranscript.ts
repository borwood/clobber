import { api, type TranscriptLine } from "../api.ts";
import { useAppendPoll } from "./useAppendPoll.ts";

export function useTranscript(sessionId: string | null): readonly TranscriptLine[] {
  return useAppendPoll<TranscriptLine>(
    (cursor) => (sessionId === null ? null : api.getTranscript(sessionId, cursor)),
    [sessionId],
  );
}
