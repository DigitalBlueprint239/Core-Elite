// =============================================================================
// BLETimingModule.kt
// Core Elite — Phase 2: RF Adaptation + Inter-Device Clock Sync (Android)
//
// Extensions over Phase 1:
//   1. Continuous RSSI monitoring (1s poll via readRemoteRssi)
//   2. RF adaptation state machine (Normal → Degrading → PHYCoded → Critical → Fallback)
//   3. PHY management: Android BluetoothGatt.setPreferredPhy() (API 26+) enables
//      TRUE mid-connection PHY switching — no disconnect/reconnect required.
//      This is the key advantage over iOS which must disconnect + reconnect.
//   4. Inter-device clock sync: dual-role operation —
//        a. GATT Client: connects to peer sync services (existing connection path)
//        b. GATT Server: advertises CoreElite Sync Service, receives PINGs, sends PONGs
//   5. Clock offset applied to all timing event packets before JS emission
//   6. Fallback: when signal is unrecoverable, emits onFallbackRequired —
//      JS shows manual entry UI; BLE timing path is disabled until reset
//
// JS-visible events (additions to Phase 1):
//   "onRSSIUpdate"        — smoothed RSSI per connected peripheral
//   "onRFAdaptation"      — RF adaptation state change
//   "onClockSyncUpdate"   — new offset estimate + rtt + sampleCount
//   "onSignalDegraded"    — smoothed RSSI below threshold; PHY switch initiated
//   "onFallbackRequired"  — signal unrecoverable; JS must show manual entry
//   "onFallbackCleared"   — signal recovered; BLE timing re-enabled
//
// Monotonic clock: SystemClock.uptimeNanos()
//   - Does NOT include deep-sleep time (analogous to CLOCK_MONOTONIC_RAW on iOS)
//   - Not adjusted by NTP
//   - Nanosecond resolution
// =============================================================================

package com.coreelite.ble

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.os.SystemClock
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Collections
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

// ---------------------------------------------------------------------------
// Timing chip service UUIDs — replace with vendor-confirmed values.
// ---------------------------------------------------------------------------
private val FREELAP_SERVICE_UUID = UUID.fromString("XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX")
private val FREELAP_TIMING_CHAR  = UUID.fromString("XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX")
private val DASHR_SERVICE_UUID   = UUID.fromString("YYYYYYYY-YYYY-YYYY-YYYY-YYYYYYYYYYYY")
private val DASHR_TIMING_CHAR    = UUID.fromString("YYYYYYYY-YYYY-YYYY-YYYY-YYYYYYYYYYYY")

// ---------------------------------------------------------------------------
// CoreElite Sync GATT Service UUIDs (matches iOS constants)
// ---------------------------------------------------------------------------
private val CE_SYNC_SERVICE_UUID      = UUID.fromString("CE515000-0001-4000-B000-000000000001")
private val CE_SYNC_CHAR_WRITE_UUID   = UUID.fromString("CE515000-0001-4000-B000-000000000002")
private val CE_SYNC_CHAR_NOTIFY_UUID  = UUID.fromString("CE515000-0001-4000-B000-000000000003")

// Standard CCCD descriptor UUID for enabling notifications
private val CLIENT_CHAR_CONFIG_UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

private const val MAX_RECONNECT_ATTEMPTS    = 5
private const val RECONNECT_BASE_DELAY_MS   = 2000L
private const val MAX_QUEUE_DEPTH           = 1000
private const val RAW_BYTES_CAPACITY        = 64
private const val RSSI_POLL_INTERVAL_MS     = 1000L
private const val SYNC_PING_INTERVAL_MS     = 30_000L
private const val SYNC_PING_JITTER_MS       = 10_000L  // uniform jitter 0..10s

// ---------------------------------------------------------------------------
// Wire-format packet data classes
// All multi-byte fields are little-endian, matching C++ __attribute__((packed)).
// ---------------------------------------------------------------------------

data class SyncPingPacket(
    val type: Byte      = 0x10,
    val flags: Byte     = 0x00,
    val reserved: Short = 0,
    val seq: Int        = 0,
    val t1Ns: Long      = 0L
) {
    fun toByteArray(): ByteArray =
        ByteBuffer.allocate(16).order(ByteOrder.LITTLE_ENDIAN)
            .put(type).put(flags).putShort(reserved).putInt(seq).putLong(t1Ns)
            .array()
}

data class SyncPongPacket(
    val type: Byte      = 0x11,
    val flags: Byte     = 0x00,
    val reserved: Short = 0,
    val seq: Int        = 0,
    val t2Ns: Long      = 0L,
    val t3Ns: Long      = 0L
) {
    fun toByteArray(): ByteArray =
        ByteBuffer.allocate(24).order(ByteOrder.LITTLE_ENDIAN)
            .put(type).put(flags).putShort(reserved).putInt(seq).putLong(t2Ns).putLong(t3Ns)
            .array()
}

private fun ByteArray.parseSyncPing(): SyncPingPacket? {
    if (size < 16) return null
    val buf = ByteBuffer.wrap(this).order(ByteOrder.LITTLE_ENDIAN)
    val type = buf.get()
    if (type != 0x10.toByte()) return null
    return SyncPingPacket(
        type = type, flags = buf.get(), reserved = buf.short,
        seq = buf.int, t1Ns = buf.long
    )
}

private fun ByteArray.parseSyncPong(): SyncPongPacket? {
    if (size < 24) return null
    val buf = ByteBuffer.wrap(this).order(ByteOrder.LITTLE_ENDIAN)
    val type = buf.get()
    if (type != 0x11.toByte()) return null
    return SyncPongPacket(
        type = type, flags = buf.get(), reserved = buf.short,
        seq = buf.int, t2Ns = buf.long, t3Ns = buf.long
    )
}

// ---------------------------------------------------------------------------
// TimingEvent — Kotlin data class mirroring C++ struct
// ---------------------------------------------------------------------------
data class TimingEvent(
    val monotonicNs: Long,
    val rawBytes: ByteArray,
    val byteCount: Int,
    val chipId: String,
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is TimingEvent) return false
        return monotonicNs == other.monotonicNs &&
               rawBytes.contentEquals(other.rawBytes) &&
               byteCount == other.byteCount &&
               chipId == other.chipId
    }
    override fun hashCode(): Int = monotonicNs.hashCode()
}

// ---------------------------------------------------------------------------
// RFAdaptationState — mirrors C++ enum class (string values match iOS emission)
// ---------------------------------------------------------------------------
enum class RFAdaptationState(val jsValue: String) {
    Normal("Normal"),
    Degrading("Degrading"),
    PHYDowngrading("PHYDowngrading"),
    PHYCoded("PHYCoded"),
    CriticalSignal("CriticalSignal"),
    FallbackActive("FallbackActive"),
}

// ---------------------------------------------------------------------------
// RSSIMonitor — Kotlin port of C++ RSSIMonitor
//
// Exponential moving average (α=0.3) of RSSI readings.
// State machine with hysteresis prevents rapid oscillation.
// Thread-safe via @Synchronized.
// ---------------------------------------------------------------------------
class RSSIMonitor {
    companion object {
        const val ALPHA                = 0.3f
        const val RSSI_DOWNGRADE_DBM   = -85
        const val RSSI_RECOVERY_DBM    = -75
        const val RSSI_TRIGGER_COUNT   = 5
        const val CRITICAL_RUN_COUNT   = RSSI_TRIGGER_COUNT * 2
    }

    private var smoothed           = 0.0f
    private var hasFirstReading    = false
    private var subThresholdRuns   = 0
    private var aboveRecoveryRuns  = 0
    private var state              = RFAdaptationState.Normal

    @Synchronized
    fun addReading(rssi: Int): RFAdaptationState {
        if (!hasFirstReading) {
            smoothed = rssi.toFloat()
            hasFirstReading = true
        } else {
            smoothed = ALPHA * rssi + (1.0f - ALPHA) * smoothed
        }

        val smoothedInt = smoothed.toInt()

        when {
            smoothedInt < RSSI_DOWNGRADE_DBM -> { ++subThresholdRuns; aboveRecoveryRuns = 0 }
            smoothedInt > RSSI_RECOVERY_DBM  -> { ++aboveRecoveryRuns; subThresholdRuns = 0 }
            else                             -> { subThresholdRuns = 0; aboveRecoveryRuns = 0 }
        }

        when (state) {
            RFAdaptationState.Normal -> {
                if (subThresholdRuns >= RSSI_TRIGGER_COUNT) {
                    state = RFAdaptationState.Degrading
                    subThresholdRuns = 0
                }
            }
            RFAdaptationState.Degrading -> {
                if (aboveRecoveryRuns >= RSSI_TRIGGER_COUNT) {
                    state = RFAdaptationState.Normal
                    aboveRecoveryRuns = 0
                }
            }
            RFAdaptationState.PHYDowngrading -> { /* waiting for onPhyUpdate callback */ }
            RFAdaptationState.PHYCoded -> {
                if (aboveRecoveryRuns >= RSSI_TRIGGER_COUNT) {
                    state = RFAdaptationState.Normal
                    aboveRecoveryRuns = 0
                } else if (subThresholdRuns >= CRITICAL_RUN_COUNT) {
                    state = RFAdaptationState.CriticalSignal
                    subThresholdRuns = 0
                }
            }
            RFAdaptationState.CriticalSignal -> { /* operator intervention required */ }
            RFAdaptationState.FallbackActive -> { /* terminal — reset() required */ }
        }

        return state
    }

    @get:Synchronized val smoothedRssi: Float get() = smoothed
    @get:Synchronized val currentState: RFAdaptationState get() = state
    @get:Synchronized val shouldDowngradePHY: Boolean get() = state == RFAdaptationState.Degrading
    @get:Synchronized val shouldTriggerFallback: Boolean
        get() = state == RFAdaptationState.CriticalSignal || state == RFAdaptationState.FallbackActive

    @Synchronized fun notifyPHYDowngraded() {
        state = RFAdaptationState.PHYCoded; subThresholdRuns = 0; aboveRecoveryRuns = 0
    }
    @Synchronized fun notifyPHYUpgraded() {
        state = RFAdaptationState.Normal; subThresholdRuns = 0; aboveRecoveryRuns = 0
    }
    @Synchronized fun notifyFallbackActive() { state = RFAdaptationState.FallbackActive }
    @Synchronized fun reset() {
        state = RFAdaptationState.Normal
        subThresholdRuns = 0; aboveRecoveryRuns = 0; hasFirstReading = false; smoothed = 0.0f
    }
}

// ---------------------------------------------------------------------------
// ClockSyncEngine — Kotlin port of C++ ClockSyncEngine
//
// Thread-safety: @Synchronized on all public methods.
// offsetNs / synced / missedPings use atomics for lock-free reads in applyOffset().
//
// Note: Kotlin Long is signed 64-bit, equivalent to C++ int64_t / uint64_t for
// nanosecond timestamps within a session. Overflow at ~292 years of uptime.
// ---------------------------------------------------------------------------
class ClockSyncEngine {
    companion object {
        const val MAX_DRIFT_NS             = 1_440_000L        // 1.44ms
        const val SYNC_SAMPLE_WINDOW       = 7
        const val PENDING_PING_SLOTS       = 8
        const val MISSED_PING_LIMIT        = 3
        const val OUTLIER_THRESHOLD_NS     = 500_000_000L      // 500ms
    }

    private data class SyncSample(
        val t1Ns: Long = 0L, val t2Ns: Long = 0L,
        val t3Ns: Long = 0L, val t4Ns: Long = 0L,
        val offsetNs: Long = 0L, val rttNs: Long = 0L,
        val valid: Boolean = false
    )

    private data class PendingPing(
        val seq: Int = 0, val t1Ns: Long = 0L, val active: Boolean = false
    )

    private val samples      = Array(SYNC_SAMPLE_WINDOW) { SyncSample() }
    private var sampleHead   = 0
    private var sampleCount  = 0
    private val pendingPings = Array(PENDING_PING_SLOTS) { PendingPing() }
    private var nextSeq      = 0

    // Atomics for lock-free reads in applyOffset()
    private val offsetNs    = AtomicLong(0L)
    private val synced      = AtomicBoolean(false)
    private val missedPings = AtomicInteger(0)

    // -------------------------------------------------------------------------
    // SLAVE side
    // -------------------------------------------------------------------------

    @Synchronized
    fun buildPing(): SyncPingPacket {
        val seq   = nextSeq++
        val t1Ns  = SystemClock.uptimeNanos()
        val slot  = seq % PENDING_PING_SLOTS
        pendingPings[slot] = PendingPing(seq, t1Ns, true)

        val flags = if (missedPings.get() > 0) 0x01.toByte() else 0x00.toByte()
        return SyncPingPacket(type = 0x10, flags = flags, seq = seq, t1Ns = t1Ns)
    }

    @Synchronized
    fun processPong(pong: SyncPongPacket, t4Ns: Long): Boolean {
        if (pong.type != 0x11.toByte()) return false

        val slot    = pong.seq % PENDING_PING_SLOTS
        val pending = pendingPings[slot]
        if (!pending.active || pending.seq != pong.seq) return false

        val t1Ns = pending.t1Ns
        pendingPings[slot] = PendingPing()  // consume slot

        val t2Ns = pong.t2Ns
        val t3Ns = pong.t3Ns

        // Sanity: reject zero timestamps (master failed to populate)
        if (t2Ns == 0L || t3Ns == 0L) return false
        // T3 ≥ T2 (master monotonic)
        if (t3Ns < t2Ns) return false
        // T4 ≥ T1 (slave monotonic)
        if (t4Ns < t1Ns) return false

        val totalElapsedNs = t4Ns - t1Ns
        val masterProcNs   = t3Ns - t2Ns
        if (masterProcNs > totalElapsedNs) return false

        val rttNs    = totalElapsedNs - masterProcNs
        val offsetNs = ((t2Ns - t1Ns) + (t3Ns - t4Ns)) / 2

        // Reject outliers: |offset| > 500ms is physically implausible same-venue
        if (offsetNs > OUTLIER_THRESHOLD_NS || offsetNs < -OUTLIER_THRESHOLD_NS) return false

        samples[sampleHead % SYNC_SAMPLE_WINDOW] =
            SyncSample(t1Ns, t2Ns, t3Ns, t4Ns, offsetNs, rttNs, true)
        sampleHead = (sampleHead + 1) % SYNC_SAMPLE_WINDOW
        if (sampleCount < SYNC_SAMPLE_WINDOW) ++sampleCount

        val median = computeMedianOffset()
        this.offsetNs.set(median)
        synced.set(true)
        missedPings.set(0)

        return true
    }

    // -------------------------------------------------------------------------
    // MASTER side
    // -------------------------------------------------------------------------

    @Synchronized
    fun buildPong(ping: SyncPingPacket, t2Ns: Long): SyncPongPacket {
        // T3 captured AFTER mutex acquisition — delta (T3-T2) is master processing
        // time and is subtracted by the slave formula, so including mutex time is correct.
        val flags = if (!synced.get()) 0x01.toByte() else 0x00.toByte()
        return SyncPongPacket(
            type = 0x11, flags = flags, seq = ping.seq,
            t2Ns = t2Ns, t3Ns = SystemClock.uptimeNanos()
        )
    }

    // -------------------------------------------------------------------------
    // Common
    // -------------------------------------------------------------------------

    /** Lock-free: safe from timing hot path. */
    fun applyOffset(rawNs: Long): Long {
        if (!synced.get()) return rawNs
        return rawNs + offsetNs.get()
    }

    fun currentOffsetNs(): Long = offsetNs.get()

    fun isSynced(): Boolean {
        if (!synced.get()) return false
        return Math.abs(offsetNs.get()) <= MAX_DRIFT_NS
    }

    fun isDesynced(): Boolean = missedPings.get() >= MISSED_PING_LIMIT

    fun recordMissedPing() {
        if (missedPings.incrementAndGet() >= MISSED_PING_LIMIT) {
            synced.set(false)
        }
    }

    fun resetMissedPings() = missedPings.set(0)

    fun markDesynced() {
        synced.set(false)
        missedPings.set(MISSED_PING_LIMIT)
    }

    @get:Synchronized val sampleCountValue: Int get() = sampleCount

    // Caller holds synchronized lock
    private fun computeMedianOffset(): Long {
        if (sampleCount == 0) return 0L
        val offsets = (0 until sampleCount)
            .map { samples[it] }
            .filter { it.valid }
            .map { it.offsetNs }
            .sorted()
        return if (offsets.isEmpty()) 0L else offsets[offsets.size / 2]
    }
}

// =============================================================================
// BLETimingModule — Phase 1 + Phase 2
// =============================================================================
class BLETimingModule(
    private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "CoreEliteBLE"

    // -------------------------------------------------------------------------
    // Timing event queue (Phase 1)
    // -------------------------------------------------------------------------
    private val timingQueue = ConcurrentLinkedQueue<TimingEvent>()

    private val bluetoothManager: BluetoothManager =
        reactContext.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
    private val bluetoothAdapter: BluetoothAdapter = bluetoothManager.adapter

    // Timing chip connections
    private val timingGatts = ConcurrentHashMap<String, BluetoothGatt>()
    // Sync peer connections (we connect to their sync service as slave)
    private val syncPeerGatts = ConcurrentHashMap<String, BluetoothGatt>()
    // Sync peer write chars (for sending PINGs)
    private val syncPeerWriteChars = ConcurrentHashMap<String, BluetoothGattCharacteristic>()

    private val reconnectAttempts = AtomicInteger(0)
    private val mainHandler       = Handler(Looper.getMainLooper())
    private var scanNamePrefix: String? = null
    private var listenerCount     = 0

    // -------------------------------------------------------------------------
    // Phase 2 state
    // -------------------------------------------------------------------------
    private val clockSync    = ClockSyncEngine()
    // Per-device RSSI monitors (one per timing chip address)
    private val rssiMonitors = ConcurrentHashMap<String, RSSIMonitor>()

    private var nodeId: String? = null
    private var isFallbackActive = false

    // GATT Server (peripheral / master role)
    private var gattServer: BluetoothGattServer? = null
    private var syncNotifyChar: BluetoothGattCharacteristic? = null
    private val subscribedCentrals: MutableSet<BluetoothDevice> =
        Collections.synchronizedSet(mutableSetOf())

    // Periodic timers
    private val rssiHandler  = Handler(Looper.getMainLooper())
    private val syncHandler  = Handler(Looper.getMainLooper())

    private val rssiRunnable = object : Runnable {
        override fun run() {
            // Poll RSSI for all connected timing chips
            timingGatts.values.forEach { it.readRemoteRssi() }
            rssiHandler.postDelayed(this, RSSI_POLL_INTERVAL_MS)
        }
    }

    private val syncPingRunnable = object : Runnable {
        override fun run() {
            sendClockSyncPingToAllPeers()
            // 30s base interval + 0..10s jitter avoids synchronized mesh pings
            val jitter = (Math.random() * SYNC_PING_JITTER_MS).toLong()
            syncHandler.postDelayed(this, SYNC_PING_INTERVAL_MS + jitter)
        }
    }

    // -------------------------------------------------------------------------
    // JS-exported methods (Phase 1)
    // -------------------------------------------------------------------------

    @ReactMethod
    fun startScan(namePrefix: String) {
        scanNamePrefix = namePrefix
        reconnectAttempts.set(0)
        startScanInternal()
    }

    @ReactMethod
    fun stopScan() {
        bluetoothAdapter.bluetoothLeScanner?.stopScan(scanCallback)
    }

    @ReactMethod
    fun disconnectAll() {
        bluetoothAdapter.bluetoothLeScanner?.stopScan(scanCallback)
        timingGatts.values.forEach { it.disconnect(); it.close() }
        timingGatts.clear()
        syncPeerGatts.values.forEach { it.disconnect(); it.close() }
        syncPeerGatts.clear()
        syncPeerWriteChars.clear()
        rssiHandler.removeCallbacks(rssiRunnable)
    }

    @ReactMethod
    fun flushBuffer() {
        flushQueueToJS()
    }

    // -------------------------------------------------------------------------
    // JS-exported methods (Phase 2)
    // -------------------------------------------------------------------------

    /**
     * Start the CoreElite Sync GATT server and begin advertising.
     * nodeId: this device's identifier; used for master election (lowest wins).
     */
    @ReactMethod
    fun startSyncService(nId: String) {
        nodeId = nId
        openGattServer()
        startAdvertising()
        rssiHandler.post(rssiRunnable)
    }

    @ReactMethod
    fun stopSyncService() {
        bluetoothAdapter.bluetoothLeAdvertiser?.stopAdvertising(advertiseCallback)
        gattServer?.close()
        gattServer = null
        subscribedCentrals.clear()
        rssiHandler.removeCallbacks(rssiRunnable)
        syncHandler.removeCallbacks(syncPingRunnable)
    }

    @ReactMethod
    fun triggerClockSync() {
        sendClockSyncPingToAllPeers()
    }

    @ReactMethod
    fun resetFallback() {
        isFallbackActive = false
        rssiMonitors.values.forEach { it.reset() }
        clockSync.resetMissedPings()
        // Restart RSSI polling and sync timers
        rssiHandler.removeCallbacks(rssiRunnable)
        rssiHandler.post(rssiRunnable)
        syncHandler.removeCallbacks(syncPingRunnable)
        syncHandler.post(syncPingRunnable)
        sendEvent("onFallbackCleared", Arguments.createMap())
    }

    @ReactMethod
    fun addListener(eventName: String) { listenerCount++ }

    @ReactMethod
    fun removeListeners(count: Int) { listenerCount = maxOf(0, listenerCount - count) }

    // -------------------------------------------------------------------------
    // BLE scan
    // -------------------------------------------------------------------------

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            val device = result.device

            // Check if this is a sync peer (advertises CoreElite sync service)
            val serviceUuids = result.scanRecord?.serviceUuids
            if (serviceUuids?.contains(ParcelUuid(CE_SYNC_SERVICE_UUID)) == true) {
                val address = device.address
                if (!syncPeerGatts.containsKey(address)) {
                    device.connectGatt(reactContext, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
                }
                return
            }

            // Otherwise check for timing chip by name prefix
            val name   = device.name ?: return
            val prefix = scanNamePrefix ?: return
            if (!name.startsWith(prefix)) return

            bluetoothAdapter.bluetoothLeScanner?.stopScan(this)
            device.connectGatt(reactContext, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
        }

        override fun onScanFailed(errorCode: Int) {
            sendEvent("onScanError", Arguments.createMap().apply {
                putInt("errorCode", errorCode)
                putString("message", "BLE scan failed with code $errorCode")
            })
        }
    }

    private fun startScanInternal() {
        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .build()
        // Scan without filters to discover both timing chips and sync peers.
        // Differentiation happens in onScanResult.
        bluetoothAdapter.bluetoothLeScanner?.startScan(null, settings, scanCallback)
    }

    // -------------------------------------------------------------------------
    // BluetoothGattCallback — shared for both timing chips and sync peers
    // -------------------------------------------------------------------------

    private val gattCallback = object : BluetoothGattCallback() {

        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            val address = gatt.device.address
            when (newState) {
                BluetoothProfile.STATE_CONNECTED -> {
                    reconnectAttempts.set(0)
                    sendEvent("onDeviceConnected", Arguments.createMap().apply {
                        putString("address", address)
                        putString("name", gatt.device.name ?: "unknown")
                    })
                    gatt.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH)
                    gatt.discoverServices()
                }
                BluetoothProfile.STATE_DISCONNECTED -> {
                    val wasTimingChip = timingGatts.remove(address) != null
                    val wasSyncPeer   = syncPeerGatts.remove(address) != null
                    syncPeerWriteChars.remove(address)
                    rssiMonitors.remove(address)

                    if (!isFallbackActive) {
                        clockSync.markDesynced()
                    }

                    sendEvent("onDeviceDisconnected", Arguments.createMap().apply {
                        putString("address", address)
                        putString("name", gatt.device.name ?: "unknown")
                        putInt("status", status)
                    })

                    if (wasTimingChip) scheduleReconnect(gatt.device)
                    // Sync peers: rescan will rediscover them
                }
            }
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            if (status != BluetoothGatt.GATT_SUCCESS) return
            val address = gatt.device.address

            // Sync peer: has CE sync service
            val syncService = gatt.getService(CE_SYNC_SERVICE_UUID)
            if (syncService != null) {
                syncPeerGatts[address] = gatt
                // Subscribe to PONG notifications
                val pongChar = syncService.getCharacteristic(CE_SYNC_CHAR_NOTIFY_UUID)
                if (pongChar != null) {
                    gatt.setCharacteristicNotification(pongChar, true)
                    pongChar.getDescriptor(CLIENT_CHAR_CONFIG_UUID)?.let { cccd ->
                        @Suppress("DEPRECATION")
                        cccd.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                        @Suppress("DEPRECATION")
                        gatt.writeDescriptor(cccd)
                    }
                }
                // Store write char for sending PINGs
                val writeChar = syncService.getCharacteristic(CE_SYNC_CHAR_WRITE_UUID)
                if (writeChar != null) {
                    syncPeerWriteChars[address] = writeChar
                }
                // Start sync ping timer if not already running
                syncHandler.removeCallbacks(syncPingRunnable)
                syncHandler.post(syncPingRunnable)
                return
            }

            // Timing chip: subscribe to timing characteristics
            timingGatts[address] = gatt
            rssiMonitors[address] = RSSIMonitor()

            val targetChars = listOf(
                gatt.getService(FREELAP_SERVICE_UUID)?.getCharacteristic(FREELAP_TIMING_CHAR),
                gatt.getService(DASHR_SERVICE_UUID)?.getCharacteristic(DASHR_TIMING_CHAR),
            ).filterNotNull()

            for (char in targetChars) {
                gatt.setCharacteristicNotification(char, true)
                char.getDescriptor(CLIENT_CHAR_CONFIG_UUID)?.let { descriptor ->
                    @Suppress("DEPRECATION")
                    descriptor.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                    @Suppress("DEPRECATION")
                    gatt.writeDescriptor(descriptor)
                }
            }
        }

        // =================================================================
        // RSSI read result
        // =================================================================
        override fun onReadRemoteRssi(gatt: BluetoothGatt, rssi: Int, status: Int) {
            if (status != BluetoothGatt.GATT_SUCCESS) return
            if (isFallbackActive) return

            val address = gatt.device.address
            val monitor = rssiMonitors[address] ?: return

            val newState = monitor.addReading(rssi)
            val smoothed = monitor.smoothedRssi

            sendEvent("onRSSIUpdate", Arguments.createMap().apply {
                putString("address", address)
                putDouble("rssi", rssi.toDouble())
                putDouble("smoothedRssi", smoothed.toDouble())
            })

            when (newState) {
                RFAdaptationState.Degrading -> {
                    sendEvent("onSignalDegraded", Arguments.createMap().apply {
                        putString("address", address)
                        putDouble("rssi", smoothed.toDouble())
                    })
                    initiatePhyDowngrade(gatt, monitor)
                }
                RFAdaptationState.CriticalSignal,
                RFAdaptationState.FallbackActive -> {
                    if (!isFallbackActive) triggerFallback(address, "signal_critical")
                }
                else -> {
                    // Emit state change for all transitions so JS can track
                    sendEvent("onRFAdaptation", Arguments.createMap().apply {
                        putString("address", address)
                        putString("state", newState.jsValue)
                    })
                }
            }
        }

        // =================================================================
        // PHY update result — fires after setPreferredPhy() negotiation
        // =================================================================
        override fun onPhyUpdate(gatt: BluetoothGatt, txPhy: Int, rxPhy: Int, status: Int) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val address = gatt.device.address
            val monitor = rssiMonitors[address] ?: return

            if (status != BluetoothGatt.GATT_SUCCESS) {
                // PHY negotiation failed — stay in current state, fallback will
                // trigger naturally if RSSI continues to degrade.
                return
            }

            val isCodedPhy = (txPhy == BluetoothDevice.PHY_LE_CODED && rxPhy == BluetoothDevice.PHY_LE_CODED)

            if (isCodedPhy) {
                monitor.notifyPHYDowngraded()
                sendEvent("onRFAdaptation", Arguments.createMap().apply {
                    putString("address", address)
                    putString("state", RFAdaptationState.PHYCoded.jsValue)
                    putString("phy", "coded_125k")
                })
            } else {
                monitor.notifyPHYUpgraded()
                sendEvent("onRFAdaptation", Arguments.createMap().apply {
                    putString("address", address)
                    putString("state", RFAdaptationState.Normal.jsValue)
                    putString("phy", "1m")
                })
            }
        }

        // =================================================================
        // THE CRITICAL PATH — timestamp capture
        // =================================================================

        // API 33+ path
        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray
        ) {
            // =========================================================
            // TIMESTAMP CAPTURE: FIRST STATEMENT — DO NOT REORDER
            // =========================================================
            val monotonicNs: Long = SystemClock.uptimeNanos()
            // =========================================================

            when (characteristic.uuid) {
                CE_SYNC_CHAR_NOTIFY_UUID -> handleSyncPong(value, monotonicNs)
                FREELAP_TIMING_CHAR,
                DASHR_TIMING_CHAR        -> handleTimingEvent(monotonicNs, value, gatt)
                else -> { /* unknown characteristic — ignore */ }
            }
        }

        @Suppress("DEPRECATION")
        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic
        ) {
            // =========================================================
            // TIMESTAMP CAPTURE: FIRST STATEMENT — DO NOT REORDER
            // =========================================================
            val monotonicNs: Long = SystemClock.uptimeNanos()
            // =========================================================

            @Suppress("DEPRECATION")
            val value = characteristic.value ?: return

            when (characteristic.uuid) {
                CE_SYNC_CHAR_NOTIFY_UUID -> handleSyncPong(value, monotonicNs)
                FREELAP_TIMING_CHAR,
                DASHR_TIMING_CHAR        -> handleTimingEvent(monotonicNs, value, gatt)
                else -> { /* unknown characteristic — ignore */ }
            }
        }
    }

    // -------------------------------------------------------------------------
    // PHY downgrade — Android advantage: true mid-connection switch (API 26+)
    // No disconnect/reconnect required unlike iOS.
    // -------------------------------------------------------------------------

    private fun initiatePhyDowngrade(gatt: BluetoothGatt, monitor: RSSIMonitor) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            // API < 26: no PHY control — skip directly to fallback assessment
            return
        }
        monitor.let {
            // State transitions to PHYDowngrading to prevent re-entry
            // (addReading will return Degrading again on next reading — we check
            // shouldDowngradePHY which is only true in Degrading state)
        }
        // PHY_OPTION_S8 = 125 kbps (maximum range, lowest throughput)
        @Suppress("NewApi")
        gatt.setPreferredPhy(
            BluetoothDevice.PHY_LE_CODED,
            BluetoothDevice.PHY_LE_CODED,
            BluetoothDevice.PHY_OPTION_S8
        )
        // State transition happens in onPhyUpdate callback
    }

    // -------------------------------------------------------------------------
    // Fallback — disables BLE timing, signals JS to show manual entry
    // -------------------------------------------------------------------------

    private fun triggerFallback(address: String, reason: String) {
        isFallbackActive = true
        rssiMonitors[address]?.notifyFallbackActive()
        clockSync.markDesynced()
        rssiHandler.removeCallbacks(rssiRunnable)
        syncHandler.removeCallbacks(syncPingRunnable)

        sendEvent("onFallbackRequired", Arguments.createMap().apply {
            putString("address", address)
            putString("reason", reason)
        })
    }

    // -------------------------------------------------------------------------
    // Timing event handling
    // -------------------------------------------------------------------------

    private fun handleTimingEvent(monotonicNs: Long, value: ByteArray, gatt: BluetoothGatt) {
        if (isFallbackActive) return
        if (value.isEmpty()) return

        val chipId = gatt.device.name ?: gatt.device.address

        // Apply clock sync offset to raw timestamp
        val correctedNs = clockSync.applyOffset(monotonicNs)

        val byteCount = minOf(value.size, RAW_BYTES_CAPACITY)
        val rawBytes  = value.copyOf(byteCount)

        val event = TimingEvent(
            monotonicNs = correctedNs,
            rawBytes    = rawBytes,
            byteCount   = byteCount,
            chipId      = chipId,
        )

        if (timingQueue.size >= MAX_QUEUE_DEPTH) return
        timingQueue.offer(event)
        scheduleFlushToJS()
    }

    // -------------------------------------------------------------------------
    // Clock sync — slave side
    // -------------------------------------------------------------------------

    private fun handleSyncPong(value: ByteArray, t4Ns: Long) {
        val pong = value.parseSyncPong() ?: return

        val updated = clockSync.processPong(pong, t4Ns)
        if (updated) {
            clockSync.resetMissedPings()
            sendEvent("onClockSyncUpdate", Arguments.createMap().apply {
                putString("offsetNs", clockSync.currentOffsetNs().toString())
                putInt("sampleCount", clockSync.sampleCountValue)
                putBoolean("isSynced", clockSync.isSynced())
            })
        }
    }

    private fun sendClockSyncPingToAllPeers() {
        if (syncPeerGatts.isEmpty()) return

        for ((address, gatt) in syncPeerGatts) {
            val writeChar = syncPeerWriteChars[address] ?: continue
            val ping      = clockSync.buildPing()
            val bytes     = ping.toByteArray()

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                @Suppress("NewApi")
                gatt.writeCharacteristic(
                    writeChar,
                    bytes,
                    BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
                )
            } else {
                @Suppress("DEPRECATION")
                writeChar.value = bytes
                @Suppress("DEPRECATION")
                writeChar.writeType = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
                @Suppress("DEPRECATION")
                gatt.writeCharacteristic(writeChar)
            }
        }

        // Track missed pings — will be cleared in handleSyncPong on success
        mainHandler.postDelayed({
            if (!clockSync.isSynced()) {
                clockSync.recordMissedPing()
                if (clockSync.isDesynced() && !isFallbackActive) {
                    triggerFallback("sync", "clock_desync")
                }
            }
        }, 5_000L) // 5s timeout per ping
    }

    // -------------------------------------------------------------------------
    // GATT Server (master/responder role for sync)
    // -------------------------------------------------------------------------

    private fun openGattServer() {
        // Build the CCCD descriptor for the notify characteristic
        val cccd = BluetoothGattDescriptor(
            CLIENT_CHAR_CONFIG_UUID,
            BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE
        )

        // Write characteristic (receives PING from slaves)
        val writeChar = BluetoothGattCharacteristic(
            CE_SYNC_CHAR_WRITE_UUID,
            BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
            BluetoothGattCharacteristic.PERMISSION_WRITE
        )

        // Notify characteristic (sends PONG to slaves)
        val notifyChar = BluetoothGattCharacteristic(
            CE_SYNC_CHAR_NOTIFY_UUID,
            BluetoothGattCharacteristic.PROPERTY_NOTIFY,
            0 // notifications have no direct read/write permission
        )
        notifyChar.addDescriptor(cccd)

        val syncService = BluetoothGattService(
            CE_SYNC_SERVICE_UUID,
            BluetoothGattService.SERVICE_TYPE_PRIMARY
        ).apply {
            addCharacteristic(writeChar)
            addCharacteristic(notifyChar)
        }

        syncNotifyChar = notifyChar
        gattServer = bluetoothManager.openGattServer(reactContext, gattServerCallback)
        gattServer?.addService(syncService)
    }

    private val gattServerCallback = object : BluetoothGattServerCallback() {

        override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
            if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                subscribedCentrals.remove(device)
            }
        }

        override fun onDescriptorWriteRequest(
            device: BluetoothDevice, requestId: Int,
            descriptor: BluetoothGattDescriptor,
            preparedWrite: Boolean, responseNeeded: Boolean,
            offset: Int, value: ByteArray?
        ) {
            if (descriptor.uuid == CLIENT_CHAR_CONFIG_UUID) {
                if (value.contentEquals(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)) {
                    subscribedCentrals.add(device)
                } else {
                    subscribedCentrals.remove(device)
                }
            }
            if (responseNeeded) {
                gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
            }
        }

        override fun onCharacteristicWriteRequest(
            device: BluetoothDevice, requestId: Int,
            characteristic: BluetoothGattCharacteristic,
            preparedWrite: Boolean, responseNeeded: Boolean,
            offset: Int, value: ByteArray?
        ) {
            // =========================================================
            // T2 CAPTURE: FIRST STATEMENT — DO NOT REORDER
            // =========================================================
            val t2Ns: Long = SystemClock.uptimeNanos()
            // =========================================================

            if (responseNeeded) {
                gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
            }

            if (characteristic.uuid != CE_SYNC_CHAR_WRITE_UUID) return
            val bytes = value ?: return
            val ping  = bytes.parseSyncPing() ?: return
            val pong  = clockSync.buildPong(ping, t2Ns)
            sendPongToDevice(device, pong)
        }
    }

    private fun sendPongToDevice(device: BluetoothDevice, pong: SyncPongPacket) {
        val char = syncNotifyChar ?: return
        val bytes = pong.toByteArray()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            @Suppress("NewApi")
            gattServer?.notifyCharacteristicChanged(device, char, false, bytes)
        } else {
            @Suppress("DEPRECATION")
            char.value = bytes
            @Suppress("DEPRECATION")
            gattServer?.notifyCharacteristicChanged(device, char, false)
        }
    }

    // -------------------------------------------------------------------------
    // BLE advertising (makes this device discoverable as a sync service provider)
    // -------------------------------------------------------------------------

    private fun startAdvertising() {
        val advertiser = bluetoothAdapter.bluetoothLeAdvertiser ?: return

        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_BALANCED)
            .setConnectable(true)
            .setTimeout(0) // advertise indefinitely
            .build()

        val data = AdvertiseData.Builder()
            .addServiceUuid(ParcelUuid(CE_SYNC_SERVICE_UUID))
            .setIncludeDeviceName(false) // keep packet small
            .build()

        advertiser.startAdvertising(settings, data, advertiseCallback)
    }

    private val advertiseCallback = object : AdvertiseCallback() {
        override fun onStartFailure(errorCode: Int) {
            sendEvent("onScanError", Arguments.createMap().apply {
                putString("message", "Sync service advertising failed: $errorCode")
                putInt("errorCode", errorCode)
            })
        }
    }

    // -------------------------------------------------------------------------
    // Flush to JS (Phase 1 — unchanged)
    // -------------------------------------------------------------------------

    private fun scheduleFlushToJS() {
        if (listenerCount == 0) return
        reactContext.runOnJSQueueThread { flushQueueToJS() }
    }

    private fun flushQueueToJS() {
        if (timingQueue.isEmpty()) return

        val jsEvents: WritableArray = Arguments.createArray()
        while (timingQueue.isNotEmpty()) {
            val event = timingQueue.poll() ?: break
            jsEvents.pushMap(Arguments.createMap().apply {
                putString("monotonic_ns", event.monotonicNs.toString())
                putString("raw_hex", event.rawBytes.joinToString("") { "%02x".format(it) })
                putInt("byte_count", event.byteCount)
                putString("chip_id", event.chipId)
            })
        }
        sendEvent("onTimingEvent", Arguments.createMap().apply {
            putArray("events", jsEvents)
        })
    }

    // -------------------------------------------------------------------------
    // Reconnect — exponential backoff (Phase 1 — timing chips only)
    // -------------------------------------------------------------------------

    private fun scheduleReconnect(device: BluetoothDevice) {
        val attempt = reconnectAttempts.incrementAndGet()
        if (attempt > MAX_RECONNECT_ATTEMPTS) {
            sendEvent("onScanError", Arguments.createMap().apply {
                putString("message",
                    "Max reconnect attempts reached for ${device.name}. " +
                    "Falling back to manual entry mode.")
                putString("address", device.address)
            })
            return
        }
        val delayMs = RECONNECT_BASE_DELAY_MS * (1L shl (attempt - 1))
        mainHandler.postDelayed({
            device.connectGatt(reactContext, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
        }, delayMs)
    }

    // -------------------------------------------------------------------------
    // Event helper
    // -------------------------------------------------------------------------

    private fun sendEvent(eventName: String, params: WritableMap) {
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(eventName, params)
    }
}
