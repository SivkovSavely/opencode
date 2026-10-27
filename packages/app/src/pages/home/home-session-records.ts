import type { Session } from "@opencode-ai/sdk/v2/client"
import type { LocalProject } from "@/context/layout"
import { compareSessionTime, displayName, projectForSession } from "@/pages/layout/helpers"
import { pathKey } from "@/utils/path-key"

export type HomeSessionRecord = {
  session: Session
  project: LocalProject
  projectName: string
}

export function buildHomeSessionRecords(input: {
  sessions: () => Session[]
  projectDirectories: () => string[]
  projects: () => LocalProject[]
  projectByID: () => Map<string, LocalProject>
  allDirectories?: boolean
}) {
  const directories = new Set(input.projectDirectories().map(pathKey))
  const sessions = [...new Map(input.sessions().map((session) => [session.id, session] as const)).values()].filter(
    (session) => input.allDirectories || directories.has(pathKey(session.directory)),
  )
  return sessions.sort(compareSessionTime).flatMap((session) => {
    const directory = pathKey(session.directory)
    const project: LocalProject = input
      .projects()
      .find(
        (item) =>
          pathKey(item.worktree) === directory || item.sandboxes?.some((sandbox) => pathKey(sandbox) === directory),
      ) ??
      projectForSession(session, input.projects(), input.projectByID()) ?? {
        id: session.projectID,
        worktree: session.directory,
        expanded: false,
      }
    return { session, project, projectName: displayName(project) }
  })
}
