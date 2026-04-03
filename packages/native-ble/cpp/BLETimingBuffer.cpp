// =============================================================================
// BLETimingBuffer.cpp
// Core Elite — Phase 1: Silicon-to-Software Optimization
// =============================================================================

#include "BLETimingBuffer.h"

namespace CoreElite {

bool BLETimingBuffer::enqueue(const TimingEvent& event) {
    std::lock_guard<std::mutex> lock(mutex_);

    if (queue_.size() >= kMaxQueueDepth) {
        // Overflow-drop: return false so the caller can log the event.
        // We never block the BLE delegate thread — a blocked delegate thread
        // causes missed gate crossings, which is worse than a dropped event.
        //
        // At combine scale this path is unreachable:
        //   max throughput = 4 athletes/min × 3 stations = 0.2 Hz per station
        //   Time to fill 1,000 slots at 0.2 Hz = 5,000 seconds (~83 minutes)
        //   flush() is called after every single enqueue, draining to 0 each time.
        return false;
    }

    queue_.push(event);
    return true;
}

std::vector<TimingEvent> BLETimingBuffer::flush() {
    std::lock_guard<std::mutex> lock(mutex_);

    std::vector<TimingEvent> result;
    result.reserve(queue_.size());

    while (!queue_.empty()) {
        result.push_back(queue_.front());
        queue_.pop();
    }

    return result; // NRVO — no copy on return
}

size_t BLETimingBuffer::size() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return queue_.size();
}

bool BLETimingBuffer::empty() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return queue_.empty();
}

} // namespace CoreElite
