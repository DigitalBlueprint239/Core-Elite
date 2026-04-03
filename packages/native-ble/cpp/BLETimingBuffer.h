#pragma once

// =============================================================================
// BLETimingBuffer.h
// Core Elite — Phase 1: Silicon-to-Software Optimization
//
// C++ timing event buffer shared between the iOS CoreBluetooth delegate and
// the Android BluetoothGattCallback. The single source of truth for the
// non-blocking enqueue / JS-thread flush pattern (v3 §1.4.2–1.4.3).
//
// Memory budget (v3 §2.1):
//   kMaxQueueDepth × sizeof(TimingEvent) = 1,000 × 112 bytes = ~112 KB
//   iOS Jetsam foreground kill threshold: ~1.5–1.8 GB (iPhone 12, 4 GB RAM)
//   This buffer is negligible. The dangerous allocation is the Hermes heap
//   during bulk sync (observed OOM at heapSize = 910,163,968 bytes, v3 §2.2).
// =============================================================================

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <mutex>
#include <queue>
#include <vector>

namespace CoreElite {

// ---------------------------------------------------------------------------
// Capacity constants
// ---------------------------------------------------------------------------

// Maximum events held before overflow-drop. At combine scale (0.2 Hz per
// station), a burst of 1,000 events is physically impossible — this ceiling
// exists only as a hard memory guard against pathological code paths.
static constexpr size_t kMaxQueueDepth    = 1000;

// Freelap FxChip BLE notification: ~30–50 bytes (v1 §1.2.2).
// 64 bytes gives headroom for any future Dashr or multi-gate packet formats.
static constexpr size_t kRawBytesCapacity = 64;

// Peripheral identifier: "FREELAP_A1B2C3" or "DASHR_001" — 31 chars + NUL.
static constexpr size_t kChipIdCapacity   = 32;

// ---------------------------------------------------------------------------
// TimingEvent
//
// Plain data struct — no vtable, no heap allocation, trivially copyable.
// Kept to exactly one cache line pair (112 bytes) for predictable layout.
// ---------------------------------------------------------------------------
struct TimingEvent {
    // Hardware monotonic timestamp captured as the FIRST statement in the
    // CoreBluetooth delegate (iOS: clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW))
    // or the BluetoothGattCallback (Android: SystemClock.uptimeNanos() via JNI).
    //
    // NEVER use Date.now() or performance.now() — both are JS-layer clocks
    // subject to GC scheduling jitter (v3 §1.4.1). A Hermes GC pause will
    // cluster all timestamps to ~0 ms delta even when gate crossings were
    // 100 ms apart (v3 §1.4.2, Mode 1).
    uint64_t monotonic_ns;

    // Raw BLE characteristic value, zero-padded to kRawBytesCapacity.
    // Decoding (centiseconds → seconds) is deferred to the JS layer after
    // the timing-critical path is clear.
    uint8_t  raw_bytes[kRawBytesCapacity];

    // Actual bytes received in this notification (≤ kRawBytesCapacity).
    size_t   byte_count;

    // Null-terminated peripheral identifier copied from CBPeripheral.name
    // (iOS) or BluetoothDevice.getName() (Android).
    char     chip_id[kChipIdCapacity];
};

// Compile-time memory budget assertion.
// sizeof(TimingEvent) = 8 + 64 + 8 + 32 = 112 bytes.
static_assert(sizeof(TimingEvent) <= 128,
    "TimingEvent exceeds 128-byte budget — check struct layout");

static_assert(kMaxQueueDepth * sizeof(TimingEvent) <= 128 * 1024,
    "BLETimingBuffer max footprint exceeds 128 KB — revise kMaxQueueDepth");

// ---------------------------------------------------------------------------
// BLETimingBuffer
//
// Thread-safety contract:
//   enqueue() — called exclusively from the BLE native thread
//               (CoreBluetooth dispatch queue / Gatt callback thread).
//               Must NEVER block longer than the mutex acquisition.
//
//   flush()   — called exclusively from the JS thread, dispatched via
//               CallInvoker::invokeAsync() (iOS) or
//               ReactContext.runOnJSQueueThread() (Android).
//               Drains the entire queue atomically.
//
// The BLE thread MUST NOT call any JSI function directly.
// jsi::Function::call() from a non-JS thread causes EXC_BAD_ACCESS (v3 §1.4.2).
// ---------------------------------------------------------------------------
class BLETimingBuffer {
public:
    BLETimingBuffer()  = default;
    ~BLETimingBuffer() = default;

    // Non-copyable, non-movable: owns the mutex and the queue state.
    BLETimingBuffer(const BLETimingBuffer&)            = delete;
    BLETimingBuffer& operator=(const BLETimingBuffer&) = delete;
    BLETimingBuffer(BLETimingBuffer&&)                 = delete;
    BLETimingBuffer& operator=(BLETimingBuffer&&)      = delete;

    // Enqueue a timing event from the BLE native thread.
    // Returns true on success, false if the queue is at kMaxQueueDepth
    // (overflow-drop — caller logs the drop and continues; never blocks).
    bool enqueue(const TimingEvent& event);

    // Atomically drain all pending events from the JS thread.
    // Returns a vector of events in arrival order. The internal queue is
    // empty after this call. Returns an empty vector if nothing is pending.
    std::vector<TimingEvent> flush();

    // Current queue depth. For telemetry / debug only — not for control flow.
    size_t size() const;

    // True iff no events are pending.
    bool empty() const;

private:
    mutable std::mutex       mutex_;
    std::queue<TimingEvent>  queue_;
};

} // namespace CoreElite
