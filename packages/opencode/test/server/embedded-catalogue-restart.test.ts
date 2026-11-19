// Register the unchanged recovery assertions with provider/model overrides omitted.
if (process.env.PHASE14_SUPPLEMENT === "1") {
  process.env.PHASE14_COMPILED = "1"
  process.env.PHASE14_CATALOGUE = "1"
  await import("./handoff-restart.test")
}
