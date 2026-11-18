'use strict';
/**
 * pulls.js - knock retard and misfires per pull (one hard acceleration).
 *
 * A pull starts when the accelerator stays at or over the start threshold (setting, % ) for 0.3 s:
 * the last pull's numbers are dropped and new ones are caught. It ends when the accelerator stays
 * under the end threshold for 0.7 s. While it runs, per cylinder:
 *   n    how often the DME pulled timing (the retard deepened by STEP deg or more since the last sample)
 *   max  the deepest retard (deg, <= 0)
 *   mf   misfires (growth of the engine unit's counter)
 * plus the pull's speed, rpm, peak boost, hottest intake air, map, ethanol and the engine's deepest mean
 * retard (kr, deg, <= 0: the DME's own number).
 * The last pull stays on screen until the next one starts. Pulls of at least `minS` seconds go to the
 * log (the last KEEP, newest first, kept in dataDir/pulls.json); a shorter stab of the throttle is
 * dropped and the last logged pull comes back on screen.
 *
 * The log switched off (opt.log false): no pull is caught and nothing is written; a pull in progress
 * is dropped.
 *
 * Accelerator: n.pedal (0..100): the demo drive's throttle; without a pedal signal, engine load
 * (torque against the engine's max torque).
 */
const fs = require('fs');
const path = require('path');

const CYL = 6, KEEP = 10;
const STEP = 0.4;                 // deg: a deeper retard than the last sample by this much = one more knock event
const START_MS = 300, END_MS = 700;
const isNum = (x) => typeof x === 'number' && isFinite(x);

class Pulls {
    constructor(dataDir, log) {
        this.file = path.join(dataDir || '.', 'pulls.json');
        this.log = log;
        this.list = [];
        try { const j = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (Array.isArray(j)) this.list = j.slice(0, KEEP); } catch (e) { /* none yet */ }
        this.cur = null; this.above = 0; this.below = 0; this.prev = null; this.mf0 = null;
        this.shown = this.list[0] || null;
    }

    get recording() { return !!this.cur; }

    /** One sample. t = ms; n = { pedal, rpm, speed, boost, iat, ethanol, map, retard[6], misfire[6] }; opt = { start (%), minS, log (default on) }. */
    feed(t, n, opt) {
        if (opt.log === false) { if (this.cur || this.above) this.reset(); return; }
        const p = n.pedal;
        if (!isNum(p)) return;
        if (!this.cur) {
            if (p >= opt.start) {
                if (!this.above) this.above = t;
                if (t - this.above >= START_MS) this._begin(this.above, n);
            } else this.above = 0;
            return;
        }
        this._sample(t, n);
        if (p < Math.min(40, opt.start - 20)) {
            if (!this.below) this.below = t;
            if (t - this.below >= END_MS) this._end(this.below, opt);
        } else this.below = 0;
    }

    _begin(t, n) {
        const r = n.retard || [], m = n.misfire || [];
        this.cur = {
            start: t, end: t, v0: n.speed, v1: n.speed, rpm0: n.rpm, rpmMax: n.rpm, boost: n.boost, iat: n.iat,
            map: n.map || null, eth: n.ethanol, kr: 0,
            cyl: Array.from({ length: CYL }, () => ({ n: 0, max: 0, mf: 0 })),
        };
        this.prev = Array.from({ length: CYL }, (_, i) => (isNum(r[i]) ? r[i] : 0));
        // retard still left from before the pull (it recovers over a few seconds) is not this pull's
        this.floor = this.prev.slice();
        this.krFloor = isNum(n.kr) ? n.kr : 0;
        this.mf0 = Array.from({ length: CYL }, (_, i) => (isNum(m[i]) ? m[i] : 0));
        this.below = 0;
        this.shown = this.cur;
        this.log.info('pull: started at ' + Math.round(n.pedal) + '% (' + Math.round(n.speed || 0) + ' km/h)');
    }

    _sample(t, n) {
        const c = this.cur, r = n.retard || [], m = n.misfire || [];
        c.end = t;
        if (isNum(n.speed)) c.v1 = n.speed;
        if (isNum(n.rpm) && !(n.rpm <= c.rpmMax)) c.rpmMax = n.rpm;
        if (isNum(n.boost) && !(n.boost <= c.boost)) c.boost = n.boost;
        if (isNum(n.iat) && !(n.iat <= c.iat)) c.iat = n.iat;
        if (isNum(n.kr) && n.kr < this.krFloor) c.kr = Math.min(c.kr, n.kr);
        for (let i = 0; i < CYL; i++) {
            const v = r[i];
            if (isNum(v)) {
                // the deepest retard: at a new knock event, or anywhere below what was left from before the pull
                if (v <= this.prev[i] - STEP) { c.cyl[i].n++; c.cyl[i].max = Math.min(c.cyl[i].max, v); } else if (v < this.floor[i]) c.cyl[i].max = Math.min(c.cyl[i].max, v);
                this.prev[i] = v;
            }
            if (isNum(m[i])) c.cyl[i].mf = Math.max(0, m[i] - this.mf0[i]);
        }
    }

    _end(t, opt) {
        const c = this.cur;
        this.cur = null; this.above = 0; this.below = 0;
        c.end = t;
        const s = (c.end - c.start) / 1000;
        if (s >= opt.minS) {
            this.list.unshift(c);
            this.list.length = Math.min(this.list.length, KEEP);
            this.shown = c;
            this._save();
            this.log.info('pull: ' + s.toFixed(1) + ' s logged, knock events ' + c.cyl.map((x) => x.n).join('/'));
        } else {
            this.shown = this.list[0] || null;          // a short stab of the throttle: the last real pull comes back
            this.log.info('pull: ' + s.toFixed(1) + ' s, too short to log');
        }
    }

    _save() { try { fs.writeFileSync(this.file, JSON.stringify(this.list)); } catch (e) { this.log.warn('pulls: ' + e.message); } }

    clear() { this.list = []; this.shown = this.cur; this._save(); }

    /** Start over (the car's data source changed, the log switched off): a pull in progress is dropped. */
    reset() { this.cur = null; this.above = 0; this.below = 0; this.shown = this.list[0] || null; }
}

module.exports = { Pulls, KEEP };
