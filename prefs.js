// PowerFluxr — prefs.js v1
// Adaptive power management for GNOME

import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import { ExtensionPreferences } from
    'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const IDLE_OPTIONS = [
    [60,   '1 minuto'],
    [120,  '2 minutos'],
    [180,  '3 minutos'],
    [300,  '5 minutos'],
    [600,  '10 minutos'],
    [900,  '15 minutos'],
    [1800, '30 minutos'],
    [0,    'Nunca'],
];

const PROFILES = [
    {
        id:       'performance',
        title:    '⚡ Performance',
        subtitle: 'Aplicado quando conectado ao carregador (AC)',
    },
    {
        id:       'balanced',
        title:    '⚖️ Balanceado',
        subtitle: 'Aplicado ao usar na bateria',
    },
    {
        id:       'power-saver',
        title:    '🪫 Economia de energia',
        subtitle: 'Aplicado quando a bateria está baixa',
    },
];

export default class PowerFluxrPrefs extends ExtensionPreferences {

    fillPreferencesWindow(window) {
        const s = this.getSettings('org.gnome.shell.extensions.powerfluxr');

        window.set_default_size(560, 700);
        window.set_title('PowerFluxr');

        const page = new Adw.PreferencesPage({
            title:     'Configurações',
            icon_name: 'battery-symbolic',
        });
        window.add(page);

        // ── Grupo: Automação ──────────────────────────────────────────────────
        const autoGroup = new Adw.PreferencesGroup({
            title:       'Automação',
            description: 'Troca de perfil automática conforme fonte de energia',
        });
        page.add(autoGroup);

        const thresholdRow = new Adw.SpinRow({
            title:    'Limite de bateria baixa',
            subtitle: 'Abaixo desse % ativa Economia de energia',
            adjustment: new Gtk.Adjustment({
                lower: 5, upper: 50, step_increment: 5, page_increment: 10,
                value: s.get_int('low-battery-threshold'),
            }),
            digits: 0,
            snap_to_ticks: true,
        });
        thresholdRow.connect('notify::value', row => {
            s.set_int('low-battery-threshold', row.value);
        });
        s.connect('changed::low-battery-threshold', () => {
            thresholdRow.value = s.get_int('low-battery-threshold');
        });
        autoGroup.add(thresholdRow);

        const acRow = new Adw.ActionRow({
            title:    'No carregador (AC)',
            subtitle: 'Ativa automaticamente → Performance',
            icon_name: 'battery-full-charged-symbolic',
        });
        autoGroup.add(acRow);

        const batRow = new Adw.ActionRow({
            title:    'Na bateria',
            subtitle: 'Ativa automaticamente → Balanceado (ou Economia se baixo)',
            icon_name: 'battery-good-symbolic',
        });
        autoGroup.add(batRow);

        // ── Grupos por perfil ─────────────────────────────────────────────────
        for (const profile of PROFILES) {
            const group = new Adw.PreferencesGroup({
                title:       profile.title,
                description: profile.subtitle,
            });
            page.add(group);

            const brightnessRow = new Adw.SpinRow({
                title:    'Brilho',
                subtitle: 'Porcentagem do brilho da tela',
                adjustment: new Gtk.Adjustment({
                    lower: 1, upper: 100, step_increment: 5, page_increment: 10,
                    value: s.get_int(profile.id + '-brightness'),
                }),
                digits: 0,
                snap_to_ticks: true,
            });
            brightnessRow.connect('notify::value', row => {
                s.set_int(profile.id + '-brightness', row.value);
            });
            s.connect('changed::' + profile.id + '-brightness', () => {
                brightnessRow.value = s.get_int(profile.id + '-brightness');
            });
            group.add(brightnessRow);

            const idleModel = new Gtk.StringList();
            IDLE_OPTIONS.forEach(([, label]) => idleModel.append(label));

            const currentDelay = s.get_int(profile.id + '-idle-delay');
            let selectedIdx    = IDLE_OPTIONS.findIndex(([v]) => v === currentDelay);
            if (selectedIdx < 0) selectedIdx = 3;

            const idleRow = new Adw.ComboRow({
                title:    'Tempo de tela',
                subtitle: 'Tempo até o monitor desligar por inatividade',
                model:    idleModel,
                selected: selectedIdx,
            });
            idleRow.connect('notify::selected', row => {
                s.set_int(profile.id + '-idle-delay', IDLE_OPTIONS[row.selected][0]);
            });
            s.connect('changed::' + profile.id + '-idle-delay', () => {
                const delay = s.get_int(profile.id + '-idle-delay');
                const idx   = IDLE_OPTIONS.findIndex(([v]) => v === delay);
                if (idx >= 0) idleRow.selected = idx;
            });
            group.add(idleRow);
        }
    }
}
