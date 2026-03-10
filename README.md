# PowerFluxr

Adaptive power management extension for GNOME. This extension automatically controls the system's energy profile, display brightness, and screen timeout based on the current power source and battery level, without polling.

## Features
- **Performance (🚀)**: Applied automatically when the device is plugged into the charger (AC).
- **Balanced (⚖️)**: Applied automatically when the device is running on battery and the battery level is above a specified threshold.
- **Power-saver (🪫)**: Applied automatically when the device is on battery and the capacity drops below the `low-battery-threshold` (configurable between 5% and 50%).
- Automatic Screen Brightness Adjustment per profile. (Note: The `brightnessctl` fallback will be removed in the future to keep the extension as native as possible).
- Automatic Screen Timeout (idle-delay) Adjustment per profile.

## Compatibility
Works with GNOME 45, 46, 47, 48, and 49.

## Installation
Clone the repository and build using standard GNOME extension installation steps, or install via extensions.gnome.org (if published).

## Licensing
This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
