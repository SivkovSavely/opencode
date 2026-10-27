export function updateSessionBookmark<T extends { bookmarked?: boolean }>(input: {
  session: {
    get(sessionID: string): T | undefined
    remember(session: T): unknown
  }
  sessionID: string
  bookmarked: boolean
}) {
  const session = input.session.get(input.sessionID)
  if (!session) return
  const previous = session.bookmarked
  input.session.remember({ ...session, bookmarked: input.bookmarked })
  return { previous }
}

export function updateSessionBookmarkPending(pending: ReadonlySet<string>, sessionID: string, value: boolean) {
  const next = new Set(pending)
  if (value) next.add(sessionID)
  else next.delete(sessionID)
  return next
}

export function sessionBookmarkRollback(input: {
  expectedRevision: number
  currentRevision: number
  persisted: boolean | undefined
  previous: boolean | undefined
}) {
  if (input.expectedRevision !== input.currentRevision) return
  return input.persisted ?? input.previous ?? false
}
