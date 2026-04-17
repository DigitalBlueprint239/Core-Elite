# @core-elite/field-ops

> **Status: PLANNED — Not Yet Integrated**
>
> This package is scaffolded and fully authored but is **not imported anywhere
> in the production Vite/React web application.** It is written for a future
> React Native mobile client. Importing it into the web bundle will fail because
> it depends on `react-native`, `expo-haptics`, and other RN-only APIs that do
> not exist in a browser context.

---

## Purpose

`field-ops` is the **mission-critical field operations UI layer** for combine
staff capturing drill results on personal smartphones in high-stress outdoor
environments. It is designed as a self-contained, independently testable package
that can be dropped into any React Native host app.

The package enforces three hard engineering constraints for the combine floor:

| Constraint | Implementation |
|---|---|
| Max 2 decision taps to complete a capture | `captureReducer`: QR scan auto-advances to `drill_active`; only CONFIRM requires a deliberate tap |
| 56dp minimum touch target throughout | `theme.ts` TOUCH constants; all controls exceed this |
| ≥7:1 WCAG AAA contrast everywhere | `theme.ts` design tokens, contrast ratios documented per pair |

---

## Contents

```
packages/field-ops/src/
├── StationCapture.tsx    Primary screen component (React Native)
├── machine.ts            Pure TypeScript state machine (no RN deps — testable in Node)
├── theme.ts              Design tokens: colors (C), spacing (S), typography (T), TOUCH, LAYOUT
├── index.ts              Public API surface
└── components/
    ├── AthleteCard.tsx   Athlete identity display (large name at arm's length)
    ├── DrillKeypad.tsx   Oversized numeric keypad — replaces native keyboard
    ├── ErrorBanner.tsx   Non-blocking persistent error overlay
    ├── ScanPrompt.tsx    Idle-state full-screen scan CTA
    └── SyncPill.tsx      Online/offline/pending indicator (nav bar)
```

### State Machine (`machine.ts`)

Five phases with deterministic transitions:

```
idle → athlete_scanned → drill_active → result_captured → syncing → idle
         (auto, no tap)                                  (CONFIRM tap)
        ANY state → idle on RESET
```

The machine is a pure reducer (`CaptureState, CaptureAction → CaptureState`).
No I/O, no side effects. Import and test directly in Node/vitest.

### `StationCapture` Props (dependency injection)

All I/O is injected — the component has no hard dependencies on Supabase or
any specific BLE library:

```typescript
interface Props {
  stationId:     string;
  eventId:       string;
  onBack:        () => void;
  fetchStation?: (id: string) => Promise<Station>;
  fetchAthlete?: (qrCode: string, eventId: string) => Promise<Athlete>;
  submitResult?: (payload: SubmitPayload) => Promise<Result>;
  openScanner?:  (onScan: (code: string) => void) => void;
}
```

When `submitResult` is omitted, results are written to the IndexedDB outbox
via `addToOutbox()` (same path as the web app's `StationMode.tsx`).

---

## Relationship to the Web App

`StationCapture.tsx` is the React Native equivalent of `src/pages/StationMode.tsx`.
They share:

- State machine concepts (`idle`, `scanning`, `result_captured`, `syncing`)
- HLC timestamp generation (`src/lib/hlc.ts`)
- Outbox writes (`src/lib/offline.ts → addToOutbox`)
- Validation pipeline (`src/lib/scoring/validation.ts`)
- Drill catalog (`src/constants.ts`)

These are imported via relative paths (`../../../src/lib/...`). In a real RN
monorepo, they would be extracted to a shared `@core-elite/shared` package.

---

## Integration Prerequisites

Before this package can be used in a React Native app:

1. Bootstrap a React Native project with the New Architecture enabled
2. Install: `expo-haptics`, `react-native` peer dependencies
3. Wire `fetchStation`, `fetchAthlete`, `submitResult`, `openScanner` to the
   app's Supabase client and QR scanner library
4. Replace relative `../../../src/lib/` imports with a shared package or path aliases
5. Run the component in the `native-ble` timing pipeline for automatic capture
   (see `packages/native-ble/README.md`)
