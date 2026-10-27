export function sessionBookmarkRollback(input: {
  expectedRevision: number
  currentRevision: number
  persisted: boolean | undefined
  previous: boolean | undefined
}) {
  if (input.expectedRevision !== input.currentRevision) return
  return input.persisted ?? input.previous ?? false
}
