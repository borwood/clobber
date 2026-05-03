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
