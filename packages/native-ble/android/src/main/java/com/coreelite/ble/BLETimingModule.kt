// =============================================================================
// BLETimingModule.kt
// Core Elite — Phase 1: Silicon-to-Software Optimization (Android)
//
// Android equivalent of CoreEliteBLEModule.mm.
//
// Monotonic clock: SystemClock.uptimeNanos()
//   - Nanosecond resolution
//   - Monotonic, not wall-clock — immune to NTP / carrier time adjustments
//   - Does NOT include deep-sleep time (analogous to CLOCK_MONOTONIC_RAW on iOS)
//   - Documented by Android: "suitable for measuring elapsed time within a session"
//
// Thread contract (mirrors C++ buffer spec):
//   - BluetoothGattCallback.onCharacteristicChanged() runs on the Gatt binder thread
//   - uptimeNanos() capture is FIRST statement — before any other processing
//   - Enqueue into ConcurrentLinkedQueue (non-blocking, lock-free)
//   - Flush to JS via ReactContext.runOnJSQueueThread() (Old Arch)
//     or JSI invoker (New Arch — TODO: wire when upgrading to TurboModule)
//
// Reconnect: exponential backoff, MAX_RECONNECT_ATTEMPTS = 5 (v1 §1.3.5)
// =============================================================================

package com.coreelite.ble

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicInteger

// ---------------------------------------------------------------------------
// Placeholder UUIDs — replace with vendor-confirmed values.
// Dashr has no public SDK (v1 Appendix A Known Unknown).
// ---------------------------------------------------------------------------
private val FREELAP_SERVICE_UUID   = UUID.fromString("XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX")
private val FREELAP_TIMING_CHAR    = UUID.fromString("XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX")
private val DASHR_SERVICE_UUID     = UUID.fromString("YYYYYYYY-YYYY-YYYY-YYYY-YYYYYYYYYYYY")
private val DASHR_TIMING_CHAR      = UUID.fromString("YYYYYYYY-YYYY-YYYY-YYYY-YYYYYYYYYYYY")

// Standard BLE descriptor for enabling notifications
private val CLIENT_CHAR_CONFIG_UUID =
    UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

private const val MAX_RECONNECT_ATTEMPTS = 5
private const val RECONNECT_BASE_DELAY_MS = 2000L
private const val MAX_QUEUE_DEPTH = 1000
private const val RAW_BYTES_CAPACITY = 64

// ---------------------------------------------------------------------------
// TimingEvent — Kotlin data class mirroring C++ struct
// ---------------------------------------------------------------------------
data class TimingEvent(
    val monotonicNs: Long,           // SystemClock.uptimeNanos() at callback entry
    val rawBytes: ByteArray,         // Raw BLE characteristic value
    val byteCount: Int,
    val chipId: String,              // BluetoothDevice.name or address
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
// BLETimingModule
// ---------------------------------------------------------------------------
class BLETimingModule(
    private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "CoreEliteBLE"

    // Lock-free queue — safe for single-producer (Gatt callback thread)
    // single-consumer (JS flush) pattern. Mirrors std::queue<TimingEvent>
    // + std::mutex from the C++ buffer, but uses Java's lock-free structure
    // which is more idiomatic on Android.
    private val timingQueue = ConcurrentLinkedQueue<TimingEvent>()

    private val bluetoothManager: BluetoothManager =
        reactContext.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
    private val bluetoothAdapter: BluetoothAdapter = bluetoothManager.adapter

    private val connectedGatts = mutableListOf<BluetoothGatt>()
    private val reconnectAttempts = AtomicInteger(0)
    private val mainHandler = Handler(Looper.getMainLooper())
    private var scanNamePrefix: String? = null
    private var listenerCount = 0

    // ---------------------------------------------------------------------------
    // JS-exported methods
    // ---------------------------------------------------------------------------

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
        connectedGatts.forEach { it.disconnect(); it.close() }
        connectedGatts.clear()
    }

    @ReactMethod
    fun flushBuffer() {
        flushQueueToJS()
    }

    // Required for RCTEventEmitter compatibility
    @ReactMethod
    fun addListener(eventName: String) { listenerCount++ }

    @ReactMethod
    fun removeListeners(count: Int) {
        listenerCount = maxOf(0, listenerCount - count)
    }

    // ---------------------------------------------------------------------------
    // BLE scan
    // ---------------------------------------------------------------------------

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            val device = result.device
            val name = device.name ?: return
            val prefix = scanNamePrefix ?: return

            if (!name.startsWith(prefix)) return

            bluetoothAdapter.bluetoothLeScanner?.stopScan(this)
            device.connectGatt(
                reactContext,
                /* autoConnect = */ false,
                gattCallback,
                BluetoothDevice.TRANSPORT_LE
            )
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
        bluetoothAdapter.bluetoothLeScanner?.startScan(null, settings, scanCallback)
    }

    // ---------------------------------------------------------------------------
    // BluetoothGattCallback
    // ---------------------------------------------------------------------------

    private val gattCallback = object : BluetoothGattCallback() {

        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            when (newState) {
                BluetoothProfile.STATE_CONNECTED -> {
                    reconnectAttempts.set(0)
                    connectedGatts.add(gatt)
                    sendEvent("onDeviceConnected", Arguments.createMap().apply {
                        putString("address", gatt.device.address)
                        putString("name", gatt.device.name ?: "unknown")
                    })
                    // Request higher priority connection for lower latency
                    gatt.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH)
                    gatt.discoverServices()
                }

                BluetoothProfile.STATE_DISCONNECTED -> {
                    connectedGatts.remove(gatt)
                    sendEvent("onDeviceDisconnected", Arguments.createMap().apply {
                        putString("address", gatt.device.address)
                        putString("name", gatt.device.name ?: "unknown")
                        putInt("status", status)
                    })
                    scheduleReconnect(gatt.device)
                }
            }
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            if (status != BluetoothGatt.GATT_SUCCESS) return

            val targetChars = listOf(
                gatt.getService(FREELAP_SERVICE_UUID)
                    ?.getCharacteristic(FREELAP_TIMING_CHAR),
                gatt.getService(DASHR_SERVICE_UUID)
                    ?.getCharacteristic(DASHR_TIMING_CHAR),
            ).filterNotNull()

            for (char in targetChars) {
                gatt.setCharacteristicNotification(char, true)
                val descriptor = char.getDescriptor(CLIENT_CHAR_CONFIG_UUID)
                descriptor?.let {
                    it.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                    gatt.writeDescriptor(it)
                }
            }
        }

        // =====================================================================
        // THE CRITICAL PATH — Android equivalent of v3 §1.4.3
        //
        // SystemClock.uptimeNanos() MUST be the first statement.
        // This is the Android CLOCK_MONOTONIC_RAW equivalent:
        //   - Does not include deep-sleep time
        //   - Not adjusted by NTP
        //   - Nanosecond resolution
        //   - Suitable for intra-session elapsed time measurement
        // =====================================================================
        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic
        ) {
            // =====================================================
            // TIMESTAMP CAPTURE: FIRST STATEMENT — DO NOT REORDER
            // =====================================================
            val monotonicNs: Long = SystemClock.uptimeNanos()
            // =====================================================

            val value = characteristic.value ?: return
            if (value.isEmpty()) return

            val chipId = gatt.device.name ?: gatt.device.address
            val byteCount = minOf(value.size, RAW_BYTES_CAPACITY)
            val rawBytes = value.copyOf(byteCount)

            val event = TimingEvent(
                monotonicNs = monotonicNs,
                rawBytes    = rawBytes,
                byteCount   = byteCount,
                chipId      = chipId,
            )

            // Non-blocking enqueue — ConcurrentLinkedQueue.offer() is O(1), lock-free.
            // Never blocks the Gatt callback thread.
            if (timingQueue.size >= MAX_QUEUE_DEPTH) {
                // Overflow-drop — same semantics as C++ BLETimingBuffer::enqueue()
                return
            }
            timingQueue.offer(event)

            // Flush to JS thread — equivalent to CallInvoker::invokeAsync()
            scheduleFlushToJS()
        }
    }

    // ---------------------------------------------------------------------------
    // Flush to JS thread
    // ---------------------------------------------------------------------------

    private fun scheduleFlushToJS() {
        if (listenerCount == 0) return

        reactContext.runOnJSQueueThread {
            flushQueueToJS()
        }
    }

    private fun flushQueueToJS() {
        if (timingQueue.isEmpty()) return

        val jsEvents: WritableArray = Arguments.createArray()

        // Drain the queue — drain all pending events atomically per flush call
        while (timingQueue.isNotEmpty()) {
            val event = timingQueue.poll() ?: break

            val jsEvent: WritableMap = Arguments.createMap().apply {
                // monotonic_ns as String to avoid JS IEEE-754 precision loss
                // on Long values > 2^53. TS layer parses with BigInt.
                putString("monotonic_ns", event.monotonicNs.toString())
                putString("raw_hex", event.rawBytes.joinToString("") {
                    "%02x".format(it)
                })
                putInt("byte_count", event.byteCount)
                putString("chip_id", event.chipId)
            }
            jsEvents.pushMap(jsEvent)
        }

        sendEvent("onTimingEvent", Arguments.createMap().apply {
            putArray("events", jsEvents)
        })
    }

    // ---------------------------------------------------------------------------
    // Reconnect — exponential backoff (v1 §1.3.5)
    //   MAX_RECONNECT_ATTEMPTS = 5, RECONNECT_DELAY_MS = 2000
    // ---------------------------------------------------------------------------

    private fun scheduleReconnect(device: BluetoothDevice) {
        val attempt = reconnectAttempts.incrementAndGet()
        if (attempt > MAX_RECONNECT_ATTEMPTS) {
            // After 5 failures, fall back to manual entry mode (v1 §1.3.5).
            sendEvent("onScanError", Arguments.createMap().apply {
                putString("message",
                    "Max reconnect attempts reached for ${device.name}. " +
                    "Falling back to manual entry mode.")
                putString("address", device.address)
            })
            return
        }

        val delayMs = RECONNECT_BASE_DELAY_MS * (1L shl (attempt - 1)) // 2s, 4s, 8s, 16s, 32s
        mainHandler.postDelayed({
            device.connectGatt(
                reactContext,
                /* autoConnect = */ false,
                gattCallback,
                BluetoothDevice.TRANSPORT_LE
            )
        }, delayMs)
    }

    // ---------------------------------------------------------------------------
    // Event helper
    // ---------------------------------------------------------------------------

    private fun sendEvent(eventName: String, params: WritableMap) {
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(eventName, params)
    }
}
