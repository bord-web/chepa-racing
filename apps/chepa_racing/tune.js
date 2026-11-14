'use strict';
/**
 * tune.js - the tuner values for the dashboard, and their history for the boost chart.
 *
 * Design stage: the engine-unit values (boost and its target, intake air, gearbox oil, knock
 * retard and misfires per cylinder) are simulated from engine speed and torque (kit/car.js: the
 * car, the emulator's sliders or the demo drive), scaled to the engine's maximum boost and torque
 * from the settings. Later they come from the DME over UDS. Ethanol already does on the car
 * (ethanol.js, fed in as d.ethanol); it is simulated (E37) only in the demo.
 *
 *   const tune = new Tune(() => ({ maxBoost, maxTorque }));
 *   car.onSample((d, t) => tune.feed(d, t), () => tune.reset());
 *   tune.now   -> { oil, coolant, gearbox, iat, ethanol, boost, target, rpm, speed, pedal, torque, power, retard[6], misfire[6] }
 *   tune.hist  -> [[t, boost, target, rpm], ...] at 10 Hz, the last 3 minutes
 */
const CYL = 6;
const HIST_MS = 180000, HIST_STEP = 100;
const PSI = 14.5038;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const isNum = (x) => typeof x === 'number' && isFinite(x);

class Tune {
    /** limits() -> { maxBoost (bar), maxTorque (Nm) }: the engine as tuned (settings). */
    constructor(limits) { this.limits = limits || (() => ({ maxBoost: 2.5, maxTorque: 650 })); this.reset(); }

    reset() {
        this.lastT = 0; this.lastHist = 0;
        this.x = -0.6; this.v = 0;                       // boost (bar, above ambient) and its rate
        this.iat = 24; this.gearbox = 32;
        this.retard = new Array(CYL).fill(0);
        this.misfire = new Array(CYL).fill(0);
        this.peak = null;
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
        const target = Tune.target(rpm, load, lim.maxBoost * 0.85, spool);
        // the turbos follow their target with lag and a little overshoot (second order)
        if (isNum(target)) {
            const w = 8 - big * 2, z = 0.55;
            let h = dt;
            while (h > 0) { const s = Math.min(h, 0.01); const a = w * w * (target - this.x) - 2 * z * w * this.v; this.v += a * s; this.x += this.v * s; h -= s; }
        }
        const boost = this.x + (Math.random() - 0.5) * 0.02;
        if (boost > 0 && (this.peak === null || boost > this.peak)) this.peak = boost;

        // intake air heats with boost, cools with airflow; gearbox oil follows engine oil slowly
        const amb = 22, spd = isNum(d.speed) ? d.speed : 0;
        this.iat += dt * (Math.max(0, boost) * load * 2.2 - (this.iat - amb - 3) * 0.015 * (1 + spd / 50));
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

        // accelerator (0..100 %): the demo drive's throttle, a pedal value when the car gives one, else engine load
        const pedal = isNum(d.throttle) ? d.throttle * 100 : isNum(d.pedal) ? d.pedal : torque === null ? null : load * 100;
        this.now = {
            rpm, load, pedal, speed: d.speed, boost, target, peak: this.peak,
            torque, power: isNum(torque) && isNum(rpm) ? Math.max(0, torque * rpm / 7121) : null,   // mechanical hp
            oil: d.oil, coolant: d.coolant, gearbox: this.gearbox, iat: this.iat,
            // ethanol: the DME's (ethanol.js, d.ethanol) on the car; simulated only in the demo
            ethanol: d.demo ? 37 + 0.4 * Math.sin(t / 200000) : isNum(d.ethanol) ? d.ethanol : null,
            retard: this.retard, misfire: this.misfire, demo: d.demo,
        };
        if (t - this.lastHist >= HIST_STEP) {
            this.lastHist = t;
            this.hist.push([t, boost, target, rpm]);
            while (this.hist.length && t - this.hist[0][0] > HIST_MS) this.hist.shift();
        }
    }

    resetCounters() { this.misfire.fill(0); this.peak = null; }
}

/**
 * Display units from the settings: temperatures (C / F), boost (bar / psi) and the boost scale:
 * from its start (setting, e.g. -0.2 bar) up to the engine's maximum boost (setting), rounded up
 * to a whole scale step. Below the start (vacuum) the dial rests at its start; the number still
 * shows the real value.
 */
function units(settings) {
    const F = settings.get('tempUnit') === 'f', psi = settings.get('pressUnit') === 'psi';
    const maxBar = settings.get('maxBoost') || 2.0;
    const minBar = isNum(settings.get('minBoost')) ? settings.get('minBoost') : -0.2;
    const k = psi ? PSI : 1, step = psi ? 5 : 0.5;
    const min = Math.round(minBar * k * 10) / 10;
    const max = Math.max(min + 2 * step, Math.ceil(maxBar * k / step - 1e-9) * step);
    return {
        T: (c) => (isNum(c) ? (F ? c * 9 / 5 + 32 : c) : null), tU: F ? '°F' : '°C',
        P: (b) => (isNum(b) ? b * k : null), pU: psi ? 'psi' : 'bar', pD: psi ? 1 : 2,
        pMin: min, pMax: max, pStep: step, chartMin: Math.floor(min / step - 1e-9) * step,
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

module.exports = { Tune, units, cylLevel, ethText, CYL, isNum, clamp };
