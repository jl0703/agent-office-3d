import { Check, Hand, Pause, Play, Square, TriangleAlert, Unplug, type LucideIcon } from "lucide-react";
import type { AgentStatus } from "../../shared/events.ts";

export const STATUS_WORD: Record<AgentStatus, string> = {
  working: "Working",
  idle: "Idle",
  waiting: "Waiting",
  done: "Done",
  stopped: "Stopped",
  error: "Error",
  detached: "Detached",
};

const ICON: Record<AgentStatus, LucideIcon> = {
  working: Play,
  idle: Pause,
  waiting: Hand,
  done: Check,
  stopped: Square,
  error: TriangleAlert,
  detached: Unplug,
};

/** The one place that decides how a status looks: icon, word, border style and colour (see the `.chip-*` rules). */
export function StatusChip({ status }: { status: AgentStatus }) {
  const Icon = ICON[status];
  return (
    <span className={`chip chip-${status}`}>
      <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
      {STATUS_WORD[status]}
    </span>
  );
}
