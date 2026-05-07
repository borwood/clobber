/**
 * Wire format for `claude -p --input-format stream-json`. Each user turn is a
 * single JSON object on its own line written to the child's stdin. claude
 * keeps the child alive across turns and exits when stdin closes.
 */
export function serializeUserMessage(content: string): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content },
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
