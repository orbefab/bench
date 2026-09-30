/**
 * One running world per document, and the public face of it. The code lives
 * in `host/` by concern: `doc` (state), `registry`, `serial`, `lifecycle`,
 * `recording`, `run`. This file re-exports what importers use.
 */
export type {
  AttachWorldOptions,
  WorldHandle,
  WorldSubscription,
} from "./host/doc";
export {
  attachWorld,
  ensureWorldRun,
  faultWorld,
  stopWorld,
} from "./host/lifecycle";
export {
  brownoutBootSnapshot,
  frameAt,
  readAdcTrace,
  readRecording,
  recordingInfo,
  setRecordingBound,
  setRecordingEnabled,
} from "./host/recording";
export {
  publishWorldEvent,
  resolveWorldFile,
  type WorldRunView,
  worldDocumentOpen,
  worldRunView,
  worldWorkerCount,
  worldWorkerEntry,
} from "./host/registry";
export {
  moveWorldTarget,
  pauseWorld,
  playWorld,
  rejectWorldStep,
  restartWorld,
  stepWorld,
  worldStepInFlight,
} from "./host/run";
export { boardRx, readSerial, sendSerial } from "./host/serial";
