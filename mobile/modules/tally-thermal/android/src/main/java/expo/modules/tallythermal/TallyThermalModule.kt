package expo.modules.tallythermal

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class TallyThermalModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("React context is not available")

  override fun definition() = ModuleDefinition {
    Name("TallyThermal")

    Function("getThermal") {
      val tempC = batteryTempC()
      val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager

      val level =
        if (pm != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          when (pm.currentThermalStatus) {
            PowerManager.THERMAL_STATUS_NONE, PowerManager.THERMAL_STATUS_LIGHT -> 0
            PowerManager.THERMAL_STATUS_MODERATE -> 1
            PowerManager.THERMAL_STATUS_SEVERE -> 2
            else -> 3 // CRITICAL, EMERGENCY, SHUTDOWN
          }
        } else {
          // API 26-28: no thermal API, infer from battery temperature.
          when {
            tempC == null -> 0
            tempC >= 50.0 -> 3
            tempC >= 45.0 -> 2
            tempC >= 40.0 -> 1
            else -> 0
          }
        }

      val headroom: Double? =
        if (pm != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
          pm.getThermalHeadroom(10).takeIf { !it.isNaN() }?.toDouble()
        } else {
          null
        }

      mapOf("level" to level, "tempC" to tempC, "headroom" to headroom)
    }
  }

  /** Battery temperature in °C from the sticky ACTION_BATTERY_CHANGED broadcast (all API levels). */
  private fun batteryTempC(): Double? {
    val intent: Intent? = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
    val tenths = intent?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Int.MIN_VALUE) ?: Int.MIN_VALUE
    return if (tenths == Int.MIN_VALUE) null else tenths / 10.0
  }
}
