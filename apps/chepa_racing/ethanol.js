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
 *
 *   const eth = new Ethanol(ctx, () => !car.data().demo);
 *   eth.value   -> % or null
 */
const POLL_MS = 2000;
const STALE_MS = 10000;
const RETRY_MS = 60000;                  // both identifiers refused: ask again after this
const WAKE_MS = 30000;                   // the DME stopped answering (asleep, engine off): try it again after this
const DME = 0x12;
const SOURCES = [
    { name: '22 55 0D', sid: 0x22, data: [0x55, 0x0D], ok: (u) => u[0] === 0x62 && u[1] === 0x55 && u[2] === 0x0D && u.length >= 4, x: (u) => u[3] },
    { name: '01 52', sid: 0x01, data: [0x52], ok: (u) => u[0] === 0x41 && u[1] === 0x52 && u.length >= 3, x: (u) => u[2] },
];

class Ethanol {
    constructor(ctx, live) {
        this.ctx = ctx; this.log = ctx.log; this.live = live;
        this.v = null; this.t = 0;
        this.src = 0; this.refusedAt = 0; this.silentAt = 0; this.said = '';
        this.link = null; this.linking = false;
        this.timer = setInterval(() => this.tick().catch((e) => this.note('error: ' + (e && e.message || e))), POLL_MS);
    }

    get value() { return this.v !== null && Date.now() - this.t < STALE_MS ? this.v : null; }

    /** Log what happens once per change (not every poll). */
    note(s) { if (s !== this.said) { this.said = s; this.log.info('ethanol: ' + s); } }

    async tick() {
        if (!this.live()) return;
        if (!this.link) {
            if (this.linking) return;
            this.linking = true;
            const { ReadOnlyDiag } = require('./kit/readonly-diag');
            this.link = await new ReadOnlyDiag(this.ctx.signals, this.log).init();
            this.linking = false;
        }
        if (!this.link.available) return this.note('waiting for the diagnostic link');
        const now = Date.now();
        if (this.src >= SOURCES.length) {
            if (now - this.refusedAt < RETRY_MS) return;
            this.src = 0;
        }
        if (this.link.silent(DME)) {
            if (!this.silentAt) this.silentAt = now;
            if (now - this.silentAt < WAKE_MS) return this.note('the DME does not answer');
            this.link.wake(DME); this.silentAt = 0;
        }
        const s = SOURCES[this.src];
        const u = await this.link.physical(DME, s.sid, s.data, 1500, (r) => s.ok(r) || (r[0] === 0x7F && r[1] === s.sid));
        if (!u) return;
        if (s.ok(u)) {
            this.v = s.x(u) / 2.55; this.t = Date.now();
            return this.note('from the DME, ' + s.name + ' (' + Math.round(this.v) + ' %)');
        }
        this.note('the DME refused ' + s.name);
        if (++this.src >= SOURCES.length) { this.refusedAt = now; this.note('the DME gives no ethanol content (refused ' + SOURCES.map((x) => x.name).join(', ') + ')'); }
    }
}

module.exports = { Ethanol };
