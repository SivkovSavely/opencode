import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { RunCommand } from "./cli/cmd/run"
import { GenerateCommand } from "./cli/cmd/generate"
import { ConsoleCommand } from "./cli/cmd/account"
import { ProvidersCommand } from "./cli/cmd/providers"
import { AgentCommand } from "./cli/cmd/agent"
import { UpgradeCommand } from "./cli/cmd/upgrade"
import { UninstallCommand } from "./cli/cmd/uninstall"
import { ModelsCommand } from "./cli/cmd/models"
import { UI } from "./cli/ui"
import { cliVersion } from "./cli/version"
import { FormatError } from "./cli/error"
import { ServeCommand } from "./cli/cmd/serve"
import { DebugCommand } from "./cli/cmd/debug"
import { StatsCommand } from "./cli/cmd/stats"
import { McpCommand } from "./cli/cmd/mcp"
import { GithubCommand } from "./cli/cmd/github"
import { ExportCommand } from "./cli/cmd/export"
import { ImportCommand } from "./cli/cmd/import"
import { AttachCommand } from "./cli/cmd/attach"
import { TuiThreadCommand } from "./cli/cmd/tui"
import { AcpCommand } from "./cli/cmd/acp"
import { EOL } from "os"
import { WebCommand } from "./cli/cmd/web"
import { PrCommand } from "./cli/cmd/pr"
import { SessionCommand } from "./cli/cmd/session"
import { DbCommand } from "./cli/cmd/db"
import { errorMessage } from "./util/error"
import { PluginCommand } from "./cli/cmd/plug"
import { Heap } from "./cli/heap"
import { ApiCommand } from "./cli/cmd/api"
import { apiCompletion, waitForApiCompletion } from "./cli/cmd/api/completion"
import { normalizeApiArgs } from "./cli/cmd/api/args"

const normalizedArgs = normalizeApiArgs(hideBin(process.argv))
const args = normalizedArgs.args
const apiInvocation = normalizedArgs.api
const apiIndex = apiInvocation ? args.indexOf("api") : -1
const completionIndex = args.indexOf("--get-yargs-completions")
const completionArgs = completionIndex < 0 ? [] : args.slice(completionIndex + 1)
const completionRootArgs = completionArgs[0]?.split(/[\\/]/).at(-1) === "opencode" ? completionArgs.slice(1) : completionArgs
const runMessageNamedApi = completionIndex >= 0 && !apiInvocation && completionRootArgs[0] === "run" && completionRootArgs[1] === "api"

function show(out: string) {
  const text = out.trimStart()
  if (!text.startsWith("opencode ")) {
    process.stderr.write(UI.logo() + EOL + EOL)
    process.stderr.write(text + EOL)
    return
  }
  process.stderr.write(out)
}

const cli = yargs(args)
  .parserConfiguration({ "populate--": true })
  .scriptName("opencode")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", cliVersion)
  .alias("version", "v")
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .option("pure", {
    describe: "run without external plugins",
    type: "boolean",
  })
  .middleware(async (opts) => {
    if (opts.printLogs) process.env.OPENCODE_PRINT_LOGS = "1"
    if (opts.logLevel) process.env.OPENCODE_LOG_LEVEL = opts.logLevel
    if (opts.pure) {
      process.env.OPENCODE_PURE = "1"
    }

    const offlineApiInvocation =
      args[0] === "completion" ||
      args.includes("--get-yargs-completions") ||
      (apiIndex >= 0 && args.slice(apiIndex).some((arg) => arg === "-h" || arg === "--help"))
    if (offlineApiInvocation) return

    Heap.start()

    process.env.AGENT = "1"
    process.env.OPENCODE = "1"
    process.env.OPENCODE_PID = String(process.pid)
  })
  .usage("")
  .completion("completion", "generate shell completion script", apiCompletion)
  .command(AcpCommand)
  .command(McpCommand)
  .command(TuiThreadCommand)
  .command(AttachCommand)
  .command(RunCommand)
  .command(GenerateCommand)
  .command(DebugCommand)
  .command(ConsoleCommand)
  .command(ProvidersCommand)
  .command(AgentCommand)
  .command(UpgradeCommand)
  .command(UninstallCommand)
  .command(ServeCommand)
  .command(WebCommand)
  .command(ModelsCommand)
  .command(StatsCommand)
  .command(ExportCommand)
  .command(ImportCommand)
  .command(GithubCommand)
  .command(PrCommand)
  .command(SessionCommand)
  .command(PluginCommand)
  .command(DbCommand)
  .command(runMessageNamedApi ? [] : [ApiCommand])
  .fail((msg, err) => {
    if (args.includes("--get-yargs-completions")) return
    if (apiInvocation && (msg?.startsWith("Unknown argument") || msg?.startsWith("Invalid values:"))) {
      if (err) throw err
      process.stderr.write(msg + EOL)
      process.exit(1)
    }
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    ) {
      if (err) throw err
      cli.showHelp(show)
    }
    if (err) throw err
    process.exit(1)
  })
  .strict()

try {
  if (args.includes("-h") || args.includes("--help")) {
    await cli.parse(args, (err: Error | undefined, _argv: unknown, out: string) => {
      if (err) throw err
      if (!out) return
      show(out)
    })
  } else if (args[0] === "completion" && (process.env.SHELL?.includes("zsh") || process.env.ZSH_NAME?.includes("zsh"))) {
    const chunks: string[] = []
    const originalWrite = process.stdout.write
    const originalLog = console.log
    const originalExit = process.exit
    const completionExit = Symbol("completion exit")
    process.stdout.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(typeof encoding === "string" ? encoding : "utf8"))
      if (typeof encoding === "function") encoding()
      callback?.()
      return true
    }) as typeof process.stdout.write
    console.log = (...values: Parameters<typeof console.log>) => chunks.push(values.map(String).join(" ") + EOL)
    process.exit = ((code?: number) => {
      process.exitCode = code ?? 0
      throw completionExit
    }) as typeof process.exit
    try {
      await cli.parse()
    } catch (error) {
      if (error !== completionExit) throw error
    } finally {
      process.stdout.write = originalWrite
      console.log = originalLog
      process.exit = originalExit
    }
    const script = chunks.join("").replace(
      "  else\n    _default\n  fi",
      `  else
    if [[ " \${words[*]} " != *" api "* ]]; then
      _default
      return
    fi
    case \${words[CURRENT]} in
      --directory=*) IPREFIX=\${words[CURRENT]%%=*}=; PREFIX=\${words[CURRENT]#*=}; _files -/; return 0 ;;
      --body-file=*) IPREFIX=\${words[CURRENT]%%=*}=; PREFIX=\${words[CURRENT]#*=}; compadd -- -; _files; return 0 ;;
      --output=*) IPREFIX=\${words[CURRENT]%%=*}=; PREFIX=\${words[CURRENT]#*=}; _files; return 0 ;;
      --path=*) IPREFIX=\${words[CURRENT]%%=*}=; PREFIX=\${words[CURRENT]#*=}; _files; return 0 ;;
    esac
    case \${words[CURRENT-1]} in
      --directory|--directory=*) _files -/ ;;
      --body-file|--body-file=*) compadd -- -; _files ;;
      --output|--output=*|--path|--path=*) _files ;;
      *)
        if [[ " \${words[*]} " == *" api v2 fs read "* ]]; then _files; return 0; fi
        return 0
        ;;
    esac
  fi`,
    )
    process.stdout.write(script)
  } else {
    await cli.parse()
  }
} catch (e) {
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error("Unexpected error" + EOL)
    process.stderr.write(errorMessage(e) + EOL)
  }
  process.exitCode = 1
} finally {
  if (args.includes("--get-yargs-completions")) await waitForApiCompletion()
  if ((apiInvocation || args.includes("--get-yargs-completions")) && process.exitCode !== 130 && process.exitCode !== 124) {
    await Promise.all([
      new Promise<void>((resolve) => process.stdout.write("", () => resolve())),
      new Promise<void>((resolve) => process.stderr.write("", () => resolve())),
    ])
  }
  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Most notably, some docker-container-based MCP servers don't handle such signals unless
  // run using `docker run --init`.
  // Explicitly exit to avoid any hanging subprocesses.
  process.exit()
}
