import { createSignal, onCleanup, onMount, Show, type JSX } from "solid-js"
import { SessionScheduleV1 } from "@opencode-ai/schema/v1/session-schedule"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { createScheduleAPI, type ScheduleAPI } from "../schedule/api"
import { newSchedule, positiveInteger, scheduleDetails } from "../schedule/form"

export function DialogSchedules(props: { sessionID: string }) {
  const sdk = useSDK()
  const sync = useSync()
  return (
    <SchedulesView
      sessionID={props.sessionID}
      api={createScheduleAPI(sdk.client, (id) => sync.data.session.find((item) => item.id === id))}
    />
  )
}

export function SchedulesView(props: { sessionID: string; api: ScheduleAPI }) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const [view, setView] = createSignal<() => JSX.Element>()
  const [error, setError] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [draft, setDraft] = createSignal(newSchedule())
  let editing: string | undefined
  let alive = true
  onCleanup(() => {
    alive = false
  })
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  type Choice = { title: string; run: () => void; details?: string[] }

  function menu(title: string, choices: Choice[], details?: string[]) {
    setView(() => () => {
      const footer = details ? (
        <scrollbox maxHeight={8}>
          <text fg={theme.textMuted}>{details.join("\n")}</text>
        </scrollbox>
      ) : undefined
      return (
        <DialogSelect
          title={title}
          locked={busy()}
          options={choices.map((item, value) => ({ title: item.title, value, details: item.details }))}
          onSelect={(item) => {
            setError("")
            choices[item.value]?.run()
          }}
          footer={footer}
        />
      )
    })
  }

  async function run(action: () => Promise<void>) {
    if (busy()) return
    setBusy(true)
    setError("")
    await action().catch((cause: unknown) => {
      if (alive) setError(cause instanceof Error ? cause.message : (JSON.stringify(cause) ?? String(cause)))
    })
    if (alive) setBusy(false)
  }

  function prompt(title: string, value: string, accept: (value: string) => void, description?: string) {
    setView(() => () => (
      <DialogPrompt
        title={title}
        value={value}
        busy={busy()}
        description={description ? () => <text fg={theme.textMuted}>{description}</text> : undefined}
        onConfirm={(text) => {
          setError("")
          try {
            accept(text)
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause))
          }
        }}
      />
    ))
  }

  async function list() {
    const items = await props.api.list(props.sessionID)
    if (!alive) return
    menu(
      "Schedules",
      [
        {
          title: "+ Create schedule",
          run: () => {
            editing = undefined
            setDraft(newSchedule())
            editor()
          },
        },
        ...items.map((item) => ({
          title: item.message.replace(/\s+/g, " "),
          details: scheduleDetails(item),
          run: () => {
            void run(async () => {
              const current = await props.api.get(props.sessionID, item.id)
              if (alive) detail(current)
            })
          },
        })),
        {
          title: "Refresh",
          run: () => {
            void run(list)
          },
        },
      ],
      items.length ? undefined : ["No schedules yet. Create one to send a recurring message."],
    )
  }

  function detail(item: SessionScheduleV1.Info) {
    menu(
      "Schedule",
      [
        {
          title: "Edit",
          run: () => {
            editing = item.id
            setDraft({
              message: item.message,
              spec: item.spec,
              sessionState: item.sessionState,
              deferUntilIdle: item.deferUntilIdle,
              missed: item.missed,
              limit: item.limit,
            })
            editor()
          },
        },
        ...(item.status === "completed"
          ? []
          : [
              {
                title: item.status === "paused" ? "Resume" : "Pause",
                run: () => {
                  void run(async () => {
                    const updated = await props.api.pause(props.sessionID, item.id, item.status !== "paused")
                    if (alive) detail(updated)
                  })
                },
              },
            ]),
        {
          title: "History and errors",
          run: () => {
            void run(() => history(item))
          },
        },
        {
          title: "Delete",
          run: () =>
            menu(
              "Delete schedule?",
              [
                { title: "Cancel", run: () => detail(item) },
                {
                  title: "Confirm delete",
                  run: () => {
                    void run(async () => {
                      await props.api.remove(props.sessionID, item.id)
                      await list()
                    })
                  },
                },
              ],
              [item.message],
            ),
        },
        {
          title: "Back to schedules",
          run: () => {
            void run(list)
          },
        },
      ],
      [item.message, ...scheduleDetails(item)],
    )
  }

  async function history(item: SessionScheduleV1.Info, cursor?: number, previous: (number | undefined)[] = []) {
    const page = await props.api.history(props.sessionID, item.id, cursor)
    if (!alive) return
    menu(
      "Schedule history",
      [
        ...page.items.map((entry) => ({
          title: `${new Date(entry.scheduled).toLocaleString()} | ${entry.state}`,
          details: entry.error ? [entry.error] : undefined,
          run: () =>
            menu(
              "Occurrence",
              [
                {
                  title: "Back to history",
                  run: () => {
                    void run(() => history(item, cursor, previous))
                  },
                },
              ],
              [
                `Scheduled: ${new Date(entry.scheduled).toLocaleString()}`,
                `State: ${entry.state}`,
                ...(entry.processed ? [`Processed: ${new Date(entry.processed).toLocaleString()}`] : []),
                ...(entry.messageID ? [`Message: ${entry.messageID}`] : []),
                entry.error ?? "No error",
              ],
            ),
        })),
        ...(page.cursor === undefined
          ? []
          : [
              {
                title: "Next page",
                run: () => {
                  void run(() => history(item, page.cursor, [...previous, cursor]))
                },
              },
            ]),
        ...(previous.length
          ? [
              {
                title: "Previous page",
                run: () => {
                  void run(() => history(item, previous.at(-1), previous.slice(0, -1)))
                },
              },
            ]
          : []),
        { title: "Back to schedule", run: () => detail(item) },
      ],
      page.items.length ? undefined : ["No occurrences yet."],
    )
  }

  function editor() {
    menu(
      editing ? "Edit schedule" : "Create schedule",
      [
        {
          title: `Message: ${draft().message || "(required)"}`,
          run: () =>
            prompt(
              "Exact message text",
              draft().message,
              (message) => {
                if (!message.trim()) throw new Error("Message must not be empty")
                setDraft({ ...draft(), message })
                editor()
              },
              "Text is sent exactly as entered. Newlines and spaces are preserved.",
            ),
        },
        { title: `Timing: ${draft().spec.mode}`, run: timing },
        {
          title: `State: ${draft().sessionState === "always" ? "Send always" : draft().sessionState === "busy" ? "Send when busy" : "Send when idle"}`,
          run: () =>
            menu(
              "Send condition",
              (
                [
                  ["always", "Send always (default)"],
                  ["busy", "Send when busy"],
                  ["idle", "Send when idle"],
                ] as const
              ).map(([sessionState, title]) => ({
                title,
                run: () => {
                  setDraft({ ...draft(), sessionState, deferUntilIdle: false })
                  editor()
                },
              })),
            ),
        },
        ...(draft().sessionState === "idle"
          ? [
              {
                title: `[${draft().deferUntilIdle ? "x" : " "}] If busy, send as soon as idle`,
                run: () => {
                  setDraft({ ...draft(), deferUntilIdle: !draft().deferUntilIdle })
                  editor()
                },
              },
            ]
          : []),
        {
          title: `Missed occurrences: ${draft().missed}`,
          run: () =>
            menu(
              "Missed occurrences",
              (["latest", "all", "none"] as const).map((missed) => ({
                title: missed === "latest" ? "Latest only (default)" : missed === "all" ? "Send all" : "Skip all",
                run: () => {
                  setDraft({ ...draft(), missed })
                  editor()
                },
              })),
            ),
        },
        {
          title: `Repeat: ${draft().limit ? `${draft().limit} successes` : "Forever"}`,
          run: () =>
            menu("Repeat limit", [
              {
                title: "Forever",
                run: () => {
                  setDraft({ ...draft(), limit: undefined })
                  editor()
                },
              },
              {
                title: "N successful sends",
                run: () =>
                  prompt("Number of successful sends", String(draft().limit ?? 1), (value) => {
                    setDraft({ ...draft(), limit: positiveInteger(value) })
                    editor()
                  }),
              },
            ]),
        },
        {
          title: "Preview next 5 and save",
          run: () => {
            if (!draft().message.trim()) {
              setError("Enter a message first")
              return
            }
            void run(async () => {
              const preview = await props.api.preview(props.sessionID, draft().spec, editing)
              if (!alive) return
              const spec = draft().spec
              const times =
                spec.mode === "interval"
                  ? preview.times.map((time) => new Date(time).toLocaleString())
                  : [
                      `Times in ${spec.timeZone}`,
                      ...preview.times.map((time) => new Date(time).toLocaleString("en", { timeZone: spec.timeZone })),
                    ]
              menu(
                "Preview next 5",
                [
                  {
                    title: "Confirm and save",
                    run: () => {
                      void run(async () => {
                        const item = await props.api.save(props.sessionID, draft(), editing)
                        if (alive) detail(item)
                      })
                    },
                  },
                  { title: "Back to editor", run: editor },
                ],
                [preview.summary, ...times, `Message: ${draft().message}`],
              )
            })
          },
        },
        {
          title: "Cancel / back to schedules",
          run: () => {
            void run(list)
          },
        },
      ],
      [timingSummary()],
    )
  }

  function timingSummary() {
    const spec = draft().spec
    if (spec.mode === "interval")
      return `Every ${spec.amount} ${spec.unit}; first send ${spec.immediate ? "immediately" : "after interval"}`
    if (spec.mode === "cron") return `${spec.expression} (${spec.timeZone})`
    return `${spec.rule} ${spec.weekdays ? `days ${spec.weekdays.join(",")}` : (spec.day ?? "")} at ${spec.time} (${spec.timeZone})`
  }

  function timing() {
    menu("Timing mode", [
      {
        title: "Interval",
        run: () => {
          if (draft().spec.mode !== "interval")
            setDraft({ ...draft(), spec: { mode: "interval", amount: 15, unit: "minutes", immediate: false } })
          interval()
        },
      },
      {
        title: "Calendar",
        run: () => {
          if (draft().spec.mode !== "calendar")
            setDraft({ ...draft(), spec: { mode: "calendar", rule: "daily", time: "09:00", timeZone: zone } })
          calendar()
        },
      },
      {
        title: "Advanced: cron (5 fields)",
        run: () => {
          if (draft().spec.mode !== "cron")
            setDraft({ ...draft(), spec: { mode: "cron", expression: "0 9 * * *", timeZone: zone } })
          cron()
        },
      },
      { title: "Back", run: editor },
    ])
  }

  function interval() {
    const spec = draft().spec
    if (spec.mode !== "interval") return
    menu("Interval", [
      {
        title: `Amount: ${spec.amount}`,
        run: () =>
          prompt("Interval amount", String(spec.amount), (value) => {
            setDraft({ ...draft(), spec: { ...spec, amount: positiveInteger(value) } })
            interval()
          }),
      },
      {
        title: `Unit: ${spec.unit}`,
        run: () =>
          menu(
            "Interval unit",
            (["minutes", "hours", "days", "weeks"] as const).map((unit) => ({
              title: unit,
              run: () => {
                setDraft({ ...draft(), spec: { ...spec, unit } })
                interval()
              },
            })),
          ),
      },
      {
        title: `[${spec.immediate ? "x" : " "}] Send immediately first`,
        details: ["Applies on creation or interval changes. Editing this alone keeps the next send."],
        run: () => {
          setDraft({ ...draft(), spec: { ...spec, immediate: !spec.immediate } })
          interval()
        },
      },
      { title: "Done", run: editor },
    ])
  }

  function timezone(back: () => void) {
    const spec = draft().spec
    if (spec.mode === "interval") return
    prompt(
      "IANA time zone",
      spec.timeZone,
      (timeZone) => {
        new Intl.DateTimeFormat("en", { timeZone }).format()
        setDraft({ ...draft(), spec: { ...spec, timeZone } })
        back()
      },
      `Detected: ${zone}. Examples: Europe/London, America/New_York, UTC.`,
    )
  }

  function calendar() {
    const spec = draft().spec
    if (spec.mode !== "calendar") return
    menu(
      "Calendar",
      [
        {
          title: `Rule: ${spec.rule}`,
          run: () =>
            menu(
              "Calendar rule",
              (
                [
                  ["daily", "Daily"],
                  ["weekly", "Selected weekdays"],
                  ["monthly", "Monthly (day 1-31)"],
                  ["last-day", "Last day of month"],
                ] as const
              ).map(([rule, title]) => ({
                title,
                run: () => {
                  setDraft({
                    ...draft(),
                    spec: {
                      ...spec,
                      rule,
                      weekdays: rule === "weekly" ? (spec.weekdays ?? [1, 2, 3, 4, 5]) : undefined,
                      day: rule === "monthly" ? (spec.day ?? 1) : undefined,
                    },
                  })
                  calendar()
                },
              })),
            ),
        },
        ...(spec.rule === "weekly" ? [{ title: "Select weekdays", run: weekdays }] : []),
        ...(spec.rule === "monthly"
          ? [
              {
                title: `Day: ${spec.day}`,
                run: () =>
                  prompt(
                    "Day of month (1-31)",
                    String(spec.day ?? 1),
                    (value) => {
                      const day = positiveInteger(value)
                      if (day > 31) throw new Error("Day must be between 1 and 31")
                      setDraft({ ...draft(), spec: { ...spec, day } })
                      calendar()
                    },
                    "Months without this day are skipped.",
                  ),
              },
            ]
          : []),
        {
          title: `Time: ${spec.time}`,
          run: () =>
            prompt("Local time (HH:mm)", spec.time, (time) => {
              if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("Use HH:mm in 24-hour time")
              setDraft({ ...draft(), spec: { ...spec, time } })
              calendar()
            }),
        },
        { title: `Time zone: ${spec.timeZone}`, run: () => timezone(calendar) },
        { title: "Done", run: editor },
      ],
      [timingSummary()],
    )
  }

  function weekdays() {
    const spec = draft().spec
    if (spec.mode !== "calendar") return
    const days = spec.weekdays ?? []
    menu("Select weekdays", [
      ...["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((title, day) => ({
        title: `[${days.includes(day) ? "x" : " "}] ${title}`,
        run: () => {
          setDraft({
            ...draft(),
            spec: {
              ...spec,
              weekdays: days.includes(day) ? days.filter((value) => value !== day) : [...days, day].sort(),
            },
          })
          weekdays()
        },
      })),
      ...[
        { title: "Weekdays", days: [1, 2, 3, 4, 5] },
        { title: "Weekends", days: [0, 6] },
        { title: "Every day", days: [0, 1, 2, 3, 4, 5, 6] },
      ].map((preset) => ({
        title: preset.title,
        run: () => {
          setDraft({ ...draft(), spec: { ...spec, weekdays: preset.days } })
          weekdays()
        },
      })),
      {
        title: "Done",
        run: () => {
          if (!days.length) {
            setError("Select at least one weekday")
            return
          }
          calendar()
        },
      },
    ])
  }

  function cron() {
    const spec = draft().spec
    if (spec.mode !== "cron") return
    menu("Advanced cron", [
      {
        title: `Expression: ${spec.expression}`,
        run: () =>
          prompt(
            "Cron: minute hour day month weekday",
            spec.expression,
            (expression) => {
              if (expression.trim().split(/\s+/).length !== 5) throw new Error("Enter exactly 5 cron fields")
              setDraft({ ...draft(), spec: { ...spec, expression } })
              cron()
            },
            "Server preview validates the expression before saving.",
          ),
      },
      ...[
        { title: "Every 15 minutes", expression: "*/15 * * * *" },
        { title: "Daily at 09:00", expression: "0 9 * * *" },
        { title: "Weekdays at 09:00", expression: "0 9 * * 1-5" },
      ].map((preset) => ({
        title: preset.title,
        run: () => {
          setDraft({ ...draft(), spec: { ...spec, expression: preset.expression } })
          cron()
        },
      })),
      { title: `Time zone: ${spec.timeZone}`, run: () => timezone(cron) },
      { title: "Done", run: editor },
    ])
  }

  onMount(() => {
    dialog.setSize("large")
    void run(list)
  })
  return (
    <box>
      <Show when={view()} keyed>
        {(render) => render()}
      </Show>
      <Show when={busy()}>
        <text paddingLeft={4} fg={theme.textMuted}>
          Working...
        </text>
      </Show>
      <Show when={error()}>
        <text paddingLeft={4} paddingRight={4} fg={theme.error}>
          {error()}
        </text>
      </Show>
    </box>
  )
}
