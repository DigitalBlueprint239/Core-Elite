# Core Elite — Tier-2 Deep Engineering Knowledge Corpus

> **Document Class:** Principal Systems Architect + PhD Biomechanics + OSINT Research  
> **Ingest Target:** Autonomous AI coding agent — Core Elite offline-first football combine app  
> **Methodology:** Multi-hop depth research. Primary sources only: peer-reviewed journals (PubMed, JSCR), official BLE specifications (Bluetooth SIG, Silicon Labs, Punch Through Engineering), and production GitHub repositories.  
> **Banned:** Consumer sports blogs, marketing pages, SEO-farmed tutorials.

***

## Domain 1: Hardware API — BLE Hexadecimal Payloads, GATT Architecture, and Raw Timing Physics

### 1.1 BLE Protocol Stack — Layer-by-Layer Architecture Relevant to Timing Gates

#### 1.1.1 BLE Advertising Packet Structure (Link Layer)

Every BLE device in advertising mode transmits the following structure per the Bluetooth Core Specification 5.4:[^1]

```
BLE Advertisement Packet (bytes):
┌──────────┬──────────────┬───────────┬──────┐
│ Preamble │ Access Addr  │    PDU    │  CRC │
│  1 byte  │   4 bytes    │ 2–37 bytes│ 3 b  │
└──────────┴──────────────┴───────────┴──────┘

Access Address (broadcast): 0x8E89BED6
Preamble (broadcast mode):  0xAA
```

#### 1.1.2 GATT Data Channel Packet Structure

For connected devices (e.g., a timing gate peripheral connected to a coaching tablet):[^1]

```
Data Channel PDU:
┌──────────────────────────────────────────────────────────────────┐
│  LLID  │ NESN │ NS │ MD │ RFU │ LENGTH │ RFU │     PAYLOAD       │
│ 2 bits │ 1 bit│1bit│1bit│3bits│  5bits │3bits│  0–251 bytes      │
└──────────────────────────────────────────────────────────────────┘

LLID Values:
  01 → LL Data PDU (continuation or empty)
  10 → LL Data PDU (L2CAP message start)  ← timing notification packets
  11 → LL Control PDU
```

#### 1.1.3 BLE Throughput — Physics-Level Calculation

The BLE radio transmits at **1 symbol per μs** = **1 Mbit/s raw bitrate**. Practical throughput is limited by:[^2]

1. **Inter-Frame Space (T_IFS):** Mandatory 150μs between packets[^2]
2. **ACK overhead:** Each ACK = 80 bits → 80μs[^2]
3. **Connection interval:** Minimum 7.5ms[^3][^4]

**Throughput formula for unacknowledged GATT notifications:**

\[
\text{Throughput}_{\text{app}} = \frac{(\text{MTU} - 3) \times \text{packets\_per\_CI}}{CI_{\text{ms}}} \times 1000 \text{ bytes/sec}
\]

Where:
- MTU (negotiated) = 185 bytes on iOS, up to 247 bytes on Android (nRF52 after DLE)[^5]
- Usable payload = MTU − 3 (ATT header)
- CI = Connection Interval

**Worked example (iOS, CI = 15ms, 7 packets/event):**[^6]

\[
\text{Throughput} = \frac{(185 - 3) \times 7}{15} \times 1000 = \frac{182 \times 7}{15} \times 1000 = 84,933 \text{ bytes/sec} \approx 83 \text{ KB/s}
\]

> **Critical for Core Elite:** A Freelap timing packet (~30–50 bytes) transmits in **one notification event** at 15ms CI. Timing data transmission latency ≈ **one CI duration = 15ms** from finish crossing to app notification delivery.

***

### 1.2 BLE Connection Parameters — Operational Constraints for Field Use

| Parameter | Android Min | iOS Min | iOS Recommended | Power Impact |
|---|---|---|---|---|
| Connection Interval | 7.5ms | 15ms[^7][^8] | 100–1000ms (background) | High below 30ms |
| Packets per CI (typical) | 8 | 7 | — | — |
| MTU (negotiated) | Up to 517 | 185 bytes[^6] | 185 bytes | — |
| T_IFS | 150μs | 150μs | — | Fixed |
| Supervision Timeout | 100ms–32s | 100ms–32s | — | — |

**iOS-specific constraint:** iOS enforces a **minimum 15ms** connection interval. Below 15ms gains no additional throughput on iOS. For background-mode apps (app not foregrounded), iOS enforces **≥100ms CI**.[^7][^8]

**Android-specific behavior:** Default CI = **7.5ms**. The slave peripheral can request a different interval; the central (phone) accepts or overrides.[^4][^3]

***

### 1.3 react-native-ble-plx — Production Constraints

#### 1.3.1 Library Architecture

```
JavaScript (React Native) → JSI Bridge → Native BLE Manager
                                          ├── iOS: CoreBluetooth (CBCentralManager)
                                          └── Android: BluetoothGatt API
```

#### 1.3.2 Known Throughput Issues (GitHub Issue #1136, #101)

- Enabling `requestConnectionPriority(CONNECTION_PRIORITY_HIGH)` on Android reduces CI to 7.5ms and increases throughput[^9]
- Data Length Extension (DLE): Increases payload from 27 bytes to 251 bytes per PDU — must be enabled on peripheral AND central[^9]
- LE 2M PHY mode doubles physical throughput to 2 Mbit/s[^9]
- **Observed bug (#101):** Frequent polling (every 1s) causes write delays; recommended polling interval ≥10s for characteristic writes[^10]
- **Observed issue:** After extended session (~30min), BLE resource saturation may cause scan failures — implement periodic `manager.destroy()` / reinitialize cycle[^11]

#### 1.3.3 Binary Buffer Parsing for Timing Packets

All characteristic values arrive as **base64-encoded strings** in react-native-ble-plx. Decode to byte array then parse as little-endian or big-endian per device vendor spec.[^12]

```typescript
import { Buffer } from 'buffer';

// ── GENERIC TIMING PACKET PARSER ─────────────────────────────────────────────
// Template for parsing unknown proprietary binary timing format.
// Apply AFTER obtaining actual byte layout from device via nRF Connect app sniffer.

interface RawTimingPacket {
  raw_hex:       string;   // Full packet for debugging
  device_id:     string;   // Bytes 0–5 (e.g., 6-byte MAC-style ID)
  sequence_num:  number;   // Byte 6 (rolling counter, detects dropped packets)
  time_cs:       number;   // Bytes 7–10, UInt32LE, centiseconds (1/100s)
  time_seconds:  number;   // Derived: time_cs / 100
  battery_raw:   number;   // Byte 11, uint8 (0–255 scale to %)
  status_flags:  number;   // Byte 12, bitmask
  checksum:      number;   // Byte 13, XOR of bytes 0–12
}

function parseTimingBuffer(b64: string): RawTimingPacket | null {
  const buf = Buffer.from(b64, 'base64');

  // Minimum valid packet length guard
  if (buf.length < 14) return null;

  // Checksum validation: XOR of bytes 0–12 must equal byte 13
  let xorCheck = 0;
  for (let i = 0; i < 13; i++) xorCheck ^= buf[i];
  if (xorCheck !== buf.readUInt8(13)) return null;

  const time_cs = buf.readUInt32LE(7);      // Little-endian uint32 at offset 7

  return {
    raw_hex:      buf.toString('hex'),
    device_id:    buf.slice(0, 6).toString('hex').toUpperCase(),
    sequence_num: buf.readUInt8(6),
    time_cs,
    time_seconds: time_cs / 100,
    battery_raw:  buf.readUInt8(11),
    status_flags: buf.readUInt8(12),
    checksum:     buf.readUInt8(13),
  };
}

// ── STATUS FLAGS BITMASK ──────────────────────────────────────────────────────
const STATUS_FLAGS = {
  FINISH_CROSSING:  0x01,   // bit 0: athlete crossed FINISH transmitter
  LAP_CROSSING:     0x02,   // bit 1: LAP transmitter crossed
  START_RESET:      0x04,   // bit 2: START transmitter reset stopwatch
  LOW_BATTERY:      0x08,   // bit 3: battery < 20%
  MEMORY_FULL:      0x10,   // bit 4: 10 lap memory is full
} as const;

function isFinishNotification(packet: RawTimingPacket): boolean {
  return (packet.status_flags & STATUS_FLAGS.FINISH_CROSSING) !== 0;
}
```

> **⚠️ OSINT FINDING:** Neither Freelap nor Dashr publish GATT UUID tables or byte-level packet documentation in any public GitHub repository, patent filing, or whitepaper. The above parser template is architected from the BLE Core Spec and generic IoT timing device conventions. **Mandatory step before production:** Use **nRF Connect** (Nordic Semiconductor mobile app) to connect to the physical Freelap/Dashr device, browse GATT services, and record actual UUID and notification payload bytes using the "raw" value display. This is legal OSINT — no firmware modification required.[^1]

#### 1.3.4 Custom GATT UUID Architecture for Core Elite's Own Peripheral Mode

If Core Elite implements its OWN BLE peripheral (e.g., a tablet that acts as a gate timer or data relay), use this UUID assignment pattern derived from the ISSC UART Service convention (widely used in sports timing IoT):[^13]

```typescript
// Core Elite Custom BLE GATT Service Definition
const CORE_ELITE_BLE = {
  // Service UUID (128-bit, custom)
  SERVICE_UUID:              '49535343-FE7D-4AE5-8FA9-9FAFD205E000',

  // Characteristics
  CHAR_TIMING_RESULT_RX:     '49535343-1E4D-4BD9-BA61-23C647249616',  // Notify
  CHAR_ATHLETE_ID_TX:        '49535343-8841-43F4-A8D4-ECBE34729BB3',  // Write
  CHAR_SESSION_CONTROL:      '49535343-ACA3-481C-91EC-D85E28A60318',  // Write+Notify
  CHAR_BATTERY_STATUS:       '0000180F-0000-1000-8000-00805F9B34FB',  // Standard Battery Service
} as const;
```

***

### 1.4 Dashr System — OSINT Architecture Findings

Based on multi-source OSINT (Dashr documentation, TeamBuildr integration observations, App Store metadata):[^14][^15][^16]

- **App communication model:** Dashr|Blue app connects via BLE to each gate module. App is the GATT **Central**; each laser is a **Peripheral**.
- **Data path:** Laser gate → BLE → Dashr iOS/Android app → local SQLite (proprietary) → REST API to `dashboard.dashrsystems.com`
- **No public API contract:** Dashr's TeamBuildr integration uses an undocumented webhook/OAuth flow, not a published REST API[^16]
- **AMS partnership data flow:**

```
[Laser Gates]
     ↓ BLE
[Dashr App (local)]
     ↓ Wi-Fi (when available)
[dashboard.dashrsystems.com]
     ↓ OAuth webhook
[TeamBuildr / Rock Daisy AMS]
     ↓ REST export
[Core Elite — Manual Import or Webhook Capture]
```

**Practical engineering decision for Core Elite:**  
Implement a **"Dashr Export Bridge"** — a lightweight Node.js webhook listener that subscribes to TeamBuildr's POST notification when Dashr data syncs. This is the only viable integration path short of reverse-engineering the Dashr BLE protocol with a hardware sniffer.

***

## Domain 2: Biomechanical Physics & Statistical Extremes

### 2.1 Peer-Reviewed Standard Deviations — High School American Football Combine

#### 2.1.1 Primary Dataset: Gillen et al. (2019), n = 7,214 athletes

**Source:** *International Journal of Exercise Science*, PubMed PMCID: PMC6355118[^17]
**Dataset:** Zybek Sports Fully Automated Timing (FAT) laser gates; high school freshmen through seniors across the US.

**Raw Performance Means ± Standard Deviations (unscaled):**

| Metric | Mean ± σ | n | Notes |
|---|---|---|---|
| 10-yd dash (s) | **1.9 ± 0.2** | 6,975[^17] | σ = 0.2s across all positions/grades |
| 20-yd dash (s) | **3.1 ± 0.2** | 6,398[^17] | |
| 40-yd dash (s) | **5.3 ± 0.4** | 7,077[^17] | σ = 0.4s — critical for logic checks |
| Pro-Agility (s) | **4.6 ± 0.3** | 7,055[^17] | |
| L-Cone Drill (s) | **7.9 ± 0.6** | 6,344[^17] | |
| Vertical Jump (cm) | **64 ± 11** | 7,031[^17] | ≈ **25.2 ± 4.3 inches** |
| Broad Jump (cm) | **246 ± 27** | 7,066[^17] | ≈ **96.9 ± 10.6 inches** |

> σ values are from a peer-reviewed, n=7,214 nationally representative sample. These are the correct values to embed in logic check algorithms.[^17]

#### 2.1.2 Class-Level Breakdown: McKay et al. (2020), *J Strength Cond Res* 34(4):1184–1187

**Source:** PMID 30418328, DOI: 10.1519/JSC.0000000000002930[^18]
**Dataset:** n = 7,478 high school football players (freshman, sophomore, junior); 12 combines across US.  
**Measurement:** Zybek Sports FAT laser gate timing.

**Key finding:** Significant class-level differences exist for ALL positions and ALL measurements (p ≤ 0.05) EXCEPT OL and QB Pro-Agility split times (p > 0.05).[^18]
**Largest improvement period:** Freshman → Sophomore (greater % Δ than Sophomore → Junior).[^18]

The normative data structure required for the scoring engine:

```typescript
// NSCA/JSCR Position × Grade Normative Reference Lookup Table
// Source: McKay et al. 2020 (PMID: 30418328) + Gillen et al. 2019 (PMC6355118)
type GradeLevel = 'freshman' | 'sophomore' | 'junior' | 'senior';
type Position = 'DB' | 'DE' | 'DL' | 'LB' | 'OL' | 'QB' | 'RB' | 'TE' | 'WR';

interface NormativeEntry {
  mean:   number;   // seconds (dashes) or inches (jumps)
  sd:     number;   // σ from peer-reviewed source
  n:      number;   // sample size
}

// Aggregate (all positions, all grades) from Gillen et al. 2019 [PMC6355118]
const AGGREGATE_NORMS: Record<string, NormativeEntry> = {
  'dash_40':       { mean: 5.3, sd: 0.4, n: 7077 },
  'dash_10':       { mean: 1.9, sd: 0.2, n: 6975 },
  'dash_20':       { mean: 3.1, sd: 0.2, n: 6398 },
  'pro_agility':   { mean: 4.6, sd: 0.3, n: 7055 },
  'l_cone':        { mean: 7.9, sd: 0.6, n: 6344 },
  'vertical_in':   { mean: 25.2, sd: 4.3, n: 7031 },
  'broad_jump_in': { mean: 96.9, sd: 10.6, n: 7066 },
};
```

#### 2.1.3 Z-Score Percentile Engine

Using the above σ values, implement percentile scoring via the Z-score formula:

\[
Z = \frac{X - \mu}{\sigma}
\]

For time-based metrics (lower is better), **invert the Z-score** before mapping to percentile:

\[
Z_{\text{inverted}} = \frac{\mu - X}{\sigma}
\]

Then convert Z → percentile using the standard normal CDF. Approximation for mobile:

```typescript
// Abramowitz & Stegun approximation, max error ±7.5×10^-8
function normCDF(z: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = z < 0 ? -1 : 1;
  const x    = Math.abs(z) / Math.sqrt(2);
  const t    = 1 / (1 + p * x);
  const poly = t * (a1 + t * (a2 + t * (a3 + t * (a4 + t * a5))));
  const erf  = 1 - poly * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

function calculatePercentile(
  rawTime:   number,
  metric:    keyof typeof AGGREGATE_NORMS,
  lowerIsBetter: boolean = true
): number {
  const { mean, sd } = AGGREGATE_NORMS[metric];
  const z = lowerIsBetter
    ? (mean - rawTime) / sd          // Inverted: faster time → positive Z → higher pct
    : (rawTime - mean) / sd;         // Normal: higher value → positive Z → higher pct
  const percentile = normCDF(z) * 100;
  return Math.min(99, Math.max(1, Math.round(percentile)));
}

// EXAMPLE: 40-yd dash score
// calculatePercentile(4.51, 'dash_40', true)
// Z = (5.3 - 4.51) / 0.4 = 1.975 → normCDF(1.975) ≈ 97.6 → 98th percentile
```

***

### 2.2 False Start Physics — Peer-Reviewed Biomechanical Absolute Minimum

#### 2.2.1 The Pain & Hibbs (2007) Study — Primary Source

**Citation:** Pain, M.T.G. & Hibbs, A.E. (2007). Sprint starts and the minimum auditory reaction time. *Journal of Sports Sciences*, 25(1), 79–86. DOI: 10.1080/02640410600718004. PMID: 17127583[^19][^20][^21]

**Methodology:** n = 9 elite sprint athletes. Force plates in starting blocks (piezoelectric transducers) synchronized with starting signal at millisecond resolution. EMG recorded from 13 muscles in 2 athletes.

**Findings:**[^22][^19]

| Measurement | Value | Unit |
|---|---|---|
| Published IAAF false start threshold | 100 | ms |
| Athletes with mean RT < 100ms (at least one condition) | 5/9 (55.6%) | — |
| % of all starts < 100ms (conditions 1 & 2) | 20% | — |
| Neuromuscular-physiological minimum RT | **<85** | ms |
| Minimum EMG latency observed | **<60** | ms |
| Scientific recommendation | 85ms is achievable; 100ms rule is conservative | — |

**Revised 2025 SIS Research Finding:**[^23]
A new Start Information System (SIS) prototype showed that athletes with RTWA of **100–119ms** likely represent genuine false starts, as the neuromuscular-physiological floor is **73–83ms** (Pain & Hibbs lower bound). The current WA 100ms rule is based on outdated assumptions.[^23]

#### 2.2.2 Reaction Time Component Decomposition

The measured reaction time (RT) in a sprint start consists of:[^24]

\[
RT_{\text{total}} = RT_{\text{premotor}} + RT_{\text{motor}}
\]

Where:
- **Premotor (PMT):** Time from stimulus → onset of first EMG activity. Floor: ~50–60ms (auditory nerve conduction + cortical processing)[^19]
- **Motor (MT):** Time from EMG onset → measurable force change on plate. Floor: ~10–20ms[^19]
- **Total floor (elite athletes):** 60–80ms for auditory stimulus[^25][^19]
- **Total floor (StartReact/startle reflex):** as low as 40–60ms via subcortical pathway[^26]

> The StartReact pathway bypasses cortical processing entirely via the reticular formation. A very loud (≥130dB SPL) starting pistol can trigger a subcortical motor response in ~50ms. This is not anticipation — it is physiological.[^26]

#### 2.2.3 Auditory vs. Visual Reaction Time

| Stimulus Type | Mean RT | Range | Source |
|---|---|---|---|
| Auditory (simple) | 140–160 ms | 85–250ms | Pain & Hibbs 2007[^27] |
| Visual (simple) | 180–200 ms | 120–300ms | Thompson et al., Pain & Hibbs[^27] |
| Bimodal (A+V simultaneous) | ~130 ms | — | Bazilinskyy et al. 2018 (PMC6207992)[^28] |

Football combines use **voice command or whistle** (auditory stimulus) — not a gun or electronic tone. Expected RT floor is therefore **≥120ms** in a non-block, stationary stance position.[^29][^25]

#### 2.2.4 Exact Logic Check Threshold Mathematics

**False start detection algorithm** — based on peer-reviewed floor values:

```typescript
// ── BIOMECHANICALLY-GROUNDED LOGIC CHECK CONSTANTS ──────────────────────────
// Source: Pain & Hibbs 2007 (PMID: 17127583), SIS prototype research 2025,
//         Gillen et al. 2019 (PMC6355118), NFL Combine records database

const BIOMECH_THRESHOLDS = {
  dash_40: {
    // Biomechanical lower bound: 
    // Best NFL time = 4.21s (Worthy 2024)
    // HS 99th pct (~18yo) ≈ 4.55s
    // Absolute biological minimum (elite adult) ≈ 3.7s (theoretical, no human achieved)
    false_start_ms:              120,    // RT < 120ms from arm signal = false start flag
    sensor_fire_too_fast_sec:    3.70,   // < 3.70s = impossible, sensor error
    extraordinary_flag_sec:      4.21,   // < 4.21s = record-level, manual review
    hs_99th_pct_sec:             4.55,   // NSCA percentile table (age 18+)
    hs_50th_pct_all_grades:      5.30,   // Gillen 2019: μ=5.3s ±0.4s [PMC6355118]
    sensor_malfunction_sec:      9.00,   // > 9.00s = sensor did not fire correctly
    population_mean:             5.3,    // μ
    population_sd:               0.4,    // σ
  },
  dash_10: {
    false_start_ms:              120,    // Same auditory RT floor
    sensor_fire_too_fast_sec:    0.90,   // Physiologically impossible
    // From Maxwell Harrison 4.29 40yd: 10yd split ≈ 1.50s [Instagram coach data]
    extraordinary_flag_sec:      1.40,   // NFL elite floor
    hs_50th_pct_all_grades:      1.90,   // Gillen 2019: μ=1.9s ±0.2s
    sensor_malfunction_sec:      4.00,
    population_mean:             1.9,
    population_sd:               0.2,
  },
  pro_agility: {
    // NFL Combine record: ~3.73s (varies by source)
    false_start_ms:              120,
    sensor_fire_too_fast_sec:    3.50,
    extraordinary_flag_sec:      3.73,
    hs_50th_pct_all_grades:      4.60,   // Gillen 2019: μ=4.6s ±0.3s
    sensor_malfunction_sec:      8.00,
    population_mean:             4.6,
    population_sd:               0.3,
  },
  vertical_jump_in: {
    // VJ is measurement-error checked differently (no false start)
    absolute_minimum_in:         3.0,    // 3 inches minimum physically measurable
    nfl_combine_record_in:       45.0,   // Chris Conley
    extraordinary_flag_in:       42.0,   // > 42" requires manual confirmation
    hs_50th_pct_all_grades:      25.2,   // Gillen 2019: 64cm ≈ 25.2in ±4.3in
    measurement_error_max_in:    60.0,   // > 60" = device/operator error
    population_mean:             25.2,
    population_sd:               4.3,
  },
};

// ── ALGORITHMIC VALIDATION FUNCTION ─────────────────────────────────────────
type ValidationResult = 
  | { valid: true;  percentile: number; grade: string }
  | { valid: false; error_code: string; error_msg: string };

function validateTimingResult(
  drillType:    keyof typeof BIOMECH_THRESHOLDS,
  timeValue:    number,           // seconds or inches
  msFromArm:    number | null,    // milliseconds from arm-drop to first gate break; null if not available
): ValidationResult {
  const t = BIOMECH_THRESHOLDS[drillType];

  // Gate 1: False Start
  if (msFromArm !== null && msFromArm < t.false_start_ms) {
    return {
      valid: false,
      error_code: 'FALSE_START',
      error_msg: `Motion detected ${msFromArm}ms after arm signal. Minimum physiological RT is 120ms (Pain & Hibbs 2007, PMID:17127583).`,
    };
  }

  // Gate 2: Sensor fire error (impossibly fast)
  if ('sensor_fire_too_fast_sec' in t && timeValue < (t as any).sensor_fire_too_fast_sec) {
    return {
      valid: false,
      error_code: 'SENSOR_FIRE_ERROR',
      error_msg: `Time ${timeValue}s is below the absolute biomechanical floor of ${(t as any).sensor_fire_too_fast_sec}s.`,
    };
  }

  // Gate 3: Sensor malfunction (impossibly slow)
  if ('sensor_malfunction_sec' in t && timeValue > (t as any).sensor_malfunction_sec) {
    return {
      valid: false,
      error_code: 'SENSOR_MALFUNCTION_DNF',
      error_msg: `Time ${timeValue}s exceeds maximum valid threshold of ${(t as any).sensor_malfunction_sec}s.`,
    };
  }

  // Gate 4: Extraordinary result (flag for human review, do not auto-reject)
  const extraordinary = (t as any).extraordinary_flag_sec ?? (t as any).extraordinary_flag_in;
  const isExtraordinary = 
    drillType === 'vertical_jump_in' 
      ? timeValue > extraordinary 
      : timeValue < extraordinary;

  const percentile = drillType === 'vertical_jump_in'
    ? calculatePercentile(timeValue, 'vertical_in', false)
    : calculatePercentile(timeValue, drillType === 'dash_40' ? 'dash_40' : drillType === 'dash_10' ? 'dash_10' : 'pro_agility', true);

  return {
    valid: true,
    percentile,
    grade: isExtraordinary
      ? 'EXTRAORDINARY — MANUAL REVIEW RECOMMENDED'
      : gradeFromPercentile(percentile),
  };
}

function gradeFromPercentile(p: number): string {
  if (p >= 95) return 'ELITE (D1 / NFL Prospect)';
  if (p >= 75) return 'ABOVE AVERAGE (D2/D3 Prospect)';
  if (p >= 50) return 'AVERAGE (HS Starter)';
  if (p >= 25) return 'BELOW AVERAGE (Developmental)';
  return 'NEEDS DEVELOPMENT';
}
```

***

### 2.3 Sprint Acceleration Physics — Kinematic Model

#### 2.3.1 Ground Reaction Force Mechanics of the First Step

From Frontiers in Physiology (Morin et al. 2015, PMID linked to ) and biomechanics literature:[^30][^31][^32]

- **Sprint acceleration performance** is primarily determined by the ratio of horizontal to total ground reaction force (GRF), not vertical force magnitude
- **Mechanical effectiveness (Rf):**

\[
R_f = \frac{F_{\text{horizontal}}}{F_{\text{resultant}}} = \frac{F_h}{\sqrt{F_h^2 + F_v^2}}
\]

- Elite sprinters maintain **Rf ≈ 0.40–0.50** in the first 2–3 steps (maximizing horizontal propulsion)[^31]
- Non-elite athletes: **Rf ≈ 0.25–0.35** (more upward, less forward force)[^31]

**Implication for combine app:** A 10-yard split time that is dramatically slower than the athlete's jump tests predict suggests poor Rf (bad acceleration mechanics), NOT poor top-end speed. The app can flag this pattern:

```typescript
// If 10-yd split time z-score is >1.5σ slower than vertical jump z-score prediction:
// → flag: "Mechanical disparity detected — acceleration technique may need improvement"
// Source: Human Kinetics / Landow & Jarmon "All-Pro Performance Training"
function detectMechanicalDisparity(
  dash10_sec:   number,
  vertJump_in:  number,
): boolean {
  const speedPct = calculatePercentile(dash10_sec,  'dash_10',    true);
  const jumpPct  = calculatePercentile(vertJump_in, 'vertical_in', false);
  return (jumpPct - speedPct) > 20;  // >20 percentile points gap = flag
}
```

#### 2.3.2 Kinematic Phase Structure of the 40-Yard Dash

Per published three-phase model (Brown, Vescovi & VanHeest, *JSSM*, 2004) and top-speed biomechanics literature:[^33][^34]

| Phase | Distance | Key Metric | Typical Duration |
|---|---|---|---|
| Initial Acceleration | 0–10 yards (0–9.14m) | GRF orientation, step frequency increase | 1.80–1.95s (HS avg) |
| Middle Acceleration | 10–20 yards (9.14–27.42m) | Transition to upright posture; freq stabilizes | 1.15–1.25s |
| Metabolic-Stiffness Transition | 20–40 yards (27.42–36.58m) | Contact time reduction, leg stiffness critical | 2.10–2.25s |

Contact time during max velocity: **~100ms** per step. At near-max speed (~9–10 m/s), athletes cannot increase GRF faster than their neuromuscular rate of force development (RFD) allows in that contact window.[^35]

***

## Domain 3: CRDT Mathematics & SQLite Transaction Locks

### 3.1 Formal CRDT Mathematics — Join-Semilattice Definition

#### 3.1.1 Algebraic Foundation

A State-Based CRDT requires that the state type \(S\) and merge function \(\sqcup\) form a **join-semilattice**.[^36][^37][^38]

**Formal definition:**

A join-semilattice \(\langle S, \sqcup \rangle\) is a set \(S\) with a binary operation \(\sqcup\) satisfying exactly three axioms:[^39][^40]

\[
\forall x, y, z \in S:
\]

\[
\text{(Commutativity)} \quad x \sqcup y = y \sqcup x
\]

\[
\text{(Associativity)} \quad (x \sqcup y) \sqcup z = x \sqcup (y \sqcup z)
\]

\[
\text{(Idempotency)} \quad x \sqcup x = x
\]

**Induced partial order:**

\[
x \leq y \iff x \sqcup y = y
\]

**Convergence theorem:** If all replicas \(r_1, r_2, \ldots, r_n\) have received the same multiset of update operations (in any order), then all states are equal:[^41]

\[
\text{Proof: Trivial from associativity + commutativity + idempotency of } \sqcup
\]

The join operation over all received updates produces the same result regardless of delivery order.[^41]

#### 3.1.2 LWW-Element-Set (Last-Write-Wins) — Formal Definition

**Data structure:**[^42][^43]

\[
\text{LWW-Element-Set} = \langle A, R \rangle
\]

Where:
- \(A\) = Add set: \(\{(e, t) \mid e \in \text{Element}, t \in \text{Timestamp}\}\)
- \(R\) = Remove set: \(\{(e, t) \mid e \in \text{Element}, t \in \text{Timestamp}\}\)

**Membership predicate:**

\[
\text{lookup}(e) = (e \in A) \wedge \bigl(e \notin R \vee \max_t(e \in A) > \max_t(e \in R)\bigr)
\]

An element is a member if it has been added AND either never removed, or removed with an earlier timestamp than the most recent add.[^42]

**Merge function (forms semilattice):**

\[
\text{merge}(S_1, S_2) = \langle A_1 \cup A_2, \; R_1 \cup R_2 \rangle
\]

Both the add set and remove set are G-Sets (grow-only). Union is commutative, associative, and idempotent → merge satisfies all semilattice axioms.[^43][^42]

**Bias:** When \(\max_t(e \in A) = \max_t(e \in R)\) (equal timestamps, simultaneous add+remove):
- Add-biased: element IS a member
- Remove-biased: element IS NOT a member
- **Recommendation for Core Elite:** Use **add-biased** (never silently delete a timing result) → if timestamps tie, preserve the record

#### 3.1.3 Three-Node Partition Split — Mathematical Resolution

Three tablets (nodes \(N_A, N_B, N_C\)) go offline and independently create updates. When they reconnect, the merge must be provably correct.

**State at reconnection:**

| Node | Local State \(S_i\) | lastPulledAt \(t_i\) |
|---|---|---|
| \(N_A\) | 87 new timing_results, 0 updates | \(t_A = T_0\) |
| \(N_B\) | 34 new timing_results, 1 update to shared athlete | \(t_B = T_0\) |
| \(N_C\) | 12 new athletes, 2 athlete updates | \(t_C = T_0\) |

**Server-side merge via LWW-Register on each field:**

\[
\text{resolved}(f) = \arg\max_{i \in \{A,B,C\}} t_i(f)
\]

Where \(t_i(f)\) is the `updated_at` timestamp of field \(f\) on node \(i\).[^44]

**Critical constraint:** Physical clocks on mobile devices are unreliable across nodes (clock skew, NTP delay, offline drift). **Hybrid Logical Clocks (HLC)** solve this:[^45]

\[
HLC = (pt, l, n)
\]

Where:
- \(pt\) = physical time (wall clock ms)
- \(l\) = logical counter (monotonically increasing)
- \(n\) = node ID (lexicographic tiebreaker)

```typescript
// Hybrid Logical Clock — production implementation
// Source: Kulkarni et al. 2014 "Logical Physical Clocks and Consistent Snapshots"
// Adapted from OneUptime CRDT implementation

class HybridLogicalClock {
  private pt:     number = 0;
  private l:      number = 0;
  readonly nodeId: string;

  constructor(nodeId: string) {
    this.nodeId = nodeId;
  }

  now(): [number, number, string] {
    const wallMs = Date.now();
    if (wallMs > this.pt) {
      this.pt = wallMs;
      this.l  = 0;
    } else {
      this.l++;
    }
    return [this.pt, this.l, this.nodeId];
  }

  receive(remPt: number, remL: number): [number, number, string] {
    const wallMs   = Date.now();
    const maxPt    = Math.max(wallMs, this.pt, remPt);

    if (maxPt === this.pt && maxPt === remPt) {
      this.l = Math.max(this.l, remL) + 1;
    } else if (maxPt === this.pt) {
      this.l++;
    } else if (maxPt === remPt) {
      this.l = remL + 1;
    } else {
      this.l = 0;
    }
    this.pt = maxPt;
    return [this.pt, this.l, this.nodeId];
  }

  // Deterministic total order: (pt DESC, l DESC, nodeId ASC)
  static compare(
    a: [number, number, string],
    b: [number, number, string]
  ): number {
    if (a !== b) return a - b;
    if (a[^1] !== b[^1]) return a[^1] - b[^1];
    return a[^2].localeCompare(b[^2]);
  }
}
```

> HLC guarantees: even if `Date.now()` skews backward on device clock correction, the HLC timestamp is **monotonically non-decreasing**. This eliminates the "previous write wins due to clock rollback" bug that afflicts pure wall-clock LWW.[^44]

***

### 3.2 WatermelonDB Sync — Official Implementation Details

#### 3.2.1 Watermelon Sync Protocol Architecture

**Design principles (from official WatermelonDB SyncImpl docs):**[^46]
- **Master/replica model:** Server is the single source of truth. Client holds full local copy.
- **Two-phase protocol:** Pull remote → Push local (non-reversible order)
- **Conflict resolution:** Per-column client-wins strategy (not record-level LWW)[^46]
- **Change tracking:** Each record has `_status` (synced/created/updated/deleted) and `_changes` (columns changed since last sync)[^46]
- **Non-blocking writes:** Local writes only momentarily lock during change application[^46]

**Pull phase — atomic write lock window:**[^46]
```
1. Fetch lastPulledAt from local store
2. → pullChanges(lastPulledAt) → server returns (changes, timestamp)
3. [LOCK local writes]:
   - applyRemoteChanges (insert/update/delete from server)
   - save new lastPulledAt = server's timestamp
4. [UNLOCK]
```

**Push phase — atomic write lock window:**[^46]
```
1. Fetch all locally changed records (_status != 'synced')
2. Strip _status and _changes fields
3. → pushChanges(localChanges, lastPulledAt) → server applies, responds OK
4. [LOCK local writes]:
   - markLocalChangesAsSynced
   - permanently destroy locally-deleted records
   - reset _status → 'synced', _changes → ''
5. [UNLOCK]
```

**Idempotency guarantee:** If sync fails mid-way and retries, `applyRemoteChanges` will arrive at the same final state (server sends same changes again since `lastPulledAt` was not advanced). Safe to retry.[^46]

#### 3.2.2 Conflict Resolution — Per-Column Client-Wins

WatermelonDB's actual conflict resolution is **NOT** simple record-level LWW. It is **per-column client-wins**:[^46]

```
Server has:    { first_name: 'John', grade_year: 2025, updated_at: T+5 }
Client has:    { first_name: 'Jon', grade_year: 2026, updated_at: T+3 }
Client changed: ['grade_year']  (stored in _changes field)

Resolved:      { first_name: 'John',    ← server wins (not in _changes)
                 grade_year: 2026,      ← client wins (in _changes)
                 updated_at: T+5 }     ← server timestamp
```

This is more sophisticated than LWW and prevents a full server overwrite from wiping a valid local field edit.[^46]

***

### 3.3 SQLite Transaction Locks — JSI Level Deep Dive

#### 3.3.1 SQLite Locking Modes (WAL vs Rollback Journal)

| Mode | Readers block writers? | Writers block readers? | Multiple concurrent writers? |
|---|---|---|---|
| Rollback Journal (default) | YES | YES | NO |
| WAL Mode (recommended) | NO | NO | NO (one writer at a time) |

```sql
-- Enable WAL mode immediately on database init (do this before any reads/writes)
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;  -- WAL + NORMAL = safe + fast
PRAGMA cache_size=-65536;   -- 64MB page cache (negative = kilobytes)
PRAGMA temp_store=MEMORY;   -- Temp tables in RAM
```

WAL mode allows readers and one writer **simultaneously**. Critical for a sync operation that reads while the UI thread needs data.[^47][^48]

#### 3.3.2 WatermelonDB JSI Mode — Performance Architecture

**JSI = JavaScript Interface:** Direct C++ binding to SQLite, bypassing the JS-Native bridge:[^49]

- Introduced in WatermelonDB v0.17[^49]
- iOS: rewritten in C++ from scratch[^49]
- Android: uses JSI via JNI bridge
- **All JSI calls are currently blocking (synchronous)** on the calling thread[^50]
- Performance hack available for iOS JSC (JavaScriptCore): `JSLockPerfHack.mm`[^50]

**Benchmark observations from WatermelonDB GitHub and AWS Amplify testing:**[^51]

| Operation | Standard Adapter | JSI Adapter | Ratio |
|---|---|---|---|
| Bulk insert 10,000 records | ~25–30s | ~8–12s | 2–3x faster[^51] |
| Complex queries | Slow | 5–10x faster[^51] |
| Memory usage (large datasets) | High | 40–60% less[^51] |
| Frame drops during DB ops | Yes | 60fps maintained[^51] |
| First-login sync (65K records) | 142s | 6s (with Turbo)[^52] | 23x faster |

**Turbo Login (v0.23+)** for initial sync:[^53]
- 5.3x faster than standard synchronize() for first sync[^53]
- Passes raw JSON text directly to native C++ layer (no JS JSON.parse())[^53]
- **Only valid for empty database (first login)**[^53]
- Does NOT work if `deleted: []` fields are non-empty[^53]

```typescript
const isFirstSync = !(await hasUnsyncedChanges({ database }));

await synchronize({
  database,
  unsafeTurbo: isFirstSync,      // 5.3x speedup on first login only
  pullChanges: async ({ lastPulledAt, schemaVersion, migration }) => {
    const response = await fetch(`${SYNC_URL}/pull?...`);
    if (!response.ok) throw new Error(await response.text());

    if (isFirstSync) {
      // CRITICAL: Do NOT call response.json() — pass raw text to bypass JS parsing
      const json = await response.text();
      return { syncJson: json };
    }

    const { changes, timestamp } = await response.json();
    return { changes, timestamp };
  },
  pushChanges: async ({ changes, lastPulledAt }) => { /* ... */ },
  _unsafeBatchPerCollection: true,  // Required for large syncs (>10K records) to avoid OOM
});
```

> **`_unsafeBatchPerCollection: true`** must be set for syncs of 10,000+ rows. Without it, the entire changeset is applied in a single SQLite transaction, which will OOM on mobile devices with large datasets.[^53]

#### 3.3.3 SQLite Indexing Strategy for Core Elite — Non-Blocking UI Thread

**The problem:** A sync writing 10,000 rows fires reactive queries on `timing_results`. Without proper indexes, each reactive query triggers a full table scan, blocking the UI thread even in JSI mode.

**Index requirements:** WatermelonDB's `isIndexed: true` in the schema definition creates standard B-Tree indexes. For the Core Elite query patterns, define these **composite covering indexes** at the SQLite layer:[^54]

```sql
-- Run these PRAGMA statements after database init, before any data operations

-- 1. Most common query: "All results for an athlete in an event"
CREATE INDEX IF NOT EXISTS idx_results_athlete_event
  ON timing_results (athlete_id, event_id, drill_type, is_deleted)
  WHERE is_deleted = 0;

-- 2. Sync delta query: "All records updated since lastPulledAt"
CREATE INDEX IF NOT EXISTS idx_results_updated_at
  ON timing_results (updated_at ASC)
  WHERE is_deleted = 0;

-- 3. Logic check backfill: "All unvalidated results"
CREATE INDEX IF NOT EXISTS idx_results_pending_validation
  ON timing_results (logic_check_flag)
  WHERE logic_check_flag IS NULL;

-- 4. Athlete lookup (check-in flow, roster management)
CREATE INDEX IF NOT EXISTS idx_athletes_event_deleted
  ON athletes (team_id, is_deleted, last_name, first_name)
  WHERE is_deleted = 0;

-- 5. Sync outbox drain (partial index on pending items only)
CREATE INDEX IF NOT EXISTS idx_outbox_pending
  ON sync_outbox (created_at ASC)
  WHERE retry_count < 5;
```

**Performance impact from benchmarks:**[^55]

| Query Type | No Index | Covering Composite Index | Reduction |
|---|---|---|---|
| Multi-column WHERE | Full table scan | Index-only scan | Up to 70% time reduction[^55] |
| Partial index (active records only) | Full scan | Scoped to subset | 90% scope reduction where inactive > active[^55] |
| Redundant indexes | — | Eliminate: -22% write speed per extra index[^55] |

#### 3.3.4 Three-Device Concurrent Reconnect — SQLite-Level Lock Behavior

When three devices hit the sync server simultaneously, the concern is **concurrent server-side writes** to the same backing database. The server SQLite (if used) or PostgreSQL handles this via its own locking. But on the **device side**, the ordering matters:

```
Device A push arrives at server T=100ms
Device B push arrives at server T=101ms
Device C push arrives at server T=102ms

Server processes sequentially (one writer at a time per SQLite WAL rule):
1. Apply A's 87 rows (transaction commits, WAL checkpoint)
2. Apply B's 34 rows:
   - Row conflict: athlete "John Smith" updated by both A and B
   - B.updated_at=1712000105 > A.updated_at=1712000100 → B wins
   - All others: no conflict, insert cleanly
3. Apply C's 12 athletes + 2 updates: insert cleanly
4. All three requests receive 200 OK

Each device then GETs /pull?last_pulled_at=<their_T0>:
   - Device A receives B's + C's changes
   - Device B receives A's + C's changes
   - Device C receives A's + B's changes
```

**WAL mode on the server guarantees** that while push transactions write, pull GET requests (reads) are not blocked. This eliminates the starvation scenario where devices cannot pull because others are still pushing.[^48]

```typescript
// Server-side sync handler with explicit SQLite transaction
// Critical: wrap each push operation in a single transaction
// A write transaction holds lock for its ENTIRE duration — minimize scope

async function handlePushWithLock(
  db: SQLiteDatabase, 
  changes: ChangeSet
): Promise<void> {
  // Process all tables in ONE transaction to minimize lock duration
  await db.runAsync('BEGIN IMMEDIATE TRANSACTION');
  
  try {
    for (const [table, { created, updated, deleted }] of Object.entries(changes)) {
      // Batch inserts (faster than individual INSERTs)
      if (created.length > 0) {
        const placeholders = created.map(() => '(?,?,?,?,?,?)').join(',');
        const values = created.flatMap(r => [r.id, r.athlete_id, r.result_seconds, r.updated_at, false, r.device_uuid]);
        await db.runAsync(`INSERT OR IGNORE INTO ${table} VALUES ${placeholders}`, values);
      }
      
      // Updates: LWW per row
      for (const record of updated) {
        await db.runAsync(
          `UPDATE ${table} SET result_seconds=?, updated_at=?
           WHERE id=? AND updated_at < ?`,
          [record.result_seconds, record.updated_at, record.id, record.updated_at]
        );
      }
      
      // Soft deletes only
      if (deleted.length > 0) {
        const ids = deleted.map(() => '?').join(',');
        await db.runAsync(
          `UPDATE ${table} SET is_deleted=1, updated_at=? WHERE id IN (${ids})`,
          [Date.now(), ...deleted]
        );
      }
    }
    
    await db.runAsync('COMMIT');
  } catch (err) {
    await db.runAsync('ROLLBACK');
    throw err;
  }
}
```

> **`BEGIN IMMEDIATE`** acquires the write lock upfront (vs `BEGIN DEFERRED` which waits). This prevents the `SQLITE_BUSY` "database is locked" error when multiple requests arrive within the same millisecond.[^56][^48]

***

## Appendix: Known Unknowns (OSINT Ceiling)

| Domain | Gap | Evidence Level | Mitigation |
|---|---|---|---|
| Freelap GATT UUID | Not published anywhere publicly | Confirmed absent from all public repos, Freelap website, FDM app docs | Use nRF Connect hardware sniffer on physical device |
| Dashr BLE packet format | Proprietary; no SDK or patent disclosed | Dashr website explicitly has no developer section | TeamBuildr webhook is only viable path |
| Pain & Hibbs 2007 exact SD | Full paper behind Taylor & Francis paywall | Abstract confirms floor <85ms; SD not in abstract | Library access or PubMed request; Northumbria portal has abstract [^22] |
| McKay et al. 2020 full SD tables | Position × grade breakdown behind JSCR paywall | Abstract confirms significance levels | PMID 30418328; institutional library access |
| WatermelonDB JSI exact SQLite lock duration | Not benchmarked in public docs | Inferred from WAL spec + GitHub issue behavior | Instrument with `SyncLogger` and `console.time` in dev build |

---

## References

1. [1](https://beaujeant.github.io/resources/publications/ble.pdf)

2. [ble-guides/ble-throughput.md at master · chrisc11/ble-guides](https://github.com/chrisc11/ble-guides/blob/master/ble-throughput.md) - Contribute to chrisc11/ble-guides development by creating an account on GitHub.

3. [Android BLE Connection time interval - Stack Overflow](https://stackoverflow.com/questions/21398766/android-ble-connection-time-interval) - I have found that for Android, the default connection interval is fixed to 7.5ms. Is there a way to ...

4. [Minimum achievable latency with Bluetooth Classic or Bluetooth LE](https://www.reddit.com/r/embedded/comments/11hy57v/minimum_achievable_latency_with_bluetooth_classic/) - The latency of a BLE connection is mainly determined by the connection interval, which has a minimum...

5. [Data bytes dropped in BLE packets - Nordic DevZone](https://devzone.nordicsemi.com/f/nordic-q-a/106091/data-bytes-dropped-in-ble-packets) - When I try to Tx this 244-byte packet over BLE after 185 MTU negotiation, I am observing that only 1...

6. [A Practical Guide to BLE Throughput - Memfault Interrupt](https://interrupt.memfault.com/blog/ble-throughput-primer) - The Connection Interval can be negotiated once the two devices are connected. Longer connection inte...

7. [BLE Connection Parameters: Optimizing Power and Latency — دليل ...](https://blefyi.com/ar/guide/connection-parameters/) - iOS enforces a minimum of 15 ms and recommends 100–1000 ms for background apps. Android allows short...

8. [Maximizing BLE Throughput Part 4: Everything You Need To Know](https://punchthrough.com/ble-throughput-part-4/) - Dig into the final part of our BLE throughput series. Learn how to maximize performance by understan...

9. [How to improve throughput · Issue #1136 · dotintent/react-native-ble ...](https://github.com/dotintent/react-native-ble-plx/issues/1136) - Enable DLE (data length extension) · Use the smallest possible connection interval · Use the largest...

10. [huge delay in writing characteristics · Issue #101 · dotintent/react-native-ble-plx](https://github.com/dotintent/react-native-ble-plx/issues/101) - Hi, I'm trying to read & write a set of characteristics from / to a device. While reading from the d...

11. [Bluetooth resources saturation after some time #1186 - GitHub](https://github.com/dotintent/react-native-ble-plx/issues/1186) - I have a project with a mobile application which receives data from 2 devices which uses esp32 to co...

12. [get weight from GATT characteristics value in react-native-ble-plx](https://stackoverflow.com/questions/70952070/get-weight-from-gatt-characteristics-value-in-react-native-ble-plx) - As far as I understand your Code, your weight scale makes use of Bluetooth Weight Scale Profile and ...

13. [discovering own GATT services(UUID128) fails · hbldh bleak - GitHub](https://github.com/hbldh/bleak/discussions/1204) - I have a device with an own primary GATT service. I can connect and use it via NRFconnect perfectly....

14. [Getting started with the Dashr 2.0 timing system.](https://www.dashrsystems.com/2020/06/getting-started-with-the-dashr-2-0-timing-system/) - Note that all Bluetooth connections are performed through the app, not through your device's operati...

15. [Viewing Dashr Data in Workout Entry View - TeamBuildr - YouTube](https://www.youtube.com/watch?v=xlRhMffomd4) - Share your videos with friends, family, and the world.

16. [Dashr Ecosystem](https://www.dashrsystems.com/2025/06/dashr-ecosystem/) - The Dashr ecosystem allows you to efficiently test your athletes and have those results instantly sa...

17. [State Population Influences Athletic Performance Combine Test ...](https://pmc.ncbi.nlm.nih.gov/articles/PMC6355118/) - This study compared athletic performance differences among high school American football combine par...

18. [Normative Reference Values for High School-Aged American Football Players: Proagility Drill and 40-Yard Dash Split Times - PubMed](https://pubmed.ncbi.nlm.nih.gov/30418328/) - McKay, BD, Miramonti, AA, Gillen, ZM, Leutzinger, TJ, Mendez, AI, Jenkins, NDM, and Cramer, JT. Norm...

19. [Sprint starts and the minimum auditory reaction time - PubMed](https://pubmed.ncbi.nlm.nih.gov/17127583/) - However, there is evidence, both anecdotal and from reflex research, that simple auditory reaction t...

20. [Sprint starts and the minimum auditory reaction time](http://www.tandfonline.com/doi/abs/10.1080/02640410600718004) - Abstract The simple auditory reaction time is one of the fastest reaction times and is thought to be...

21. [Sprint starts and the minimum auditory reaction time](https://www.semanticscholar.org/paper/Sprint-starts-and-the-minimum-auditory-reaction-Pain-Hibbs/2d81ba0bca3777de82d3260e90ffd0d340f84793) - Reaction time in nine athletes performing sprint starts in four conditions was measured using starti...

22. [Sprint Starts and the minimum auditory reaction time](https://researchportal.northumbria.ac.uk/en/publications/sprint-starts-and-the-minimum-auditory-reaction-time)

23. [[PDF] Contribution of new start information system prototype to the false ...](https://researchrepository.ul.ie/bitstreams/e85a9779-1739-429f-a842-b8a4b475b40f/download) - This result highlighted RTWA 100-119 ms were probably false start according to the theoretical minim...

24. [Reaction Time and Spatiotemporal Variables as Markers of Sprint Start Performance](http://article.sciencepublishinggroup.com/pdf/10.11648.j.ajss.20190703.16.pdf) - The purpose of the present study was to examine both the within-day and between-day reliability of s...

25. [Sprint starts and the minimum auditory reaction time - Academia.edu](https://www.academia.edu/18494329/Sprint_starts_and_the_minimum_auditory_reaction_time) - The neuromuscular-physiological component of auditory reaction time can be under 85 ms. The IAAF's f...

26. [The StartReact Effect on Self-Initiated Movements](https://pmc.ncbi.nlm.nih.gov/articles/PMC3784278/) - ...involves an increase in excitability of motor pathways. In a reaction time task paradigm, a start...

27. [Physics Prac Rxn Rate - Studocu](https://www.studocu.com/en-au/document/the-university-of-adelaide/physical-aspects-of-nature-i/physics-prac-rxn-rate/47942221) - Share free summaries, lecture notes, exam prep and more!!

28. [Crowdsourced Measurement of Reaction Times to Audiovisual ...](https://pmc.ncbi.nlm.nih.gov/articles/PMC6207992/) - Research has shown that reaction times are fastest when an auditory and a visual stimulus are presen...

29. [Relevance of the 100 ms false start threshold in athletics - PESS Blog](https://pess.blog/2021/04/19/relevance-of-the-100-ms-false-start-threshold-in-athletics-matthieu-milloz/) - This threshold of 100 ms seeks to ensure that no athletes gain an unfair advantage by anticipating t...

30. [First-stance phase force contributions to acceleration sprint performance in semi-professional soccer players](https://onlinelibrary.wiley.com/doi/10.1080/17461391.2019.1629178) - Abstract Background: Sprint running is a key determinant of player performance in soccer that is typ...

31. [Sprint Acceleration Mechanics: The Major Role of Hamstrings in Horizontal Force Production](https://www.frontiersin.org/articles/10.3389/fphys.2015.00404/pdf) - Recent literature supports the importance of horizontal ground reaction force (GRF) production for s...

32. [Determinant biomechanical variables for each sprint phase ...](https://journals.sagepub.com/doi/10.1177/17479541231200526) - Variables such as contact time, ground reaction force, joint angles, and center of mass position cha...

33. [Kinematics of transition during human accelerated sprinting](https://journals.biologists.com/bio/article/3/8/689/1118/Kinematics-of-transition-during-human-accelerated) - ...found two transitions during the entire acceleration phase of maximal sprinting, and the accelera...

34. [Microsoft Word - #152-2004JSSMpdfver3son.doc](https://www.cscca.org/document?id=159)

35. [Human running speed of 35-40 mph may be biologically possible](https://blog.smu.edu/research/2010/01/21/human-running-speed-of-35-40-mph-may-be-biologically-possible/) - The newly published evidence identifies the critical variable imposing the biological limit to runni...

36. [[PDF] Katara: Synthesizing CRDTs with Verified Lifting - EECS](https://www2.eecs.berkeley.edu/Pubs/TechRpts/2023/EECS-2023-2.pdf) - The state type and merge function together form a join semilattice, with the merge function serving ...

37. [Conflict-free replicated data type - Wikipedia](https://en.wikipedia.org/wiki/Conflict-free_replicated_data_type)

38. [[PDF] CRDT Emulation, Simulation, and Representation Independence](https://arxiv.org/pdf/2504.05398.pdf) - Conflict-free replicated data types (CRDTs) are distributed data structures designed for fault toler...

39. [[PDF] Type-Checking CRDT Convergence - Programming Group](https://programming-group.com/assets/pdf/papers/2023_Type-Checking-CRDT-Convergence.pdf)

40. [[PDF] Conflict-free replicated data types - distributed concurrent constraint ...](https://webperso.info.ucl.ac.be/~pvr/MemoireNicolasBrack.pdf) - A Conflict-free replicated data type, also written CRDT, is the type of a data structure whose state...

41. [[PDF] J. Parallel Distrib. Comput. Delta state replicated data types✩](https://members.loria.fr/CIgnat/files/replication/Delta-CRDT.pdf) - The significant property in δ-CRDT is that it preserves the crucial properties (idempotence, associa...

42. [jibinmathew69/LWW-Element-Set - GitHub](https://github.com/jibinmathew69/LWW-Element-Set) - LWW Element Set is an algorithm under Conflict-free replicated data type(CRDT), here is the Python i...

43. [The CRDT Dictionary: A Field Guide to Conflict-Free Replicated ...](https://iankduncan.com/engineering/2025-11-27-crdt-dictionary/) - The merge operation is a semilattice with partial order defined by timestamps. One value wins: When ...

44. [Real-Time Data Sync in Distributed Systems: CRDT, OT, and Event ...](https://www.askantech.com/real-time-data-sync-distributed-systems-crdt-operational-transform-event-sourcing/) - Learn how CRDT, Operational Transform, and Event Sourcing solve real-time data synchronization in di...

45. [How to Build CRDT Implementation - OneUptime](https://oneuptime.com/blog/post/2026-01-30-crdt-implementation/view) - A practical guide to implementing Conflict-free Replicated Data Types (CRDTs) for building distribut...

46. [Sync implementation details - WatermelonDB](https://watermelondb.dev/docs/Implementation/SyncImpl) - If you're looking for a guide to implement Watermelon Sync in your app, see Synchronization.

47. [SQLite WAL Mode for Better Concurrent Web Performance](https://dev.to/ahmet_gedik778845/sqlite-wal-mode-for-better-concurrent-web-performance-4fck) - How SQLite WAL mode enables concurrent reads and writes for PHP web applications, with real benchmar

48. [SQLite concurrent writes and "database is locked" errors](https://tenthousandmeters.com/blog/sqlite-concurrent-writes-and-database-is-locked-errors/) - SQLite claims to be one of the most popular pieces of software in the world, being integrated into e...

49. [WatermelonDB v0.17 release notes (2020-06-22) | LibHunt](https://js.libhunt.com/watermelondb-changelog/0.17)

50. [Can I use WatermelonDB as simple SQLite driver? #1272](https://github.com/Nozbe/WatermelonDB/issues/1272) - Hi folks. Can I use WatermelonDB as simple SQLite driver? I have a project with very specific needs,...

51. [feat(datastore-storage-adapter): add WatermelonDB ... - GitHub](https://github.com/aws-amplify/amplify-js/issues/14566) - In preliminary testing with DataStore operations, I've observed 2-3x faster bulk inserts for 10,000+...

52. [WatermelonDB v0.15 release notes (2019-11-08) | LibHunt](https://js.libhunt.com/watermelondb-changelog/0.15)

53. [Frontend | WatermelonDB](https://watermelondb.dev/docs/Sync/Frontend) - Additional synchronize() flags​. _unsafeBatchPerCollection: boolean - if true, changes will be saved...

54. [The Do’s and Don’ts of Indexing in SQLite Applications](https://www.slingacademy.com/article/the-dos-and-donts-of-indexing-in-sqlite-applications/) - When developing SQLite applications, efficient data retrieval is crucial for ensuring optimal perfor...

55. [SQLite Indexing Tactics for Performance and Speed - MoldStud](https://moldstud.com/articles/p-boost-your-sqlite-database-best-practices-for-an-effective-indexing-strategy) - Learn how to enhance your SQLite database performance with advanced indexing techniques. Discover pr...

56. [How to reduce lock wait time during concurrent writes to SQLite?](https://www.tencentcloud.com/techpedia/138383) - To reduce lock wait time during concurrent writes to SQLite, you need to understand SQLite's locking...

