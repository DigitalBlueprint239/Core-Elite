// =============================================================================
// BLETimingPackage.kt
// Core Elite — React Native package registration
//
// Register in MainApplication.kt:
//   override fun getPackages(): List<ReactPackage> =
//       PackageList(this).packages.apply {
//           add(BLETimingPackage())
//       }
// =============================================================================

package com.coreelite.ble

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class BLETimingPackage : ReactPackage {

    override fun createNativeModules(
        reactContext: ReactApplicationContext
    ): List<NativeModule> = listOf(BLETimingModule(reactContext))

    override fun createViewManagers(
        reactContext: ReactApplicationContext
    ): List<ViewManager<*, *>> = emptyList()
}
