import { createEffect, createSignal } from "solid-js"
import type { SessionQueueV1 } from "@opencode-ai/schema/v1/session-queue"
import { queueRows, type QueueController } from "./controller"

export function createQueueDialog(queue: QueueController, sessionID: string) {
  const [selected, setSelected] = createSignal<string>()
  const [confirmation, setConfirmation] = createSignal<{ action: "delete"; id: string } | { action: "clear" }>()
  const rows = () => queueRows(queue.data.snapshots[sessionID])
  const current = () => rows().find((item) => item.id === selected()) ?? rows()[0]
  const busy = () => Boolean(queue.data.busy[sessionID] || queue.data.loading[sessionID])
  createEffect(() => {
    if (!rows().some((item) => item.id === selected())) setSelected(rows()[0]?.id)
  })

  function update(mutation: SessionQueueV1.Mutation) {
    if (busy()) return
    void queue.update(sessionID, mutation)
  }

  function confirmClear() {
    if (!busy() && queue.pending(sessionID, "queue").length) setConfirmation({ action: "clear" })
  }

  return {
    rows,
    current,
    confirmation,
    busy,
    select(id: string) {
      if (confirmation()) {
        setConfirmation(undefined)
        return
      }
      setSelected(id)
    },
    confirmClear,
    key(event: { name: string; shift?: boolean; ctrl?: boolean; meta?: boolean; super?: boolean }) {
      const confirm = confirmation()
      if (confirm) {
        setConfirmation(undefined)
        if (event.name.toLowerCase() === "y" && !event.ctrl && !event.meta && !event.super) update(confirm)
        // Every cancelling key is consumed, including Escape and keys with other queue actions.
        return true
      }
      const name = event.name.toLowerCase()
      if (event.ctrl || event.meta || event.super) return false
      if (!["up", "down", "s", "p", "delete", "backspace", "c"].includes(name)) return false
      const item = current()
      if (busy()) return true
      if ((name === "up" || name === "down") && !event.shift) {
        const index = rows().findIndex((row) => row.id === item?.id)
        const next = rows()[Math.max(0, Math.min(rows().length - 1, index + (name === "up" ? -1 : 1)))]
        setSelected(next?.id)
        return true
      }
      if (name === "p") {
        const snapshot = queue.data.snapshots[sessionID]
        if (snapshot) update({ action: "pause", paused: snapshot.blocked ? false : !snapshot.paused })
        return true
      }
      if (name === "c") {
        confirmClear()
        return true
      }
      if (!item || item.state !== "pending") return true
      setSelected(item.id)
      if (name === "delete" || name === "backspace") setConfirmation({ action: "delete", id: item.id })
      if (name === "s")
        update({ action: "convert", id: item.id, delivery: item.delivery === "steer" ? "queue" : "steer" })
      if ((name === "up" || name === "down") && event.shift) {
        const group = rows().filter((row) => row.delivery === item.delivery)
        const index = group.findIndex((row) => row.id === item.id)
        const other = group[index + (name === "up" ? -1 : 1)]
        if (!other || other.state !== "pending") return true
        const ids = group.filter((row) => row.state === "pending").map((row) => row.id)
        const a = ids.indexOf(item.id)
        const b = ids.indexOf(other.id)
        ;[ids[a], ids[b]] = [ids[b], ids[a]]
        update({ action: "reorder", delivery: item.delivery, ids })
      }
      return true
    },
  }
}
