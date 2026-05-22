import type { RoleTrigger } from "@clobber/shared";

const PAYLOAD_MAX_CHARS = 2000;

function renderWithPayload(head: string, payload: unknown): string {
  if (payload === undefined) return head;
  const body = JSON.stringify(payload, null, 2).slice(0, PAYLOAD_MAX_CHARS);
  return `${head}\n\n${body}`;
}

export function defaultSynthesizePrompt(
  trigger: RoleTrigger,
  payload: unknown,
): string {
  switch (trigger.kind) {
    case "cron":
      return `a cron fired: ${trigger.expr}`;
    case "file-watch":
      return `a file-watch fired: ${trigger.glob}`;
    case "webhook":
      return renderWithPayload(`a webhook fired: ${trigger.path}`, payload);
    case "issue-assigned":
      return trigger.repo === undefined
        ? "an issue was assigned"
        : `an issue was assigned in ${trigger.repo}`;
    case "workspace-open":
      return renderWithPayload("the workspace was opened", payload);
  }
}
