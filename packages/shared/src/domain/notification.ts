import { z } from "zod";
import { ClobberTurnSchema } from "./user-turn.ts";

/**
 * The unified notifications dispatcher's durable record (#425, EPIC #424). One
 * shape for every cross-agent and agent↔human signal — a trigger fire, a #93
 * message, an ask, a wake — generalizing the #241 `agent_questions` lifecycle
 * without disturbing it. A notification is a `<clobber>` turn (`payload`)
 * addressed to a `recipient` at a `priority`, stamped with provenance, carried
 * through a delivery/ack `state`.
 */

/** Who a notification is addressed to. The user is a first-class recipient. */
export const RecipientRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent"), agent_id: z.string().min(1) }),
  z.object({ kind: z.literal("user") }),
]);
export type RecipientRef = z.infer<typeof RecipientRefSchema>;

/** high → push/wake; low → queue/pull. */
export const PrioritySchema = z.enum(["high", "low"]);
export type Priority = z.infer<typeof PrioritySchema>;

/**
 * The delivery/ack lifecycle. Generalizes #241's `QuestionStatus`: `answered`
 * is the ask-type's ack, `acked` the generic ack, `delivered` the non-flushing
 * middle state (dumped to chat but not cleared). `pending` covers a record that
 * was persisted but not yet delivered (queued/skipped/errored at dispatch time).
 */
export const NOTIFICATION_STATES = [
  "pending",
  "delivered",
  "acked",
  "answered",
  "cancelled",
] as const;
export const NotificationStateSchema = z.enum(NOTIFICATION_STATES);
export type NotificationState = z.infer<typeof NotificationStateSchema>;

/** Reuses the #221 sink-stamp pattern so a notification is transcript-locatable. */
export const NotificationProvenanceSchema = z.object({
  source_kind: z.string().min(1),
  source_id: z.string().optional(),
  emitter_agent_id: z.string().optional(),
  commit: z.string().optional(),
  role_version_id: z.string().optional(),
  transcript_anchor: z.string().optional(),
});
export type NotificationProvenance = z.infer<typeof NotificationProvenanceSchema>;

export const NotificationSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  recipient: RecipientRefSchema,
  priority: PrioritySchema,
  payload: ClobberTurnSchema,
  provenance: NotificationProvenanceSchema,
  metadata: z.record(z.string(), z.unknown()),
  state: NotificationStateSchema,
  created_at: z.number().int().nonnegative(),
  delivered_at: z.number().int().nonnegative().optional(),
  acked_at: z.number().int().nonnegative().optional(),
});
export type Notification = z.infer<typeof NotificationSchema>;

/** The fields an emitter supplies; the store mints id/state/timestamps. */
export const CreateNotificationSchema = z.object({
  type: z.string().min(1),
  recipient: RecipientRefSchema,
  priority: PrioritySchema,
  payload: ClobberTurnSchema,
  provenance: NotificationProvenanceSchema,
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type CreateNotification = z.infer<typeof CreateNotificationSchema>;
