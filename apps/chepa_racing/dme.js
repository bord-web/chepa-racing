'use strict';
/**
 * dme.js - the engine unit's live values, from the DME (0x12) of the real car (the identifiers Live Data
 * shows, DME8FF_R), over the head unit's read-only diagnostic link (the one ethanol.js opens, one queue):
 *
 *   4205  charge pressure before the throttle (abs, 0.078125 hPa)    boost = 4205 - 4201 (bar)
 *   4536  boost control deviation (0.125 hPa, +-4 bar)              target = 4205 + 4536 - 4201
 *   4AB0  charge pressure target (abs, 0.0390625 hPa: up to 2560 hPa, under a tuned engine's full boost)
 *   4201  ambient pressure (0.0390625 hPa)
 *   580F  intake air (0.75 - 48 deg C), Live Data's "Intake air"; without it OBD 01 0F (x - 40), as there
 *   554C  mean knock control retard of the cylinders (0.375 deg CA, half quantisation)
 *   4A49 4A4A 4A4C 4A4D 4A4E 4A4F   ignition angle, cylinders 1-6 (0.1 deg CA)
 *   4B23 4B24 4B25 4B30 4B31 4B32   misfire counters, cylinders 1-6
 *   4650  gearbox oil temperature (0.75 - 48 deg C)
 *   5814  accelerator pedal, normalised (0.01220703 %); without it 480B, the same value
 *
 * The DME gives no knock retard per cylinder, only their mean (554C), so that is the number to trust: while
 * it is 0 every cylinder's retard is 0, and otherwise the six always average to it. How it is shared out is an
 * estimate from the angles (of one reply, or within KNOCK_SPAN one a request): angle(i) = base + trim(i) -
 * retard(i), so retard(i) = mean(angle) + 554C + trim(i) - angle(i). trim(i), a cylinder's own offset, is learnt
 * while the DME takes nothing. Without the angles each cylinder shows the mean.
 * Misfires: what each counter grew since the app first read it (a counter that went back started over).
 * The target: 4AB0 ends at 2560 hPa, so from the deviation of the same reply. Which way round the DME
 * counts it (target - actual, the usual, or actual - target) is learnt from 4AB0 while that is in its
 * range; without 4536, 4AB0 (none at its end).
 *
 * GROUPS are read on their own: each has its own request, pace and failures, so one that fails leaves the
 * others running. The link takes one request at a time, so a request gets ASK_MS at most, and a group that
 * got no answer waits (HOLD_MS, doubling up to HOLD_MAX) while the others go on; when the DME answers again
 * they all go at once. A group whose several identifiers are refused in one request: each on its own (one
 * the DME hasn't got is found that way and left out for RETRY_MS once refused REFUSALS times in a row, a
 * single refusal may be another app's); refused that way MULTI_FAILS times while each answers alone, one a
 * request, several tried again after MULTI_RETRY_MS. No answer at all for QUIET_AFTER requests (asleep,
 * engine off): one request every QUIET_MS until it answers.
 * Below -45 deg C a temperature counts as no data (an unset sensor reads -48). Only while live() (the
 * car's own data, not the demo). Values older than their group's `stale` count as none.
 *
 *   const dme = new Dme(ctx, () => !car.data().demo, () => eth._link());
 *   dme.values() -> { boost, target, iat, gearbox, pedal, kr, angle[6], retard[6], misfire[6] } (bar / deg C / % / deg; null: none)
 *   dme.state()  -> { multi, rate, absent: ['580F', ...], said, notes, groups: [{ name, age, misses, why }] }  (the Developer logs page)
 */
const DME = 0x12;
const ASK_MS = 1000;                     // a request not answered after this is missed
const RETRY_MS = 60000;                  // an identifier the DME hasn't got: asked again after this
const REFUSALS = 2;
const GONE = [0x11, 0x12, 0x31, 0x33, 0x7E, 0x7F];      // refusals that say it isn't there (not: busy, conditions)
const HOLD_MS = 250;
const HOLD_MAX = 5000;
const QUIET_AFTER = 10;
const QUIET_MS = 2000;
const OBD_IAT = 0x0F;                    // OBD-II PID: intake air, while the DME gives no 580F
const OBD_AFTER = 2000;                  // 580F not read for this long: OBD alongside
const OBD_EVERY = 500;
const OBD_HOLD = 5000;                   // OBD didn't give it: asked again after this
const OBD_STALE = 30000;
const MULTI_FAILS = 3;
const MULTI_RETRY_MS = 30000;
const KNOCK_SPAN = 1000;                 // ms: the angles and the mean retard count as one moment within this
const KNOCK_NONE = 0.1;                  // deg: a mean retard under this is none (554C's step is 0.375)
const TRIM_RATE = 0.05;                  // how fast a cylinder's own offset follows, per reply
const NOTES = 8;
const CYL = 6;
const ANGLES = [0x4A49, 0x4A4A, 0x4A4C, 0x4A4D, 0x4A4E, 0x4A4F];
const MISFIRES = [0x4B23, 0x4B24, 0x4B25, 0x4B30, 0x4B31, 0x4B32];
const PEDALS = [0x5814, 0x480B];
// what each identifier's reply holds: data bytes and the value
const u16 = (b) => (b[0] << 8) | b[1];
const s16 = (b) => (u16(b) >= 0x8000 ? u16(b) - 0x10000 : u16(b));
const DIDS = {
    0x4205: { len: 2, v: (b) => u16(b) * 0.078125 },
    0x4AB0: { len: 2, v: (b) => (u16(b) >= 0xFFF0 ? null : u16(b) * 0.0390625) },      // at its end: over 2560 hPa
    0x4536: { len: 2, v: (b) => s16(b) * 0.125 },
    0x4201: { len: 2, v: (b) => u16(b) * 0.0390625 },
    0x580F: { len: 1, v: (b) => b[0] * 0.75 - 48 },
    0x4650: { len: 1, v: (b) => b[0] * 0.75 - 48 },
    0x554C: { len: 1, v: (b) => (b[0] >= 0x80 ? b[0] - 0x100 : b[0]) * 0.375 },
};
ANGLES.forEach((d) => { DIDS[d] = { len: 2, v: (b) => s16(b) * 0.1 }; });
MISFIRES.forEach((d) => { DIDS[d] = { len: 2, v: u16 }; });
PEDALS.forEach((d) => { DIDS[d] = { len: 2, v: (b) => s16(b) * 0.01220703 }; });
// what belongs to one moment stays in one request (boost and its deviation; the cylinders' knock); what changes
// slowly is read slowly and stays on screen through a gap
const GROUPS = [
    { name: 'boost', every: 100, stale: 2500, ids: [0x4205, 0x4536, 0x4AB0] },
    { name: 'knock', every: 100, stale: 2500, ids: [0x554C].concat(ANGLES) },
    { name: 'pedal', every: 200, stale: 1000, ids: PEDALS },
    { name: 'intake', every: 500, stale: 30000, ids: [0x580F] },
    { name: 'gearbox', every: 1000, stale: 30000, ids: [0x4650] },
    { name: 'ambient', every: 1000, stale: 60000, ids: [0x4201] },
    { name: 'misfire', every: 1000, stale: 10000, ids: MISFIRES },
];
const STALE = {};
GROUPS.forEach((g) => g.ids.forEach((d) => { STALE[d] = g.stale; }));
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
        this.absent = {};                // did -> left out at (ms)
        this.refused = {};               // did -> refusals in a row
        this.groups = GROUPS.map((g) => Object.assign({ at: 0, hold: 0, misses: 0, why: '', okAt: 0, multi: null, multiFails: 0, multiAt: 0 }, g));
        this.missed = 0;                 // requests in a row without an answer, of any group
        this.askedAt = 0;
        this.mfBase = new Array(CYL).fill(null);
        this.devSign = 1;                // 4536 = target - actual (1) or actual - target (-1)
        this.trim = null; this.trimT = 0; // each cylinder's own angle offset (deg), the reply it was last learnt from
        this.obd = null; this.obdAt = 0; // intake air from OBD: { v, t }, not asked before (ms)
        this.reads = 0; this.rateT = Date.now(); this.rate = 0;
        this.said = ''; this.notes = [];
        this.stopped = false;
        if (!ctx.noLoop) this.loop();
    }

    stop() { this.stopped = true; }

    /** Several identifiers a request: true, false (a group reads one a request), null (not known yet). */
    get multi() {
        const m = this.groups.filter((g) => g.ids.length > 1).map((g) => g.multi);
        return m.indexOf(false) >= 0 ? false : m.indexOf(true) >= 0 ? true : null;
    }

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

    /** Ask the group most overdue; returns how long to wait before the next. */
    async tick() {
        if (!this.live()) return 500;
        const link = await this.link();
        if (!link.available) { this.note('waiting for the diagnostic link'); return 1000; }
        const now = Date.now();
        if (this.missed >= QUIET_AFTER && now - this.askedAt < QUIET_MS) return QUIET_MS - (now - this.askedAt);
        let g = null, due = Infinity;
        this.groups.forEach((x) => {
            const at = Math.max(x.at + x.every, x.hold);
            if (at < due) { due = at; g = x; }
        });
        if (due > now) return Math.min(500, due - now);
        g.at = now; this.askedAt = now;
        await this.ask(link, g);
        if (g.name === 'intake') await this.askObd(link);
        if (now - this.rateT >= 2000) { this.rate = this.reads * 1000 / (now - this.rateT); this.reads = 0; this.rateT = now; }
        return 0;
    }

    /** A reply, or null without one (why: this.why). */
    async read(link, ids) {
        this.why = 'no answer';
        try { return await link.readMany(DME, ids, ASK_MS); } catch (e) { this.why = String(e && e.message || e); return null; }
    }

    /** This group got nothing: it waits, the others go on. */
    fail(g, why) {
        g.misses++; g.why = why; this.missed++;
        g.hold = Date.now() + Math.min(HOLD_MAX, HOLD_MS * Math.pow(2, g.misses - 1));
        if (g.misses === 1) this.note(g.name + ': ' + why);
        if (this.missed === QUIET_AFTER) this.note('the DME does not answer');
    }

    ok(g) {
        if (this.missed >= 2) this.groups.forEach((x) => { x.hold = 0; });       // it answers again: all of them now
        this.missed = 0;
        g.misses = 0; g.hold = 0; g.why = ''; g.okAt = Date.now();
    }

    async ask(link, g) {
        const now = Date.now(), ids = g.ids.filter((d) => !(now - (this.absent[d] || -Infinity) < RETRY_MS));
        if (!ids.length) return;
        if (ids.length > 1 && (g.multi !== false || now - g.multiAt >= MULTI_RETRY_MS)) {
            const u = await this.read(link, ids);
            if (!u) { this.fail(g, this.why); return; }
            const parts = split(u, ids);
            if (parts) {
                g.multi = true; g.multiFails = 0;
                this.store(parts);
                this.ok(g);
                return;
            }
            // refused or not understood: each on its own this time (that finds one the DME doesn't have)
            const alone = await this.each(link, g, ids);
            if (alone && ++g.multiFails >= MULTI_FAILS) { g.multi = false; g.multiAt = Date.now(); this.note(g.name + ': one identifier a request'); }
            return;
        }
        await this.each(link, g, ids);
    }

    /** Intake air from OBD, every OBD_EVERY while 580F isn't read. */
    async askObd(link) {
        const now = Date.now();
        if (this.intake(now, OBD_AFTER) !== null || now < this.obdAt) return;
        this.obdAt = now + OBD_EVERY;
        let u = null;
        try {
            u = await link.physical(DME, 0x01, [OBD_IAT], ASK_MS, (r) => (r[0] === 0x41 && r[1] === OBD_IAT) || (r[0] === 0x7F && r[1] === 0x01));
        } catch (e) { /* as no answer */ }
        if (u && u[0] === 0x41 && u.length >= 3) this.obd = { v: u[2] - 40, t: Date.now() };
        else this.obdAt = Date.now() + OBD_HOLD;
    }

    /** Each identifier in a request of its own, until one gets no answer; true when every one answered. */
    async each(link, g, ids) {
        let all = true;
        for (const d of ids) {
            const u = await this.read(link, [d]);
            if (!u) { this.fail(g, this.why); return false; }
            const parts = split(u, [d]);
            if (parts) { this.store(parts); continue; }
            all = false;
            if (u[0] !== 0x7F) continue;
            if (GONE.indexOf(u[2]) < 0) { this.fail(g, 'busy'); return false; }
            this.refused[d] = (this.refused[d] || 0) + 1;
            if (this.refused[d] >= REFUSALS) { this.absent[d] = Date.now(); this.note('the DME refused ' + hex4(d)); }
        }
        this.ok(g);
        return all;
    }

    store(parts) {
        const t = Date.now();
        Object.keys(parts).forEach((k) => { this.raw[k] = { v: DIDS[k].v(parts[k]), t }; delete this.absent[k]; delete this.refused[k]; this.reads++; });
        // misfire counters: the first read is where they start from
        MISFIRES.forEach((d, i) => {
            const r = this.raw[d];
            if (r && r.t === t && (this.mfBase[i] === null || r.v < this.mfBase[i])) this.mfBase[i] = this.mfBase[i] === null ? r.v : 0;
        });
        if (this.said !== 'reading') this.note('reading');
    }

    /** A value read within its group's stale time, or null; with the time it was read. */
    get(did, now) {
        const r = this.raw[did];
        return r && now - r.t < STALE[did] ? r : null;
    }

    /** Intake air from 580F read within `age` ms, or null. */
    intake(now, age) {
        const r = this.raw[0x580F];
        return r && now - r.t < age && r.v >= -45 ? r.v : null;
    }

    /** Each cylinder's retard (deg, 0 or less) from the DME's mean retard kr (read at t) and the angles `as`. */
    shares(kr, t, as) {
        const one = as.every((a) => a && Math.abs(a.t - t) <= KNOCK_SPAN);
        const mean = one ? as.reduce((x, a) => x + a.v, 0) / CYL : 0;
        const deg = (r) => { const x = Math.round(r * 10) / 10; return x ? -x : 0; };
        if (kr < KNOCK_NONE) {
            if (one && t !== this.trimT) {
                this.trimT = t;
                this.trim = as.map((a, i) => { const d = a.v - mean; return this.trim ? this.trim[i] + (d - this.trim[i]) * TRIM_RATE : d; });
            }
            return new Array(CYL).fill(0);
        }
        if (!one) return new Array(CYL).fill(deg(kr));
        const r = as.map((a, i) => Math.max(0, mean + kr + (this.trim ? this.trim[i] : 0) - a.v));
        const sum = r.reduce((x, y) => x + y, 0);
        return r.map((x) => deg(sum > 0 ? x * CYL * kr / sum : kr));
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
        // intake air: 580F just read, else OBD, else the last 580F while it counts
        const fresh = this.intake(now, OBD_AFTER), obd = this.obd && now - this.obd.t < OBD_STALE ? this.obd.v : null;
        const pedal = PEDALS.map(v).find((x) => x !== null && x >= -2 && x <= 102);
        const out = {
            pedal: pedal === undefined ? null : Math.max(0, Math.min(100, pedal)),
            boost: amb !== null && p !== null ? (p - amb) / 1000 : null,
            target: amb !== null && goal !== null ? (goal - amb) / 1000 : null,
            iat: fresh !== null ? fresh : obd !== null ? obd : this.intake(now, STALE[0x580F]),
            gearbox: temp(0x4650),
            kr: null, angle: ANGLES.map(v), retard: new Array(CYL).fill(null), misfire: new Array(CYL).fill(null),
        };
        const kr = this.get(0x554C, now);
        if (kr) {
            out.kr = kr.v ? -Math.abs(kr.v) : 0;
            out.retard = this.shares(Math.abs(kr.v), kr.t, ANGLES.map((d) => this.get(d, now)));
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
            groups: this.groups.map((g) => ({ name: g.name, age: g.okAt ? now - g.okAt : null, misses: g.misses, why: g.why })),
        };
    }
}

module.exports = { Dme, GROUPS, DIDS, split };
