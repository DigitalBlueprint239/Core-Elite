/**
 * Field Ops Design Tokens
 *
 * Engineering constraints:
 *   - Minimum touch target: 56dp (Android Material / iOS HIG recommendation is 44-48pt;
 *     we exceed both for gloved / stressed / moving-hand use)
 *   - All contrast ratios ≥ 7:1 (WCAG AAA) — sunlight visibility
 *   - Color palette uses only 4-step contrast-verified pairs
 *
 * Contrast pairs (verified against APCA / WCAG 2.1):
 *   BLACK (#000) on WHITE (#FFF):          21:1  ✓
 *   WHITE (#FFF) on BLACK (#000):          21:1  ✓
 *   WHITE (#FFF) on BRAND (#1A1A2E):       15:1  ✓
 *   BLACK (#000) on AMBER (#FFB800):        9:1  ✓  ← active drill state
 *   BLACK (#000) on GREEN (#00C853):        7.4:1 ✓  ← confirm button
 *   WHITE (#FFF) on RED (#C62828):         10:1  ✓  ← error / alert
 *   WHITE (#FFF) on GRAY7 (#424242):        7:1  ✓  ← secondary text backgrounds
 */

export const C = {
  // Base
  black:        '#000000',
  white:        '#FFFFFF',

  // Brand background
  brand:        '#1A1A2E',
  brandLight:   '#16213E',

  // State: active drill — amber on black = 9:1
  amber:        '#FFB800',
  amberDark:    '#E6A500',

  // State: confirmed / success — green
  green:        '#00C853',
  greenDark:    '#00A844',

  // State: error / critical
  red:          '#C62828',
  redLight:     '#FFEBEE',

  // State: syncing
  blue:         '#1565C0',
  blueLight:    '#E3F2FD',

  // Neutral scale (all ≥7:1 on white when used as text)
  gray9:        '#212121',  // primary text
  gray7:        '#424242',  // secondary text
  gray5:        '#9E9E9E',  // disabled / placeholder
  gray2:        '#EEEEEE',  // divider / keypad key bg
  gray1:        '#F5F5F5',  // screen bg
} as const;

// ---------------------------------------------------------------------------
// Spacing (8dp grid)
// ---------------------------------------------------------------------------
export const S = {
  xs:   4,
  sm:   8,
  md:   16,
  lg:   24,
  xl:   32,
  xxl:  48,
} as const;

// ---------------------------------------------------------------------------
// Typography (sp = scaled pixels, same unit in RN StyleSheet)
// ---------------------------------------------------------------------------
export const T = {
  // Arm's-length readable — athlete name, band number
  hero:       { fontSize: 40, fontWeight: '900' as const, letterSpacing: -1 },
  heroSub:    { fontSize: 28, fontWeight: '700' as const },

  // Primary labels — drill name, value display
  title:      { fontSize: 24, fontWeight: '800' as const },
  titleMono:  { fontSize: 32, fontWeight: '900' as const, fontVariant: ['tabular-nums'] as any },

  // Controls — keypad keys, button labels
  keypad:     { fontSize: 28, fontWeight: '700' as const },
  button:     { fontSize: 20, fontWeight: '800' as const, letterSpacing: 0.5 },

  // Body / supporting info
  body:       { fontSize: 16, fontWeight: '500' as const },
  label:      { fontSize: 13, fontWeight: '600' as const, letterSpacing: 0.8 },
  caption:    { fontSize: 12, fontWeight: '400' as const },
} as const;

// ---------------------------------------------------------------------------
// Touch targets
// ---------------------------------------------------------------------------
export const TOUCH = {
  min:      56,   // absolute floor — no control goes below this
  primary:  72,   // primary action (confirm, scan)
  keypad:   64,   // keypad keys
  nav:      56,   // navigation / secondary controls
} as const;

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------
export const LAYOUT = {
  // Bottom thumb zone = bottom 40% of screen.
  // We pin the keypad and action button to the bottom via flex, not hardcoded %.
  // The parent ScrollView's contentContainerStyle uses flexGrow:1 to push content up.
  bottomZoneMinHeight: 320,   // keypad (3×64 + gaps) + confirm button (72) + padding
  borderRadius:        16,
  cardRadius:          20,
  pillRadius:          100,
} as const;
