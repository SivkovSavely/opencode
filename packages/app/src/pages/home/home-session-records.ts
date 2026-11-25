import type { Project, Session } from "@opencode-ai/sdk/v2/client"
import type { LocalProject } from "@/context/layout"
import { compareSessionTime, displayName, projectForSessionPresentation } from "@/pages/layout/helpers"
import { pathKey } from "@/utils/path-key"

export type HomeSessionRecord = {
  session: Session
  project: LocalProject
  projectName: string
}

export function buildHomeSessionRecords(input: {
  sessions: () => Session[]
  projectDirectories: () => string[]
  openedProjects: () => LocalProject[]
  repositoryProjects: () => Project[]
  allDirectories?: boolean
}) {
  const directories = new Set(input.projectDirectories().map(pathKey))
  const sessions = [...new Map(input.sessions().map((session) => [session.id, session] as const)).values()].filter(
    (session) => input.allDirectories || directories.has(pathKey(session.directory)),
  )
  const opened = input.openedProjects()
  return sessions.sort(compareSessionTime).map((session) => {
    const project = projectForSessionPresentation(session, opened, input.repositoryProjects) ?? {
      id: session.projectID,
      worktree: session.directory,
      expanded: false,
    }
    return { session, project, projectName: displayName(project) }
  })
}
