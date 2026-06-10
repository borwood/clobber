import { useState } from "react";
import { api } from "../api.ts";
import type { Notification } from "../api.ts";
import { useWorkspace } from "../layout/WorkspaceContext.tsx";

function formatTs(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

function PayloadPreview({ payload }: { readonly payload: Notification["payload"] }) {
  const text = typeof payload.body === "string" ? payload.body : JSON.stringify(payload.body);
  return <span className="truncate max-w-xs text-sm">{text}</span>;
}

function NotificationInspector({
  notification,
  onAck,
}: {
  readonly notification: Notification;
  readonly onAck: () => void;
}) {
  const n = notification;
  return (
    <div className="p-4 border-t border-border text-xs space-y-2 overflow-y-auto">
      <div className="flex items-center justify-between">
        <span className="font-semibold text-sm">Notification detail</span>
        <button
          className="px-2 py-1 rounded bg-accent text-white text-xs hover:opacity-80"
          data-action="ack"
          onClick={onAck}
        >
          Ack
        </button>
      </div>
      <table className="w-full text-left border-collapse">
        <tbody>
          {(
            [
              ["id", n.id],
              ["type", n.type],
              ["priority", n.priority],
              ["state", n.state],
              ["delivery_mode", n.delivery_mode ?? "—"],
              ["created_at", formatTs(n.created_at)],
              ["delivered_at", n.delivered_at !== undefined ? formatTs(n.delivered_at) : "—"],
              ["acked_at", n.acked_at !== undefined ? formatTs(n.acked_at) : "—"],
            ] as const
          ).map(([k, v]) => (
            <tr key={k} className="border-b border-border/30">
              <td className="py-0.5 pr-3 text-text-subtle w-28">{k}</td>
              <td className="py-0.5 font-mono break-all">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div>
        <div className="text-text-subtle mb-0.5">payload</div>
        <pre className="bg-surface-muted rounded p-2 overflow-x-auto text-xs whitespace-pre-wrap break-all">
          {JSON.stringify(n.payload, null, 2)}
        </pre>
      </div>

      <div>
        <div className="text-text-subtle mb-0.5">provenance</div>
        <pre className="bg-surface-muted rounded p-2 overflow-x-auto text-xs whitespace-pre-wrap break-all">
          {JSON.stringify(n.provenance, null, 2)}
        </pre>
      </div>

      {Object.keys(n.metadata).length > 0 && (
        <div>
          <div className="text-text-subtle mb-0.5">metadata</div>
          <pre className="bg-surface-muted rounded p-2 overflow-x-auto text-xs whitespace-pre-wrap break-all">
            {JSON.stringify(n.metadata, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

function NotificationRow({
  notification,
  selected,
  onSelect,
}: {
  readonly notification: Notification;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const n = notification;
  const isHigh = n.priority === "high";
  return (
    <div
      className={[
        "flex items-start gap-3 px-3 py-2 cursor-pointer border-b border-border/30",
        selected ? "bg-surface-muted" : "hover:bg-surface-hover",
        isHigh ? "border-l-2 border-l-danger" : "border-l-2 border-l-transparent",
      ].join(" ")}
      data-notification-id={n.id}
      data-priority={n.priority}
      onClick={onSelect}
    >
      <span
        className={[
          "mt-0.5 shrink-0 inline-block size-2 rounded-full",
          isHigh ? "bg-danger" : "bg-text-subtle",
        ].join(" ")}
        aria-hidden
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 text-xs text-text-subtle">
          <span className={isHigh ? "font-semibold text-danger-text" : ""}>{n.priority}</span>
          <span>·</span>
          <span>{n.type}</span>
          <span>·</span>
          <span>{n.state}</span>
          <span className="ml-auto shrink-0">{formatTs(n.created_at)}</span>
        </div>
        <div className="mt-0.5">
          <PayloadPreview payload={n.payload} />
        </div>
      </div>
    </div>
  );
}

export function InboxView() {
  const w = useWorkspace();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [ackedIds, setAckedIds] = useState<ReadonlySet<string>>(new Set());

  const notifications = w.userNotifications.filter((n) => !ackedIds.has(n.id));
  const selected = notifications.find((n) => n.id === selectedId) ?? null;

  function handleAck(id: string) {
    void api.ackNotification(id).then(() => {
      setAckedIds((prev) => new Set([...prev, id]));
      if (selectedId === id) setSelectedId(null);
    });
  }

  const hasUnread = notifications.length > 0;
  const hasHigh = notifications.some((n) => n.priority === "high");

  if (w.invalidWorkspace) {
    return (
      <p className="text-sm text-text-subtle p-4">
        Workspace not found. Pick one above or create a new workspace.
      </p>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border text-sm font-semibold">
        <span>Inbox</span>
        {hasUnread && (
          <span
            className={[
              "inline-block size-2 rounded-full",
              hasHigh ? "bg-danger" : "bg-accent",
            ].join(" ")}
            aria-label={hasHigh ? "high-priority unread" : "unread"}
          />
        )}
        <span className="ml-auto text-xs text-text-subtle font-normal">
          {notifications.length} unread
        </span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {notifications.length === 0 && (
          <p className="text-sm text-text-subtle px-3 py-4">No unread notifications</p>
        )}
        {notifications.map((n) => (
          <NotificationRow
            key={n.id}
            notification={n}
            selected={n.id === selectedId}
            onSelect={() => setSelectedId((prev) => (prev === n.id ? null : n.id))}
          />
        ))}
      </div>

      {selected !== null && (
        <NotificationInspector
          notification={selected}
          onAck={() => handleAck(selected.id)}
        />
      )}
    </div>
  );
}
