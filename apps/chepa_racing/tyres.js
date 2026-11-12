'use strict';
/**
 * tyres.js - tyre pressures and temperatures from the car's TPMS (read as BMW's own M Vitals reads
 * them, apps/car_vitals), or a demo that warms the tyres with the demo drive.
 *
 * de.bmw.infotainment.vehicle.TPMS
 *   statusTyrePressure / statusTargetTyrePressure   0.1 per bit in the car's pressure unit (bar / kPa / psi),
 *                                                   65532 and up = no value
 *   statusTyreTemperature                           degrees + 40 in the car's temperature unit, 65535 = no value
 * de.bmw.infotainment.vehicle.Vehicle.statusNewCurrentUnitsStatusExt tells those units. Until it does, the
 * pressures tell them: tyre pressures in bar (0.5-6), psi (7-60) and kPa (60-600) don't overlap; psi also
 * means deg F. The car may not send changes, so the TPMS is also read every 10 s.
 *
 *   tyres.now(demo) -> { p: { FL, FR, RL, RR } bar, target: { ... } bar, t: { ... } deg C }   (null: no value)
 */
const CORNERS = ['FL', 'FR', 'RL', 'RR'];
const TPMS = 'de.bmw.infotainment.vehicle.TPMS';
const UNITS_IF = 'de.bmw.infotainment.vehicle.Vehicle';
const P_OK = [0.5, 6], PT_OK = [1, 6], T_OK = [-40, 150];
const PRESS_UNITS = { 1: 'BAR', 2: 'KPA', 3: 'PSI' }, TEMP_UNITS = { 1: 'C', 2: 'F' };
const TO_BAR = { BAR: 1, KPA: 0.01, PSI: 1 / 14.5038 };
const unitName = (map, v) => map[v] || (Object.values(map).indexOf(v) >= 0 ? v : null);
const inside = (v, r) => (typeof v === 'number' && isFinite(v) && v >= r[0] && v <= r[1] ? v : null);
const empty = () => ({ FL: null, FR: null, RL: null, RR: null });

/** Demo: the tyres warm with speed, throttle (rears) and cornering (fronts) and cool towards the air; pressures follow. */
class TyreSim {
    constructor() {
        this.air = 22;
        this.t = { FL: 24, FR: 25, RL: 24, RR: 23 };
        this.cold = { FL: 2.42, FR: 2.4, RL: 2.62, RR: 2.6 };            // set cold (20 deg C)
        this.target = { FL: 2.5, FR: 2.5, RL: 2.7, RR: 2.7 };
        this.at = 0;
    }
    step(d, ms) {
        const dt = this.at ? Math.min(1, (ms - this.at) / 1000) : 0;
        this.at = ms;
        if (!dt) return;
        const v = d.speed || 0, thr = d.throttle || 0, lat = Math.abs(d.gLat || 0), lon = Math.abs(d.gLong || 0);
        for (const k of CORNERS) {
            const front = k[0] === 'F', out = (k[1] === 'L') === ((d.gLat || 0) > 0);       // the outer side in a bend
            const heat = v / 100 * 0.25 + (front ? lat * 3.5 * (out ? 1.4 : 0.7) + lon * 0.8 : thr * 1.6 + lat * 2);
            const cool = (this.t[k] - this.air) * (0.004 + v / 100 * 0.006);
            this.t[k] = Math.min(115, this.t[k] + (heat - cool) * dt);
        }
    }
    now() {
        const p = {}, t = {};
        // a gas: the pressure grows with the absolute temperature
        for (const k of CORNERS) { t[k] = this.t[k]; p[k] = this.cold[k] * (this.t[k] + 273) / 293; }
        return { p, target: Object.assign({}, this.target), t };
    }
}

class Tyres {
    constructor(log) {
        this.log = log;
        this.units = { press: null, temp: null, psiSeen: false };
        this.live = { p: empty(), target: empty(), t: empty() };
        this.sim = new TyreSim();
        this.seen = false;                          // the car sent tyre values
    }

    /** Subscribe to the car's TPMS and display units. */
    watch(ctx) {
        const log = ctx.log;
        ctx.signals.watch(TPMS, '1', {
            statusTyrePressure: (v) => this.pressures(v),
            statusTargetTyrePressure: (v) => this.targets(v),
            statusTyreTemperature: (v) => this.temperatures(v),
        }, log, { pollMs: 10000 }).then((s) => log.info('signal TPMS ' + (s && s.error ? 'error: ' + s.error : 'subscribed'))).catch(() => {});
        ctx.signals.watch(UNITS_IF, '1', { statusNewCurrentUnitsStatusExt: (v) => this.carUnits(v) }, log)
            .then((s) => log.info('signal car units ' + (s && s.error ? 'error: ' + s.error : 'subscribed'))).catch(() => {});
    }

    carUnits(v) {
        const press = unitName(PRESS_UNITS, v && v.unitOfMeasurementAirPressure), temp = unitName(TEMP_UNITS, v && v.unitOfMeasurementTemperature);
        if (press === this.units.press && temp === this.units.temp) return;
        this.units.press = press; this.units.temp = temp;
        if (this.log) this.log.info('tyres: car units ' + (press || '?') + ' / ' + (temp || '?'));
    }

    /** A raw pressure -> bar (null: none). */
    bar(raw) {
        if (typeof raw !== 'number' || raw >= 65532) return null;
        const v = raw * 0.1, k = TO_BAR[this.units.press];
        if (k) return v * k;
        if (v >= P_OK[0] && v <= P_OK[1]) return v;
        if (v >= 7 && v < 60) { this.units.psiSeen = true; return v / 14.5038; }
        if (v >= 60 && v <= 600) return v / 100;
        return null;
    }

    /** A raw temperature -> deg C (null: none). */
    celsius(raw) {
        if (typeof raw !== 'number' || raw === 65535) return null;
        const v = raw - 40, f = this.units.temp ? this.units.temp === 'F' : this.units.psiSeen;
        return f ? (v - 32) * 5 / 9 : v;
    }

    _put(into, v, field, fn, ok) {
        if (!v) return;
        for (const k of CORNERS) {
            const raw = v[field + 'Tyre' + k + 'H'];
            if (raw !== undefined) into[k] = inside(fn(raw), ok);
        }
        this.seen = true;
    }
    pressures(v) { this._put(this.live.p, v, 'actualValuePressure', (r) => this.bar(r), P_OK); }
    targets(v) { this._put(this.live.target, v, 'targetPressure', (r) => this.bar(r), PT_OK); }
    temperatures(v) { this._put(this.live.t, v, 'actualValueTemperature', (r) => this.celsius(r), T_OK); }

    /** The demo tyres follow the car's (demo) samples. */
    step(d, ms) { this.sim.step(d, ms); }

    now(demo) { return demo ? this.sim.now() : this.live; }
}

module.exports = { Tyres, TyreSim, CORNERS };
