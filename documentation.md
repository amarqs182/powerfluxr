# PowerFluxr Documentation

PowerFluxr is an adaptive power management extension for GNOME. It automatically controls the system's energy profile, display brightness, and screen timeout based on the current power source and battery level, without the use of polling loops, relying purely on DBus signals.

## Architecture & DBus Interfaces

The extension communicates with standard Linux desktop interfaces over system DBus:
- **`net.hadess.PowerProfiles`**: To read and set the active power profile (`performance`, `balanced`, or `power-saver`).
- **`org.freedesktop.UPower`**: To detect if the system is currently on battery power (`OnBattery`).
- **`org.freedesktop.UPower.Device` (DisplayDevice)**: To read the primary battery's charge percentage and charging state.

### Event-Driven Design
PowerFluxr uses a debounce mechanism. When rapid DBus property changes occur (e.g. battery percentage drops or AC is unplugged), it schedules a single evaluation after 200ms to avoid applying settings redundantly.

## Profiles and Automation Lógica

PowerFluxr automatically switches between three power states based on predefined rules:

1. **Performance (🚀)**: Applied automatically when the device is plugged into the charger (AC).
2. **Balanced (⚖️)**: Applied automatically when the device is running on battery and the battery level is above a user-specified threshold.
3. **Power-saver (🪫)**: Applied automatically when the device is on battery and the capacity drops below the `low-battery-threshold` (configurable between 5% and 50%).

### Auto-Applied Settings
Whenever a profile switch occurs (either automatically by the rules above or manually by the user via GNOME quick settings), PowerFluxr immediately applies:
- **Screen Brightness**: Target brightness percentage is applied by manipulating the GNOME Quick Settings slider directly. If this fails, it currently uses `brightnessctl` via a subprocess as a fallback (Note: The `brightnessctl` fallback will be removed in the future to keep the extension as native as possible).
- **Screen Timeout (idle-delay)**: Modifies the `org.gnome.desktop.session:idle-delay` GSettings key to adjust the time until the screen turns off due to inactivity.

## Preferences UI ([prefs.js](file:///home/alman/Downloads/powerfluxr/prefs.js))

PowerFluxr offers a fully integrated libadwaita preferences window with groups for:
- **Automation Settings**: A SpinRow to adjust the "Low battery threshold" at which the system activates the power-saver profile.
- **Per-Profile Configuration**: Groups for *Performance*, *Balanced*, and *Power Saver*. Each group contains:
  - **Brightness**: A SpinRow configuring the exact screen brightness percentage (1-100%).
  - **Screen Timeout**: A ComboRow with pre-set intervals ranging from "1 minute" up to "30 minutes", or "Never".

## Project Files

- **[metadata.json](file:///home/alman/Downloads/powerfluxr/metadata.json)**: Standard GNOME extension metadata defining compatibility for GNOME 45–49.
- **[extension.js](file:///home/alman/Downloads/powerfluxr/extension.js)**: Core extension logic, DBus proxy setups, automatic power profile evaluation, and enforcement of brightness/timeout.
- **[prefs.js](file:///home/alman/Downloads/powerfluxr/prefs.js)**: GUI for extension preferences using Gtk4/libadwaita. Setup for settings bindings to `org.gnome.shell.extensions.powerfluxr`.
- **`schemas/`**: GSettings schemas defining the underlying storage (e.g., `performance-brightness`, `low-battery-threshold`).
