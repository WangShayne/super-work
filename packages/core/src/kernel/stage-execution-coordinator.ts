// Facade: stage execution logic lives in the stage-*-helpers / stage-run-ticket-stage modules.
// Re-exports keep every historical import path (`./kernel/stage-execution-coordinator.ts`) working.
export {
  ensureVisualBaselineDirOp,
  runRepoVerificationGateOp,
} from "./stage-verification-helpers.ts";
export { runTicketStageOp } from "./stage-run-ticket-stage.ts";
export { handleSpecTestPostTurnOp } from "./stage-spec-test-helpers.ts";
export { handleRebaseStageOp } from "./stage-rebase-helpers.ts";
