'use strict';
/**
 * Tuner B - the tuner dashboard ("Race" design), made for an MHD-tuned S58 (G80 M3 Competition).
 *
 *   Vitals  left: oil, water, gearbox oil and intake air as bars, each coloured by its own
 *           limits from the settings (blue / green / yellow / red); in yellow or red the whole
 *           block lights up. Centre (setting): the boost dial up to the engine's max boost, the
 *           target on its rim; or the tyres (tyres.js): a black M3 from above (car_art.js) with
 *           each tyre's pressure, target and temperature. Right: map (tap: the map page) and ethanol (E37: from the DME, ethanol.js), then a 3 x 2
 *           grid of cylinders: knock retard and misfires of the last pull (held until the next
 *           pull starts; pulls.js), or live (setting, or the pull log off). Full screen: it all grows
 *           into the screen's whole height (vitalsRoom)
 *   Boost   actual, target, deviation, peak, torque, power and rpm in a row; actual over target
 *           (filled) and the deviation under it
 *   Log     the last 10 pulls: when, how long, speed, peak boost, map, intake air, and per cylinder
 *           the deepest retard, how often timing was pulled and misfires. "Log: on / off" (also a
 *           setting): off catches and records nothing, the cylinder tiles on Vitals show live values
 *   Maps    (from the map tile) maps 1-4 for MHD: tap a map, tap again to switch
 * No bar buttons besides the pager and Settings: the kit then draws no bar under the page.
 */
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const Car = require('./kit/car');
const { Tune, units, cylLevel, ethText, CYL } = require('./tune');
const { MapControl, MAPS } = require('./maps');
const { Pulls, KEEP } = require('./pulls');
const { Tyres } = require('./tyres');
const { Ethanol } = require('./ethanol');
const CAR_ART = require('./car_art');
require('./kit/fonts').register(CAR_ART.name, CAR_ART);

const W = 1600, H = 520;
const PAGES = ['vitals', 'boost', 'log'];
const PEDAL_IF = 'de.bmw.powertrain.AcceleratorPedal';
const PEDAL_MS = 1000;                   // a pedal value older than this counts as none
const GO = '#2fd27a';
const CONFIRM_MS = 5000;
const DIAL_HOLD = 333;                   // the boost dial's numbers: 3 a second, the car's samples come at 20 Hz
const MAP_NAMES = { none: '', stock: 'Stock', valet: 'Valet', street: 'Street', s1: 'Stage 1', s2: 'Stage 2', s2p: 'Stage 2+',
    e30: 'E30', e40: 'E40', e50: 'E50', e85: 'E85', race: 'Race', track: 'Track' };
// the four temperatures: settings keys, the bar's end (deg C, at least the red limit + 20)
const TEMPS = [
    { key: 'oil', label: 'Engine oil', set: 'oil', max: 150 },
    { key: 'coolant', label: 'Water', set: 'water', max: 130 },
    { key: 'gearbox', label: 'Gearbox oil', set: 'gear', max: 150 },
    { key: 'iat', label: 'Intake air', set: 'iat', max: 90 },
];

mgu.run({
    async start(ctx) {
        const { ui, settings } = ctx;
        const car = new Car(ctx, ['rpm', 'speed', 'temps', 'torque']);
        const tune = new Tune(() => ({ maxBoost: settings.get('maxBoost') || 2.5, maxTorque: settings.get('maxTorque') || 650 }));
        const maps = new MapControl(ctx);
        const pulls = new Pulls(ctx.dataDir, ctx.log);
        const tyres = new Tyres(ctx.log);
        tyres.watch(ctx);
        // the accelerator pedal from the car (AcceleratorPedal.AngleAcceleratorPedal, 0.025 % a step), when it sends it
        const pedal = { v: null, t: 0 };
        ctx.signals.watch(PEDAL_IF, '1', {
            AngleAcceleratorPedal: (v) => {
                const raw = v && v.actualValueAngleAcceleratorPedal, p = typeof raw === 'number' ? raw * 0.025 : null;
                if (p !== null && p >= -2 && p <= 102) { pedal.v = G.clamp(p, 0, 100); pedal.t = Date.now(); }
            },
        }, ctx.log).then((s) => ctx.log.info('signal AcceleratorPedal ' + (s && s.error ? 'error: ' + s.error : 'subscribed'))).catch(() => {});
        // the fuel's ethanol content from the DME (ethanol.js), on the car only
        const eth = new Ethanol(ctx, () => !car.data().demo);
        car.onSample((d, t) => {
            const live = !d.demo && pedal.v !== null && Date.now() - pedal.t < PEDAL_MS;
            tune.feed(d.demo ? d : Object.assign({}, d, { ethanol: eth.value }, live ? { pedal: pedal.v } : null), t);
            if (d.demo) tyres.step(d, t);
            // the log off: no pulls are caught at all (the tiles show live values)
            pulls.feed(t, Object.assign({ map: maps.map }, tune.now), { start: settings.get('pullStart') || 80, minS: settings.get('pullMin') || 2, log: logOn() });
        }, () => { tune.reset(); pulls.reset(); });
        let page = Math.max(0, PAGES.indexOf(settings.get('page')));
        let onMaps = false, pick = null;                 // the map page; a map tapped once (waits for the second tap)

        /** The pull log is on (setting; off: nothing is recorded to it). */
        function logOn() { return settings.get('pullLog') !== false; }
        const levelColor = (t, l) => (l === 2 ? t.crit : l === 1 ? t.warn : GO);
        const mapName = (n) => MAP_NAMES[settings.get('map' + n + 'Name')] || '';
        /** Limits of one temperature (deg C), in order: blue below cold, yellow from warn, red from crit. */
        function limits(set) {
            const cold = settings.get(set + 'Cold'), warn = Math.max(cold, settings.get(set + 'Warn'));
            return { cold, warn, crit: Math.max(warn, settings.get(set + 'Crit')) };
        }
        /** 0 blue, 1 green, 2 yellow, 3 red; null without a value. */
        const band = (c, l) => (!G.isNum(c) ? null : c >= l.crit ? 3 : c >= l.warn ? 2 : c < l.cold ? 0 : 1);
        const bandColor = (t, b) => [t.cold, GO, t.warn, t.crit][b];
        // the dial's own end ticks only: its scale (ticks on round values from a start like -0.2) is drawn below
        const dial = (u) => ({ min: u.pMin, max: u.pMax, ticks: 1, majorEvery: 1, tickLabels: false });
        /** Boost scale on the dial: a tick every half step, numbers on whole steps (0, 0.5 ... bar; 0, 5 ... psi). Cached. */
        function dialScale(cv, t, u, cx, cy, r) {
            const S = Math.ceil(r + 16), key = ['tb-scale', r, u.pMin, u.pMax, u.pU, t.name].join('|');
            cv.blit(G.layer(key, 2 * S, 2 * S, (c) => {
                const thick = Math.max(8, r * 0.11), minor = u.pStep / 2;
                for (let v = Math.ceil(u.pMin / minor - 1e-9) * minor; v <= u.pMax + 1e-9; v += minor) {
                    const major = Math.abs(v / u.pStep - Math.round(v / u.pStep)) < 1e-6;
                    const a = (-135 + (v - u.pMin) / (u.pMax - u.pMin) * 270) * Math.PI / 180, sx = Math.sin(a), sy = -Math.cos(a);
                    const ri = r - thick - (major ? 16 : 9), ro = r - thick - 5;
                    c.line(S + sx * ri, S + sy * ri, S + sx * ro, S + sy * ro, major ? 3 : 2, major ? t.tick : withAlpha(t.tick, 0.6));
                    if (major) {
                        const lr = r - thick - 38, txt = Math.abs(v) < 1e-9 ? '0' : G.fmt(v, Math.abs(v % 1) > 1e-9 ? 1 : 0);
                        c.text(txt, S + sx * lr, S + sy * lr + 9, 24, v === 0 ? t.text : t.dim, { align: 'center', font: 'label' });
                    }
                }
            }, cv.textScale), Math.round(cx) - S, Math.round(cy) - S);
        }
        const repaint = () => render();
        const openMaps = () => { onMaps = true; pick = null; return render(); };

        /* ---------------- Vitals ---------------- */
        /**
         * The Vitals page's room, y0..y1. With no bar under the page (full screen) the kit gives the page the
         * screen down to its bottom (cv.extra; reading it places the page as one that reaches down, right under
         * the header) and everything grows into it; else the app's 520 (k = 1: the layout as drawn for it).
         */
        function vitalsRoom(cv) {
            const extra = cv.extra || 0, y0 = extra ? 44 : 56, y1 = G.pageBottom(cv) - 6;
            return { y0, y1, k: (y1 - y0) / 450 };
        }

        function temperature(cv, t, u, i, d, v, now, R) {
            // four blocks over the room; the bar (its head and scale, 108 px) in the middle of its block
            const step = (R.y1 - R.y0 + 6) / 4, l = limits(d.set), b = band(v, l), x = 32, w = 460;
            const y = Math.round(R.y0 + i * step), h = Math.round(step - 6), by = y + Math.round((h - 108) / 2);
            // yellow / red: the whole block lights up (red pulses)
            if (b >= 2) {
                const c = bandColor(t, b), a = b === 3 ? 0.2 + 0.14 * Math.pow(Math.sin(now / 260), 2) : 0.18;
                cv.roundRect(x - 14, y - 6, w + 28, h - 2, 10, withAlpha(c, a));
                cv.strokeRoundRect(x - 14, y - 6, w + 28, h - 2, 10, 2, withAlpha(c, 0.9));
            }
            const max = Math.max(d.max, l.crit + 20);
            G.bar(cv, t, x, by, w, 108, {
                label: d.label, value: u.T(v), unit: u.tU, decimals: 0, min: u.T(0), max: u.T(max), niceMax: true, color: GO,
                valueColor: b >= 2 ? bandColor(t, b) : null,
                zones: [{ from: u.T(-100), to: u.T(l.cold) - 1e-6, color: 'cold' }, { from: u.T(l.warn), to: u.T(l.crit), color: 'warn' }, { from: u.T(l.crit), to: u.T(500), color: 'crit' }],
            });
        }

        function vitals(cv, t, n, u, now) {
            const R = vitalsRoom(cv);
            TEMPS.forEach((d, i) => temperature(cv, t, u, i, d, n[d.key], now, R));
            cv.fillRect(524, R.y0 + 8, 1, R.y1 - R.y0 - 10, withAlpha('#ffffff', 0.12));
            cv.fillRect(1076, R.y0 + 8, 1, R.y1 - R.y0 - 10, withAlpha('#ffffff', 0.12));
            if (settings.get('centre') === 'tyres') tyrePanel(cv, t, n, u, R);
            else boostDial(cv, t, n, u, R);

            // ---- map (a tap opens the map page) and ethanol: taller (and their numbers bigger) with more room
            const ty = R.y0, th = Math.round(150 + (R.y1 - R.y0 - 450) * 0.35), big = Math.round(96 * Math.min(1.12, th / 150));
            const tile = (x, y, w, h) => cv.roundRect(x, y, w, h, 12, withAlpha('#ffffff', 0.05));
            tile(1100, ty, 228, th);
            cv.strokeRoundRect(1100, ty, 228, th, 12, 1.5, withAlpha(t.accent2 || t.accent, 0.45));
            cv.text('MAP', 1120, ty + 32, 20, t.dim, { font: 'bold', spacing: 2 });
            const nm = maps.map ? mapName(maps.map) : '';
            if (nm) cv.text(nm.toUpperCase(), 1310, ty + 32, 18, t.accent2 || t.accent, { align: 'right', font: 'bold', spacing: 1 });
            cv.text(maps.map ? String(maps.map) : '-', 1214, ty + th - 28, big, t.accent2 || t.accent, { align: 'center', font: 'num' });
            cv.text('TAP TO CHANGE', 1214, ty + th - 8, 14, t.dim, { align: 'center', font: 'bold', spacing: 2 });
            cv.target(1100, ty, 228, th, openMaps, 'mapTile');
            tile(1340, ty, 236, th);
            cv.text('FUEL', 1360, ty + 32, 20, t.dim, { font: 'bold', spacing: 2 });
            cv.text(ethText(n.ethanol), 1458, ty + th - 18, big, GO, { align: 'center', font: 'num' });

            cylinders(cv, t, n, now, { top: ty + th, y1: R.y1 });
        }

        /** The boost dial up to the engine's max boost, the target as a marker on its rim (kept on the page: r <= cy - 70). */
        function boostDial(cv, t, n, u, R) {
            const cx = 800, cy = Math.round((R.y0 + R.y1) / 2) + 5, r = Math.min(Math.round(214 * R.k), cy - 70), sc = dial(u);
            // the arc and the target marker follow every sample; the numbers change at most every DIAL_HOLD ms
            const b = u.P(n.boost), tg = u.P(n.target);
            G.radial(cv, t, cx, cy, r, Object.assign({
                value: b, readout: G.hold('d.b', b, DIAL_HOLD), decimals: u.pD, label: 'Boost', unit: u.pU, peak: u.P(n.peak), limit: u.maxBoost * 0.9,
                zones: [{ from: u.maxBoost * 0.9, to: sc.max, color: 'crit', tintOnly: true }],
            }, sc));
            dialScale(cv, t, u, cx, cy, r);
            if (G.isNum(tg)) {
                const a = (-135 + G.clamp((tg - sc.min) / (sc.max - sc.min), 0, 1) * 270) * Math.PI / 180;
                const p = (rr) => [cx + Math.sin(a) * rr, cy - Math.cos(a) * rr];
                const s = 12, c = t.accent2 || t.accent, [tx, ty] = p(r + 8), [ox, oy] = p(r + 30);
                const nx = Math.cos(a) * s, ny = Math.sin(a) * s;
                cv.quad([[ox - nx, oy - ny], [ox + nx, oy + ny], [tx, ty], [tx, ty]], c);
            }
            cv.text('TARGET ' + G.fmt(G.hold('d.tg', tg, DIAL_HOLD), u.pD), cx, cy - Math.round(92 * r / 214), 26, t.accent2 || t.accent, { align: 'center', font: 'bold', spacing: 1.5 });
        }

        /**
         * Tyres (as M Vitals' Chassis page): a black M3 from above, lit as in a drone photo (car_art.js), each tyre
         * coloured by its temperature (the tyre limits), its pressure beside it, green / yellow / red against the
         * car's target, the target under it, then the temperature.
         */
        function tyrePanel(cv, t, n, u, R) {
            const A = CAR_ART, ty = tyres.now(n.demo);
            // the art's box over the whole room (its frame has a margin round the car)
            const cx = 800, top = R.y0 - 12, hBox = R.y1 - R.y0 + 20, s = hBox / A.view.h, left = cx + A.view.x * s;
            const X = (mm) => cx + mm * s, Y = (mm) => top + (mm - A.view.y) * s;
            const art = (k, c, dx, dy) => cv.text(k, left + (dx || 0) * s, top + (dy || 0) * s, hBox, c, { font: A.name, literal: true });
            const lim = limits('tyre'), T = A.tyres, dec = u.psi ? 0 : 1;
            cv.text('TYRES', 548, R.y0 + 24, 18, t.dim, { font: 'bold', spacing: 2 });
            if (!n.demo && !tyres.seen) cv.text('NO TPMS DATA YET', 548, R.y0 + 46, 14, t.dim, { font: 'bold', spacing: 1.5 });

            // the car in its layers (car_art.js: floor, shadow, body, glass, ...); the tyres where the art puts them:
            // one tyre drawn at each corner, its tread lit by the temperature colour (as a thermal camera), a glow round it
            // that grows with the heat
            const corners = [['FL', -1, T.front], ['FR', 1, T.front], ['RL', -1, T.rear], ['RR', 1, T.rear]];
            const col = {};
            corners.forEach(([k]) => { const b = band(ty.t[k], lim); col[k] = { b, c: b === null ? t.dim : bandColor(t, b) }; });
            for (const [m, c, a] of A.layers) {
                if (m !== 'tyres') { art(m, withAlpha(c, a)); continue; }
                corners.forEach(([k, side, ay]) => {
                    const dx = side > 0 ? 2 * T.x : 0, dy = ay - T.front, { b, c: tc } = col[k];
                    if (b !== null) art('Q', withAlpha(tc, [0.3, 0.3, 0.5, 0.75][b]), dx, dy);
                    art('K', '#15171a', dx, dy);
                    art('W', b === null ? withAlpha(t.tick, 0.5) : withAlpha(tc, 0.92), dx, dy);
                });
            }

            // per tyre: pressure (against the target), target, temperature
            corners.forEach(([k, side, ay]) => {
                const al = side < 0 ? 'right' : 'left', lx = side < 0 ? X(-T.x - T.w / 2) - 16 : X(T.x + T.w / 2) + 16;
                const pr = u.P(ty.p[k]), tg = u.P(ty.target[k]), temp = ty.t[k], py = Y(ay) + 4;
                let pc = G.isNum(pr) ? t.text : t.dim;
                if (G.isNum(pr) && G.isNum(tg) && tg > 0) { const r = pr / tg; pc = r < 0.85 ? t.crit : r < 0.93 || r > 1.15 ? t.warn : GO; }
                const ps = G.fmt(pr, dec), unit = ' ' + u.pU;
                if (side < 0) {
                    const uw = cv.text(unit, lx, py, 20, t.dim, { align: 'right' });
                    cv.text(ps, lx - uw, py, 60, pc, { align: 'right', font: 'num' });
                } else cv.text(unit, lx + cv.text(ps, lx, py, 60, pc, { font: 'num' }), py, 20, t.dim);
                cv.text(G.isNum(tg) ? 'TARGET ' + G.fmt(tg, dec) : 'NO TARGET', lx, py + 26, 14, t.dim, { align: al, font: 'bold', spacing: 1.5 });
                cv.text((G.isNum(temp) ? G.fmt(u.T(temp), 0) : '--') + u.tU, lx, py + 64, 30, col[k].c, { align: al, font: 'bold' });
            });
        }

        /**
         * Cylinders, 3 x 2 tiles. "Last pull" (default, with the log on): the deepest retard of the pull, how
         * often timing was pulled (x3) and misfires, held until the next pull starts. "Live" or the log off:
         * the retard and misfires now, as before the pull log (no caption).
         */
        function cylinders(cv, t, n, now, C) {
            if (!logOn() || settings.get('retardView') === 'live') return liveCylinders(cv, t, n, C);
            // two rows from under the map / fuel tiles (and the caption) down to the room's bottom
            const cw = 152, gx = 1100, gy = C.top + 30, ch = Math.floor((C.y1 - gy - 10) / 2), p = pulls.shown;
            const f = Math.min(1.15, ch / 130), fs = Math.round(60 * f);
            const rec = pulls.recording, s = p ? ((p.end - p.start) / 1000).toFixed(1) + ' s' : '';
            const cap = rec ? 'RECORDING PULL · ' + s : p ? 'LAST PULL · ' + s + ' · ' + clock(p.start) : 'LAST PULL · NONE YET';
            const cc = rec ? (Math.floor(now / 400) % 2 ? t.crit : withAlpha(t.crit, 0.55)) : t.dim;
            cv.text(cap, gx + 4, gy - 10, 16, cc, { font: 'bold', spacing: 1.5 });
            for (let i = 0; i < CYL; i++) {
                const x = gx + (i % 3) * (cw + 10), y = gy + Math.floor(i / 3) * (ch + 10);
                const k = p ? p.cyl[i] : null, r6 = k ? k.max : null, mf = k ? k.mf : 0;
                const l = G.isNum(r6) ? cylLevel(r6, mf) : 0, c = levelColor(t, l);
                cv.roundRect(x, y, cw, ch, 12, withAlpha(l ? c : '#ffffff', l ? 0.22 : 0.05));
                if (l) cv.strokeRoundRect(x, y, cw, ch, 12, 2, withAlpha(c, 0.8));
                cv.text('CYL ' + (i + 1), x + 14, y + 26, 18, t.dim, { font: 'bold', spacing: 1.5 });
                if (k) cv.text('×' + k.n, x + cw - 14, y + 26, 20, k.n ? c : t.dim, { align: 'right', font: 'bold' });
                const v = G.isNum(r6) ? G.fmt(r6, 1) : '--', vw = cv.textWidth(v, fs, { font: 'num' }), vy = y + Math.round(ch / 2 + 29 * f);
                cv.text(v, x + cw / 2 - 8, vy, fs, !G.isNum(r6) ? t.dim : l ? c : t.text, { align: 'center', font: 'num' });
                if (G.isNum(r6)) cv.text('°', x + cw / 2 - 8 + vw / 2 + 2, vy - Math.round(20 * f), Math.round(26 * f), t.dim);
                cv.text(mf > 0 ? 'MISFIRE ×' + mf : 'MAX RETARD', x + cw / 2, y + ch - 11, 15, mf > 0 ? t.crit : t.dim, { align: 'center', font: 'bold', spacing: 2 });
            }
        }

        /** Cylinders live: tinted by the knock retard and misfires now (the tiles as before the pull log). */
        function liveCylinders(cv, t, n, C) {
            const cw = 152, gx = 1100, gy = C.top + 12, ch = Math.floor((C.y1 - 2 - gy - 10) / 2);
            const f = Math.min(1.15, ch / 138), fs = Math.round(64 * f);
            for (let i = 0; i < CYL; i++) {
                const x = gx + (i % 3) * (cw + 10), y = gy + Math.floor(i / 3) * (ch + 10);
                const r6 = n.retard[i], mf = n.misfire[i], l = cylLevel(r6, mf), c = levelColor(t, l);
                cv.roundRect(x, y, cw, ch, 12, withAlpha(l ? c : '#ffffff', l ? 0.22 : 0.05));
                if (l) cv.strokeRoundRect(x, y, cw, ch, 12, 2, withAlpha(c, 0.8));
                cv.text('CYL ' + (i + 1), x + 14, y + 28, 18, t.dim, { font: 'bold', spacing: 1.5 });
                cv.text(mf > 0 ? 'MF ' + mf : '', x + cw - 14, y + 28, 18, t.crit, { align: 'right', font: 'bold', spacing: 1 });
                const v = G.fmt(r6, 1), vw = cv.textWidth(v, fs, { font: 'num' }), vy = y + Math.round(ch / 2 + 31 * f);
                cv.text(v, x + cw / 2 - 8, vy, fs, l ? c : t.text, { align: 'center', font: 'num' });
                cv.text('°', x + cw / 2 - 8 + vw / 2 + 2, vy - Math.round(22 * f), Math.round(28 * f), t.dim);
                cv.text(mf > 0 ? 'MISFIRE' : 'RETARD', x + cw / 2, y + ch - 12, 15, mf > 0 ? t.crit : t.dim, { align: 'center', font: 'bold', spacing: 2 });
            }
        }

        /** hh:mm:ss of a time in ms */
        const clock = (ms) => { const d = new Date(ms), z = (x) => ('0' + x).slice(-2); return z(d.getHours()) + ':' + z(d.getMinutes()) + ':' + z(d.getSeconds()); };

        /* ---------------- Log: the last pulls ---------------- */
        function logPage(cv, t, u, now) {
            const bottom = G.pageBottom(cv) - 8;
            const on = logOn();
            cv.text('PULL LOG', 40, 80, 22, t.dim, { font: 'bold', spacing: 2.5 });
            if (on) cv.text('last ' + KEEP + ' pulls · a pull starts at ' + (settings.get('pullStart') || 80) + '% accelerator · newest on top', 190, 80, 20, t.dim);
            else cv.text('LOGGING IS OFF · new pulls are not recorded', 190, 80, 20, t.warn, { font: 'bold', spacing: 1 });
            // on / off: the same as the setting "Pull log: record pulls"
            G.button(cv, t, 1176, 50, 200, 44, on ? 'Log: on' : 'Log: off', () => { settings.set('pullLog', !on); return render(); },
                { key: 'logOnOff', color: on ? GO : t.warn, primary: !on });
            G.button(cv, t, 1396, 50, 180, 44, 'Clear log', () => { pulls.clear(); return render(); }, { key: 'clearLog', confirm: true, color: t.crit });
            // columns: #, time, length, speed, peak boost, map, intake air, then cylinders 1-6
            const cols = [['#', 40], ['Time', 116], ['Length', 86], ['Speed km/h', 150], ['Boost', 100], ['Map', 64], ['IAT', 80]];
            const x0 = 32, cylW = (1576 - x0 - cols.reduce((a, c) => a + c[1], 0)) / CYL;
            const hy = 132, top = 146, rows = pulls.recording ? [pulls.cur].concat(pulls.list.slice(0, KEEP - 1)) : pulls.list.slice(0, KEEP);
            const rh = Math.min(42, (bottom - top) / KEEP);
            let x = x0;
            cols.forEach(([h, w]) => { cv.text(h.toUpperCase(), x, hy, 15, t.dim, { font: 'bold', spacing: 1.5 }); x += w; });
            const cx0 = x;
            for (let i = 0; i < CYL; i++) cv.text('CYL ' + (i + 1), cx0 + i * cylW, hy, 15, t.dim, { font: 'bold', spacing: 1.5 });
            cv.fillRect(x0 - 8, top - 4, 1576 - x0 + 8, 1, withAlpha('#ffffff', 0.2));
            if (!rows.length) {
                cv.text(on ? 'No pulls yet. Press the accelerator past ' + (settings.get('pullStart') || 80) + '% for a pull; the knock retard of each one is kept here.'
                    : 'No pulls logged. The log is off: tap "Log: off" to record pulls again.', 40, top + 60, 24, t.dim);
                return;
            }
            rows.forEach((p, r) => {
                const y = top + r * rh, base = y + rh * 0.68, rec = pulls.recording && r === 0;
                if (r % 2) cv.fillRect(x0 - 8, y, 1576 - x0 + 8, rh, withAlpha('#ffffff', 0.03));
                if (rec) cv.fillRect(x0 - 8, y, 1576 - x0 + 8, rh, withAlpha(t.crit, 0.12));
                const len = ((p.end - p.start) / 1000).toFixed(1) + ' s';
                const cells = [
                    [rec ? 'REC' : String(r + (pulls.recording ? 0 : 1)), rec ? t.crit : t.dim],
                    [clock(p.start), t.text], [len, t.text],
                    [Math.round(p.v0 || 0) + ' – ' + Math.round(p.v1 || 0), t.text],
                    [G.fmt(u.P(p.boost), u.pD), t.accent2 || t.accent], [p.map ? String(p.map) : '-', t.text],
                    [G.fmt(u.T(p.iat), 0) + '°', t.text],
                ];
                let xx = x0;
                cells.forEach(([s, c], k) => { cv.text(s, xx, base, 22, c, { font: 'bold' }); xx += cols[k][1]; });
                p.cyl.forEach((k, i) => {
                    const l = cylLevel(k.max, k.mf), c = l ? levelColor(t, l) : t.dim, cx = cx0 + i * cylW;
                    if (l) cv.roundRect(cx - 6, y + 4, cylW - 10, rh - 8, 6, withAlpha(c, 0.16));
                    const w = cv.text(G.fmt(k.max, 1) + '°', cx, base, 22, l ? c : t.text, { font: 'bold' });
                    cv.text('×' + k.n + (k.mf ? '  MF' + k.mf : ''), cx + w + 10, base, 18, k.mf ? t.crit : k.n ? c : t.dim, { font: 'bold' });
                });
            });
        }

        /* ---------------- Boost ---------------- */
        function boostPage(cv, t, n, u) {
            const win = settings.get('window') || 30, now = Date.now();
            const pts = tune.hist.filter((h) => now - h[0] <= win * 1000);
            const act = t.accent2 || t.accent;
            const dev = G.isNum(n.boost) && G.isNum(n.target) ? u.P(n.boost) - u.P(n.target) : null;
            const maxT = settings.get('maxTorque'), maxP = settings.get('maxPower');
            const pct = (v, m) => (G.isNum(v) && m ? v / m : null);
            // the numbers in a row; torque and power with their share of the engine's maximum (settings)
            [
                ['Actual', G.fmt(G.hold('b.a', u.P(n.boost), 150), u.pD), u.pU, act],
                ['Target', G.fmt(u.P(n.target), u.pD), u.pU, t.text],
                ['Deviation', G.isNum(dev) ? (dev > 0 ? '+' : '') + G.fmt(dev, u.pD) : '--', u.pU, G.isNum(dev) && Math.abs(dev) > (u.psi ? 2 : 0.15) ? t.warn : t.text],
                ['Peak', G.fmt(u.P(n.peak), u.pD), u.pU, t.dim],
                ['Torque', G.fmt(G.hold('b.tq', n.torque, 150), 0), 'Nm', t.text, pct(n.torque, maxT)],
                ['Power', G.fmt(G.hold('b.hp', n.power, 150), 0), 'hp', t.text, pct(n.power, maxP)],
                ['RPM', G.fmt(G.hold('b.rpm', n.rpm, 150), 0), '', t.text],
            ].forEach(([label, s, unit, c, f], i) => {
                const x = 32 + i * 222;
                cv.text(label.toUpperCase(), x, 76, 18, t.dim, { font: 'bold', spacing: 2 });
                const w = cv.text(s, x, 128, 64, c, { font: 'num' });
                if (unit) cv.text(unit, x + w + 6, 128, 20, t.dim);
                if (f !== undefined) {
                    cv.fillRect(x, 140, 190, 3, t.track);
                    if (G.isNum(f) && f > 0) cv.fillRect(x, 140, 190 * G.clamp(f, 0, 1), 3, f > 0.95 ? t.warn : act);
                }
            });
            // actual (filled) over target, scaled to the engine's max boost
            const bottom = G.pageBottom(cv);
            const xs = (h) => (h[0] - now) / 1000;
            G.chart(cv, t, 24, 156, 1552, bottom - 156 - 132, {
                xMin: -win, xMax: 0, yMin: u.chartMin, yMax: u.pMax, yStep: u.pStep, yUnit: u.pU, xFmt: () => '', padBottom: 8,
                marks: [{ y: 0, color: t.tick }, { y: u.maxBoost, color: 'crit', label: 'MAX ' + G.fmt(u.maxBoost, u.psi ? 0 : 2) }],
                series: [
                    { pts: pts.map((h) => [xs(h), u.P(h[1])]), color: act, width: 4, fill: 0.22 },
                    { pts: pts.map((h) => [xs(h), u.P(h[2])]), color: withAlpha(t.text, 0.9), width: 2 },
                ],
                empty: 'Waiting for data',
            });
            // deviation: above target in amber, below in blue
            const dmax = u.psi ? 6 : 0.4;
            const g = G.chart(cv, t, 24, bottom - 110, 1552, 110, {
                xMin: -win, xMax: 0, yMin: -dmax, yMax: dmax, yStep: dmax, xFmt: (v) => (v === 0 ? 'now' : v + ' s'),
                yFmt: (v) => (v > 0 ? '+' : '') + G.fmt(v, u.psi ? 0 : 1),
            });
            const z = g.Y(0);
            cv.clip(g.px, g.py, g.pw, g.ph);
            pts.forEach((h) => {
                if (!G.isNum(h[1]) || !G.isNum(h[2])) return;
                const d = u.P(h[1]) - u.P(h[2]), x = g.X(xs(h)), y = g.Y(G.clamp(d, -dmax, dmax));
                cv.fillRect(x - 1.5, Math.min(y, z), 3, Math.max(1, Math.abs(y - z)), d > 0 ? t.warn : t.cold);
            });
            cv.noclip();
            cv.text('DEVIATION', g.px + 8, g.py + 18, 16, t.dim, { font: 'bold', spacing: 2 });
        }

        /* ---------------- Maps ---------------- */
        function tapMap(n) {
            return () => {
                ctx.log.info('maps: tap on map ' + n + ' (page ' + (onMaps ? 'maps' : PAGES[page]) + ', armed ' + (pick ? pick.n : '-') + ')');
                if (maps.busy) return render();
                if (pick && pick.n === n && Date.now() - pick.at < CONFIRM_MS) {
                    pick = null;
                    const p = maps.setMap(n);
                    render();
                    return p.then(repaint);
                }
                pick = { n, at: Date.now() };
                setTimeout(repaint, CONFIRM_MS + 50);
                return render();
            };
        }

        function mapsPage(cv, t, u, now) {
            const act = t.accent2 || t.accent, live = maps.live;
            cv.text('ENGINE MAP', 40, 82, 22, t.dim, { font: 'bold', spacing: 2.5 });
            cv.text('MHD · maps 1-4', 230, 82, 20, t.dim);
            G.pill(cv, t, 1296, 58, 280, 34, live ? 'MHD · SENDS TO THE DME' : 'SIMULATED', { color: live ? GO : 'warn', size: 16 });
            if (pick && now - pick.at >= CONFIRM_MS) pick = null;
            const tw = (1552 - 3 * 16) / MAPS, ty = 106, th = 246;
            for (let i = 0; i < MAPS; i++) {
                const n = i + 1, x = 24 + i * (tw + 16), on = maps.map === n, armed = pick && pick.n === n;
                const c = armed ? t.warn : on ? act : '#ffffff';
                cv.roundRect(x, ty, tw, th, 16, withAlpha(c, on || armed ? 0.2 : 0.05));
                cv.strokeRoundRect(x, ty, tw, th, 16, on || armed ? 3 : 1.5, withAlpha(c, on || armed ? 0.95 : 0.25));
                cv.text('MAP', x + 24, ty + 40, 20, t.dim, { font: 'bold', spacing: 2 });
                if (on) G.pill(cv, t, x + tw - 140, ty + 16, 120, 32, 'ACTIVE', { color: act, size: 16 });
                cv.text(String(n), x + tw / 2, ty + 170, 150, on ? act : t.text, { align: 'center', font: 'num' });
                const name = mapName(n);
                cv.text(armed ? 'TAP AGAIN TO SWITCH' : name ? name.toUpperCase() : ' ', x + tw / 2, ty + 222, armed ? 20 : 26,
                    armed ? t.warn : t.text, { align: 'center', font: 'bold', spacing: armed ? 1.5 : 1 });
                cv.target(x, ty, tw, th, tapMap(n), 'map' + n);
            }
            // status and the note about MHD
            const bottom = G.pageBottom(cv) - G.MARGIN;
            const note = maps.busy ? 'Sending…' : maps.note || (maps.map ? 'Map ' + maps.map + ' is the last one switched from this app' : 'No map switched from this app yet');
            const nc = maps.noteType === 'go' ? GO : maps.noteType === 'warn' ? t.warn : t.text;
            cv.text(note, 40, ty + th + 46, 26, nc, { font: 'bold' });
            cv.text(live ? 'MHD reports no active map: the app shows the last map it switched to.' : 'Settings, Map switching: "MHD: send to the DME" to switch maps on the car.',
                40, ty + th + 82, 20, t.dim);
            G.button(cv, t, 1376, bottom - 56, 200, 56, 'Back', () => { onMaps = false; pick = null; return render(); }, { key: 'mapsBack' });
        }

        function render() {
            const t = ctx.theme(), n = tune.now, u = units(settings), now = Date.now();
            const cv = ctx.canvas(W, H).clear(t.bg);
            if (onMaps) mapsPage(cv, t, u, now);
            else if (PAGES[page] === 'boost') boostPage(cv, t, n, u);
            else if (PAGES[page] === 'log') logPage(cv, t, u, now);
            else vitals(cv, t, n, u, now);
            const badge = 'MAP ' + (maps.map || '-') + ' · ' + ethText(n.ethanol);
            G.frame(cv, t, ['Vitals', 'Boost', 'Log'], onMaps ? -1 : page, [n.demo && { text: 'DEMO' },
                pulls.recording && { text: 'PULL', color: 'crit' }, { text: badge, color: 'accent2' }]);
            return ui.image('MAIN_GFX', cv);
        }

        ui.onClick('BTN_PAGE', () => { onMaps = false; page = (page + 1) % PAGES.length; return render(); });
        ctx.onTab((i) => { onMaps = false; page = i; return render(); });
        settings.onChange((k) => { if (k === 'page') page = Math.max(0, PAGES.indexOf(settings.get('page'))); });
        ctx.loop('MAIN', 10, render);
        render().catch((e) => ctx.log.warn('first render: ' + e));
    },
});
