// =============================================================================
// ClockSync.h
// Core Elite — Phase 2: Inter-Device Clock Synchronisation
//
// Implements a two-way BLE clock sync protocol modelled on SNTP/PTP:
//
//   Slave (initiator)                  Master (responder)
//     |                                    |
//     |-- SYNC_PING[seq, T1] ------------->|  T1 = slave MONOTONIC_RAW at send
//     |                                    |  T2 = master MONOTONIC_RAW at recv
//     |<-- SYNC_PONG[seq, T2, T3] ---------|  T3 = master MONOTONIC_RAW at send
//     |                                    |
//     T4 = slave MONOTONIC_RAW at recv
//
//   offset_master_minus_slave = ((T2 - T1) + (T3 - T4)) / 2
//   rtt = (T4 - T1) - (T3 - T2)
//
//   corrected_timestamp_ns = raw_slave_ns + offset_master_minus_slave
//
// Accuracy characteristics:
//   - BLE 1M PHY: 22-byte packet ≈ 0.176ms on-air; measurement error ≈ ±RTT_jitter/2
//   - BLE Coded PHY (125kbps): same calculation, ~1.4ms on-air
//   - With 30–60s sync interval and 2ppm crystal: drift ≤ 60μs between syncs
//   - System budget of ±1.44ms provides 24× headroom at the sync interval
//
// All timestamps in nanoseconds from CLOCK_MONOTONIC_RAW / uptimeNanos().
// No wall-clock values anywhere in this file.
// =============================================================================

#pragma once

#include <array>
#include <atomic>
#include <cstdint>
#include <cstring>
#include <functional>
#include <mutex>

namespace CoreElite {

// ---------------------------------------------------------------------------
// Compile-time constants
// ---------------------------------------------------------------------------

// Maximum allowed drift before a forced resync is flagged to the application.
// 1.44ms = 1,440,000ns.
static constexpr int64_t kMaxDriftNs        = 1'440'000LL;

// RSSI threshold for PHY downgrade recommendation (dBm, stored as int8_t).
static constexpr int8_t  kRSSIDowngradeDbm  = -85;

// RSSI recovery threshold — hysteresis gap prevents oscillation.
static constexpr int8_t  kRSSIRecoveryDbm   = -75;

// Consecutive sub-threshold readings required to trigger PHY downgrade.
static constexpr int     kRSSITriggerCount  = 5;

// Consecutive missed pings that constitute desync.
static constexpr int     kMissedPingLimit   = 3;

// Rolling sample window for median-filtered offset estimation.
// Odd count ensures a clean median without averaging two middle values.
static constexpr size_t  kSyncSampleWindow  = 7;

// Pending PING slots — sequence numbers in flight, not yet matched to a PONG.
// Window of 8 covers ~4 minutes of 30s ping intervals with no response.
static constexpr size_t  kPendingPingSlots  = 8;

// ---------------------------------------------------------------------------
// Wire-format packet structures (packed — exactly what goes over BLE GATT)
// All multi-byte fields are little-endian.
// ---------------------------------------------------------------------------

// SYNC_PING — 16 bytes (≤50-byte budget ✓)
// Sent by the slave (initiator) to the master's sync characteristic.
struct __attribute__((packed)) SyncPingPacket {
    uint8_t  type;     // 0x10
    uint8_t  flags;    // bit0=1 if sender is requesting resync urgently
    uint16_t reserved; // must be 0x0000
    uint32_t seq;      // monotonically incrementing per-device sequence
    uint64_t t1_ns;    // slave MONOTONIC_RAW at the moment of write() call
};
static_assert(sizeof(SyncPingPacket) == 16, "SyncPingPacket must be 16 bytes");

// SYNC_PONG — 24 bytes (≤50-byte budget ✓)
// Sent by the master to the slave via GATT notification.
struct __attribute__((packed)) SyncPongPacket {
    uint8_t  type;     // 0x11
    uint8_t  flags;    // bit0=1 if master itself is desynced (cascaded desync signal)
    uint16_t reserved;
    uint32_t seq;      // echo of the PING seq this is responding to
    uint64_t t2_ns;    // master MONOTONIC_RAW at receipt of the PING
    uint64_t t3_ns;    // master MONOTONIC_RAW at moment of notification send
};
static_assert(sizeof(SyncPongPacket) == 24, "SyncPongPacket must be 24 bytes");

// TIMING_EVENT — 24 bytes (≤50-byte budget ✓)
// Extended version of the raw BLE characteristic value; includes the
// clock-corrected timestamp applied after the sync offset is known.
struct __attribute__((packed)) TimingEventPacket {
    uint8_t  type;          // 0x01
    uint8_t  rssi;          // RSSI + 128 → maps -128dBm=0, 0dBm=128, +127dBm=255
    uint8_t  phy;           // 0x01=1M, 0x02=2M, 0x04=Coded
    uint8_t  flags;         // bit0=clock_synced, bit1=fallback_active, bit2=phy_downgraded
    uint32_t sequence;
    uint64_t corrected_ns;  // raw_monotonic + offset (nanoseconds)
    uint8_t  chip_id[8];    // first 8 bytes of ASCII chip identifier
};
static_assert(sizeof(TimingEventPacket) == 24, "TimingEventPacket must be 24 bytes");

// ---------------------------------------------------------------------------
// SyncSample — one completed two-way exchange
// ---------------------------------------------------------------------------

struct SyncSample {
    uint64_t t1_ns       = 0;
    uint64_t t2_ns       = 0;
    uint64_t t3_ns       = 0;
    uint64_t t4_ns       = 0;
    int64_t  offset_ns   = 0;   // (T2-T1 + T3-T4) / 2
    uint64_t rtt_ns      = 0;   // (T4-T1) - (T3-T2)
    bool     valid       = false;
};

// ---------------------------------------------------------------------------
// ClockSyncEngine
//
// Thread-safety:
//   All public methods are mutex-protected and safe for concurrent calls.
//   The caller is responsible for calling buildPong() from the BLE queue
//   (same thread that receives GATT write callbacks) and processPong() from
//   the same queue. applyOffset() and isSynced() may be called from any thread.
// ---------------------------------------------------------------------------

class ClockSyncEngine {
public:
    // monotonicClock: a callable returning the current monotonic time in nanoseconds.
    // On iOS: wraps clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW).
    // On Android: wraps SystemClock.uptimeNanos() via JNI.
    explicit ClockSyncEngine(std::function<uint64_t()> monotonicClock);

    // -------------------------------------------------------------------------
    // SLAVE (initiator) side
    // -------------------------------------------------------------------------

    // Build a SYNC_PING packet to send to the master.
    // T1 is captured inside this call using the injected clock.
    // The sequence number is stored internally; call processPong() with
    // the matching PONG when it arrives.
    SyncPingPacket buildPing();

    // Process a received SYNC_PONG from the master.
    // t4_ns: slave monotonic clock at the moment the PONG notification arrived.
    //        Caller must capture this as the FIRST statement in the GATT
    //        notification callback — before any other processing.
    // Returns true if the offset estimate was updated.
    // Returns false if the PONG seq does not match any pending PING
    //   (stale, out-of-order, or duplicate — silently ignored).
    bool processPong(const SyncPongPacket& pong, uint64_t t4_ns);

    // -------------------------------------------------------------------------
    // MASTER (responder) side
    // -------------------------------------------------------------------------

    // Build a SYNC_PONG in response to a received PING.
    // t2_ns: master monotonic clock at the moment the PING write arrived.
    //        Caller must capture this as the FIRST statement in the GATT
    //        write callback — before any other processing.
    // T3 is captured inside this call immediately before return.
    SyncPongPacket buildPong(const SyncPingPacket& ping, uint64_t t2_ns);

    // -------------------------------------------------------------------------
    // Common
    // -------------------------------------------------------------------------

    // Apply the current estimated offset to a raw monotonic timestamp.
    // Returns corrected_ns = raw_ns + offset_master_minus_slave.
    // If not yet synced (no valid samples), returns raw_ns unchanged.
    // This function is lock-free (reads a single atomic).
    uint64_t applyOffset(uint64_t raw_ns) const;

    // Current estimated offset in nanoseconds (positive = master ahead).
    // Returns 0 if not yet synced.
    int64_t currentOffsetNs() const;

    // True iff at least one valid sync sample exists and the most recent
    // offset estimate is within ±kMaxDriftNs.
    bool isSynced() const;

    // True iff consecutive missed pings have exceeded kMissedPingLimit.
    bool isDesynced() const;

    // Call when a PING was sent but no PONG arrived within the timeout.
    // After kMissedPingLimit consecutive calls, isDesynced() returns true.
    void recordMissedPing();

    // Reset the missed-ping counter. Call when a successful sync occurs.
    void resetMissedPings();

    // Explicitly mark as desynced (e.g. BLE disconnect, signal drop).
    void markDesynced();

    // Number of valid samples in the rolling window.
    size_t sampleCount() const;

private:
    int64_t computeMedianOffset() const;  // Caller holds _mutex

    mutable std::mutex             _mutex;
    std::function<uint64_t()>      _clock;

    // Rolling sample buffer (circular, overwrites oldest)
    std::array<SyncSample, kSyncSampleWindow> _samples{};
    size_t   _sampleHead  = 0;
    size_t   _sampleCount = 0;

    // Atomic for lock-free reads in the hot path (applyOffset)
    std::atomic<int64_t>  _offsetNs{0};
    std::atomic<bool>     _synced{false};
    std::atomic<int>      _missedPings{0};

    // Pending PING slots — correlate PING→PONG by sequence number
    struct PendingPing {
        uint32_t seq    = 0;
        uint64_t t1_ns  = 0;
        bool     active = false;
    };
    std::array<PendingPing, kPendingPingSlots> _pendingPings{};
    uint32_t _nextSeq = 0;
};

// ---------------------------------------------------------------------------
// RSSIMonitor
//
// Exponential moving average of RSSI readings.
// Determines when to trigger PHY downgrade or fallback to manual entry.
// Thread-safe: all methods protected by an atomic or mutex.
// ---------------------------------------------------------------------------

enum class RFAdaptationState : uint8_t {
    Normal          = 0,  // RSSI ≥ kRSSIRecoveryDbm, 1M PHY
    Degrading       = 1,  // kRSSIDowngradeDbm ≤ RSSI < kRSSIRecoveryDbm
    PHYDowngrading  = 2,  // Disconnect+reconnect in progress (iOS) or setPreferredPhy() in flight (Android)
    PHYCoded        = 3,  // Operating on Coded PHY (125kbps)
    CriticalSignal  = 4,  // RSSI < kRSSIDowngradeDbm even on Coded PHY
    FallbackActive  = 5,  // Manual entry fallback triggered
};

class RSSIMonitor {
public:
    RSSIMonitor() = default;

    // Add a new RSSI reading. Returns the updated adaptation state.
    // rssi: signed integer, dBm (e.g. -72, -85, -91)
    RFAdaptationState addReading(int8_t rssi);

    // Current smoothed RSSI (EMA, α=0.3)
    float smoothedRSSI() const;

    // Current adaptation state
    RFAdaptationState state() const;

    // Call when PHY downgrade completes (device reconnected on Coded PHY)
    void notifyPHYDowngraded();

    // Call when PHY upgrade completes (device reconnected on 1M PHY)
    void notifyPHYUpgraded();

    // Call when fallback is triggered
    void notifyFallbackActive();

    // Reset to Normal state (e.g. after reconnect with good signal)
    void reset();

    // Returns true if PHY downgrade should be requested.
    // True when: state==Degrading and subThresholdCount >= kRSSITriggerCount.
    bool shouldDowngradePHY() const;

    // Returns true if PHY upgrade should be requested.
    // True when: state==PHYCoded and aboveRecoveryCount >= kRSSITriggerCount.
    bool shouldUpgradePHY() const;

    // Returns true if manual entry fallback should be triggered.
    bool shouldTriggerFallback() const;

private:
    mutable std::mutex  _mutex;
    float               _smoothed        = 0.0f;
    bool                _hasFirstReading = false;
    int                 _subThresholdRuns = 0;   // consecutive < -85 dBm
    int                 _aboveRecoveryRuns = 0;  // consecutive > -75 dBm
    RFAdaptationState   _state           = RFAdaptationState::Normal;

    static constexpr float kAlpha = 0.3f;  // EMA weight for new reading
    // Fallback when sub-threshold persists for 10× trigger count even on Coded PHY
    static constexpr int kCriticalRunCount = kRSSITriggerCount * 2;
};

} // namespace CoreElite
