import ExpoModulesCore
import Foundation

public class TallyThermalModule: Module {
  public func definition() -> ModuleDefinition {
    Name("TallyThermal")

    // iOS exposes only the thermal pressure level, never a temperature.
    Function("getThermal") { () -> [String: Int] in
      let level: Int
      switch ProcessInfo.processInfo.thermalState {
      case .nominal: level = 0
      case .fair: level = 1
      case .serious: level = 2
      case .critical: level = 3
      @unknown default: level = 0
      }
      return ["level": level] // tempC/headroom are null in JS
    }
  }
}
