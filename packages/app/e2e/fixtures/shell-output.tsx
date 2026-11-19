import { Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Dynamic, render } from "solid-js/web"
import { ThemeProvider } from "@opencode-ai/ui/theme/context"
import { getTool } from "@opencode-ai/session-ui/message-part"
import { DataProvider } from "@opencode-ai/session-ui/context"
import "../../src/index.css"

const params = new URLSearchParams(location.search)
document.documentElement.dataset.newLayoutDesigns = params.get("layout") ?? "true"
document.documentElement.dir = params.get("dir") ?? "ltr"
document.documentElement.lang = params.get("lang") ?? "en"
localStorage.setItem("opencode-color-scheme", params.get("theme") ?? "light")

function Fixture() {
  const [state, setState] = createStore({
    command: 'git status --short && printf "%s" "$HOME"; echo "Finished"',
    output: "\u001b[32mfirst\u001b[0m\r\n  next\r\n",
    shell: "bash",
    status: "running",
    mounted: true,
  })
  const tool = params.get("tool") ?? "shell"
  return (
    <ThemeProvider>
      <main style={{ padding: "12px", "max-width": "800px", margin: "auto" }}>
        <label>
          Command
          <input
            aria-label="Command"
            value={state.command}
            onInput={(event) => setState("command", event.currentTarget.value)}
          />
        </label>
        <label>
          Output
          <textarea
            aria-label="Output"
            value={state.output}
            onInput={(event) => setState("output", event.currentTarget.value)}
          />
        </label>
        <label>
          Interpreter
          <input
            aria-label="Interpreter"
            value={state.shell}
            onInput={(event) => setState("shell", event.currentTarget.value)}
          />
        </label>
        <button onClick={() => setState("status", "completed")}>Complete</button>
        <button onClick={() => setState("mounted", !state.mounted)}>Toggle mount</button>
        <section aria-label="Shell tool">
          <Show when={state.mounted}>
            <DataProvider
              directory="/repo"
              data={{
                session: [],
                session_status: {},
                session_diff: {},
                message: {},
                part: {},
                get config() {
                  return { shell: state.shell }
                },
              }}
            >
              <Dynamic
                component={getTool(tool)}
                tool={tool}
                input={{ command: state.command }}
                metadata={{}}
                output={state.output}
                status={state.status}
              />
            </DataProvider>
          </Show>
        </section>
      </main>
    </ThemeProvider>
  )
}

render(() => <Fixture />, document.getElementById("root")!)
