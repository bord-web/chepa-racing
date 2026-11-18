'use strict';
/**
 * ethanol.js - the ethanol content of the fuel, from the DME (0x12) of the real car.
 *
 * With a flex fuel sensor (MHD Flex Fuel) the DME knows the fuel's ethanol share (the cluster shows
 * it). The app asks the DME for it every POLL_MS over the head unit's diagnostic link, read-only
 * (kit/readonly-diag.js: nothing but reads can leave the head unit):
 *   22 55 0D  ->  62 55 0D <x>   PROZENT_ALK_KRST, "Prozent Alkohol im Kraftstoff" (DME8FF_R): x / 2.55 %
 *   01 52     ->  41 52 <x>      OBD-II PID 52 (SAE J1979), the same scale; when the DME refuses 55 0D
 * Only while live() (the car's own data, not the demo). A value older than STALE_MS counts as none.
 * The link is shared with dme.js: a car without the sensor costs two refusals a minute, and a DME that doesn't
 * answer this is left alone for QUIET_MS, so the ethanol never holds up the live values.
 *
 * probe(): every candidate once (PROBES: the DME's type, its ethanol and fuel quality identifiers,
 * the OBD ones), raw replies kept for the Developer logs page, to find where this car has the value.
 *
 *   const eth = new Ethanol(ctx, () => !car.data().demo);
 *   eth.value   -> % or null;  eth.source -> the request it came from;  eth.notes -> [[ms, text]]
 *   await eth.probe();  eth.probed -> [{ req, what, reply, value }]
 */
const POLL_MS = 2000;
const STALE_MS = 10000;
const RETRY_MS = 60000;                  // both identifiers refused: ask again after this
const ASK_MS = 1000;
const QUIET_MS = 15000;                  // no answer: asked again after this
const NOTES = 8;
// the link of the live values: no request holds the others for long, and no unit is ever given up on (dme.js paces itself)
const LINK = { silentAfter: Infinity, request: { callTimeoutMs: 1000, pendingTimeoutMs: 1000, maxRetries: 2 } };
const DME = 0x12;
const SOURCES = [
    { name: '22 55 0D', sid: 0x22, data: [0x55, 0x0D], ok: (u) => u[0] === 0x62 && u[1] === 0x55 && u[2] === 0x0D && u.length >= 4, x: (u) => u[3] },
    { name: '01 52', sid: 0x01, data: [0x52], ok: (u) => u[0] === 0x41 && u[1] === 0x52 && u.length >= 3, x: (u) => u[2] },
];
const FUEL_TYPES = { 1: 'petrol', 2: 'methanol', 3: 'ethanol', 4: 'diesel', 5: 'LPG', 6: 'CNG', 8: 'electric', 17: 'hybrid petrol' };
const u16 = (u, i) => (u.length > i + 1 ? (u[i] << 8) | u[i + 1] : null);
const frac = (v) => (v === null ? '-' : (v * 3.052e-05).toFixed(4) + '  (x100: ' + (v * 3.052e-03).toFixed(1) + ')');
/** OBD 01 40: is PID p (0x41..0x60) supported, from the reply's bit mask */
const has = (u, p) => { const i = p - 0x41, b = u[2 + (i >> 3)]; return b === undefined ? '?' : b & (0x80 >> (i & 7)) ? 'yes' : 'no'; };
// what the Developer logs page asks: request bytes after the service, and how a positive reply reads
const PROBES = [
    { what: 'DME type (SGBD index)', sid: 0x22, data: [0xF1, 0x50], show: (u) => u.slice(3, 6).map(hex).join('') },
    { what: 'Alcohol in fuel  550D', sid: 0x22, data: [0x55, 0x0D], show: (u) => (u[3] / 2.55).toFixed(1) + ' %' },
    { what: 'Ethanol content  5939', sid: 0x22, data: [0x59, 0x39], show: (u) => frac(u16(u, 3)) },
    { what: 'Ethanol sensor raw  5938', sid: 0x22, data: [0x59, 0x38], show: (u) => frac(u16(u, 3)) },
    { what: 'Fuel quality factor  5776', sid: 0x22, data: [0x57, 0x76], show: (u) => (u[3] / 256).toFixed(3) + ' (0 RON98, 1 RON91)' },
    { what: 'Fuel quality data  4035', sid: 0x22, data: [0x40, 0x35], show: () => 'see the bytes' },
    { what: 'OBD ethanol  01 52', sid: 0x01, data: [0x52], show: (u) => (u[2] / 2.55).toFixed(1) + ' %' },
    { what: 'OBD fuel type  01 51', sid: 0x01, data: [0x51], show: (u) => FUEL_TYPES[u[2]] || String(u[2]) },
    { what: 'OBD PIDs 41-60  01 40', sid: 0x01, data: [0x40], show: (u) => '51: ' + has(u, 0x51) + ', 52: ' + has(u, 0x52) },
];
function hex(b) { return ('0' + b.toString(16).toUpperCase()).slice(-2); }
/** a positive reply to this request: 62 <DID> ... / 41 <PID> ... */
const positive = (sid, data, u) => u[0] === sid + 0x40 && data.every((b, i) => u[1 + i] === b);

class Ethanol {
    constructor(ctx, live) {
        this.ctx = ctx; this.log = ctx.log; this.live = live;
        this.v = null; this.t = 0; this.source = null;
        this.src = 0; this.refusedAt = 0; this.quietUntil = 0; this.asking = false; this.said = '';
        this.notes = [];
        this.link = null; this.linking = null;
        this.probed = null; this.probedAt = 0; this.probing = false;
        this.timer = setInterval(() => this.tick().catch((e) => this.note('error: ' + (e && e.message || e))), POLL_MS);
    }

    get value() { return this.v !== null && Date.now() - this.t < STALE_MS ? this.v : null; }

    /** Log what happens once per change (not every poll); the last NOTES are kept for the Developer logs page. */
    note(s) {
        if (s === this.said) return;
        this.said = s; this.log.info('ethanol: ' + s);
        this.notes.push([Date.now(), s]);
        if (this.notes.length > NOTES) this.notes.shift();
    }

    /** The read-only diagnostic link, opened the first time it is needed (one for the polls and the probes). */
    async _link() {
        if (this.link) return this.link;
        if (!this.linking) {
            const { ReadOnlyDiag } = require('./kit/readonly-diag');
            this.linking = new ReadOnlyDiag(this.ctx.signals, this.log, LINK).init().then((l) => { this.link = l; return l; });
        }
        return this.linking;
    }

    async tick() {
        if (!this.live() || this.asking) return;
        const link = await this._link();
        if (!link.available) return this.note('waiting for the diagnostic link');
        const now = Date.now();
        if (now < this.quietUntil) return;
        if (this.src >= SOURCES.length) {
            if (now - this.refusedAt < RETRY_MS) return;
            this.src = 0;
        }
        const s = SOURCES[this.src];
        let u;
        this.asking = true; this.quietUntil = now + QUIET_MS;
        try {
            u = await link.physical(DME, s.sid, s.data, ASK_MS, (r) => s.ok(r) || (r[0] === 0x7F && r[1] === s.sid));
        } finally { this.asking = false; }
        if (!u) return this.note('the DME does not answer');
        this.quietUntil = 0;
        if (s.ok(u)) {
            this.v = s.x(u) / 2.55; this.t = Date.now(); this.source = s.name;
            return this.note('from the DME, ' + s.name + ' (' + Math.round(this.v) + ' %)');
        }
        this.note('the DME refused ' + s.name);
        if (++this.src >= SOURCES.length) { this.refusedAt = now; this.note('the DME gives no ethanol content (refused ' + SOURCES.map((x) => x.name).join(', ') + ')'); }
    }

    /** Ask every PROBES request once (also in the demo: only reads). Rows in this.probed. */
    async probe() {
        if (this.probing) return;
        this.probing = true;
        try {
            const link = await this._link();
            let NRC = {};
            try { NRC = require('./kit/readonly-diag').NRC; } catch (e) { /* tests: the app's source without the kit */ }
            const rows = [];
            for (const p of PROBES) {
                const req = [p.sid].concat(p.data).map(hex).join(' ');
                const row = { req, what: p.what, reply: '', value: '' };
                rows.push(row);
                if (!link.available) { row.value = 'no diagnostic link'; continue; }
                const u = await link.physical(DME, p.sid, p.data, 1500, (r) => positive(p.sid, p.data, r) || (r[0] === 0x7F && r[1] === p.sid));
                if (u === undefined) { row.value = 'not sent'; continue; }
                if (!u) { row.value = 'no answer'; continue; }
                row.reply = u.slice(0, 16).map(hex).join(' ') + (u.length > 16 ? ' ..' : '');
                if (u[0] === 0x7F) row.value = 'refused: ' + (NRC[u[2]] || hex(u[2]));
                else try { row.value = p.show(u); } catch (e) { row.value = '?'; }
            }
            this.probed = rows;
            this.log.info('ethanol probe: ' + rows.map((r) => r.req + ' -> ' + (r.reply || r.value)).join(' | '));
        } finally {
            this.probing = false; this.probedAt = Date.now();      // also after a failure: the page asks again in a while, not every frame
        }
    }

    /** The link's state for the page: { state, stats } */
    linkState() {
        const l = this.link;
        if (!l) return { state: this.linking ? 'opening' : 'not opened yet', stats: null };
        return { state: l.error ? 'error: ' + l.error : l.available ? 'ready' : 'not available', stats: l.stats, busy: l.busy };
    }
}

module.exports = { Ethanol, PROBES, LINK };
