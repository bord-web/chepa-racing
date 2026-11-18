'use strict';
/**
 * tune.js - the tuner values for the dashboard, and their history for the boost chart.
 *
 * On the car the engine-unit values come from the DME (dme.js: boost and its target, intake air,
 * gearbox oil, knock retard and misfires per cylinder; ethanol.js: ethanol), none where it gives none.
 * In the demo drive they are simulated from engine speed and torque (kit/car.js), scaled to the
 * engine's maximum boost and torque from the settings.
 *
 *   const tune = new Tune(() => ({ maxBoost, maxTorque }));
 *   car.onSample((d, t) => tune.feed(d, t), () => tune.reset());
 *   tune.now   -> { oil, coolant, gearbox, iat, ethanol, boost, target, peak, targetPeak, rpm, speed, pedal, torque, power, retard[6], misfire[6] }
 *                 peak, targetPeak: the highest boost and target lately (PeakHold)
 *   tune.hist  -> [[t, boost, target, rpm], ...] at 10 Hz, the last 3 minutes
 */
const CYL = 6;
const HIST_MS = 180000, HIST_STEP = 100;
const PSI = 14.5038;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const isNum = (x) => typeof x === 'number' && isFinite(x);
const HOLD_MS = 10000;                   // the peaks: how long a high stays once the pedal came back
const HOLD_DROP = 20;                    // % of accelerator: this far back from where it was at the peak starts the count
const FALL_MS = 70;                      // the peaks' fall on the dial: its time constant

/**
 * The highest value lately (0 at the least): follows the value up at once and remembers where the pedal was then.
 * The count of HOLD_MS starts when the pedal is HOLD_DROP back from there (a peak with the pedal under HOLD_DROP, or
 * without a pedal value: at once); after it the value drops to the value now and holds that in turn. A gap in the
 * pedal's readings changes nothing: its last value counts.
 */
class PeakHold {
    constructor() { this.v = null; this.t = 0; this.p = null; this.at = null; this.counting = true; }

    /** One sample: x, at t (ms), the pedal (%). Returns the value to show. */
    feed(x, t, pedal) {
        if (isNum(pedal)) this.p = pedal;
        if (!this.counting && this.p <= this.at - HOLD_DROP) { this.counting = true; this.t = t; }
        const over = this.counting && t - this.t >= HOLD_MS;
        if (!isNum(x)) { if (over) this.v = null; return this.v; }
        const c = Math.max(0, x);
        if (this.v === null || c >= this.v) {
            this.v = c; this.t = t; this.at = this.p;
            this.counting = this.p === null || this.p < HOLD_DROP;
        } else if (over) { this.v = c; this.t = t; }
        return this.v;
    }
}

/** A peak on the dial as it is drawn: up with the value at once, down to it quickly and smoothly (about 0.4 s). */
class Falling {
    constructor() { this.x = null; this.t = 0; }

    feed(v, t) {
        if (!isNum(v)) { this.x = null; return v; }
        if (this.x === null || v >= this.x) this.x = v;
        else {
            this.x = v + (this.x - v) * Math.exp(-Math.max(0, t - this.t) / FALL_MS);
            if (this.x - v < 0.005) this.x = v;
        }
        this.t = t;
        return this.x;
    }
}

class Tune {
    /** limits() -> { maxBoost (bar), maxTorque (Nm) }: the engine as tuned (settings). */
    constructor(limits) { this.limits = limits || (() => ({ maxBoost: 2.5, maxTorque: 650 })); this.reset(); }

    reset() {
        this.lastT = 0; this.lastHist = 0;
        this.x = -0.6; this.v = 0;                       // boost (bar, above ambient) and its rate
        this.iat = 24; this.gearbox = 32;
        this.retard = new Array(CYL).fill(0);
        this.misfire = new Array(CYL).fill(0);
        this.holdBoost = new PeakHold(); this.holdTarget = new PeakHold();
        this.hist = [];
        this.now = { retard: this.retard, misfire: this.misfire, ethanol: null };
    }

    /**
     * Boost target (bar above ambient) for engine speed and load: spool-up between `spool` [from, to] rpm,
     * plateau at `top`, taper to the redline.
     */
    static target(rpm, load, top, spool) {
        if (!isNum(rpm)) return null;
        if (load < 0.08) return -0.6 + load * 4;         // throttled: manifold vacuum
        const s = clamp((rpm - spool[0]) / (spool[1] - spool[0]), 0, 1), taper = rpm > 5800 ? 1 - clamp((rpm - 5800) / 1400, 0, 1) * 0.12 : 1;
        return -0.6 + (0.6 + top * Math.pow(s, 0.8) * taper) * clamp((load - 0.08) / 0.92, 0, 1);
    }

    /** The demo drive's torque for this engine: its throttle x the torque curve, up to the max torque (setting). */
    static demoTorque(rpm, throttle, maxTorque, spool) {
        const curve = clamp(0.45 + 0.55 * (rpm - 1200) / (spool[1] - 1200), 0.45, 1) * (rpm > 6800 ? 0.96 : 1);
        return 40 + (maxTorque - 40) * clamp(throttle, 0, 1) * curve;
    }

    /**
     * One sample. On the car d carries the DME's values (dme.js: boost, target, iat, gearbox, retard[6],
     * misfire[6]; ethanol.js: ethanol), each null without one; the demo drive's are simulated here.
     */
    feed(d, tMs) {
        const t = tMs || Date.now(), dt = this.lastT ? clamp((t - this.lastT) / 1000, 0, 0.25) : 0.05;
        this.lastT = t;
        const lim = this.limits();
        // bigger turbos (more boost than a stock S58's ~2 bar: hybrids) spool later and answer slower
        const big = clamp(lim.maxBoost - 2, 0, 2);
        const spool = [1300 + big * 600, 3000 + big * 800];
        const rpm = d.rpm;
        let torque = isNum(d.torque) ? d.torque : null;
        if (d.demo && isNum(d.throttle) && isNum(rpm)) torque = Tune.demoTorque(rpm, d.throttle, lim.maxTorque, spool);
        const load = clamp(((torque === null ? 40 : torque) - 40) / (lim.maxTorque * 0.85), 0, 1);
        const num = (v) => (isNum(v) ? v : null), cyl = (a) => Array.from({ length: CYL }, (_, i) => num(a && a[i]));
        let boost, target, iat, gearbox, retard, misfire;
        if (d.demo) {
            target = Tune.target(rpm, load, lim.maxBoost * 0.85, spool);
            this.simulate(d, dt, rpm, load, target, big);
            boost = this.x + (Math.random() - 0.5) * 0.02;
            ({ iat, gearbox, retard, misfire } = this);
        } else {
            boost = num(d.boost); target = num(d.target); iat = num(d.iat); gearbox = num(d.gearbox);
            retard = cyl(d.retard); misfire = cyl(d.misfire);
        }
        // accelerator (0..100 %): the demo drive's throttle, or the pedal's real position; none without one
        const pedal = isNum(d.throttle) ? d.throttle * 100 : num(d.pedal);
        this.now = {
            rpm, load, pedal, speed: d.speed, boost, target,
            peak: this.holdBoost.feed(boost, t, pedal), targetPeak: this.holdTarget.feed(target, t, pedal),
            torque, power: isNum(torque) && isNum(rpm) ? Math.max(0, torque * rpm / 7121) : null,   // mechanical hp
            oil: d.oil, coolant: d.coolant, iat, gearbox,
            // ethanol: the DME's (ethanol.js, d.ethanol) on the car; simulated only in the demo
            ethanol: d.demo ? 37 + 0.4 * Math.sin(t / 200000) : num(d.ethanol),
            retard, misfire, demo: d.demo,
            // the engine's mean knock retard (deg, 0 or less): the DME's own number on the car
            kr: d.demo ? retard.reduce((a, b) => a + b, 0) / CYL : num(d.kr),
        };
        if (t - this.lastHist >= HIST_STEP) {
            this.lastHist = t;
            this.hist.push([t, boost, target, rpm]);
            while (this.hist.length && t - this.hist[0][0] > HIST_MS) this.hist.shift();
        }
    }

    /** The demo drive's engine-unit values: boost after its target, intake air, gearbox oil, knock retard, misfires. */
    simulate(d, dt, rpm, load, target, big) {
        // the turbos follow their target with lag and a little overshoot (second order)
        if (isNum(target)) {
            const w = 8 - big * 2, z = 0.55;
            let h = dt;
            while (h > 0) { const s = Math.min(h, 0.01); const a = w * w * (target - this.x) - 2 * z * w * this.v; this.v += a * s; this.x += this.v * s; h -= s; }
        }
        // intake air heats with boost, cools with airflow; gearbox oil follows engine oil slowly
        const amb = 22, spd = isNum(d.speed) ? d.speed : 0;
        this.iat += dt * (Math.max(0, this.x) * load * 2.2 - (this.iat - amb - 3) * 0.015 * (1 + spd / 50));
        const oil = isNum(d.oil) ? d.oil : 60;
        this.gearbox += dt * (0.012 * (oil - 4 - this.gearbox) + load * 0.04);
        // knock retard: high load and hot intake air pull timing (cylinder 5 most), recovering 1.2 deg/s
        const hot = this.iat > 45 ? 1.8 : 1;
        for (let i = 0; i < CYL; i++) {
            this.retard[i] = Math.min(0, this.retard[i] + dt * 1.2);
            const chance = load > 0.75 && rpm > 3800 ? dt * (i === 4 ? 0.9 : 0.22) * hot : 0;
            if (Math.random() < chance) this.retard[i] = Math.max(-6, this.retard[i] - (1.5 + Math.random() * (i === 4 ? 3 : 1.5)));
            if (load > 0.85 && rpm > 5500 && Math.random() < dt * (i === 4 ? 0.05 : 0.004)) this.misfire[i]++;
        }
    }

    resetCounters() { this.misfire.fill(0); this.holdBoost = new PeakHold(); this.holdTarget = new PeakHold(); }
}

/**
 * Display units from the settings: temperatures (C / F), boost (bar / psi) and the boost scale:
 * from 0 up to the engine's maximum boost (setting), rounded up to a half bar (5 psi). Below 0 the
 * dial rests at its start; the number still shows the real value. A scale over 4 bar (60 psi) has its
 * numbers every 1 bar (10 psi), so they keep their room on the dial and the chart, which then starts at 0.
 */
function units(settings) {
    const F = settings.get('tempUnit') === 'f', psi = settings.get('pressUnit') === 'psi';
    const maxBar = settings.get('maxBoost') || 2.0;
    const k = psi ? PSI : 1, fine = psi ? 5 : 0.5;
    const max = Math.max(2 * fine, Math.ceil(maxBar * k / fine - 1e-9) * fine);
    const wide = max > (psi ? 60 : 4), step = wide ? 2 * fine : fine;
    return {
        T: (c) => (isNum(c) ? (F ? c * 9 / 5 + 32 : c) : null), tU: F ? '°F' : '°C',
        P: (b) => (isNum(b) ? b * k : null), pU: psi ? 'psi' : 'bar', pD: psi ? 1 : 2,
        pMin: 0, pMax: max, pStep: step, chartMin: wide ? 0 : -step,
        maxBoost: maxBar * k, psi,
    };
}

/** Ethanol content as the fuel's name: 37.4 % -> 'E37' (whole numbers only). */
const ethText = (e) => (isNum(e) ? 'E' + Math.round(e) : 'E--');

/** Severity of a cylinder: 0 fine, 1 some retard, 2 heavy retard or a misfire. */
function cylLevel(retard, misfire) {
    if (misfire > 0 || retard <= -3) return 2;
    if (retard <= -1) return 1;
    return 0;
}

module.exports = { Tune, PeakHold, Falling, HOLD_MS, units, cylLevel, ethText, CYL, isNum, clamp };
