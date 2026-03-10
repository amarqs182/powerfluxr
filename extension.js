// PowerFluxr — extension.js v1
// Adaptive power management for GNOME
// Controls energy profile, brightness and screen timeout automatically
// via UPower and power-profiles-daemon DBus signals — zero polling.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const UPOWER_IFACE = `
<node>
  <interface name="org.freedesktop.UPower">
    <property name="OnBattery" type="b" access="read"/>
  </interface>
</node>`;

const UPOWER_DEVICE_IFACE = `
<node>
  <interface name="org.freedesktop.UPower.Device">
    <property name="Percentage" type="d" access="read"/>
    <property name="State"      type="u" access="read"/>
  </interface>
</node>`;

const POWER_PROFILES_IFACE = `
<node>
  <interface name="net.hadess.PowerProfiles">
    <property name="ActiveProfile" type="s" access="readwrite"/>
  </interface>
</node>`;

const UPowerProxy        = Gio.DBusProxy.makeProxyWrapper(UPOWER_IFACE);
const UPowerDeviceProxy  = Gio.DBusProxy.makeProxyWrapper(UPOWER_DEVICE_IFACE);
const PowerProfilesProxy = Gio.DBusProxy.makeProxyWrapper(POWER_PROFILES_IFACE);

export default class PowerFluxr extends Extension {

    enable() {
        this._settings          = this.getSettings('org.gnome.shell.extensions.powerfluxr');
        this._upowerProxy       = null;
        this._batteryProxy      = null;
        this._profilesProxy     = null;
        this._upowerChangedId   = 0;
        this._batteryChangedId  = 0;
        this._profilesChangedId = 0;
        this._settingProfile    = false;
        this._evalTimeout       = null;
        this._lastBrightness    = -1;

        this._initProxies();
    }

    disable() {
        if (this._evalTimeout) {
            GLib.source_remove(this._evalTimeout);
            this._evalTimeout = null;
        }

        if (this._upowerProxy && this._upowerChangedId)
            this._upowerProxy.disconnect(this._upowerChangedId);
        if (this._batteryProxy && this._batteryChangedId)
            this._batteryProxy.disconnect(this._batteryChangedId);
        if (this._profilesProxy && this._profilesChangedId)
            this._profilesProxy.disconnect(this._profilesChangedId);

        this._upowerProxy       = null;
        this._batteryProxy      = null;
        this._profilesProxy     = null;
        this._upowerChangedId   = 0;
        this._batteryChangedId  = 0;
        this._profilesChangedId = 0;
        this._lastBrightness    = -1;
        this._settings          = null;
    }

    // ── Setup ─────────────────────────────────────────────────────────────────

    _initProxies() {
        // 1. PowerProfiles — escuta mudança manual de perfil
        this._profilesProxy = new PowerProfilesProxy(
            Gio.DBus.system,
            'net.hadess.PowerProfiles',
            '/net/hadess/PowerProfiles',
            (proxy, error) => {
                if (error) {
                    console.error('[PowerFluxr] PowerProfiles erro: ' + error);
                    return;
                }
                this._profilesChangedId = proxy.connect('g-properties-changed',
                    (_p, changed) => {
                        const props = changed.deepUnpack();
                        if ('ActiveProfile' in props) {
                            if (this._settingProfile) return;
                            const profile = props['ActiveProfile'].deepUnpack();
                            console.log('[PowerFluxr] Perfil manual → ' + profile);
                            this._applyBrightnessAndIdle(profile);
                        }
                    }
                );
            }
        );

        // 2. UPower — escuta mudança AC/bateria
        this._upowerProxy = new UPowerProxy(
            Gio.DBus.system,
            'org.freedesktop.UPower',
            '/org/freedesktop/UPower',
            (proxy, error) => {
                if (error) {
                    console.error('[PowerFluxr] UPower erro: ' + error);
                    return;
                }
                this._upowerChangedId = proxy.connect('g-properties-changed',
                    (_p, changed) => {
                        const props = changed.deepUnpack();
                        if ('OnBattery' in props)
                            this._scheduleEvaluate();
                    }
                );
                this._initBatteryProxy();
            }
        );
    }

    _initBatteryProxy() {
        // DisplayDevice = bateria principal do sistema (mais confiável que buscar por nome)
        this._batteryProxy = new UPowerDeviceProxy(
            Gio.DBus.system,
            'org.freedesktop.UPower',
            '/org/freedesktop/UPower/devices/DisplayDevice',
            (proxy, error) => {
                if (error) {
                    console.error('[PowerFluxr] DisplayDevice erro: ' + error);
                    this._scheduleEvaluate();
                    return;
                }
                this._batteryChangedId = proxy.connect('g-properties-changed',
                    (_p, changed) => {
                        const props = changed.deepUnpack();
                        if ('Percentage' in props || 'State' in props)
                            this._scheduleEvaluate();
                    }
                );
                this._scheduleEvaluate();
            }
        );
    }

    // ── Debounce — agrupa eventos rápidos em uma única avaliação ──────────────

    _scheduleEvaluate() {
        if (this._evalTimeout)
            GLib.source_remove(this._evalTimeout);

        this._evalTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            this._evalTimeout = null;
            this._evaluate();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ── Lógica principal ──────────────────────────────────────────────────────

    _evaluate() {
        if (!this._upowerProxy || !this._profilesProxy) return;

        const onBattery = this._upowerProxy.OnBattery ?? true;
        const pct       = this._batteryProxy
            ? Math.round(this._batteryProxy.Percentage)
            : 100;
        const threshold = this._settings.get_int('low-battery-threshold');

        let profile;
        if (!onBattery)            profile = 'performance';
        else if (pct <= threshold) profile = 'power-saver';
        else                       profile = 'balanced';

        console.log('[PowerFluxr] AC=' + !onBattery + ' bat=' + pct + '% → ' + profile);

        // Só muda se for diferente do perfil atual
        try {
            if (this._profilesProxy.ActiveProfile !== profile) {
                this._settingProfile = true;
                this._profilesProxy.ActiveProfile = profile;
                this._settingProfile = false;
            }
        } catch (e) {
            this._settingProfile = false;
            console.error('[PowerFluxr] Erro ao setar perfil: ' + e);
        }

        this._applyBrightnessAndIdle(profile);
    }

    _applyBrightnessAndIdle(profile) {
        const s = this._settings;
        let brightness, idleDelay;

        switch (profile) {
        case 'performance':
            brightness = s.get_int('performance-brightness');
            idleDelay  = s.get_int('performance-idle-delay');
            break;
        case 'balanced':
            brightness = s.get_int('balanced-brightness');
            idleDelay  = s.get_int('balanced-idle-delay');
            break;
        case 'power-saver':
            brightness = s.get_int('power-saver-brightness');
            idleDelay  = s.get_int('power-saver-idle-delay');
            break;
        default:
            console.warn('[PowerFluxr] Perfil desconhecido: ' + profile);
            return;
        }

        this._setBrightness(brightness);
        this._setIdleDelay(idleDelay);
    }

    _setBrightness(percent) {
        if (this._lastBrightness === percent) return;
        this._lastBrightness = percent;

        const safe = Math.max(1, Math.min(100, percent));

        try {
            const slider = Main.panel.statusArea.quickSettings
                ._brightness.quickSettingsItems[0].slider;
            slider.value = safe / 100;
            console.log('[PowerFluxr] brilho=' + safe + '% (slider nativo)');
        } catch (e) {
            console.warn('[PowerFluxr] Fallback brightnessctl: ' + e);
            try {
                const proc = Gio.Subprocess.new(
                    ['brightnessctl', 'set', safe + '%'],
                    Gio.SubprocessFlags.NONE
                );
                proc.wait_async(null, (_, res) => {
                    try { proc.wait_finish(res); }
                    catch (err) { console.error('[PowerFluxr] brightnessctl: ' + err); }
                });
            } catch (err) {
                console.error('[PowerFluxr] Subprocess erro: ' + err);
            }
        }
    }

    _setIdleDelay(seconds) {
        try {
            const ss = new Gio.Settings({ schema: 'org.gnome.desktop.session' });
            ss.set_uint('idle-delay', seconds);
        } catch (e) {
            console.error('[PowerFluxr] idle-delay: ' + e);
        }
    }
}
