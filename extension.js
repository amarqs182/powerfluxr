// PowerFluxr — extension.js v2.4
// Panel indicator: symbolic icon + battery time (both AC and battery).
// Brightness via Main.brightnessManager.globalScale.value (GNOME 49 API oficial)
// Fix v2.4: _expectedProfile reset após consumo; set atômico para evitar race condition.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
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
    <property name="Percentage"  type="d" access="read"/>
    <property name="State"       type="u" access="read"/>
    <property name="TimeToEmpty" type="x" access="read"/>
    <property name="TimeToFull"  type="x" access="read"/>
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

const PROFILE_META = {
    'performance': { icon: 'power-profile-performance-symbolic' },
    'balanced':    { icon: 'power-profile-balanced-symbolic'    },
    'power-saver': { icon: 'power-profile-power-saver-symbolic' },
};

// UPower battery states
const STATE_CHARGING    = 1;
const STATE_DISCHARGING = 2;
const STATE_FULL        = 4;

const PowerFluxrIndicator = GObject.registerClass(
    class PowerFluxrIndicator extends PanelMenu.Button {

        _init(extension) {
            super._init(0.0, 'PowerFluxr');
            this._ext = extension;

            const box = new St.BoxLayout({
                style_class: 'panel-status-menu-box',
                y_align: Clutter.ActorAlign.CENTER,
            });
            this.add_child(box);

            this._icon = new St.Icon({
                icon_name:   'power-profile-balanced-symbolic',
                style_class: 'system-status-icon',
            });
            box.add_child(this._icon);

            this._label = new St.Label({
                text:    '',
                y_align: Clutter.ActorAlign.CENTER,
                style:   'font-size: 11px; padding-left: 4px;',
            });
            box.add_child(this._label);

            this.connect('button-press-event', () => {
                try { this._ext.openPreferences(); }
                catch (e) { console.error('[PowerFluxr] openPreferences: ' + e); }
                return Clutter.EVENT_STOP;
            });
        }

        setProfile(profile) {
            const meta = PROFILE_META[profile];
            if (meta) this._icon.icon_name = meta.icon;
        }

        setBatteryTime(onBattery, state, timeToEmpty, timeToFull) {
            if (!onBattery) {
                if (state === STATE_FULL) {
                    this._label.text = '';
                } else if (timeToFull > 60) {
                    this._label.text = this._fmt(timeToFull);
                } else {
                    this._label.text = '…';
                }
            } else {
                this._label.text = timeToEmpty > 60 ? this._fmt(timeToEmpty) : '';
            }
        }

        _fmt(seconds) {
            const h = Math.floor(seconds / 3600);
            const m = Math.floor((seconds % 3600) / 60);
            return h > 0 ? `${h}:${m.toString().padStart(2, '0')}` : `${m}m`;
        }
    });

export default class PowerFluxr extends Extension {

    enable() {
        this._settings         = this.getSettings('org.gnome.shell.extensions.powerfluxr');
        this._upowerProxy      = null;
        this._batteryProxy     = null;
        this._profilesProxy    = null;
        this._upowerChangedId  = 0;
        this._batteryChangedId = 0;
        this._profilesChangedId = 0;

        // Perfil que esta extensão acabou de solicitar ao daemon.
        // null → nenhuma requisição pendente; qualquer mudança de perfil é manual.
        // Resetado para null logo após o callback confirmar a mudança,
        // garantindo que mudanças manuais posteriores para o mesmo perfil
        // não sejam engolidas.
        this._expectedProfile  = null;

        this._evalTimeout      = null;
        this._lastBrightness   = -1;
        this._lastIdleDelay    = -1;
        this._sessionSettings  = new Gio.Settings({ schema: 'org.gnome.desktop.session' });

        this._indicator = new PowerFluxrIndicator(this);
        Main.panel.addToStatusArea('powerfluxr', this._indicator);

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

        this._indicator?.destroy();
        this._indicator        = null;
        this._upowerProxy      = null;
        this._batteryProxy     = null;
        this._profilesProxy    = null;
        this._upowerChangedId  = 0;
        this._batteryChangedId = 0;
        this._profilesChangedId = 0;
        this._expectedProfile  = null;
        this._lastBrightness   = -1;
        this._lastIdleDelay    = -1;
        this._settings         = null;
        this._sessionSettings  = null;
    }

    // ── Setup ─────────────────────────────────────────────────────────────────

    _initProxies() {
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
                        if (!('ActiveProfile' in props)) return;

                        const profile = props['ActiveProfile'].deepUnpack();

                        // FIX: consome e reseta _expectedProfile atomicamente.
                        // Se este evento confirma a nossa própria requisição,
                        // limpa o flag e retorna — não é mudança manual.
                        // Se _expectedProfile for null ou diferente, é manual.
                        if (this._expectedProfile === profile) {
                            this._expectedProfile = null;   // ← reset imediato
                            return;
                        }

                        // Chegou aqui: mudança manual pelo usuário.
                        this._expectedProfile = null;       // ← garante reset mesmo assim
                        console.log('[PowerFluxr] Perfil manual → ' + profile);
                        this._indicator?.setProfile(profile);
                        this._applyBrightnessAndIdle(profile);
                    }
                );
            }
        );

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
                        if ('OnBattery' in props) this._scheduleEvaluate();
                    }
                );
                this._initBatteryProxy();
            }
        );
    }

    _initBatteryProxy() {
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
                        if ('Percentage' in props || 'State' in props ||
                            'TimeToEmpty' in props || 'TimeToFull' in props)
                            this._scheduleEvaluate();
                    }
                );
                this._scheduleEvaluate();
            }
        );
    }

    // ── Debounce ──────────────────────────────────────────────────────────────

    _scheduleEvaluate() {
        if (this._evalTimeout) GLib.source_remove(this._evalTimeout);
        this._evalTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            this._evalTimeout = null;
            this._evaluate();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ── Lógica principal ──────────────────────────────────────────────────────

    _evaluate() {
        if (!this._upowerProxy || !this._profilesProxy) return;

        const onBattery   = this._upowerProxy.OnBattery ?? true;
        const pct         = this._batteryProxy ? Math.round(this._batteryProxy.Percentage) : 100;
        const state       = this._batteryProxy ? (this._batteryProxy.State      ?? 0) : 0;
        const timeToEmpty = this._batteryProxy ? Number(this._batteryProxy.TimeToEmpty ?? 0) : 0;
        const timeToFull  = this._batteryProxy ? Number(this._batteryProxy.TimeToFull  ?? 0) : 0;
        const threshold   = this._settings.get_int('low-battery-threshold');

        let profile;
        if (!onBattery)            profile = 'performance';
        else if (pct <= threshold) profile = 'power-saver';
        else                       profile = 'balanced';

        console.log('[PowerFluxr] AC=' + !onBattery + ' bat=' + pct + '% state=' + state + ' → ' + profile);

        this._indicator?.setProfile(profile);
        this._indicator?.setBatteryTime(onBattery, state, timeToEmpty, timeToFull);

        // FIX: set atômico — só marca _expectedProfile se o set não lançar exceção.
        // Assim, uma falha silenciosa não "trava" a detecção de mudanças manuais.
        try {
            if (this._profilesProxy.ActiveProfile !== profile) {
                this._profilesProxy.ActiveProfile = profile; // pode lançar
                this._expectedProfile = profile;             // ← só chega aqui se não lançou
            }
        } catch (e) {
            // _expectedProfile permanece null: próxima mudança de perfil
            // (inclusive retry automático) será tratada corretamente.
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

        // 1. API oficial GNOME 49+
        try {
            Main.brightnessManager.globalScale.value = safe / 100;
            console.log('[PowerFluxr] brilho=' + safe + '% (brightnessManager)');
            return;
        } catch (e) {
            console.warn('[PowerFluxr] brightnessManager falhou: ' + e);
        }

        // 2. Fallback: slider interno (GNOME 45–48)
        try {
            const slider = Main.panel.statusArea.quickSettings
                ._brightness.quickSettingsItems[0].slider;
            slider.value = safe / 100;
            console.log('[PowerFluxr] brilho=' + safe + '% (slider)');
            return;
        } catch (e) {
            console.warn('[PowerFluxr] slider falhou: ' + e);
        }

        // 3. Último recurso: brightnessctl
        try {
            const proc = Gio.Subprocess.new(
                ['brightnessctl', 'set', safe + '%'],
                Gio.SubprocessFlags.NONE
            );
            proc.wait_async(null, (_, res) => {
                try { proc.wait_finish(res); }
                catch (err) { console.error('[PowerFluxr] brightnessctl: ' + err); }
            });
            console.log('[PowerFluxr] brilho=' + safe + '% (brightnessctl)');
        } catch (err) {
            console.error('[PowerFluxr] Falha total no brilho: ' + err);
        }
    }

    _setIdleDelay(seconds) {
        if (this._lastIdleDelay === seconds) return;
        this._lastIdleDelay = seconds;
        try {
            if (this._sessionSettings.get_uint('idle-delay') !== seconds)
                this._sessionSettings.set_uint('idle-delay', seconds);
        } catch (e) {
            console.error('[PowerFluxr] idle-delay: ' + e);
        }
    }
}