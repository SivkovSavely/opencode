import { SessionScheduleV1 } from "@opencode-ai/schema/v1/session-schedule"

export function newSchedule(): SessionScheduleV1.Input {
  return {
    message: "",
    spec: { mode: "interval", amount: 15, unit: "minutes", immediate: false },
    sessionState: "always",
    deferUntilIdle: false,
    missed: "latest",
  }
}

export function positiveInteger(value: string) {
  const number = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1)
    throw new Error("Enter a positive whole number")
  return number
}

export function scheduleDetails(item: SessionScheduleV1.Info) {
  return [
    item.summary,
    `${item.status} | ${item.completed}/${item.limit ?? "unlimited"} successes | Next: ${item.next === undefined ? "none" : new Date(item.next).toLocaleString()}`,
    `${item.sessionState === "always" ? "Send always" : item.sessionState === "busy" ? "Send when busy" : "Send when idle"}${item.sessionState === "idle" && item.deferUntilIdle ? " (defer while busy)" : ""} | Missed: ${item.missed}`,
  ]
}
