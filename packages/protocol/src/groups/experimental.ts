import { ArtifactEndpoints } from "./artifact.js"
import { MediaGetEndpoint } from "./media.js"
import { PersistentPtyGroup } from "./persistent-pty.js"
import { ScheduleEndpoints } from "./schedule.js"
import { TranscriptEndpoints } from "./transcript-search.js"

/** `server.experimental`: routes under /api/experimental, without compatibility guarantees. */
export const ExperimentalGroup = PersistentPtyGroup.add(
  MediaGetEndpoint,
  ...ScheduleEndpoints,
  ...ArtifactEndpoints,
  ...TranscriptEndpoints,
)
