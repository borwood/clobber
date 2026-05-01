import { z } from "zod";

export const PermissionModeSchema = z.enum([
  "default",
  "plan",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypassPermissions",
]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

const envelopeShape = {
  session_id: z.string(),
  transcript_path: z.string(),
  cwd: z.string(),
  permission_mode: PermissionModeSchema,
};

const toolFieldsShape = {
  tool_name: z.string(),
  tool_input: z.record(z.string(), z.unknown()),
  tool_use_id: z.string(),
};

export const PreToolUsePayloadSchema = z.object({
  ...envelopeShape,
  hook_event_name: z.literal("PreToolUse"),
  ...toolFieldsShape,
});
export type PreToolUsePayload = z.infer<typeof PreToolUsePayloadSchema>;

export const PostToolUsePayloadSchema = z.object({
  ...envelopeShape,
  hook_event_name: z.literal("PostToolUse"),
  ...toolFieldsShape,
  tool_response: z.unknown(),
});
export type PostToolUsePayload = z.infer<typeof PostToolUsePayloadSchema>;

export const UserPromptSubmitPayloadSchema = z.object({
  ...envelopeShape,
  hook_event_name: z.literal("UserPromptSubmit"),
  prompt: z.string(),
});
export type UserPromptSubmitPayload = z.infer<typeof UserPromptSubmitPayloadSchema>;

export const NotificationPayloadSchema = z.object({
  ...envelopeShape,
  hook_event_name: z.literal("Notification"),
});
export type NotificationPayload = z.infer<typeof NotificationPayloadSchema>;

export const StopPayloadSchema = z.object({
  ...envelopeShape,
  hook_event_name: z.literal("Stop"),
});
export type StopPayload = z.infer<typeof StopPayloadSchema>;

export const SessionEndPayloadSchema = z.object({
  ...envelopeShape,
  hook_event_name: z.literal("SessionEnd"),
});
export type SessionEndPayload = z.infer<typeof SessionEndPayloadSchema>;

export const PreCompactPayloadSchema = z.object({
  ...envelopeShape,
  hook_event_name: z.literal("PreCompact"),
});
export type PreCompactPayload = z.infer<typeof PreCompactPayloadSchema>;

export const SessionStartSourceSchema = z.enum(["startup", "resume", "clear", "compact"]);
export type SessionStartSource = z.infer<typeof SessionStartSourceSchema>;

export const SessionStartPayloadSchema = z.object({
  ...envelopeShape,
  hook_event_name: z.literal("SessionStart"),
  source: SessionStartSourceSchema.optional(),
  model: z.string().optional(),
});
export type SessionStartPayload = z.infer<typeof SessionStartPayloadSchema>;

export const HookPayloadSchema = z.discriminatedUnion("hook_event_name", [
  PreToolUsePayloadSchema,
  PostToolUsePayloadSchema,
  UserPromptSubmitPayloadSchema,
  NotificationPayloadSchema,
  StopPayloadSchema,
  SessionEndPayloadSchema,
  PreCompactPayloadSchema,
  SessionStartPayloadSchema,
]);
export type HookPayload = z.infer<typeof HookPayloadSchema>;

export type HookEventName = HookPayload["hook_event_name"];
