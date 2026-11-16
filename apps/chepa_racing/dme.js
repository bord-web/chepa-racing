'use strict';
/**
 * dme.js - the engine unit's live values, from the DME (0x12) of the real car (the identifiers Live Data
 * shows, DME8FF_R), over the head unit's read-only diagnostic link (the one ethanol.js opens, one queue):
 *
 *   4205  charge pressure before the throttle (abs, 0.078125 hPa)    boost = 4205 - 4201 (bar)
 *   4536  boost control deviation (0.125 hPa, +-4 bar)              target = 4205 + 4536 - 4201
 *   4AB0  charge pressure target (abs, 0.0390625 hPa: up to 2560 hPa, under a tuned engine's full boost)
 *   4201  ambient pressure (0.0390625 hPa)
 *   59D4  intake air before the throttle, measured (0.0234375 - 273.15 deg C); without it 580F (0.75 - 48)
 *   554C  mean knock control retard of the cylinders (0.375 deg CA, half quantisation)
 *   4A49 4A4A 4A4C 4A4D 4A4E 4A4F   ignition angle, cylinders 1-6 (0.1 deg CA)
 *   4B23 4B24 4B25 4B30 4B31 4B32   misfire counters, cylinders 1-6
 *   4650  gearbox oil temperature (0.75 - 48 deg C)
 *
 * The DME gives no knock retard per cylinder, only their mean. Each cylinder's: the cylinders share one
 * base angle, so angle(i) = base - retard(i), and mean(retard) is 554C: retard(i) = mean(angle) + 554C -
 * angle(i) (all from one reply, one moment). Under DEADBAND it counts as none (the angles' own spread).
 * Misfires: what each counter grew since the app first read it (a counter that went back started over).
 * The target: 4AB0 ends at 2560 hPa, so from the deviation of the same reply. Which way round the DME
 * counts it (target - actual, the usual, or actual - target) is learnt from 4AB0 while that is in its
 * range; without 4536, 4AB0 (none at its end).
 *
 * Up to 8 identifiers go in one request (22 <DID> <DID> ...); BATCHES are asked in turn, each as often as
 * its `every` allows. A DME that refuses several in one request: each on its own (a refused one is left
 * out for RETRY_MS); refused that way MULTI_FAILS times while each answers alone, one a request from then on.
 * Below -45 deg C a temperature counts as no data (an unset sensor reads -48). Only while live() (the
 * car's own data, not the demo). Values older than their batch's `stale` count as none.
 *
 *   const dme = new Dme(ctx, () => !car.data().demo, () => eth._link());
 *   dme.values() -> { boost, target, iat, gearbox, kr, angle[6], retard[6], misfire[6] } (bar / deg C / deg; null: none)
 *   dme.state()  -> { multi, rate, absent: ['59D4', ...], said }  (the Developer logs page)
 */
const DME = 0x12;
const RETRY_MS = 60000;                  // an identifier the DME refused: asked again after this
const MULTI_FAILS = 3;
const DEADBAND = 0.2;                    // deg: less retard than this counts as none
const NOTES = 8;
const CYL = 6;
const ANGLES = [0x4A49, 0x4A4A, 0x4A4C, 0x4A4D, 0x4A4E, 0x4A4F];
const MISFIRES = [0x4B23, 0x4B24, 0x4B25, 0x4B30, 0x4B31, 0x4B32];
// what each identifier's reply holds: data bytes and the value
const u16 = (b) => (b[0] << 8) | b[1];
const s16 = (b) => (u16(b) >= 0x8000 ? u16(b) - 0x10000 : u16(b));
const DIDS = {
    0x4205: { len: 2, v: (b) => u16(b) * 0.078125 },
    0x4AB0: { len: 2, v: (b) => (u16(b) >= 0xFFF0 ? null : u16(b) * 0.0390625) },      // at its end: over 2560 hPa
    0x4536: { len: 2, v: (b) => s16(b) * 0.125 },
    0x4201: { len: 2, v: (b) => u16(b) * 0.0390625 },
    0x59D4: { len: 2, v: (b) => u16(b) * 0.0234375 - 273.15 },
    0x580F: { len: 1, v: (b) => b[0] * 0.75 - 48 },
    0x4650: { len: 1, v: (b) => b[0] * 0.75 - 48 },
    0x554C: { len: 1, v: (b) => (b[0] >= 0x80 ? b[0] - 0x100 : b[0]) * 0.375 },
};
ANGLES.forEach((d) => { DIDS[d] = { len: 2, v: (b) => s16(b) * 0.1 }; });
MISFIRES.forEach((d) => { DIDS[d] = { len: 2, v: u16 }; });
// boost, its deviation and target, ambient and intake air in one reply (one moment); the cylinders' knock in
// one; misfires and the slow ones
const BATCHES = [
    { every: 100, stale: 1500, ids: [0x4205, 0x4536, 0x4AB0, 0x4201, 0x59D4] },
    { every: 100, stale: 1500, ids: [0x554C].concat(ANGLES) },
    { every: 500, stale: 5000, ids: MISFIRES.concat([0x4650, 0x580F]) },
];
const STALE = {};
BATCHES.forEach((b) => b.ids.forEach((d) => { STALE[d] = b.stale; }));
const hex4 = (d) => ('000' + d.toString(16).toUpperCase()).slice(-4);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A positive reply 62 <DID> <data> <DID> <data> ... of the identifiers asked: { did: data bytes }, or null. */
function split(u, asked) {
    if (!u || u[0] !== 0x62) return null;
    const out = {};
    let i = 1;
    while (i < u.length) {
        const did = (u[i] << 8) | u[i + 1], def = DIDS[did];
        if (!def || asked.indexOf(did) < 0 || i + 2 + def.len > u.length) return null;
        out[did] = u.slice(i + 2, i + 2 + def.len);
        i += 2 + def.len;
    }
    return out;
}

class Dme {
    /** link() -> a promise of the read-only diagnostic link (kit/readonly-diag.js), shared with ethanol.js */
    constructor(ctx, live, link) {
        this.log = ctx.log; this.live = live; this.link = link;
        this.raw = {};                   // did -> { v, t }
        this.absent = {};                // did -> refused at (ms)
        this.multi = null;               // several identifiers a request: null (not known yet), true, false
        this.multiFails = 0;
        this.last = BATCHES.map(() => 0);
        this.mfBase = new Array(CYL).fill(null);
        this.devSign = 1;                // 4536 = target - actual (1) or actual - target (-1)
        this.reads = 0; this.rateT = Date.now(); this.rate = 0;
        this.said = ''; this.notes = [];
        this.stopped = false;
        if (!ctx.noLoop) this.loop();
    }

    stop() { this.stopped = true; }

    /** Log what happens once per change (not every poll); the last NOTES are kept for the Developer logs page. */
    note(s) {
        if (s === this.said) return;
        this.said = s; this.log.info('dme: ' + s);
        this.notes.push([Date.now(), s]);
        if (this.notes.length > NOTES) this.notes.shift();
    }

    async loop() {
        while (!this.stopped) {
            let wait = 500;
            try { wait = await this.tick(); } catch (e) { this.note('error: ' + (e && e.message || e)); }
            await sleep(wait);
        }
    }

    /** Ask the batch most overdue; returns how long to wait before the next. */
    async tick() {
        if (!this.live()) return 500;
        const link = await this.link();
        if (!link.available) { this.note('waiting for the diagnostic link'); return 1000; }
        // asleep or not answering: ethanol.js wakes the DME again in a while
        if (link.silent(DME)) { this.note('the DME does not answer'); return 1000; }
        const now = Date.now();
        let best = -1, due = Infinity;
        BATCHES.forEach((b, i) => {
            const at = this.last[i] + b.every;
            if (at < due) { due = at; best = i; }
        });
        if (due > now) return Math.min(500, due - now);
        this.last[best] = now;
        await this.ask(link, BATCHES[best].ids.filter((d) => !(now - (this.absent[d] || -Infinity) < RETRY_MS)));
        if (now - this.rateT >= 2000) { this.rate = this.reads * 1000 / (now - this.rateT); this.reads = 0; this.rateT = now; }
        return 0;
    }

    async ask(link, ids) {
        if (!ids.length) return;
        if (ids.length > 1 && this.multi !== false) {
            const u = await link.readMany(DME, ids, 1500);
            if (!u) return;
            const parts = split(u, ids);
            if (parts) {
                if (this.multi !== true) { this.multi = true; this.note('up to ' + ids.length + ' identifiers a request'); }
                this.store(parts);
                return;
            }
            // refused or not understood: each on its own this time (that finds one the DME doesn't have)
            const alone = await this.each(link, ids);
            if (alone && ++this.multiFails >= MULTI_FAILS) { this.multi = false; this.note('the DME answers one identifier a request'); }
            return;
        }
        await this.each(link, ids);
    }

    /** Each identifier in a request of its own; true when every one answered. */
    async each(link, ids) {
        let all = true;
        for (const d of ids) {
            const u = await link.readMany(DME, [d], 1500);
            if (!u) { all = false; continue; }
            const parts = split(u, [d]);
            if (parts) this.store(parts);
            else {
                all = false;
                if (u[0] === 0x7F) { this.absent[d] = Date.now(); this.note('the DME refused ' + hex4(d)); }
            }
        }
        return all;
    }

    store(parts) {
        const t = Date.now();
        Object.keys(parts).forEach((k) => { this.raw[k] = { v: DIDS[k].v(parts[k]), t }; delete this.absent[k]; this.reads++; });
        // misfire counters: the first read is where they start from
        MISFIRES.forEach((d, i) => {
            const r = this.raw[d];
            if (r && r.t === t && (this.mfBase[i] === null || r.v < this.mfBase[i])) this.mfBase[i] = this.mfBase[i] === null ? r.v : 0;
        });
        if (this.multi !== false && this.said !== 'reading') this.note('reading');
    }

    /** A value read within its batch's stale time, or null; with the time it was read. */
    get(did, now) {
        const r = this.raw[did];
        return r && now - r.t < STALE[did] ? r : null;
    }

    values() {
        const now = Date.now(), v = (d) => { const r = this.get(d, now); return r ? r.v : null; };
        const temp = (d) => { const c = v(d); return c !== null && c >= -45 ? c : null; };
        const amb = v(0x4201), p = v(0x4205), dev = v(0x4536), s = v(0x4AB0);
        // which way the deviation counts: from 4AB0 when that is in its range and fits one way only
        if (p !== null && dev !== null && s !== null && Math.abs(dev) > 30) {
            const e1 = Math.abs(s - p - dev), e2 = Math.abs(s - p + dev);
            if (Math.min(e1, e2) < 30 && Math.max(e1, e2) > 60) this.devSign = e1 < e2 ? 1 : -1;
        }
        const goal = p !== null && dev !== null ? p + this.devSign * dev : s;
        const out = {
            boost: amb !== null && p !== null ? (p - amb) / 1000 : null,
            target: amb !== null && goal !== null ? (goal - amb) / 1000 : null,
            iat: temp(0x59D4) !== null ? temp(0x59D4) : temp(0x580F),
            gearbox: temp(0x4650),
            kr: null, angle: ANGLES.map(v), retard: new Array(CYL).fill(null), misfire: new Array(CYL).fill(null),
        };
        // each cylinder's retard: from the angles and the mean retard of one reply
        const kr = this.get(0x554C, now), as = ANGLES.map((d) => this.get(d, now));
        if (kr) out.kr = -Math.abs(kr.v);
        if (kr && as.every((a) => a && a.t === kr.t)) {
            const mean = as.reduce((x, a) => x + a.v, 0) / CYL;
            out.retard = as.map((a) => { const r = mean + Math.abs(kr.v) - a.v; return r < DEADBAND ? 0 : -Math.round(r * 10) / 10; });
        }
        MISFIRES.forEach((d, i) => { const c = v(d); if (c !== null) out.misfire[i] = c - this.mfBase[i]; });
        return out;
    }

    /** For the Developer logs page. */
    state() {
        const now = Date.now();
        return {
            multi: this.multi, rate: this.rate, said: this.said, notes: this.notes,
            absent: Object.keys(this.absent).filter((d) => now - this.absent[d] < RETRY_MS).map((d) => hex4(+d)),
        };
    }
}

module.exports = { Dme, BATCHES, DIDS, split };
