# Core Elite Football Combine App — AI Engineering Knowledge Corpus

> **Document Purpose:** This is a high-density technical reference for an autonomous AI coding agent tasked with building "Core Elite" — an offline-proof, high-performance football combine mobile app. All domain content is sourced from hardware documentation, peer-reviewed sports science data, and production-grade architectural references. Strip this document into your context window verbatim.

***

## Table of Contents
1. [Domain 1: Hardware API & BLE Integration](#domain-1)
2. [Domain 2: Sports Science Baselines & Logic Check Thresholds](#domain-2)
3. [Domain 3: Offline-First Architecture (CRDTs & WatermelonDB)](#domain-3)

***

## Domain 1: Hardware API & BLE Integration {#domain-1}

### 1.1 Dashr Systems — Architecture & Protocol Overview

Dashr (dashr.systems) is a proprietary closed-protocol BLE timing system. **No public REST API or open SDK is published.** Integration with third-party apps occurs through their online Dashboard and AMS partner integrations (TeamBuildr, Rock Daisy). The following specifications are extracted from official Dashr documentation.[^1][^2][^3][^4]

#### 1.1.1 Hardware Models

| Model | Connection Type | Range | Notes |
|---|---|---|---|
| Dashr\|Blue | BLE (phone ↔ laser direct) | 100 yards reliable, 150 yards max[^1] | Primary field system |
| Dashr\|Silver | BLE (phone ↔ start laser) + RF daisy-chain | Extended via RF network[^3] | Not compatible with Blue lasers in same drill |
| Dashr 2.0 | BLE | 60 yards max[^5] | Legacy model |

#### 1.1.2 Dashr BLE Connection Protocol (Reverse-Engineered)

Dashr manages BLE connections entirely through its own app layer — not the device OS Bluetooth menu. This is a proprietary GATT peripheral model.[^2]

**Connection Sequence:**
1. Power OFF all lasers
2. Power ON target laser — module broadcasts advertisement for exactly **3 seconds**[^2]
3. User taps the lightning bolt icon in the app for the corresponding gate slot (start / split / stop)
4. On success: blue checkmark confirms GATT connection
5. Repeat per laser module
6. Press "Start Testing" to arm the drill

**Key Constraint:** If multiple laser modules are powered ON simultaneously, the app cannot disambiguate which advertisement belongs to which physical unit. **Power on ONE at a time.**[^6]

#### 1.1.3 Dashr Data Architecture

- **Local storage:** Results are saved locally on the coaching phone/tablet in real time[^4]
- **Cloud sync:** Results sync to `dashboard.dashrsystems.com` when connectivity is available[^4]
- **Athlete distribution:** Via Dashr Player Profile App (free, iOS/Android)[^7]
- **AMS export:** Auto-import to TeamBuildr and Rock Daisy via OAuth integration[^8]

**Dashboard Export Format (TeamBuildr integration observation):**
The dashboard provides time, speed, and split data per rep. Based on integration observations, the inferred result payload structure per athlete rep is:[^8]

```json
{
  "athlete_id": "string",
  "drill_type": "dash | pro_agility | l_drill | vertical | broad_jump | flying",
  "date_utc": "ISO8601",
  "gate_times": {
    "start": 0.000,
    "split_1": 1.532,
    "finish": 4.421
  },
  "speed_mph": 18.7,
  "distance_yards": 40,
  "rep_index": 1
}
```

> **⚠️ IMPORTANT NOTE FOR CODING AGENT:** Dashr does **not** publish a public developer API. The above JSON structure is an inferred representation based on observable data fields in the TeamBuildr integration. For "Core Elite" to ingest Dashr data, you must implement one of these three approaches:[^8]
> 1. **Manual CSV import** from the Dashr Dashboard export
> 2. **Screen-scrape/webhook** pattern from a shared TeamBuildr/Rock Daisy account
> 3. **BLE peripheral simulation** by building a custom BLE GATT peripheral that mimics a Dashr laser gate (advanced)

***

### 1.2 Freelap BLE System — Technical Specification

Freelap uses the **FxChip BLE** transponder worn by the athlete. It is the most documented of the two systems for third-party BLE integration.[^9][^10][^11]

#### 1.2.1 FxChip BLE Hardware Specifications

| Specification | Value |
|---|---|
| Timing Accuracy | 1/100 second (10ms resolution)[^11] |
| Internal Memory | 10 intermediate LAP times[^11] |
| Minimum gate interval | 0.7 seconds[^11] |
| Bluetooth Version | BLE 2.10[^10] |
| Battery | LiPo 3.7V 80mA[^11] |
| Battery Life (active use) | 100 hours[^11] |
| Battery Life (standby, moving) | 3 weeks[^11] |
| Battery Life (standby, static) | 10 months[^11] |
| Auto-shutdown | 30 minutes without transmitter crossing[^11] |
| Compatible OS | iOS 13+ / Android 6+[^10] |

#### 1.2.2 Freelap Data Flow Protocol

```
[Tx Junior Pro Transmitter] ──RF──► [FxChip BLE on athlete] ──BLE──► [Mobile App]
       (3 modes)                        (worn device)                (myfreelap / custom)
```

**Transmitter Modes and FxChip Behavior:**[^9]

| Mode | FxChip Response |
|---|---|
| START | Resets internal stopwatch to 0.000 |
| LAP | Appends split + lap to memory (max 10 laps) |
| FINISH | Transmits ALL stored times to mobile app via BLE |

**Data Transmission Trigger:** Data is NOT streamed continuously. The FxChip BLE **only transmits** when it crosses a FINISH transmitter. All split and lap data accumulated during the run is packaged and sent as a single BLE notification burst.[^11][^9]

**Offline Behavior:** If the mobile app is unreachable at FINISH crossing, the last time remains in memory until the chip auto-shuts after 30 minutes. Recovery method: place chip near the mobile device, open the app, shake the chip — the stored time downloads.[^11]

#### 1.2.3 Inferred Freelap BLE GATT Data Packet Structure

Freelap does not publish GATT UUIDs publicly. Based on FDM app documentation and BLE characteristic conventions for timing devices, the inferred payload on the FINISH notification is:

```json
{
  "chip_id": "FX-XXXXXX",           // Unique device ID
  "firmware_version": "HEX 1.61",
  "ble_version": "BLE 2.10",
  "battery_pct": 87,
  "session_times": [
    {
      "lap": 1,
      "split_seconds": 2.341,       // Time from last transmitter to this one
      "cumulative_seconds": 2.341   // Total elapsed from START
    },
    {
      "lap": 2,
      "split_seconds": 1.892,
      "cumulative_seconds": 4.233   // FINISH time
    }
  ],
  "total_time_seconds": 4.233,
  "timestamp_unix": 1712000000
}
```

> **⚠️ IMPORTANT NOTE FOR CODING AGENT:** The above is a REVERSE-ENGINEERED inferred structure. The actual payload is likely binary-encoded. Production integration should decode the raw base64 BLE notification buffer using the `react-native-ble-plx` library and parse per Freelap's proprietary protocol. Contact Freelap at freelap.com/support for SDK access if building a licensed integration.

***

### 1.3 React Native BLE Integration Blueprint

#### 1.3.1 Library Selection

```
Primary:   react-native-ble-plx (by dotintent, formerly Polidea)
Secondary: react-native-ble-manager
Platform:  iOS (CoreBluetooth) + Android (BluetoothGatt API)
```

**react-native-ble-plx** supports all core BLE features: scan, connect, discover services, read/write characteristics, and monitor notifications.[^12][^13]

#### 1.3.2 Required Permissions (Platform-Specific)

**Android (AndroidManifest.xml):**
```xml
<uses-permission android:name="android.permission.BLUETOOTH_SCAN" />
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
```
> Android API 6+ requires runtime location permission for BLE scanning.[^14]

**iOS (Info.plist):**
```xml
<key>NSBluetoothAlwaysUsageDescription</key>
<string>Required to connect to timing hardware</string>
<key>NSLocationWhenInUseUsageDescription</key>
<string>Required for BLE device discovery</string>
```
> iOS 13+ requires `NSBluetoothAlwaysUsageDescription`.[^15]

#### 1.3.3 Full BLE Connection & Data Reception Pipeline

```typescript
import { BleManager, BleError, Characteristic, Device } from 'react-native-ble-plx';
import { Buffer } from 'buffer';

// ── 1. INITIALIZATION ─────────────────────────────────────────────────────────
const bleManager = new BleManager();

// ── 2. SCAN FOR TIMING DEVICE ─────────────────────────────────────────────────
function scanForTimingGate(
  targetNamePrefix: string,           // e.g., "Freelap" or "Dashr"
  onDeviceFound: (device: Device) => void
): void {
  bleManager.startDeviceScan(null, null, (error: BleError | null, device: Device | null) => {
    if (error) {
      console.error('BLE scan error:', error.message);
      return;
    }
    if (device && device.name?.startsWith(targetNamePrefix)) {
      bleManager.stopDeviceScan();
      onDeviceFound(device);
    }
  });
}

// ── 3. CONNECT AND DISCOVER SERVICES ─────────────────────────────────────────
async function connectToTimingGate(device: Device): Promise<Device> {
  await bleManager.stopDeviceScan();
  
  const connectedDevice = await device.connect({ timeout: 12000 });
  await connectedDevice.discoverAllServicesAndCharacteristics();
  
  return connectedDevice;
}

// ── 4. MONITOR TIMING DATA CHARACTERISTIC ────────────────────────────────────
// NOTE: Replace UUIDs with actual values from hardware vendor documentation
const TIMING_SERVICE_UUID  = 'XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX';
const TIMING_CHAR_UUID     = 'XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX';

function monitorTimingData(
  device: Device,
  onTimingResult: (result: ParsedTimingResult) => void
): () => void {
  const subscription = device.monitorCharacteristicForService(
    TIMING_SERVICE_UUID,
    TIMING_CHAR_UUID,
    (error: BleError | null, characteristic: Characteristic | null) => {
      if (error) {
        handleBleError(error);
        return;
      }
      if (characteristic?.value) {
        const rawBuffer = Buffer.from(characteristic.value, 'base64');
        const parsed    = parseTimingPacket(rawBuffer);
        
        if (isValidTimingResult(parsed)) {
          onTimingResult(parsed);
        }
      }
    }
  );

  // Return cleanup function
  return () => subscription.remove();
}

// ── 5. PACKET PARSER (PLACEHOLDER — IMPLEMENT PER VENDOR SPEC) ───────────────
function parseTimingPacket(buffer: Buffer): ParsedTimingResult {
  // Freelap: likely little-endian uint32 for time in centiseconds
  const rawCentiseconds = buffer.readUInt32LE(0);
  const timeSeconds     = rawCentiseconds / 100;
  
  return {
    raw_buffer:          buffer.toString('hex'),
    total_time_seconds:  timeSeconds,
    lap_times:           [],   // Parse per actual packet structure
    chip_id:             '',   // Parse from packet header
    timestamp_local:     Date.now(),
  };
}

// ── 6. CONNECTION DROP HANDLER ────────────────────────────────────────────────
function handleBleError(error: BleError): void {
  switch (error.errorCode) {
    case 201: // Device disconnected
      console.warn('BLE device disconnected. Queuing local data and flagging for re-pair.');
      // → write to local SQLite outbox, display reconnect UI
      break;
    case 203: // Operation cancelled (scan stopped)
      break;
    case 205: // GATT error
      console.error('GATT error — likely firmware issue or packet corruption');
      break;
    default:
      console.error('BLE error code', error.errorCode, error.message);
  }
}

// ── 7. MANUAL OFFLINE ENTRY FALLBACK ─────────────────────────────────────────
interface ManualEntry {
  athlete_id:     string;
  drill:          'dash_40' | 'pro_agility' | 'vertical' | 'broad_jump' | 'l_drill';
  time_seconds:   number;
  split_seconds?: number;
  manual:         true;
  entry_ts:       number;  // Unix ms
}
```

#### 1.3.4 BLE Latency & Timing Accuracy Constraints

| Parameter | Value | Notes |
|---|---|---|
| BLE GATT notification latency | 7.5ms – 15ms | Connection interval dependent |
| Characteristic write latency (with response) | 30–100ms | Round trip[^16] |
| BLE throughput (react-native-ble-plx) | ~17KB–37KB/14s | Chunked transfers only[^17] |
| Freelap FxChip accuracy | ±10ms (1/100 sec)[^11] | Burst at FINISH crossing only |
| Dashr|Blue rated range | 100 yards reliable[^1] | Independent of BLE version |
| BLE connection drop (typical outdoors) | >30m metal interference | Use reconnect retry loop |

#### 1.3.5 BLE Drop Reconnect Strategy (Production Pattern)

```typescript
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS     = 2000;

async function bleReconnectWithBackoff(
  deviceId: string,
  attempt: number = 0
): Promise<Device | null> {
  if (attempt >= MAX_RECONNECT_ATTEMPTS) {
    // Fall back to manual entry mode; persist incomplete data locally
    activateManualEntryMode();
    return null;
  }
  
  try {
    await new Promise(r => setTimeout(r, RECONNECT_DELAY_MS * Math.pow(2, attempt)));
    const device = await bleManager.connectToDevice(deviceId, { timeout: 8000 });
    await device.discoverAllServicesAndCharacteristics();
    return device;
  } catch {
    return bleReconnectWithBackoff(deviceId, attempt + 1);
  }
}
```

***

## Domain 2: Sports Science Baselines & Logic Check Thresholds {#domain-2}

### 2.1 NFL Combine — 40-Yard Dash Statistics by Position

All historical combine data per NFL.com official database (2003–2026).[^18]

| Position | Average (sec) | All-Time Record (sec) | Athlete |
|---|---|---|---|
| Wide Receiver | 4.52[^18] | 4.21[^19] | Xavier Worthy, Texas (2024) |
| Cornerback | 4.50[^20] | 4.23 | Various |
| Safety | 4.54[^19] | 4.29[^19] | Zedrick Woods |
| Running Back | 4.53[^19] | 4.24[^19] | Chris Johnson |
| Quarterback | 4.59[^21] | 4.43 | Anthony Richardson (2023) |
| Outside Linebacker | 4.65 | 4.43 | Devin Bush (2019) |
| Defensive End | 4.80[^19] | 4.36[^19] | Amare Barno |
| Tight End | 4.68 | 4.40 | Various |
| Defensive Tackle | 5.06[^21] | 4.49[^19] | Kancey (2023) |
| Center | 5.26[^21] | 5.14 | Luke Wypler (2023) |

**Statistical Distribution (2022 NFL Combine, n=324):**[^22]

| Metric | Drafted Mean | Drafted SD | Non-Drafted Mean | Non-Drafted SD |
|---|---|---|---|---|
| 40-Yard Dash (sec) | 4.70 | ±0.30 | 4.75 | ±0.31 |
| Vertical Jump (in) | 32.81 | ±4.58 | 31.96 | ±4.38 |
| Bench Press (reps) | 21.83 | ±4.62 | 20.12 | ±4.59 |

***

### 2.2 High School Football — NSCA Percentile Norms by Age

Source: NSCA Male Percentile Rank data (National Strength & Conditioning Association). Grades approximate: Age 14 = 9th grade, Age 15 = 10th grade, Age 16 = 11th grade, Age 17 = 12th grade, Age 18 = college-eligible senior.[^23]

#### 2.2.1 40-Yard Dash Norms (seconds — LOWER is better)

| Percentile | Age 14 | Age 15 | Age 16 | Age 17 | Age 18+ |
|---|---|---|---|---|---|
| 99th | <4.91 | <4.75 | <4.68 | <4.62 | <4.55 |
| 90th | 4.96–4.97 | 4.80–4.81 | 4.73–4.74 | 4.67–4.68 | 4.60–4.61 |
| 75th | 5.08–5.09 | 4.92–4.93 | 4.85–4.86 | 4.79–4.80 | 4.72–4.73 |
| 50th | 5.32–5.34 | 5.15–5.17 | 5.07–5.09 | 5.00–5.02 | 4.92–4.94 |
| 25th | 5.57–5.58 | 5.39–5.40 | 5.30–5.31 | 5.22–5.23 | 5.13–5.14 |
| 10th | 5.69–5.70 | 5.51–5.52 | 5.42–5.43 | 5.34–5.35 | 5.25–5.26 |

#### 2.2.2 Pro-Agility / 5-10-5 Shuttle Norms (seconds — LOWER is better)

| Percentile | Age 14 | Age 15 | Age 16 | Age 17 | Age 18+ |
|---|---|---|---|---|---|
| 99th | <4.39 | <4.25 | <4.18 | <3.97 | <3.81 |
| 90th | 4.44–4.45 | 4.30–4.31 | 4.23–4.24 | 4.02–4.03 | 3.86–3.87 |
| 75th | 4.56–4.57 | 4.42–4.43 | 4.35–4.36 | 4.14–4.15 | 3.98–3.99 |
| 50th | 4.92–4.97 | 4.78–4.82 | 4.70–4.74 | 4.48–4.52 | 4.31–4.35 |
| 25th | 5.33–5.34 | 5.17–5.18 | 5.08–5.09 | 4.85–4.86 | 4.67–4.68 |
| 10th | 5.45–5.46 | 5.29–5.30 | 5.20–5.21 | 4.97–4.98 | 4.79–4.80 |

#### 2.2.3 Vertical Jump Norms (inches — HIGHER is better)

| Percentile | Age 14 | Age 15 | Age 16 | Age 17 | Age 18+ |
|---|---|---|---|---|---|
| 99th | >27 | >30.75 | >32.5 | >34.25 | >36 |
| 90th | 26.25 | 30 | 31.75 | 33.5 | 35.25 |
| 75th | 24.75 | 28.5 | 30.25 | 32 | 33.25–33.5 |
| 50th | 21–21.5 | 24–24.5 | 25.5–26 | 26.75–27.25 | 28–28.5 |
| 25th | 17.75 | 20 | 21.25 | 22 | 23–23.25 |
| 10th | 16.25 | 18.5 | 19.75 | 20.5 | 21.25 |

***

### 2.3 Logic Check Thresholds — Algorithmic Validation Rules

These thresholds are derived from biomechanical research on human running limits and established false-start science in elite athletics.[^24][^25][^26][^27][^28]

#### 2.3.1 Biological Speed Limits Reference

- **Usain Bolt top speed:** 27.3 mph (12.2 m/s), recorded at Berlin 2009[^25]
- **Theoretical human maximum:** 35–40 mph under ideal conditions[^24][^25]
- **Biomechanical limiter:** Foot-ground contact time (<100ms at top speed)[^24]
- **NFL record 40-yd:** 4.21 seconds (Xavier Worthy, 2024) ≈ 19.4 mph average[^19]

#### 2.3.2 False Start Detection

From World Athletics and peer-reviewed reaction time research:[^26][^27]

- **IAAF Threshold:** Any reaction < 100ms (0.100 sec) after the start signal = automatic false start
- **Scientific evidence:** Elite sprinters CAN react in 85–95ms; 100ms rule is contested as overly strict[^27][^28]
- **Football combine standard (no starting blocks):** Minimum realistic human reaction from set position = **120–150ms**
- **Conservative application for combine app:** flag any initial movement (beam break) within **0.120 seconds** of the arming signal as a false start

#### 2.3.3 Full Logic Check Threshold Table

Implement these as server-side and client-side validation rules in the "Core Elite" app:

```typescript
const LOGIC_CHECK_THRESHOLDS = {
  dash_40_yards: {
    // Time to travel 40 yards
    absolute_minimum_sec:    3.50,   // Impossible for any human; definite sensor error
    false_start_threshold_sec: 0.120, // Motion within 120ms of arm signal = flag
    world_record_floor_sec:  4.21,   // Below this = extraordinary flag (Worthy 2024)
    hs_99th_percentile:      4.55,   // Best realistic HS time (age 18+)
    hs_50th_percentile:      4.92,   // Median age 18+
    sensor_error_max_sec:    9.00,   // Above = sensor malfunction / DNF
    error_type_map: {
      'time < 3.50':   'SENSOR_FIRE_ERROR',
      'time < 0.120 from arm': 'FALSE_START',
      'time > 9.00':   'SENSOR_MALFUNCTION_DNF',
      'time < 4.21':   'EXTRAORDINARY_RESULT — FLAG FOR MANUAL REVIEW',
    }
  },
  pro_agility_5_10_5: {
    absolute_minimum_sec:    3.50,   // Below NFL all-time record floor
    world_record_floor_sec:  3.73,   // NFL combine record
    hs_99th_percentile:      3.81,   // Age 18+ NSCA 99th pct
    hs_50th_percentile:      4.31,   // Age 18+ median
    sensor_error_max_sec:    8.00,   // Above = malfunction
    error_type_map: {
      'time < 3.50':   'SENSOR_ERROR',
      'time > 8.00':   'SENSOR_MALFUNCTION_DNF',
    }
  },
  vertical_jump_inches: {
    absolute_minimum_in:    5.0,    // Below = measurement error
    world_record_in:        46.0,   // Gerald Sensabaugh (unofficial) or ~45.5" NCAA verified
    nfl_combine_record_in:  45.0,   // Chris Conley, WR
    hs_99th_pct_age18_in:   36.0,
    hs_50th_pct_age18_in:   28.25,
    error_type_map: {
      'inches < 5':    'MEASUREMENT_ERROR',
      'inches > 60':   'MEASUREMENT_ERROR',
      'inches > 45':   'EXTRAORDINARY_RESULT — FLAG FOR MANUAL REVIEW',
    }
  },
  broad_jump_feet: {
    absolute_minimum_in:    24.0,   // 2 feet minimum for any athlete
    nfl_combine_record_in:  147.0,  // 12'3" (Tyler Owens)
    error_max_in:           168.0,  // 14 feet = impossible
  },
  ten_yard_split_dash: {
    // 10-yard split from stationary start
    absolute_minimum_sec:  0.90,    // Physically impossible faster
    nfl_record_sec:        1.40,    // Chris Johnson
    hs_99th_age18_sec:     1.50,
    hs_50th_age18_sec:     1.84,
    error_type_map: {
      'time < 0.90':   'SENSOR_FIRE_ERROR',
      'time < 1.40':   'EXTRAORDINARY_RESULT — FLAG FOR MANUAL REVIEW',
    }
  }
};
```

#### 2.3.4 Percentile Scoring Function

```typescript
interface PercentileResult {
  percentile:     number;   // 0–99
  grade:          'ELITE' | 'ABOVE_AVG' | 'AVERAGE' | 'BELOW_AVG' | 'DEVELOPING';
  nfl_comparison: string;
}

function score40YardDash(
  timeSeconds: number,
  ageYears: number
): PercentileResult {
  // Uses NSCA norms table from Domain 2.2.1
  const norms = NSCA_NORMS[ageYears] ?? NSCA_NORMS[^18];
  
  if      (timeSeconds <= norms.p99) return { percentile: 99, grade: 'ELITE',       nfl_comparison: 'NFL Combine level' };
  else if (timeSeconds <= norms.p90) return { percentile: 90, grade: 'ELITE',       nfl_comparison: 'D1 recruit level' };
  else if (timeSeconds <= norms.p75) return { percentile: 75, grade: 'ABOVE_AVG',   nfl_comparison: 'D2/D3 prospect' };
  else if (timeSeconds <= norms.p50) return { percentile: 50, grade: 'AVERAGE',     nfl_comparison: 'High school starter' };
  else if (timeSeconds <= norms.p25) return { percentile: 25, grade: 'BELOW_AVG',   nfl_comparison: 'Developmental' };
  else                               return { percentile: 10, grade: 'DEVELOPING',  nfl_comparison: 'Growth opportunity' };
}
```

***

### 2.4 NSCA 5-10-5 Shuttle Protocol (Exact)

Per NSCA official testing protocol:[^29][^30]

```
SETUP:
- 3 cones in a straight line, 5 yards apart (cone A — cone B — cone C)
- Athlete straddles middle cone (B), drops into 3-point stance
- Hand touching floor = direction of first run

PROCEDURE:
1. On "GO" command, athlete sprints 5 yards to first cone (A or C)
2. Touches line with foot AND hand (lead hand only; inside hand must NOT touch)
3. Sprints 10 yards to opposite end cone
4. Touches line with foot AND hand
5. Sprints 5 yards back through middle cone (B) — FINISH

SCORING:
- Best of minimum 3 trials
- 2–3 minutes rest between trials
- Time = total elapsed from "GO" to crossing finish (B)

NFL COMBINE NOTES:
- Athlete chooses direction of first run
- Electronic timing preferred (laser gates at start/finish line = cone B)
- Hand touch at turn lines is NOT required at NFL Combine (foot touch only)
- NSCA guidelines require hand touch for normative data comparison
```

***

## Domain 3: Offline-First Architecture (CRDTs & WatermelonDB) {#domain-3}

### 3.1 CRDT Fundamentals for the Coding Agent

Conflict-free Replicated Data Types (CRDTs) are data structures designed for distributed systems where replicas can be modified independently (optimistic replication) and must eventually converge to a consistent state without manual conflict resolution.[^31][^32]

**Core CRDT Properties:**
1. Any replica can be modified without coordinating with any other replica, even if offline[^31]
2. When any two replicas have received the same set of updates, they converge to identical state[^32]
3. Merge is performed automatically — no special conflict resolution code or user intervention required[^31]

**CRDT Types Relevant to Core Elite:**

| CRDT Type | Use Case in App | Merge Behavior |
|---|---|---|
| LWW-Register (Last-Write-Wins) | Individual timing result fields | Higher timestamp wins |
| LWW-Map | Athlete profile fields | Per-field LWW |
| G-Counter | Rep count, attempt count | Monotonically increasing; sum of all nodes |
| OR-Set (Observed-Remove Set) | Athlete roster membership | Tracks add/remove causally |

***

### 3.2 WatermelonDB — Architecture Overview

WatermelonDB is an open-source offline-first reactive database for React Native, built on SQLite. It provides:[^33][^34]
- **Lazy loading** — queries are cheap until observed
- **Reactive subscriptions** — UI updates automatically when underlying data changes
- **Sync primitives** — built-in protocol for pull/push synchronization
- **JSI mode** — JavaScript Interface for high-performance SQLite access[^35]
- **Bundle size** — adds ~2MB to app[^36]

***

### 3.3 Complete WatermelonDB Schema for Core Elite

```typescript
// schema/index.ts
import { appSchema, tableSchema } from '@nozbe/watermelondb';

export const combineSchema = appSchema({
  version: 1,
  tables: [

    // ── ATHLETES ────────────────────────────────────────────────────────────
    tableSchema({
      name: 'athletes',
      columns: [
        { name: 'first_name',       type: 'string' },
        { name: 'last_name',        type: 'string' },
        { name: 'date_of_birth',    type: 'number' },          // Unix ms
        { name: 'grad_year',        type: 'number' },          // e.g., 2026
        { name: 'position',         type: 'string' },          // WR, QB, CB, etc.
        { name: 'height_inches',    type: 'number' },
        { name: 'weight_lbs',       type: 'number' },
        { name: 'jersey_number',    type: 'number', isOptional: true },
        { name: 'team_id',          type: 'string', isIndexed: true },
        { name: 'barcode_id',       type: 'string', isOptional: true },
        { name: 'rfid_tag',         type: 'string', isOptional: true },
        { name: 'profile_photo_url',type: 'string', isOptional: true },
        { name: 'is_deleted',       type: 'boolean' },         // Soft delete
        { name: 'created_at',       type: 'number' },
        { name: 'updated_at',       type: 'number' },
        { name: 'server_id',        type: 'string', isOptional: true, isIndexed: true },
      ],
    }),

    // ── EVENTS (Combine Sessions) ────────────────────────────────────────────
    tableSchema({
      name: 'events',
      columns: [
        { name: 'name',             type: 'string' },
        { name: 'location',         type: 'string', isOptional: true },
        { name: 'event_date',       type: 'number' },          // Unix ms
        { name: 'organizer_id',     type: 'string', isIndexed: true },
        { name: 'is_active',        type: 'boolean' },
        { name: 'is_deleted',       type: 'boolean' },
        { name: 'created_at',       type: 'number' },
        { name: 'updated_at',       type: 'number' },
        { name: 'server_id',        type: 'string', isOptional: true, isIndexed: true },
      ],
    }),

    // ── TIMING RESULTS ───────────────────────────────────────────────────────
    tableSchema({
      name: 'timing_results',
      columns: [
        { name: 'athlete_id',         type: 'string', isIndexed: true },
        { name: 'event_id',           type: 'string', isIndexed: true },
        { name: 'drill_type',         type: 'string' },         // 'dash_40' | 'pro_agility' | etc.
        { name: 'result_seconds',     type: 'number' },
        { name: 'split_1_seconds',    type: 'number', isOptional: true },
        { name: 'split_2_seconds',    type: 'number', isOptional: true },
        { name: 'speed_mph',          type: 'number', isOptional: true },
        { name: 'attempt_number',     type: 'number' },
        { name: 'is_manual_entry',    type: 'boolean' },
        { name: 'device_source',      type: 'string' },         // 'dashr_blue' | 'freelap' | 'manual'
        { name: 'raw_ble_payload',    type: 'string', isOptional: true }, // hex string
        { name: 'logic_check_flag',   type: 'string', isOptional: true }, // null | 'FALSE_START' | 'SENSOR_ERROR' | 'EXTRAORDINARY'
        { name: 'is_deleted',         type: 'boolean' },
        { name: 'created_at',         type: 'number' },
        { name: 'updated_at',         type: 'number' },
        { name: 'server_id',          type: 'string', isOptional: true, isIndexed: true },
        { name: 'device_uuid',        type: 'string' },         // UUID of recording tablet/phone
      ],
    }),

    // ── VERTICAL / FIELD MEASUREMENTS ───────────────────────────────────────
    tableSchema({
      name: 'field_measurements',
      columns: [
        { name: 'athlete_id',         type: 'string', isIndexed: true },
        { name: 'event_id',           type: 'string', isIndexed: true },
        { name: 'measurement_type',   type: 'string' },         // 'vertical_jump' | 'broad_jump'
        { name: 'value_primary',      type: 'number' },         // inches for jump; reps for bench
        { name: 'attempt_number',     type: 'number' },
        { name: 'is_manual_entry',    type: 'boolean' },
        { name: 'logic_check_flag',   type: 'string', isOptional: true },
        { name: 'is_deleted',         type: 'boolean' },
        { name: 'created_at',         type: 'number' },
        { name: 'updated_at',         type: 'number' },
        { name: 'server_id',          type: 'string', isOptional: true, isIndexed: true },
        { name: 'device_uuid',        type: 'string' },
      ],
    }),

    // ── OUTBOX (Sync Queue) ──────────────────────────────────────────────────
    // Stores pending operations when offline; cleared on successful server ACK
    tableSchema({
      name: 'sync_outbox',
      columns: [
        { name: 'entity_table',       type: 'string' },         // 'timing_results' | 'athletes' etc.
        { name: 'entity_id',          type: 'string' },
        { name: 'operation',          type: 'string' },         // 'create' | 'update' | 'delete'
        { name: 'payload_json',       type: 'string' },         // JSON stringified record
        { name: 'retry_count',        type: 'number' },
        { name: 'created_at',         type: 'number' },
        { name: 'last_attempt_at',    type: 'number', isOptional: true },
        { name: 'error_message',      type: 'string', isOptional: true },
      ],
    }),

    // ── SYNC STATE ───────────────────────────────────────────────────────────
    tableSchema({
      name: 'sync_state',
      columns: [
        { name: 'key',                type: 'string' },         // 'last_pulled_at' | 'schema_version'
        { name: 'value',              type: 'string' },         // string representation of value
        { name: 'updated_at',         type: 'number' },
      ],
    }),

  ],
});
```

***

### 3.4 WatermelonDB Model Definitions

```typescript
// models/TimingResult.ts
import { Model } from '@nozbe/watermelondb';
import { field, date, readonly, relation, nochange } from '@nozbe/watermelondb/decorators';

export class TimingResult extends Model {
  static table = 'timing_results';
  static associations = {
    athletes: { type: 'belongs_to', key: 'athlete_id' },
    events:   { type: 'belongs_to', key: 'event_id'   },
  };

  @field('drill_type')          drillType!:        string;
  @field('result_seconds')      resultSeconds!:    number;
  @field('split_1_seconds')     split1Seconds!:    number | null;
  @field('split_2_seconds')     split2Seconds!:    number | null;
  @field('speed_mph')           speedMph!:         number | null;
  @field('attempt_number')      attemptNumber!:    number;
  @field('is_manual_entry')     isManualEntry!:    boolean;
  @field('device_source')       deviceSource!:     string;
  @field('raw_ble_payload')     rawBlePayload!:    string | null;
  @field('logic_check_flag')    logicCheckFlag!:   string | null;
  @field('is_deleted')          isDeleted!:        boolean;
  @field('device_uuid')         deviceUuid!:       string;
  @field('server_id')           serverId!:         string | null;

  @readonly @date('created_at') createdAt!:        Date;
  @date('updated_at')           updatedAt!:        Date;

  @relation('athletes', 'athlete_id') athlete!: any;
  @relation('events',   'event_id')   event!:   any;
}
```

***

### 3.5 Sync Implementation — Full WatermelonDB Synchronize Pattern

```typescript
// sync/syncEngine.ts
import { synchronize } from '@nozbe/watermelondb/sync';
import { database }    from '../database';

const SYNC_URL = process.env.SYNC_BACKEND_URL ?? 'https://api.coreelite.app/sync';

let syncLock: Promise<void> | null = null;

export async function triggerSync(authToken: string): Promise<void> {
  // Mutex: prevent concurrent sync calls
  if (syncLock) return syncLock;

  syncLock = (async () => {
    try {
      await synchronize({
        database,

        pullChanges: async ({ lastPulledAt, schemaVersion, migration }) => {
          const params = new URLSearchParams({
            last_pulled_at:  String(lastPulledAt ?? 0),
            schema_version:  String(schemaVersion),
            migration:       JSON.stringify(migration),
          });

          const res = await fetch(`${SYNC_URL}/pull?${params}`, {
            headers: { Authorization: `Bearer ${authToken}` },
          });

          if (!res.ok) throw new Error(`Pull failed: ${res.status}`);

          const { changes, timestamp } = await res.json();
          return { changes, timestamp };
        },

        pushChanges: async ({ changes, lastPulledAt }) => {
          const res = await fetch(
            `${SYNC_URL}/push?last_pulled_at=${lastPulledAt}`,
            {
              method:  'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${authToken}`,
              },
              body: JSON.stringify(changes),
            }
          );

          if (!res.ok) throw new Error(`Push failed: ${res.status}`);
        },

        migrationsEnabledAtVersion: 1,

        // Flag new local creates as updated so server doesn't try to re-create
        // after the first push cycle
        sendCreatedAsUpdated: true,
      });
    } finally {
      syncLock = null;
    }
  })();

  return syncLock;
}
```

**WatermelonDB Changes Payload Format (what `pushChanges` sends to server):**

```json
{
  "timing_results": {
    "created": [
      {
        "id": "local-uuid-001",
        "athlete_id": "ath-123",
        "event_id":   "evt-456",
        "drill_type": "dash_40",
        "result_seconds": 4.73,
        "created_at": 1712000000000,
        "updated_at": 1712000000000,
        "_status": "created"
      }
    ],
    "updated": [],
    "deleted": []
  },
  "athletes": {
    "created": [],
    "updated": [],
    "deleted": []
  }
}
```

***

### 3.6 Three-Device Offline Reconnect — Conflict Resolution Architecture

This is the core engineering challenge: **three tablets simultaneously running sessions in a dead zone, then reconnecting to Wi-Fi at the same time.**

#### 3.6.1 Problem Decomposition

```
Device A (Head Coach tablet)  — offline 2 hours — recorded 87 timing results
Device B (Assistant tablet)   — offline 2 hours — recorded 34 timing results (some for same athletes)
Device C (Check-in tablet)    — offline 2 hours — recorded athlete registrations / roster updates
                         ↓ All three regain Wi-Fi simultaneously ↓
                     [Server must reconcile all three change sets]
```

#### 3.6.2 Resolution Strategy: Server-Authoritative LWW with Tombstone Deletes

```typescript
// server/syncHandler.ts (Node.js / Express — backend reference)

interface SyncPullResponse {
  changes:   ChangeSet;
  timestamp: number;  // Server Unix timestamp — clients store this as lastPulledAt
}

interface ChangeSet {
  [tableName: string]: {
    created: Record<string, unknown>[];
    updated: Record<string, unknown>[];
    deleted: string[];  // Array of record IDs
  };
}

async function handlePull(lastPulledAt: number): Promise<SyncPullResponse> {
  // Return all server-side records updated since lastPulledAt
  const changes = await db.query(`
    SELECT * FROM timing_results
    WHERE updated_at > $1
    ORDER BY updated_at ASC
  `, [lastPulledAt]);

  return {
    changes:   formatChanges(changes),
    timestamp: Date.now(),   // Server clock is AUTHORITATIVE
  };
}

async function handlePush(
  deviceChanges: ChangeSet,
  lastPulledAt:  number
): Promise<void> {
  for (const table of Object.keys(deviceChanges)) {
    const { created, updated, deleted } = deviceChanges[table];

    // RULE 1: Process created records
    for (const record of created) {
      await db.upsert(table, {
        ...record,
        // Server sets authoritative timestamps
        server_created_at: Date.now(),
        updated_at:        Math.max(record.updated_at, Date.now()),
      });
    }

    // RULE 2: Process updates — LAST WRITE WINS on updated_at
    for (const record of updated) {
      const existing = await db.findById(table, record.id);
      if (!existing || record.updated_at >= existing.updated_at) {
        await db.update(table, record.id, record);
      }
      // If existing.updated_at > record.updated_at: server version wins, skip
    }

    // RULE 3: Deletes — use tombstone (soft delete), never hard delete
    for (const id of deleted) {
      await db.update(table, id, {
        is_deleted:  true,
        updated_at:  Date.now(),
        deleted_at:  Date.now(),
      });
    }
  }
}
```

#### 3.6.3 Concurrent Three-Device Reconnect — Step-by-Step Sequence

```
T=0  All three devices regain network simultaneously

T=1  Device A → POST /sync/push  (87 new timing_results)
     Device B → POST /sync/push  (34 new timing_results)
     Device C → POST /sync/push  (roster updates)

     [Server receives all three pushes; may be near-simultaneous]

     Server processes each push in a DB transaction (row-level locking)
     Conflict rule: last updated_at wins on any row

T=2  Device A → GET /sync/pull?last_pulled_at=T_A_old
     Device B → GET /sync/pull?last_pulled_at=T_B_old
     Device C → GET /sync/pull?last_pulled_at=T_C_old

     [Server returns ALL changes since each device's lastPulledAt]
     Device A now receives Device B's 34 results + Device C's roster updates
     Device B now receives Device A's 87 results + Device C's roster updates
     Device C now receives Device A's + Device B's timing results

T=3  All three devices store new server timestamp as their new lastPulledAt
     All three devices are now fully synchronized

CONFLICT EXAMPLE:
     Both Device A and B recorded a time for athlete "John Smith" in 40-yd dash:
       Device A: result_seconds=4.73,  updated_at=1712000100
       Device B: result_seconds=4.71,  updated_at=1712000105

     → Server stores Device B's record (updated_at is 5s later = more recent)
     → On next pull, Device A receives Device B's version and overwrites local
     → Both devices now show 4.71 sec for that rep
```

#### 3.6.4 Handling Same Athlete, Same Drill, Different Attempt Numbers

The key design decision: **DO NOT merge timing results.** Each rep is a **separate immutable record** with a monotonically increasing `attempt_number`. Two different scouts recording the same athlete's attempts are writing NEW records, not updating the same record. This eliminates the majority of conflicts.

```typescript
// Correct: Each rep is its own record
const rep1 = { athlete_id: 'ath-123', drill_type: 'dash_40', attempt_number: 1, result_seconds: 4.79 };
const rep2 = { athlete_id: 'ath-123', drill_type: 'dash_40', attempt_number: 2, result_seconds: 4.73 };
const rep3 = { athlete_id: 'ath-123', drill_type: 'dash_40', attempt_number: 3, result_seconds: 4.71 };
// → All three exist in DB simultaneously; "best" is computed at query time
```

**Conflict only occurs when:**
- Two devices attempt to UPDATE the same record (same `id`)
- One device DELETEs a record the other device is also editing

Both cases are resolved by LWW on `updated_at`.

#### 3.6.5 Outbox Pattern for Guaranteed Delivery

```typescript
// When offline, write to outbox instead of directly calling sync
async function writeTimingResultOffline(
  db:     SQLiteDatabase,
  result: TimingResultInput
): Promise<void> {
  const id  = generateUUID();
  const now = Date.now();
  const row = { ...result, id, created_at: now, updated_at: now };

  // 1. Write to primary table (for immediate local display)
  await db.runAsync(
    `INSERT INTO timing_results (id, athlete_id, event_id, drill_type, result_seconds, ...)
     VALUES (?, ?, ?, ?, ?, ...)`,
    [id, row.athlete_id, row.event_id, row.drill_type, row.result_seconds]
  );

  // 2. Enqueue in outbox (guarantees delivery even if app crashes before sync)
  await db.runAsync(
    `INSERT INTO sync_outbox (id, entity_table, entity_id, operation, payload_json, retry_count, created_at)
     VALUES (?, 'timing_results', ?, 'create', ?, 0, ?)`,
    [generateUUID(), id, JSON.stringify(row), now]
  );
}

// When connectivity restored:
async function processOutbox(db: SQLiteDatabase, authToken: string): Promise<void> {
  const pendingOps = await db.getAllAsync<OutboxRow>(
    `SELECT * FROM sync_outbox WHERE retry_count < 5 ORDER BY created_at ASC LIMIT 100`
  );

  if (pendingOps.length === 0) return;

  const res = await fetch(`${SYNC_URL}/push`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
    body:    JSON.stringify({ items: pendingOps }),
  });

  if (!res.ok) {
    // Increment retry count for all failed ops
    for (const op of pendingOps) {
      await db.runAsync(
        `UPDATE sync_outbox SET retry_count = retry_count + 1, last_attempt_at = ? WHERE id = ?`,
        [Date.now(), op.id]
      );
    }
    return;
  }

  const { ackIds } = await res.json();
  // Remove ACK'd ops from outbox
  await db.runAsync(
    `DELETE FROM sync_outbox WHERE id IN (${ackIds.map(() => '?').join(',')})`,
    ackIds
  );
}
```

***

### 3.7 Network State Management — React Native Context

```typescript
// contexts/NetworkContext.tsx
import React, { createContext, useContext, useEffect, useState } from 'react';
import NetInfo, { NetInfoState } from '@react-native-community/netinfo';

interface NetworkContextValue {
  isConnected:  boolean;
  isInternetReachable: boolean | null;
  connectionType: string;
}

const NetworkContext = createContext<NetworkContextValue>({
  isConnected: true,
  isInternetReachable: null,
  connectionType: 'unknown',
});

export const NetworkProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, setState] = useState<NetworkContextValue>({
    isConnected: true,
    isInternetReachable: null,
    connectionType: 'unknown',
  });

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((netState: NetInfoState) => {
      setState({
        isConnected:         netState.isConnected ?? false,
        isInternetReachable: netState.isInternetReachable,
        connectionType:      netState.type,
      });
    });
    return unsubscribe;
  }, []);

  return (
    <NetworkContext.Provider value={state}>
      {children}
    </NetworkContext.Provider>
  );
};

export const useNetwork = () => useContext(NetworkContext);
```

***

### 3.8 Tech Stack Summary for Core Elite

| Layer | Recommended Library | Version | Notes |
|---|---|---|---|
| Local DB | `@nozbe/watermelondb` | ^0.27 | SQLite + sync primitives[^33][^37] |
| BLE | `react-native-ble-plx` | ^3.x | Scan, GATT, notifications[^13] |
| Network State | `@react-native-community/netinfo` | ^11 | Connectivity detection |
| State Management | `react-query` (TanStack) + WatermelonDB observables | ^5 | Hybrid local/remote |
| Offline Queue | Custom `sync_outbox` SQLite table | — | Per pattern in §3.5 / §3.6.5 |
| Auth | JWT Bearer tokens | — | Passed in all sync requests |
| Backend Sync API | Node.js / Express or Next.js API routes | — | Must implement pull + push endpoints |
| CRDT Layer | WatermelonDB LWW (built-in) | — | Sufficient for combine data[^38] |

***

## Appendix A — Known API Gaps (Coding Agent Awareness)

| System | Gap | Mitigation |
|---|---|---|
| Dashr BLE | No public API or GATT UUIDs published | Use manual CSV import or TeamBuildr webhook |
| Freelap BLE | No public GATT UUID documentation | Contact Freelap for SDK; implement binary packet parser |
| Dashr offline mode | Unknown — app stores locally but no documented fallback export | Implement manual entry as primary fallback |
| Freelap memory recovery | Chip data lost after 30 min if app unreachable | Document this in UX; prompt coach to recover within window[^11] |

***

## Appendix B — Critical Engineering Constraints

1. **BLE range on football field:** Dashr|Blue is rated to 100 yards. At 150 yards, connections may drop[^1]. Position coaching tablet within 100 yards of farthest gate.
2. **Android BLE requirement:** Location permission is MANDATORY on Android 6+ for BLE scanning. Without it, `startDeviceScan` will not detect any peripherals.[^14]
3. **Freelap minimum gate interval:** 0.7 seconds minimum between transmitter crossings. A 5-10-5 shuttle with a 40-yard dash warmup crossing at high speed may approach this limit.[^11]
4. **WatermelonDB `sendCreatedAsUpdated`:** Must be set to `true` in sync options to prevent the pull-then-push cycle from attempting to re-create just-pushed records.[^39]
5. **Sync mutex:** A `syncInFlight` lock must prevent duplicate concurrent sync calls, especially when all three tablets reconnect simultaneously.[^40]
6. **NSCA vs. NFL Norms:** High school NSCA norms assume HAND TOUCH at turnarounds for 5-10-5. NFL Combine requires FOOT TOUCH only. This means NFL split times are faster. When displaying comparisons, always disclose which protocol was used.[^41][^29]

---

## References

1. [[PDF] Dashr|Blue Quick Start Guide](https://www.dashrsystems.com/wp-content/uploads/Dashr-Blue-Quick-Start-Guide.pdf) - T1.1 - If you are testing in the sun, make sure that the laser is oriented towards the sun so that t...

2. [Getting started with the Dashr 2.0 timing system.](https://www.dashrsystems.com/2020/06/getting-started-with-the-dashr-2-0-timing-system/) - Note that all Bluetooth connections are performed through the app, not through your device's operati...

3. [Dashr Timing Systems | Elevate Your Game Performance](https://www.dashrsystems.com) - *Bluetooth communication from phone/tablet to each laser. Range is dependent on your phone/tablet's ...

4. [Dashr Ecosystem](https://www.dashrsystems.com/2025/06/dashr-ecosystem/) - The Dashr ecosystem allows you to efficiently test your athletes and have those results instantly sa...

5. [FAQs Archive - Dashr](https://www.dashrsystems.com/faqs/) - The Dashr 2.0 timing system has a maximum range of 60 yards/meters so a single system could not reco...

6. [Tips for connecting to bluetooth? - Dashr](https://www.dashrsystems.com/faq/tips-for-connecting-to-bluetooth/) - To connect to Bluetooth, please follow these steps first: Ensure lasers are turned on one at a time ...

7. [Dashr Player Profile - App Store - Apple](https://apps.apple.com/us/app/dashr-player-profile/id6502371887) - The Dashr Player Profile App is for athletes to easily access their athletic performance testing and...

8. [Viewing Dashr Data in Workout Entry View - TeamBuildr - YouTube](https://www.youtube.com/watch?v=xlRhMffomd4) - Share your videos with friends, family, and the world.

9. [Freelap Pro BT Timing System](https://www.freelapusa.com/freelap-pro-bt-timing-system/) - When the FxChip BLE detects the Finish mode, the FxChip BLE transmits all the stored times to the my...

10. [User guide - Freelap Device Manager App | Freelap Timing](https://www.freelap.com/support/freelap-device-manager-user-guide/) - For the app to detect your FxChip BLE: • Turn on location and Bluetooth function on your smartphone....

11. [[PDF] FxChip BLE | Freelap](https://www.freelap.com/wp-content/uploads/2025/02/fxchipble_rechargeable_manual.pdf) - To get your timing data, you must turn on and place the transmitters on the track, and use the MyFre...

12. [Mastering Bluetooth Low Energy Integration with React Native](https://reactnativeexpert.com/blog/mastering-bluetooth-low-energy-integration-with-react-native/) - This professional blog explores the essentials of BLE integration in React Native, focusing on best ...

13. [React Native + BLE  Real Device Connection App Tutorial](https://www.youtube.com/watch?v=3Jkxld3xFEY) - React Native + BLE: Real Device Connection App

Need to connect your React Native app to real Blueto...

14. [Integrating BLE Beacons in React Native Apps - dev.family](https://dev.family/blog/article/using-ble-technology-when-working-with-beacon-in-react-native) - Set up BLE beacons in React Native apps for real-time data collection and improved user interactions...

15. [sicpa-dlab/ble-react-native: React Native wrapper for Bluetooth Low ...](https://github.com/sicpa-dlab/ble-react-native) - A React Native library for connecting two phones via Bluetooth Low Energy and exchanging messages. B...

16. [Characteristic Writing · dotintent/react-native-ble-plx Wiki - GitHub](https://github.com/dotintent/react-native-ble-plx/wiki/Characteristic-Writing) - It is generally faster to send more data to the peripheral but in expense of loosing the ability to ...

17. [Improve BLE throughput in react-native-ble-plx mobile app](https://devzone.nordicsemi.com/f/nordic-q-a/32449/improve-ble-throughput-in-react-native-ble-plx-mobile-app) - We are developing a React Native mobile application for iOS and Android, making use of the react-nat...

18. [2026 NFL Combine: Best and average 40-yard dash times by position](https://www.nfl.com/_amp/2026-nfl-combine-best-and-average-40-yard-dash-times-by-position) - NFL.com's Matt Okada takes a historic deep dive into the 40-yard dash and lays out what to expect at...

19. [NFL Combine Records: Athlete Benchmark Testing Standards - LPS](https://lpsathletic.com/nfl-combine-records-athlete-benchmark-testing-standards/) - Explore the all-time NFL Combine records for key drills like the 40-yard dash, bench press, and broa...

20. [[OC] The average 40-yard dash time by position at the NFL Scouting Combine over the last decade](https://www.reddit.com/r/dataisbeautiful/comments/11gbedx/oc_the_average_40yard_dash_time_by_position_at/)

21. [Average 40-yard dash time for every position at NFL Combine](https://fansided.com/posts/average-40-yard-dash-time-for-every-position-at-nfl-combine-01hqktr2gxk3) - The fastest 40-yard dash times at the NFL Combine usually come from specific positions. What times s...

22. [The Predictive Ability of the Physical Skills Used at the NFL ...](https://thesportjournal.org/article/the-predictive-ability-of-the-physical-skills-used-at-the-nfl-combine-to-predict-draft-status/) - The Predictive Ability of the Physical Skills Used at the NFL Combine to Predict Draft Status ; Vert...

23. [[PDF] 12 years old & under Male Performance Score & Percentile Rank](https://vistaridgefootball.com/wp-content/uploads/2018/03/Male-Percentile-Rank-by-Age-Master.pdf) - Percentile. Vertical Jump. Pro-Agility Run. 10-Yard Dash. 40-Yard Dash. Rank. Inches. Seconds. Secon...

24. [Human running speed of 35-40 mph may be biologically possible](https://blog.smu.edu/research/2010/01/21/human-running-speed-of-35-40-mph-may-be-biologically-possible/) - The newly published evidence identifies the critical variable imposing the biological limit to runni...

25. [The Potential for a 40-MPH Man | WIRED](https://www.wired.com/2010/02/40-mph-human/) - The human frame is built to handle running speeds up to 40 miles per hour, scientists say. The only ...

26. [Relevance of the 100 ms false start threshold in athletics - PESS Blog](https://pess.blog/2021/04/19/relevance-of-the-100-ms-false-start-threshold-in-athletics-matthieu-milloz/) - This threshold of 100 ms seeks to ensure that no athletes gain an unfair advantage by anticipating t...

27. [Runners can be disqualified for starting after the gun. What gives?](https://www.vox.com/unexplainable/23365327/tynia-gaither-devon-allen-false-starts-worlds-science-physiology-human-limit) - The rules of elite running say no one can start a race faster than 0.1 seconds. Scientists say that'...

28. [The Rule That Punishes Athletes for Being 'Too Fast' - YouTube](https://www.youtube.com/watch?v=sP8nZwLjXaE&vl=en-US) - Track & field's false start rule punishes sprinters for being too fast. We break down why the 100ms ...

29. [Assessing Agility Using the T Test, 5-10-5 Shuttle, and Illinois Test](https://www.nsca.com/education/articles/kinetic-select/assessing-agility-using-the-t-test-5-10-5-shuttle-and-illinois-test/) - The 5-10-5 shuttle consists of rapid directional changes in a linear plane. It is commonly used as a...

30. [Pro-Agility (5-10-5) Test - Physiopedia](https://www.physio-pedia.com/Pro-Agility_(5-10-5)_Test) - The Pro-Agility Test, also known as the 5-10-5 shuttle or 20-yard shuttle test, is a popular protoco...

31. [About CRDTs • Conflict-free Replicated Data Types](https://crdt.tech) - Resources and community around CRDT technology — papers, blog posts, code and more.

32. [Conflict-free Replicated Data Types: An Overview](https://arxiv.org/pdf/1806.10254.pdf)

33. [Using WatermelonDB for offline data sync - LogRocket Blog](https://blog.logrocket.com/watermelondb-offline-data-sync/) - Syncing data outside a mobile device is a common feature for offline React Native apps. WatermelonDB...

34. [Build a fully offline app using React Native and WatermelonDB](https://blog.logrocket.com/offline-app-react-native-watermelondb/) - In this post, I will walk you through building a React Native app that lets the user track their wei...

35. [How to Implement Offline-First Architecture in React Native](https://oneuptime.com/blog/post/2026-01-15-react-native-offline-architecture/view) - Learn how to design and implement offline-first architecture in React Native for apps that work seam...

36. [React Native with WatermelonDB: A Lightweight and Reactive ...](https://dev.to/sachingaggar/react-native-with-watermelondb-a-lightweight-and-reactive-database-for-scalable-apps-l88) - WatermelonDB is an excellent lightweight database solution. Adding only about 2MB to your app's size...

37. [Frontend | WatermelonDB](https://watermelondb.dev/docs/Sync/Frontend) - To synchronize, you need to pass pullChanges and pushChanges (optional) that talk to your backend an...

38. [Offline-first React Native Apps with Expo, WatermelonDB, and ...](https://supabase.com/blog/react-native-offline-first-watermelon-db) - Store your data locally and sync it with Postgres using WatermelonDB!

39. [Push Changes with create/delete and subsequent pull - API would ...](https://github.com/Nozbe/WatermelonDB/issues/649) - We do a second pull/push right after the first one to read in changes made (make sure to use sendCre...

40. [React Native offline-first: conflict-safe SQLite sync - DEV Community](https://dev.to/sathish_daggula/react-native-offline-first-conflict-safe-sqlite-sync-549a) - I store edits in SQLite as an outbox. Not memory. I use per-row updated_at + deleted_at for merges. ...

41. [Instructions for the Pro Agility Test (5-10-5) - YouTube](https://www.youtube.com/watch?v=z-wV9O8y-a0) - The NSCA guidelines say touch the side line with hand or foot. Not worried about the hand touch, ath...

