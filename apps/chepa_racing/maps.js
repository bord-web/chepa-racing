'use strict';
/**
 * maps.js - engine map switching for an MHD-tuned DME (S58 / MG1), maps 1-4.
 *
 * Setting "mapControl":
 *   sim (default)  simulated: the picked map is only remembered, NOTHING is sent to the car
 *   mhd            sent to the DME (0x12) over the head unit's diagnostic link (kit/diag.js):
 *                  2F 01 <map - 1>  ->  6F 01 <map - 1>   (map 1..4 = 00..03)
 *                  the same command as apps/live_adjustments (validated there on an MG1 with MHD)
 *
 * MHD gives no read-back of the active map: the app shows the map it last switched to (kept in
 * dataDir/map.json), and a switch counts only when the DME echoes the request.
 */
const fs = require('fs');
const path = require('path');

const MAPS = 4;
const hex = (b) => ('0' + b.toString(16)).slice(-2);

class MapControl {
    constructor(ctx) {
        this.ctx = ctx; this.log = ctx.log;
        this.file = path.join(ctx.dataDir || '.', 'map.json');
        this.map = null; this.busy = false; this.link = null;
        this.note = null; this.noteType = 'dim';
        try { const j = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (j.map >= 1 && j.map <= MAPS) this.map = j.map; } catch (e) { /* none yet */ }
    }

    get live() { return this.ctx.settings.get('mapControl') === 'mhd'; }

    _save() { try { fs.writeFileSync(this.file, JSON.stringify({ map: this.map, at: Date.now() })); } catch (e) { this.log.warn('map: ' + e.message); } }

    /** The diagnostic link, opened the first time a map is sent (never in simulated mode). */
    async _link() {
        if (!this.link) {
            const { Diag } = require('./kit/diag');
            this.link = await new Diag(this.ctx.signals, this.log).init();
        }
        return this.link;
    }

    /** Switch to map n (1..4). Resolves when done; the outcome is in note / noteType. */
    async setMap(n) {
        if (this.busy || !(n >= 1 && n <= MAPS)) return;
        this.busy = true;
        try {
            if (!this.live) {
                this.map = n; this._save();
                this.note = 'Map ' + n + ' · simulated, nothing was sent to the car'; this.noteType = 'dim';
                return;
            }
            this.note = 'Sending map ' + n + '…'; this.noteType = 'dim';
            const diag = await this._link();
            if (!diag.available) { this.note = 'Waiting for the diagnostic link'; this.noteType = 'warn'; return; }
            const { replyTo, NRC } = require('./kit/diag');
            const req = [0x01, n - 1];
            this.log.info('map: UDS -> DME 2F ' + req.map(hex).join(' '));
            const r = await diag.physical(0x12, 0x2F, req, 3000, replyTo(0x2F, req));
            if (r && r[0] === 0x6F && r[1] === req[0] && r[2] === req[1]) {
                this.map = n; this._save();
                this.note = 'Map ' + n + ' · accepted by the DME'; this.noteType = 'go';
            } else if (r && r[0] === 0x7F) {
                this.log.info('map: DME refused (' + (NRC[r[2]] || hex(r[2])) + ')');
                this.note = 'Not available on this car (no MHD map switching)'; this.noteType = 'warn';
            } else {
                this.note = 'No answer from the DME'; this.noteType = 'warn';
            }
        } catch (e) {
            this.note = String(e && e.message || e); this.noteType = 'warn';
            this.log.warn('map ' + n + ': ' + this.note);
        } finally {
            this.busy = false;
        }
    }
}

module.exports = { MapControl, MAPS };
