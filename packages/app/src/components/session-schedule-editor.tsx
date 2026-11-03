import { createEffect, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import type { SessionScheduleV1 } from "@opencode-ai/schema/v1/session-schedule"
import { useLanguage } from "@/context/language"
import type { sessionSchedule } from "@/utils/session-schedule"
import "./session-schedule.css"

export function scheduleError(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string")
    return error.message
  return fallback
}

export function SessionScheduleEditor(props: {
  schedule?: SessionScheduleV1.Info
  preview: ReturnType<typeof sessionSchedule>["preview"]
  onSave: (input: SessionScheduleV1.Input) => Promise<void>
  onCancel: () => void
}) {
  const language = useLanguage()
  const [state, setState] = createStore({
    mode: props.schedule?.spec.mode ?? "interval",
    amount: props.schedule?.spec.mode === "interval" ? props.schedule.spec.amount : 15,
    unit: props.schedule?.spec.mode === "interval" ? props.schedule.spec.unit : ("minutes" as const),
    immediate: props.schedule?.spec.mode === "interval" ? props.schedule.spec.immediate : false,
    rule: props.schedule?.spec.mode === "calendar" ? props.schedule.spec.rule : ("daily" as const),
    weekdays:
      props.schedule?.spec.mode === "calendar"
        ? [...(props.schedule.spec.weekdays ?? [1, 2, 3, 4, 5])]
        : [1, 2, 3, 4, 5],
    day: props.schedule?.spec.mode === "calendar" ? (props.schedule.spec.day ?? 1) : 1,
    time: props.schedule?.spec.mode === "calendar" ? props.schedule.spec.time : "09:00",
    timeZone:
      props.schedule?.spec.mode !== "interval" && props.schedule
        ? props.schedule.spec.timeZone
        : Intl.DateTimeFormat().resolvedOptions().timeZone,
    expression: props.schedule?.spec.mode === "cron" ? props.schedule.spec.expression : "0 9 * * *",
    message: props.schedule?.message ?? "",
    sessionState: props.schedule?.sessionState ?? "always",
    deferUntilIdle: props.schedule?.deferUntilIdle ?? false,
    missed: props.schedule?.missed ?? "latest",
    limited: props.schedule?.limit !== undefined,
    limit: props.schedule?.limit ?? 10,
    preview: undefined as SessionScheduleV1.Preview | undefined,
    previewError: "",
    previewPending: true,
    pending: false,
    error: "",
  })
  const spec = (): SessionScheduleV1.Spec => {
    if (state.mode === "interval")
      return { mode: "interval", amount: state.amount, unit: state.unit, immediate: state.immediate }
    if (state.mode === "cron") return { mode: "cron", expression: state.expression, timeZone: state.timeZone }
    return {
      mode: "calendar",
      rule: state.rule,
      time: state.time,
      timeZone: state.timeZone,
      ...(state.rule === "weekly" ? { weekdays: [...state.weekdays] } : {}),
      ...(state.rule === "monthly" ? { day: state.day } : {}),
    }
  }
  createEffect(() => {
    const value = spec()
    const id = props.schedule?.id
    setState({ preview: undefined, previewError: "", previewPending: true })
    let active = true
    const timer = setTimeout(() => {
      void props.preview(value, id).then(
        (preview) => {
          if (active) setState({ preview, previewPending: false })
        },
        (error) => {
          if (active)
            setState({
              previewError: scheduleError(error, language.t("schedule.preview.failed")),
              previewPending: false,
            })
        },
      )
    }, 300)
    onCleanup(() => {
      active = false
      clearTimeout(timer)
    })
  })
  const save = async (event: SubmitEvent) => {
    event.preventDefault()
    if (state.pending || state.previewPending || !state.preview || !state.message.trim()) return
    setState({ pending: true, error: "" })
    await props
      .onSave({
        message: state.message,
        spec: spec(),
        sessionState: state.sessionState,
        deferUntilIdle: state.sessionState === "idle" && state.deferUntilIdle,
        missed: state.missed,
        ...(state.limited ? { limit: state.limit } : {}),
      })
      .catch((error) => setState("error", scheduleError(error, language.t("common.requestFailed"))))
    setState("pending", false)
  }
  return (
    <form class="session-schedule-editor flex flex-col gap-4" onSubmit={save}>
      <fieldset disabled={state.pending} class="flex flex-col gap-4">
        <label>
          {language.t("schedule.mode")}
          <select value={state.mode} onChange={(e) => setState("mode", e.currentTarget.value as typeof state.mode)}>
            <For each={["interval", "calendar", "cron"] as const}>
              {(mode) => <option value={mode}>{language.t(`schedule.mode.${mode}`)}</option>}
            </For>
          </select>
        </label>
        <Show when={state.mode === "interval"}>
          <div class="grid grid-cols-2 gap-3">
            <label>
              {language.t("schedule.amount")}
              <input
                required
                type="number"
                min="1"
                step="1"
                value={state.amount}
                onInput={(e) => setState("amount", e.currentTarget.valueAsNumber)}
              />
            </label>
            <label>
              {language.t("schedule.unit")}
              <select value={state.unit} onChange={(e) => setState("unit", e.currentTarget.value as typeof state.unit)}>
                <For each={["minutes", "hours", "days", "weeks"] as const}>
                  {(unit) => <option value={unit}>{language.t(`schedule.unit.${unit}`)}</option>}
                </For>
              </select>
            </label>
          </div>
          <label class="schedule-check">
            <input
              type="checkbox"
              checked={state.immediate}
              onChange={(e) => setState("immediate", e.currentTarget.checked)}
            />
            {language.t("schedule.immediate")}
          </label>
        </Show>
        <Show when={state.mode === "calendar"}>
          <label>
            {language.t("schedule.rule")}
            <select value={state.rule} onChange={(e) => setState("rule", e.currentTarget.value as typeof state.rule)}>
              <For each={["daily", "weekly", "monthly", "last-day"] as const}>
                {(rule) => <option value={rule}>{language.t(`schedule.rule.${rule}`)}</option>}
              </For>
            </select>
          </label>
          <Show when={state.rule === "weekly"}>
            <div class="flex flex-wrap gap-2">
              <For each={["weekdays", "weekends", "everyday"] as const}>
                {(preset) => (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() =>
                      setState(
                        "weekdays",
                        preset === "weekdays"
                          ? [1, 2, 3, 4, 5]
                          : preset === "weekends"
                            ? [0, 6]
                            : [0, 1, 2, 3, 4, 5, 6],
                      )
                    }
                  >
                    {language.t(`schedule.${preset}`)}
                  </Button>
                )}
              </For>
            </div>
            <div class="flex flex-wrap gap-3" role="group" aria-label={language.t("schedule.weekdays")}>
              <For each={[0, 1, 2, 3, 4, 5, 6] as const}>
                {(day) => (
                  <label class="schedule-check">
                    <input
                      type="checkbox"
                      checked={state.weekdays.includes(day)}
                      onChange={(e) =>
                        setState(
                          "weekdays",
                          e.currentTarget.checked
                            ? [...state.weekdays, day].sort()
                            : state.weekdays.filter((value) => value !== day),
                        )
                      }
                    />
                    {language.t(`schedule.day.${day}`)}
                  </label>
                )}
              </For>
            </div>
          </Show>
          <Show when={state.rule === "monthly"}>
            <label>
              {language.t("schedule.dayOfMonth")}
              <select value={state.day} onChange={(e) => setState("day", Number(e.currentTarget.value))}>
                <For each={Array.from({ length: 31 }, (_, i) => i + 1)}>
                  {(day) => <option value={day}>{day}</option>}
                </For>
              </select>
            </label>
          </Show>
          <label>
            {language.t("schedule.time")}
            <input required type="time" value={state.time} onInput={(e) => setState("time", e.currentTarget.value)} />
          </label>
        </Show>
        <Show when={state.mode === "cron"}>
          <label>
            {language.t("schedule.presets")}
            <select
              value={state.expression}
              onChange={(e) => {
                if (e.currentTarget.value) setState("expression", e.currentTarget.value)
              }}
            >
              <option value="">{language.t("schedule.custom")}</option>
              <For
                each={
                  [
                    ["*/15 * * * *", "quarterHour"],
                    ["0 * * * *", "hourly"],
                    ["0 9 * * *", "daily"],
                    ["0 9 * * 1-5", "weekdays"],
                    ["0 9 1 * *", "monthly"],
                  ] as const
                }
              >
                {(preset) => <option value={preset[0]}>{language.t(`schedule.preset.${preset[1]}`)}</option>}
              </For>
            </select>
          </label>
          <label>
            {language.t("schedule.expression")}
            <input
              required
              value={state.expression}
              onInput={(e) => setState("expression", e.currentTarget.value)}
              spellcheck={false}
            />
          </label>
          <p class="text-text-weak">{language.t("schedule.cron.help")}</p>
        </Show>
        <Show when={state.mode !== "interval"}>
          <label>
            {language.t("schedule.timeZone")}
            <input
              required
              value={state.timeZone}
              onInput={(e) => setState("timeZone", e.currentTarget.value)}
              spellcheck={false}
            />
          </label>
        </Show>
        <section
          aria-label={language.t("schedule.preview")}
          class="rounded-lg border border-border-weak-base p-3"
          aria-busy={state.previewPending}
        >
          <h3>{language.t("schedule.preview")}</h3>
          <Show when={state.previewPending}>
            <p role="status">{language.t("common.loading")}</p>
          </Show>
          <Show when={state.previewError}>
            <p role="alert">{state.previewError}</p>
          </Show>
          <Show when={state.preview}>
            {(preview) => (
              <>
                <p data-slot="schedule-summary">{preview().summary}</p>
                <ol class="text-text-weak">
                  <For each={preview().times}>
                    {(time) => (
                      <li>
                        <time dateTime={new Date(time).toISOString()}>
                          {new Date(time).toLocaleString(language.locale(), {
                            timeZone: state.mode === "interval" ? undefined : state.timeZone,
                          })}
                        </time>
                      </li>
                    )}
                  </For>
                </ol>
              </>
            )}
          </Show>
        </section>
        <label>
          {language.t("schedule.message")}
          <textarea
            required
            rows={5}
            value={state.message}
            onInput={(e) => setState("message", e.currentTarget.value)}
          />
        </label>
        <label>
          {language.t("schedule.sessionState")}
          <select
            value={state.sessionState}
            onChange={(e) => setState("sessionState", e.currentTarget.value as typeof state.sessionState)}
          >
            <For each={["always", "busy", "idle"] as const}>
              {(value) => <option value={value}>{language.t(`schedule.sessionState.${value}`)}</option>}
            </For>
          </select>
        </label>
        <Show when={state.sessionState === "idle"}>
          <label class="schedule-check">
            <input
              type="checkbox"
              checked={state.deferUntilIdle}
              onChange={(e) => setState("deferUntilIdle", e.currentTarget.checked)}
            />
            {language.t("schedule.defer")}
          </label>
        </Show>
        <label>
          {language.t("schedule.missed")}
          <select
            value={state.missed}
            onChange={(e) => setState("missed", e.currentTarget.value as typeof state.missed)}
          >
            <For each={["latest", "all", "none"] as const}>
              {(value) => <option value={value}>{language.t(`schedule.missed.${value}`)}</option>}
            </For>
          </select>
        </label>
        <label>
          {language.t("schedule.stop")}
          <select
            value={state.limited ? "limited" : "forever"}
            onChange={(e) => setState("limited", e.currentTarget.value === "limited")}
          >
            <option value="forever">{language.t("schedule.forever")}</option>
            <option value="limited">{language.t("schedule.limited")}</option>
          </select>
        </label>
        <Show when={state.limited}>
          <label>
            {language.t("schedule.limit")}
            <input
              required
              type="number"
              min="1"
              step="1"
              value={state.limit}
              onInput={(e) => setState("limit", e.currentTarget.valueAsNumber)}
            />
          </label>
        </Show>
      </fieldset>
      <Show when={state.error}>
        <p role="alert">{state.error}</p>
      </Show>
      <div class="flex gap-2 justify-end">
        <Button type="button" variant="ghost" disabled={state.pending} onClick={props.onCancel}>
          {language.t("common.cancel")}
        </Button>
        <Button
          type="submit"
          disabled={state.pending || state.previewPending || !state.preview || !state.message.trim()}
        >
          {language.t(state.pending ? "common.loading" : "schedule.save")}
        </Button>
      </div>
    </form>
  )
}
