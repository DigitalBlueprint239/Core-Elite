// Public API — field ops component system
export { StationCapture }  from './StationCapture';
export { AthleteCard }     from './components/AthleteCard';
export { DrillKeypad }     from './components/DrillKeypad';
export { ErrorBanner }     from './components/ErrorBanner';
export { ScanPrompt }      from './components/ScanPrompt';
export { SyncPill }        from './components/SyncPill';
export { captureReducer, initialState } from './machine';
export type {
  CaptureState,
  CaptureAction,
  CapturePhase,
  ErrorEntry,
} from './machine';
export { C, S, T, TOUCH, LAYOUT } from './theme';
