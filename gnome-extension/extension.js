'use strict';

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

const STATE_DIR = GLib.build_filenamev(
    [GLib.get_home_dir(), '.local', 'state', 'pi-traffic-light', 'sessions']);
const POLL_SECONDS = 2;
// Safety net only: a session that stops updating (crash, kill -9) without
// firing its cleanup hook eventually disappears instead of lingering forever.
const STALE_SECONDS = 6 * 3600;

const STATUS_COLOR = {
    waiting: '#F44336',
    running: '#FF9800',
    finished: '#4CAF50',
};

// Translated lazily (not a static table) so the strings are looked up
// through gettext at call time, after the extension's translation domain
// is bound — not frozen into English at module load.
function statusLabel(status) {
    switch (status) {
    case 'waiting': return _('Waiting for confirmation');
    case 'running': return _('Running');
    case 'finished': return _('Finished');
    default: return status;
    }
}

function nowSeconds() {
    return GLib.get_real_time() / 1000000;
}

function formatDuration(seconds) {
    if (seconds < 60)
        return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    if (m < 60)
        return s ? `${m}m${s}s` : `${m}m`;
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return rm ? `${h}h${rm}m` : `${h}h`;
}

function isPidAlive(pid) {
    return GLib.file_test(`/proc/${pid}`, GLib.FileTest.IS_DIR);
}

// The pid we track is the claude/pi process itself, not its terminal's
// window. Walk up /proc/<pid>/stat's parent chain to collect ancestors, so
// we can match against whichever ancestor actually owns a window.
function ancestorPids(pid, maxDepth = 12) {
    const pids = new Set();
    let current = pid;
    for (let i = 0; i < maxDepth && current > 1 && !pids.has(current); i++) {
        pids.add(current);
        try {
            const [ok, contents] = GLib.file_get_contents(`/proc/${current}/stat`);
            if (!ok)
                break;
            const stat = new TextDecoder().decode(contents);
            const afterComm = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
            const ppid = parseInt(afterComm[1], 10);
            if (!ppid)
                break;
            current = ppid;
        } catch (e) {
            break;
        }
    }
    return pids;
}

function activateWindowForPid(pid, ordinal, label) {
    const candidates = ancestorPids(pid);
    const matches = [];
    for (const actor of global.get_window_actors()) {
        const win = actor.meta_window;
        if (win && candidates.has(win.get_pid()))
            matches.push(win);
    }
    if (matches.length === 0)
        return false;
    if (matches.length === 1) {
        matches[0].activate(global.get_current_time());
        return true;
    }
    // Single-instance apps (e.g. GNOME Console) report the same pid for
    // every window/tab they own. Pi natively titles its window/tab with the
    // project directory ("π - aes-ui"), so matching the session's own label
    // against the live title disambiguates without tracking any state —
    // recomputed fresh on every click, nothing to get out of sync. Falls
    // back to a stable (not stacking-order-dependent) pick when the label
    // isn't in any title (e.g. claude manages its own title, or two
    // sessions share the same directory/label).
    const byLabel = label ? matches.find(w => (w.get_title() || '').includes(label)) : null;
    if (byLabel) {
        byLabel.activate(global.get_current_time());
        return true;
    }
    matches.sort((a, b) => a.get_frame_rect().x - b.get_frame_rect().x);
    matches[ordinal % matches.length].activate(global.get_current_time());
    return true;
}

function isWindowAlive(win) {
    if (!win)
        return false;
    for (const actor of global.get_window_actors()) {
        if (actor.meta_window === win)
            return true;
    }
    return false;
}

function activateSpecificWindow(win) {
    if (!isWindowAlive(win))
        return false;
    win.activate(global.get_current_time());
    return true;
}

function readSessions() {
    const sessions = [];

    let enumerator;
    try {
        const dirFile = Gio.File.new_for_path(STATE_DIR);
        enumerator = dirFile.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    } catch (e) {
        return sessions;
    }

    const now = nowSeconds();
    let info;
    while ((info = enumerator.next_file(null)) !== null) {
        const name = info.get_name();
        if (!name.endsWith('.json'))
            continue;
        const path = GLib.build_filenamev([STATE_DIR, name]);
        try {
            const [ok, contents] = GLib.file_get_contents(path);
            if (!ok)
                continue;
            const data = JSON.parse(new TextDecoder().decode(contents));
            if (!STATUS_COLOR[data.status])
                continue;
            if (typeof data.pid === 'number' && !isPidAlive(data.pid)) {
                // Process is gone without a clean shutdown (killed session,
                // closed terminal): drop the dot right away instead of
                // waiting on the stale-time fallback below.
                GLib.unlink(path);
                continue;
            }
            if (typeof data.ts === 'number' && now - data.ts > STALE_SECONDS)
                continue;
            sessions.push({
                key: name,
                agent: data.agent || '?',
                label: data.label || data.session || name,
                status: data.status,
                ts: data.ts || 0,
                pid: typeof data.pid === 'number' ? data.pid : null,
            });
        } catch (e) {
            // Ignore malformed/partially-written files, they'll settle next poll.
        }
    }
    enumerator.close(null);
    // Determines display order for sessions we haven't seen before (already
    //-known sessions keep whatever position they were first given). Sort by
    // creation time, not filename, so it actually matches appearance order.
    sessions.sort((a, b) => a.ts - b.ts);
    return sessions;
}

const SessionDot = GObject.registerClass(
class SessionDot extends St.Widget {
    _init(styleClass = 'pi-dot') {
        super._init({
            style_class: styleClass,
            width: 10,
            height: 10,
            y_align: Clutter.ActorAlign.CENTER,
        });
    }

    setStatus(status) {
        this.set_style(`background-color: ${STATUS_COLOR[status]};`);
    }
});

// A drawn 3-light housing instead of the 🚦 emoji: some fonts render that
// glyph with lopsided built-in whitespace that no amount of CSS padding on
// our side can correct.
const TrafficLightLogo = GObject.registerClass(
class TrafficLightLogo extends St.DrawingArea {
    _init() {
        super._init({ width: 10, height: 22, y_align: Clutter.ActorAlign.CENTER });
        this.connect('repaint', area => this._draw(area));
    }

    _draw(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const margin = w / 2;
        const dotR = 2;

        // Translucent white rather than a fixed gray: stays visibly
        // distinct whether the panel is plain black or the lighter shade
        // GNOME's hover state paints behind it.
        const r = 2;
        cr.setSourceRGBA(1, 1, 1, 0.18);
        roundedRectPath(cr, 0, 0, w, h, r);
        cr.fill();
        cr.setSourceRGBA(1, 1, 1, 0.5);
        cr.setLineWidth(1);
        roundedRectPath(cr, 0.5, 0.5, w - 1, h - 1, r);
        cr.stroke();

        const colors = [Object.values(hexToRgb(STATUS_COLOR.waiting)),
            Object.values(hexToRgb(STATUS_COLOR.running)),
            Object.values(hexToRgb(STATUS_COLOR.finished))];
        const step = (h - 2 * margin) / 2;
        colors.forEach((c, i) => {
            cr.setSourceRGBA(c[0] / 255, c[1] / 255, c[2] / 255, 1);
            cr.arc(margin, margin + step * i, dotR, 0, 2 * Math.PI);
            cr.fill();
        });
        cr.$dispose();
    }
});

function roundedRectPath(cr, x, y, w, h, r) {
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 3 * Math.PI / 2);
    cr.closePath();
}

function hexToRgb(hex) {
    return {
        r: parseInt(hex.slice(1, 3), 16),
        g: parseInt(hex.slice(3, 5), 16),
        b: parseInt(hex.slice(5, 7), 16),
    };
}

export default class PiTrafficLightExtension extends Extension {
    enable() {
        this._dots = new Map();
        this._dynamicCount = 0;
        // key -> Meta.Window captured the moment we first saw that session's
        // file appear. Whatever window had focus right when claude/pi started
        // is, in practice, always the right one — sidesteps pid ambiguity
        // entirely for apps like GNOME Console where every window/tab shares
        // the same owning process.
        this._windowBySession = new Map();

        GLib.mkdir_with_parents(STATE_DIR, 0o755);
        this._dirMonitor = Gio.File.new_for_path(STATE_DIR).monitor_directory(Gio.FileMonitorFlags.NONE, null);
        this._dirMonitorId = this._dirMonitor.connect('changed', () => this._captureNewSessions());

        this._indicator = new PanelMenu.Button(0.0, 'PI Traffic Light', false);
        // The theme's default .panel-button padding stacks with our own
        // box padding below, which is what reads as a lopsided gap around
        // the icon. Zero it out so only pi-panel-box controls the spacing.
        this._indicator.add_style_class_name('pi-indicator');

        const box = new St.BoxLayout({ style_class: 'pi-panel-box' });
        this._box = box;
        this._icon = new TrafficLightLogo();
        this._dotsBox = new St.BoxLayout({
            style_class: 'pi-traffic-dots',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._icon);
        box.add_child(this._dotsBox);
        this._indicator.add_child(box);

        this._emptyItem = new PopupMenu.PopupMenuItem(_('No active sessions'), { reactive: false });
        this._indicator.menu.addMenuItem(this._emptyItem);

        Main.panel.addToStatusArea('pi-traffic-light', this._indicator, 1, 'right');

        this._refresh();
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_SECONDS, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        if (this._dirMonitor) {
            this._dirMonitor.disconnect(this._dirMonitorId);
            this._dirMonitor.cancel();
            this._dirMonitor = null;
        }
        this._indicator?.destroy();
        this._indicator = null;
        this._icon = null;
        this._dotsBox = null;
        this._dots.clear();
        this._windowBySession.clear();
    }

    _captureNewSessions() {
        let enumerator;
        try {
            enumerator = Gio.File.new_for_path(STATE_DIR)
                .enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        } catch (e) {
            return;
        }
        let sawNew = false;
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const name = info.get_name();
            if (!name.endsWith('.json') || this._windowBySession.has(name))
                continue;
            this._windowBySession.set(name, global.display.focus_window || null);
            sawNew = true;
        }
        enumerator.close(null);
        if (sawNew)
            this._refresh();
    }

    // Smallest positive integer not currently shown, rather than an
    // ever-incrementing counter — a session ending frees its number back up
    // for the next one instead of drifting off into #11 for 3 sessions.
    _nextAvailableIndex() {
        const used = new Set([...this._dots.values()].map(e => e.index));
        let i = 1;
        while (used.has(i))
            i++;
        return i;
    }

    _refresh() {
        const sessions = readSessions();
        const seenKeys = new Set();
        const now = nowSeconds();

        // Only auto-capture the fallback association when exactly one
        // session is ambiguous: capturing several at once would hand them
        // all the same (single) focused window, silently mis-associating
        // every one of them but the lucky match.
        const uncaptured = sessions.filter(s => !isWindowAlive(this._windowBySession.get(s.key)));
        const soleUncapturedKey = uncaptured.length === 1 ? uncaptured[0].key : null;

        for (const session of sessions) {
            seenKeys.add(session.key);
            let entry = this._dots.get(session.key);
            if (!entry) {
                const dot = new SessionDot();
                const menuItem = new PopupMenu.PopupMenuItem('');
                const menuDot = new SessionDot('pi-dot pi-dot-menu');
                menuItem.insert_child_at_index(menuDot, 0);
                menuItem.connect('activate', () => {
                    // 1) The window captured automatically when this session's
                    //    file first appeared (works out of the box, no setup).
                    if (activateSpecificWindow(this._windowBySession.get(session.key)))
                        return;
                    // 2) No capture (e.g. session predates this extension
                    //    instance): fall back to pid + live title matching,
                    //    recomputed fresh every click, nothing to maintain.
                    if (!entry.pid || !activateWindowForPid(entry.pid, entry.index, entry.label))
                        Main.notify('PI Traffic Light', _('Window not found for this session.'));
                });
                // Append (not insert-at-0) so both the panel and the menu
                // show sessions in the order they actually appeared.
                this._dotsBox.add_child(dot);
                this._indicator.menu.addMenuItem(menuItem, this._dynamicCount++);
                entry = { dot, menuItem, menuDot, pid: null, label: null, index: this._nextAvailableIndex() };
                this._dots.set(session.key, entry);
            }
            // Fallback for sessions whose file already existed before we
            // started watching the directory (the create-monitor never saw
            // them appear): capture whatever has focus, but only when this
            // is the single remaining ambiguous session (see above).
            if (session.key === soleUncapturedKey && global.display.focus_window)
                this._windowBySession.set(session.key, global.display.focus_window);
            entry.dot.setStatus(session.status);
            entry.menuDot.setStatus(session.status);
            entry.pid = session.pid;
            entry.label = session.label;
            const ago = formatDuration(Math.max(0, Math.round(now - session.ts)));
            // Same-directory sessions share the same label (dir basename),
            // so a simple stable per-session index is what tells them apart
            // on screen (the real pid is still used internally for the click).
            entry.menuItem.label.set_text(
                `#${entry.index} · ${session.agent} · ${session.label} — ${statusLabel(session.status)} (${ago})`);
        }

        for (const [key, entry] of this._dots) {
            if (!seenKeys.has(key)) {
                entry.dot.destroy();
                entry.menuItem.destroy();
                this._dots.delete(key);
                this._windowBySession.delete(key);
                this._dynamicCount--;
            }
        }

        this._emptyItem.visible = sessions.length === 0;
        // Hidden (not just empty) so the panel doesn't reserve the box's
        // inter-child spacing for a row with nothing in it, and shrink the
        // panel button's own padding so it isn't wider than the bare icon.
        const hasSessions = sessions.length > 0;
        this._dotsBox.visible = hasSessions;
        this._box.style_class = hasSessions ? 'pi-panel-box' : 'pi-panel-box pi-panel-box-empty';
    }
}
