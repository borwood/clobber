import { wrapClobberTag, type ClobberPromptTag } from "@clobber/shared";

/**
 * Wire format for `claude -p --input-format stream-json`. Each user turn is a
 * single JSON object on its own line written to the child's stdin. claude
 * keeps the child alive across turns and exits when stdin closes.
 *
 * `tag` marks the turn as clobber-synthesized (wake-kick, trigger, ask-answer,
 * spawn-prompt, live-inject); the content is wrapped in `<clobber type=…>` so
 * the receiving agent and the web transcript can both tell it apart from a
 * bare human-composer turn. Composer paths omit `tag` — bareness is the
 * positive presence signal.
 */
export function serializeUserMessage(
  content: string,
  tag?: ClobberPromptTag,
): string {
  const wrapped = tag === undefined ? content : wrapClobberTag(content, tag);
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: wrapped },
  }) + "\n";
}

/**
 * Aborts the in-flight turn without ending the session. claude responds with
 * a `control_response` and a `result` of subtype `error_during_execution`,
 * then accepts the next user message normally. SIGINT, by contrast, would
 * exit the process.
 */
export function serializeInterruptRequest(requestId: string): string {
  return JSON.stringify({
    type: "control_request",
    request_id: requestId,
    request: { subtype: "interrupt" },
  }) + "\n";
}

/**
 * Retunes the running session's model; takes effect on the next turn. claude
 * accepts aliases ("sonnet") and full ids ("claude-sonnet-5") alike.
 */
export function serializeSetModelRequest(requestId: string, model: string): string {
  return JSON.stringify({
    type: "control_request",
    request_id: requestId,
    request: { subtype: "set_model", model },
  }) + "\n";
}

/**
 * Effort has no dedicated control subtype; it rides the generic
 * `apply_flag_settings` channel (the stream-json analogue of `--effort`).
 */
export function serializeSetEffortRequest(requestId: string, effort: string): string {
  return JSON.stringify({
    type: "control_request",
    request_id: requestId,
    request: { subtype: "apply_flag_settings", settings: { effort } },
  }) + "\n";
}
