export const calendarStatuses = {
  confirmed: "确认",
  conflict: "冲突",
  planned: "待定",
  cancelled: "取消",
} as const;
export type CalendarStatus = keyof typeof calendarStatuses;
export function calendarStatus(status: string): CalendarStatus {
  if (["confirmed", "booked", "completed"].includes(status)) return "confirmed";
  if (status === "conflict") return "conflict";
  if (status === "cancelled") return "cancelled";
  return "planned";
}
export const calendarStatusLabels: Record<string, string> = Object.fromEntries(
  [
    "confirmed",
    "booked",
    "completed",
    "conflict",
    "cancelled",
    "applied",
    "planned",
    "considering",
    "waiting",
  ].map((s) => [s, calendarStatuses[calendarStatus(s)]]),
);
