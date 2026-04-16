// =============================================================================
// ClockSync.cpp
// Core Elite — Phase 2: Inter-Device Clock Synchronisation
// =============================================================================

#include "ClockSync.h"

#include <algorithm>
#include <cassert>
#include <cstring>
#include <limits>

namespace CoreElite {

// ---------------------------------------------------------------------------
// ClockSyncEngine
// ---------------------------------------------------------------------------

ClockSyncEngine::ClockSyncEngine(std::function<uint64_t()> monotonicClock)
    : _clock(std::move(monotonicClock))
{
    assert(_clock && "monotonicClock must not be null");
    _pendingPings.fill(PendingPing{});
    _samples.fill(SyncSample{});
}

// ---------------------------------------------------------------------------
// buildPing — SLAVE side
//
// Captures T1 using the injected monotonic clock, allocates a pending
// slot indexed by sequence number, returns the packet.
// ---------------------------------------------------------------------------
SyncPingPacket ClockSyncEngine::buildPing() {
    std::lock_guard<std::mutex> lock(_mutex);

    const uint32_t seq   = _nextSeq++;
    const uint64_t t1_ns = _clock();

    // Find a free pending slot (round-robin eviction of oldest if all full)
    size_t slot = seq % kPendingPingSlots;
    _pendingPings[slot] = PendingPing{ seq, t1_ns, true };

    SyncPingPacket pkt{};
    pkt.type     = 0x10;
    pkt.flags    = (_missedPings.load(std::memory_order_relaxed) > 0) ? 0x01 : 0x00;
    pkt.reserved = 0;
    pkt.seq      = seq;
    pkt.t1_ns    = t1_ns;
    return pkt;
}

// ---------------------------------------------------------------------------
// processPong — SLAVE side
//
// Matches the PONG to a pending PING by sequence number.
// Computes the clock offset sample and adds it to the rolling window.
// Updates the atomic offset used by applyOffset().
// ---------------------------------------------------------------------------
bool ClockSyncEngine::processPong(const SyncPongPacket& pong, uint64_t t4_ns) {
    if (pong.type != 0x11) return false;

    std::lock_guard<std::mutex> lock(_mutex);

    // Locate the pending PING with matching seq
    const size_t slot = pong.seq % kPendingPingSlots;
    PendingPing& pending = _pendingPings[slot];

    if (!pending.active || pending.seq != pong.seq) {
        // Stale, out-of-order, or duplicate PONG — silently discard.
        // This is NOT an error: BLE retransmissions can produce duplicates.
        return false;
    }

    // Consume the pending slot immediately to prevent double-processing
    const uint64_t t1_ns = pending.t1_ns;
    pending.active = false;

    const uint64_t t2_ns = pong.t2_ns;
    const uint64_t t3_ns = pong.t3_ns;

    // Sanity check: monotonic clocks must not go backward.
    // If T2 == 0 or T3 == 0 the master failed to populate the packet — discard.
    if (t2_ns == 0 || t3_ns == 0) return false;

    // T3 must be ≥ T2 (master clocks can only move forward)
    if (t3_ns < t2_ns) return false;

    // T4 must be ≥ T1 (slave clock monotonic)
    if (t4_ns < t1_ns) return false;

    const uint64_t total_elapsed_ns = t4_ns - t1_ns;  // time from ping send to pong recv
    const uint64_t master_proc_ns   = t3_ns - t2_ns;  // time master spent between recv and send

    // master_proc_ns can never exceed total_elapsed_ns if the link is physical
    if (master_proc_ns > total_elapsed_ns) return false;

    const uint64_t rtt_ns = total_elapsed_ns - master_proc_ns;

    // NTP formula:
    // offset_master_minus_slave = ((T2 - T1) + (T3 - T4)) / 2
    // Using signed arithmetic to handle negative offsets (slave ahead of master)
    const int64_t term1 = static_cast<int64_t>(t2_ns) - static_cast<int64_t>(t1_ns);
    const int64_t term2 = static_cast<int64_t>(t3_ns) - static_cast<int64_t>(t4_ns);
    const int64_t offset_ns = (term1 + term2) / 2;

    // Reject outlier samples: offset magnitude > 500ms is physically implausible
    // for two devices in the same venue (and would indicate a clock reset or bug).
    static constexpr int64_t kOutlierThresholdNs = 500'000'000LL; // 500ms
    if (offset_ns >  kOutlierThresholdNs ||
        offset_ns < -kOutlierThresholdNs) {
        return false;
    }

    // Store sample in circular window
    SyncSample& sample = _samples[_sampleHead % kSyncSampleWindow];
    sample = SyncSample{ t1_ns, t2_ns, t3_ns, t4_ns, offset_ns, rtt_ns, true };
    _sampleHead = (_sampleHead + 1) % kSyncSampleWindow;
    if (_sampleCount < kSyncSampleWindow) ++_sampleCount;

    // Recompute median offset
    const int64_t medianOffset = computeMedianOffset();

    // Update atomics — lock-free reads in applyOffset() see consistent state
    _offsetNs.store(medianOffset, std::memory_order_release);
    _synced.store(true, std::memory_order_release);
    _missedPings.store(0, std::memory_order_release);

    return true;
}

// ---------------------------------------------------------------------------
// buildPong — MASTER side
//
// t2_ns: captured as FIRST STATEMENT in the GATT write callback.
// T3 is captured inside this function immediately before packet assembly —
// the delta (T3 - T2) is the master's processing time, subtracted in the
// offset formula on the slave side.
// ---------------------------------------------------------------------------
SyncPongPacket ClockSyncEngine::buildPong(const SyncPingPacket& ping, uint64_t t2_ns) {
    // Capture T3 as late as possible (after all processing)
    // to minimise the artificial processing delay introduced between T2 and T3.
    // The mutex acquisition below is included in this processing time —
    // that is correct because the slave's formula subtracts (T3-T2) exactly.
    std::lock_guard<std::mutex> lock(_mutex);

    SyncPongPacket pkt{};
    pkt.type     = 0x11;
    // Propagate desync state: if master is itself desynced, slave should know.
    pkt.flags    = _synced.load(std::memory_order_relaxed) ? 0x00 : 0x01;
    pkt.reserved = 0;
    pkt.seq      = ping.seq;
    pkt.t2_ns    = t2_ns;
    pkt.t3_ns    = _clock();   // T3 captured HERE — after mutex, just before return
    return pkt;
}

// ---------------------------------------------------------------------------
// applyOffset — lock-free hot path
//
// Called from the timing event path to correct a raw monotonic timestamp.
// Uses atomic loads with acquire semantics for visibility of the latest
// offset computed in processPong().
// ---------------------------------------------------------------------------
uint64_t ClockSyncEngine::applyOffset(uint64_t raw_ns) const {
    if (!_synced.load(std::memory_order_acquire)) {
        return raw_ns;  // Not yet synced — return raw (acceptable at event start)
    }
    const int64_t offset = _offsetNs.load(std::memory_order_acquire);
    // Saturating add: avoid wraparound on uint64_t.
    // If offset is negative and larger than raw_ns, clamp to 0.
    // This situation is physically implausible (would require the device's
    // monotonic clock to have started billions of seconds in the future)
    // but we guard anyway.
    if (offset < 0 && static_cast<uint64_t>(-offset) > raw_ns) {
        return 0;
    }
    return static_cast<uint64_t>(static_cast<int64_t>(raw_ns) + offset);
}

int64_t ClockSyncEngine::currentOffsetNs() const {
    return _offsetNs.load(std::memory_order_acquire);
}

bool ClockSyncEngine::isSynced() const {
    if (!_synced.load(std::memory_order_acquire)) return false;
    const int64_t offset = _offsetNs.load(std::memory_order_acquire);
    const int64_t absOff = offset < 0 ? -offset : offset;
    return absOff <= kMaxDriftNs;
}

bool ClockSyncEngine::isDesynced() const {
    return _missedPings.load(std::memory_order_acquire) >= kMissedPingLimit;
}

void ClockSyncEngine::recordMissedPing() {
    _missedPings.fetch_add(1, std::memory_order_acq_rel);
    if (isDesynced()) {
        _synced.store(false, std::memory_order_release);
    }
}

void ClockSyncEngine::resetMissedPings() {
    _missedPings.store(0, std::memory_order_release);
}

void ClockSyncEngine::markDesynced() {
    _synced.store(false, std::memory_order_release);
    _missedPings.store(kMissedPingLimit, std::memory_order_release);
}

size_t ClockSyncEngine::sampleCount() const {
    std::lock_guard<std::mutex> lock(_mutex);
    return _sampleCount;
}

// ---------------------------------------------------------------------------
// computeMedianOffset — caller holds _mutex
//
// Extracts valid offset samples into a fixed array, sorts, returns median.
// With kSyncSampleWindow=7 (odd), the median is _sorted[3].
// ---------------------------------------------------------------------------
int64_t ClockSyncEngine::computeMedianOffset() const {
    if (_sampleCount == 0) return 0;

    std::array<int64_t, kSyncSampleWindow> offsets{};
    size_t valid = 0;
    for (size_t i = 0; i < _sampleCount; ++i) {
        const SyncSample& s = _samples[i];
        if (s.valid) {
            offsets[valid++] = s.offset_ns;
        }
    }
    if (valid == 0) return 0;

    // Partial sort to find median — O(N log N) but N ≤ 7, effectively O(1)
    std::sort(offsets.begin(), offsets.begin() + valid);
    return offsets[valid / 2];
}

// ---------------------------------------------------------------------------
// RSSIMonitor
// ---------------------------------------------------------------------------

RFAdaptationState RSSIMonitor::addReading(int8_t rssi) {
    std::lock_guard<std::mutex> lock(_mutex);

    // Exponential moving average — first reading initialises the filter
    if (!_hasFirstReading) {
        _smoothed = static_cast<float>(rssi);
        _hasFirstReading = true;
    } else {
        _smoothed = kAlpha * static_cast<float>(rssi) + (1.0f - kAlpha) * _smoothed;
    }

    const int8_t smoothedInt = static_cast<int8_t>(_smoothed);

    // Update run counters
    if (smoothedInt < kRSSIDowngradeDbm) {
        ++_subThresholdRuns;
        _aboveRecoveryRuns = 0;
    } else if (smoothedInt > kRSSIRecoveryDbm) {
        ++_aboveRecoveryRuns;
        _subThresholdRuns = 0;
    } else {
        // In hysteresis band — hold current state, reset both counters
        _subThresholdRuns  = 0;
        _aboveRecoveryRuns = 0;
    }

    // State machine transitions
    switch (_state) {

        case RFAdaptationState::Normal:
            if (_subThresholdRuns >= kRSSITriggerCount) {
                _state = RFAdaptationState::Degrading;
                _subThresholdRuns = 0;
            }
            break;

        case RFAdaptationState::Degrading:
            // Caller should check shouldDowngradePHY() and act; the state
            // advances to PHYDowngrading via notifyPHYDowngraded() call.
            if (_aboveRecoveryRuns >= kRSSITriggerCount) {
                _state = RFAdaptationState::Normal;
                _aboveRecoveryRuns = 0;
            }
            break;

        case RFAdaptationState::PHYDowngrading:
            // Waiting for PHY negotiation — stay here until notifyPHYDowngraded()
            break;

        case RFAdaptationState::PHYCoded:
            if (_aboveRecoveryRuns >= kRSSITriggerCount) {
                // Signal recovered — upgrade back to 1M
                _state = RFAdaptationState::Normal;
                _aboveRecoveryRuns = 0;
            } else if (_subThresholdRuns >= kCriticalRunCount) {
                // Still below threshold even on Coded PHY — critical
                _state = RFAdaptationState::CriticalSignal;
                _subThresholdRuns = 0;
            }
            break;

        case RFAdaptationState::CriticalSignal:
            // Only recovery path: explicit reset (operator intervention)
            // shouldTriggerFallback() will return true from this state
            break;

        case RFAdaptationState::FallbackActive:
            // Terminal state — remains until reset() is called
            break;
    }

    return _state;
}

float RSSIMonitor::smoothedRSSI() const {
    std::lock_guard<std::mutex> lock(_mutex);
    return _smoothed;
}

RFAdaptationState RSSIMonitor::state() const {
    std::lock_guard<std::mutex> lock(_mutex);
    return _state;
}

void RSSIMonitor::notifyPHYDowngraded() {
    std::lock_guard<std::mutex> lock(_mutex);
    _state = RFAdaptationState::PHYCoded;
    _subThresholdRuns  = 0;
    _aboveRecoveryRuns = 0;
}

void RSSIMonitor::notifyPHYUpgraded() {
    std::lock_guard<std::mutex> lock(_mutex);
    _state = RFAdaptationState::Normal;
    _subThresholdRuns  = 0;
    _aboveRecoveryRuns = 0;
}

void RSSIMonitor::notifyFallbackActive() {
    std::lock_guard<std::mutex> lock(_mutex);
    _state = RFAdaptationState::FallbackActive;
}

void RSSIMonitor::reset() {
    std::lock_guard<std::mutex> lock(_mutex);
    _state             = RFAdaptationState::Normal;
    _subThresholdRuns  = 0;
    _aboveRecoveryRuns = 0;
    _hasFirstReading   = false;
    _smoothed          = 0.0f;
}

bool RSSIMonitor::shouldDowngradePHY() const {
    std::lock_guard<std::mutex> lock(_mutex);
    return _state == RFAdaptationState::Degrading;
}

bool RSSIMonitor::shouldUpgradePHY() const {
    std::lock_guard<std::mutex> lock(_mutex);
    return _state == RFAdaptationState::PHYCoded && _aboveRecoveryRuns >= kRSSITriggerCount;
}

bool RSSIMonitor::shouldTriggerFallback() const {
    std::lock_guard<std::mutex> lock(_mutex);
    return _state == RFAdaptationState::CriticalSignal ||
           _state == RFAdaptationState::FallbackActive;
}

} // namespace CoreElite
