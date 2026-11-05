// Public entry of the round-engine module (M13). Other modules import ONLY from here.
export { RoundEngineModule } from './round-engine.module';
export { RoundEngineService, type CodingRoundContext, type ContinueAfterCoding } from './round-engine.service';
export { isOnlineRound, roundKind, type RoundKind } from './online-test';
export {
  CODING_CONSENT_VERSION,
  cameraModeFromEnv,
  cameraMonitored,
  codingMinutes,
  type CameraMode,
  type CodingKind,
  emptyCodingState,
  parseCodingState,
  type CodingFinishReason,
  type CodingQuestionState,
  type CodingState,
} from './coding-round';
export { hashAssessmentToken } from './link';
