#!/usr/bin/gjs
/* mp3-scanner.js
 * Независимый CLI-инструмент и библиотека для сканирования каталогов и чтения ID3.
 * Совместим с Cinnamon JS / GJS.
 */

imports.gi.versions.Gio = '2.0';
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const System = imports.system;
const ByteArray = imports.byteArray;

Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');

const BATCH_SIZE = 100;
const MP3_RE = /\.mp3$/i;

/* ============================================================
 *  ЛОГИРОВАНИЕ
 * ============================================================ */
function log(tag, msg) {
    printerr(`[${tag}] ${msg}`);
}

/* ============================================================
 *  УТИЛИТЫ ПУТЕЙ (для портативного кэша)
 * ============================================================ */
function getRelativePath(root, abs) {
    if (abs.startsWith(root)) {
        let rel = abs.substring(root.length);
        if (rel.startsWith('/')) rel = rel.substring(1);
        return rel;
    }
    return abs;
}

function getAbsolutePath(root, rel) {
    if (rel.startsWith('/')) return rel;
    return GLib.build_filenamev([root, rel]);
}

/* ============================================================
 *  ЧТЕНИЕ ТЕГОВ (ID3v1 / ID3v2)
 * ============================================================ */
function toUint8Array(x) {
    if (x instanceof Uint8Array) return x;
    if (x && typeof x.length === 'number') {
        const out = new Uint8Array(x.length);
        for (let i = 0; i < x.length; i++) out[i] = x[i];
        return out;
    }
    throw new Error('Cannot convert to Uint8Array: ' + typeof x);
}

function loadFileBytes(path) {
    const file = Gio.File.new_for_path(path);
    const [ok, contents] = file.load_contents(null);
    if (!ok) throw new Error('Не удалось прочитать: ' + path);
    return toUint8Array(contents);
}

function isMarker(buf, off, marker) {
    if (buf.length - off < marker.length) return false;
    for (let i = marker.length - 1; i >= 0; i--) {
        if (buf[off + i] !== marker[i]) return false;
    }
    return true;
}

function scanTerminator(data, term, start) {
    const tlen = term.length;
    const limit = data.length - tlen;
    for (let i = start; i <= limit; i += tlen) {
        let match = true;
        for (let j = 0; j < tlen; j++) {
            if (data[i + j] !== term[j]) { match = false; break; }
        }
        if (match) return i;
    }
    return data.length;
}

function bitarray(byte) {
    return [128, 64, 32, 16, 8, 4, 2, 1].map(o => (byte & o) === o ? 1 : 0);
}

function flagsArr(names, values) {
    const r = {};
    for (let i = 0; i < names.length; i++) r[names[i]] = !!values[i];
    return r;
}

function unsynchsafe(input) {
    let out = 0, mask = 0x7F000000;
    while (mask) {
        out = (out >>> 1);
        out |= (input & mask);
        mask = (mask >>> 8);
    }
    return out >>> 0;
}

function removeZeroString(s) {
    for (let j = 0; j < s.length; j++) if (s.charCodeAt(j) === 0) return s.slice(0, j);
    return s;
}

function removeUnsyncBytes(data) {
    if (data.length === 0) return data;
    const result = new Uint8Array(data.length);
    result[0] = data[0];
    let pos = 1;
    for (let i = 1; i < data.length; i++) {
        if (data[i] === 0 && data[i - 1] === 0xFF) {
            // skip
        } else {
            result[pos++] = data[i];
        }
    }
    return result.slice(0, pos);
}

function decodeLatin1(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 4096) {
        const end = Math.min(i + 4096, bytes.length);
        const chunk = [];
        for (let j = i; j < end; j++) chunk.push(bytes[j]);
        s += String.fromCharCode.apply(null, chunk);
    }
    return s;
}

function decodeUTF16(bytes, littleEndian) {
    let s = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) {
        const code = littleEndian ? (bytes[i] | (bytes[i + 1] << 8)) : ((bytes[i] << 8) | bytes[i + 1]);
        s += String.fromCharCode(code);
    }
    return s;
}

function decodeUTF8(bytes) {
    let out = '';
    let i = 0;
    while (i < bytes.length) {
        const b = bytes[i++];
        if (b < 0x80) {
            out += String.fromCharCode(b);
        } else if ((b & 0xE0) === 0xC0) {
            out += String.fromCharCode(((b & 0x1F) << 6) | (bytes[i++] & 0x3F));
        } else if ((b & 0xF0) === 0xE0) {
            out += String.fromCharCode(((b & 0x0F) << 12) | ((bytes[i++] & 0x3F) << 6) | (bytes[i++] & 0x3F));
        } else if ((b & 0xF8) === 0xF0) {
            const cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3F) << 12) | ((bytes[i++] & 0x3F) << 6) | (bytes[i++] & 0x3F);
            const off = cp - 0x10000;
            out += String.fromCharCode(0xD800 + (off >> 10), 0xDC00 + (off & 0x3FF));
        } else {
            out += '\uFFFD';
        }
    }
    return out;
}

const ENC_LATIN1   = { name: 'iso-8859-1', byte: 0, terminator: [0],     decode: decodeLatin1 };
const ENC_UCS2     = { name: 'ucs2',       byte: 1, terminator: [0, 0],
    decode: function (b) {
        if (b.length >= 2 && b[0] === 0xFF && b[1] === 0xFE) return decodeUTF16(b.subarray(2), true);
        if (b.length >= 2 && b[0] === 0xFE && b[1] === 0xFF) return decodeUTF16(b.subarray(2), false);
        let isAscii = true;
        for (let i = 0; i < b.length; i++) if (b[i] === 0) { isAscii = false; break; }
        if (isAscii && b.length > 4) return decodeLatin1(b);
        return decodeUTF16(b, true);
    }
};
const ENC_UTF16BE  = { name: 'utf16-be',   byte: 2, terminator: [0, 0],
    decode: function (b) {
        if (b.length >= 2 && b[0] === 0xFE && b[1] === 0xFF) return decodeUTF16(b.subarray(2), false);
        if (b.length >= 2 && b[0] === 0xFF && b[1] === 0xFE) return decodeUTF16(b.subarray(2), true);
        return decodeUTF16(b, false);
    }
};
const ENC_UTF8     = { name: 'utf8',       byte: 3, terminator: [0],
    decode: function (b) {
        if (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) b = b.subarray(3);
        return decodeUTF8(b);
    }
};

const encodingsByName = {
    'iso-8859-1': ENC_LATIN1, 'ascii': ENC_LATIN1, 'binary': ENC_LATIN1,
    'ucs2': ENC_UCS2, 'ucs2le': ENC_UCS2, 'ucs2-be': ENC_UTF16BE,
    'utf16-be': ENC_UTF16BE, 'utf16be': ENC_UTF16BE, 'utf8': ENC_UTF8, 'utf-8': ENC_UTF8
};
const ascii  = ENC_LATIN1, binary = ENC_LATIN1, utf8 = ENC_UTF8;

function ByteReader(data) { this.data = data; this.position = 0; }
ByteReader.prototype.readByte = function () { return this.data[this.position++]; };
ByteReader.prototype.readBuffer = function (n) { const r = this.data.subarray(this.position, this.position + n); this.position += n; return r; };
ByteReader.prototype.readUInt = function (n) { let r = 0; for (let i = 0; i < n; i++) r = r * 256 + this.data[this.position + i]; this.position += n; return r; };
ByteReader.prototype.readEncoding = function () {
    const b = this.data[this.position++];
    const name = b === 0 ? 'iso-8859-1' : b === 1 ? 'ucs2' : b === 2 ? 'utf16-be' : b === 3 ? 'utf8' : b === 254 ? 'ucs2' : 'iso-8859-1';
    return encodingsByName[name] || ENC_LATIN1;
};
ByteReader.prototype.readString = function (n, enc) { return enc.decode(this.readBuffer(n)); };
ByteReader.prototype.readStringBuffer = function (amount) {
    let buf = this.readBuffer(amount);
    for (let i = 0; i < buf.length; i++) if (buf[i] === 0) { buf = buf.subarray(0, i); break; }
    return buf;
};
ByteReader.prototype.readFixedAsciiString = function (amount) { return ascii.decode(this.readStringBuffer(amount)); };
ByteReader.prototype.readFixedAutodetectString = function (amount) {
    const buf = this.readStringBuffer(amount);
    let result = decodeUTF8(buf);
    if (result.indexOf('\uFFFD') >= 0) result = decodeLatin1(buf);
    return result;
};
ByteReader.prototype.readStringTerminated = function (enc) {
    const idx = scanTerminator(this.data, enc.terminator, this.position);
    const buf = this.data.subarray(this.position, idx);
    const result = buf.length === 0 ? '' : enc.decode(buf);
    this.position = idx === this.data.length ? idx : idx + enc.terminator.length;
    return result;
};
ByteReader.prototype.readUnsyncedBuffer = function (amount) {
    let result = this.data.subarray(this.position, this.position + amount);
    let unsynced = removeUnsyncBytes(result);
    let stuffed = 0;
    while (unsynced.length < amount && (this.position + amount + stuffed < this.data.length)) {
        stuffed += amount - unsynced.length;
        result = this.data.subarray(this.position, this.position + amount + stuffed);
        unsynced = removeUnsyncBytes(result);
    }
    this.position += amount + stuffed;
    return unsynced;
};
ByteReader.prototype.rest = function () { const r = this.data.subarray(this.position); this.position = this.data.length; return r; };
ByteReader.prototype.unread = function () { return this.data.length - this.position; };
ByteReader.prototype.hasData = function () { return this.position < this.data.length; };

const MARKER_TAG = [84, 65, 71], MARKER_ID3 = [73, 68, 51];
const ID3v1_GENRES = ['Blues','Classic Rock','Country','Dance','Disco','Funk','Grunge','Hip-Hop','Jazz','Metal','New Age','Oldies','Other','Pop','R&B','Rap','Reggae','Rock','Techno','Industrial','Alternative','Ska','Death Metal','Pranks','Soundtrack','Euro-Techno','Ambient','Trip-Hop','Vocal','Jazz+Funk','Fusion','Trance','Classical','Instrumental','Acid','House','Game','Sound Clip','Gospel','Noise','AlternRock','Bass','Soul','Punk','Space','Meditative','Instrumental Pop','Instrumental Rock','Ethnic','Gothic','Darkwave','Techno-Industrial','Electronic','Pop-Folk','Eurodance','Dream','Southern Rock','Comedy','Cult','Gangsta','Top 40','Christian Rap','Pop/Funk','Jungle','Native American','Cabaret','New Wave','Psychadelic','Rave','Showtunes','Trailer','Lo-Fi','Tribal','Acid Punk','Acid Jazz','Polka','Retro','Musical','Rock & Roll','Hard Rock','Folk','Folk-Rock','National Folk','Swing','Fast Fusion','Bebob','Latin','Revival','Celtic','Bluegrass','Avantgarde','Gothic Rock','Progressive Rock','Psychedelic Rock','Symphonic Rock','Slow Rock','Big Band','Chorus','Easy Listening','Acoustic','Humour','Speech','Chanson','Opera','Chamber Music','Sonata','Symphony','Booty Bass','Primus','Porn Groove','Satire','Slow Jam','Club','Tango','Samba','Folklore','Ballad','Power Ballad','Rhythmic Soul','Freestyle','Duet','Punk Rock','Drum Solo','A capella','Euro-House','Dance Hall','Goa','Drum & Bass','Club-House','Hardcore','Terror','Indie','BritPop','World Music','Polsk Punk','Beat','Christian','Heavy Metal','Black Metal','Crossover','Contemporary','Christian Rock','Merengue','Salsa','Thrash Metal','Anime','JPop','Synthpop'];

const ID3v2_FRAME_HEADER_LENGTHS = { SIZE: { 2: 3, 3: 4, 4: 4 }, MARKER: { 2: 3, 3: 4, 4: 4 }, FLAGS: { 2: 0, 3: 2, 4: 2 } };
const ID3v2_FRAME_FLAGS1 = { 3: ['tagAlterPreservation','fileAlterPreservation','readOnly'], 4: ['reserved','tagAlterPreservation','fileAlterPreservation','readOnly'] };
const ID3v2_FRAME_FLAGS2 = { 3: ['compressed','encrypted','grouping'], 4: ['reserved','grouping','reserved2','reserved3','compressed','encrypted','unsynchronised','dataLengthIndicator'] };

function readID3v1(bytes) {
    if (bytes.length < 128 || !isMarker(bytes, 0, MARKER_TAG)) return null;
    const r = new ByteReader(bytes); r.position = 3;
    const value = {};
    value.title  = r.readFixedAutodetectString(30);
    value.artist = r.readFixedAutodetectString(30);
    value.album  = r.readFixedAutodetectString(30);
    value.year   = r.readFixedAutodetectString(4);
    if (bytes[125] === 0 && bytes[126] !== 0) {
        value.comment = r.readFixedAutodetectString(29);
        value.track = r.readByte(); value.version = 1;
    } else {
        value.comment = r.readFixedAutodetectString(30); value.version = 0;
    }
    value.genreIndex = r.readByte();
    return { id: 'ID3v1', version: value.version, value: value };
}

function readID3v2Header(buf, offset) {
    if (!isMarker(buf, offset, MARKER_ID3) || buf.length < offset + 10) return null;
    const flagBits = bitarray(buf[offset + 5]);
    const head = { ver: buf[offset + 3], rev: buf[offset + 4], size: ((buf[offset+6] << 24) | (buf[offset+7] << 16) | (buf[offset+8] << 8) | buf[offset+9]) >>> 0, flagBits: flagBits, valid: false };
    if (head.ver > 2) head.size = unsynchsafe(head.size);
    if (head.ver === 4) head.v4 = { flags: { unsynchronisation: flagBits[0] === 1, extendedheader: flagBits[1] === 1, experimental: flagBits[2] === 1, footer: flagBits[3] === 1 } };
    else if (head.ver === 3) head.v3 = { flags: { unsynchronisation: flagBits[0] === 1, extendedheader: flagBits[1] === 1, experimental: flagBits[2] === 1 } };
    else if (head.ver <= 2) head.v2 = { sizeAsSyncSafe: unsynchsafe(head.size), flags: { unsynchronisation: flagBits[0] === 1, compression: flagBits[1] === 1 } };
    head.valid = head.size >= 0 && head.ver <= 4;
    return head;
}

const FrameUnknown = { parse: (r, frame) => ({ value: { bin: frame.data }, encoding: binary }), simplify: v => v && v.bin && v.bin.length ? ('<bin ' + v.bin.length + 'bytes>') : null };
const FrameText = { parse: (r, frame) => { if (frame.data.length === 0) return { value: { text: '' }, encoding: utf8 }; const enc = r.readEncoding(); return { value: { text: r.readStringTerminated(enc) }, encoding: enc }; }, simplify: v => v && v.text ? v.text : null };
const FrameTextConcatList = { parse: (r, frame) => { if (frame.data.length === 0) return { value: { text: '' }, encoding: utf8 }; const enc = r.readEncoding(); let text = r.readStringTerminated(enc); while (r.hasData()) { const t = r.readStringTerminated(enc); if (t.length > 0) text += '/' + t; } return { value: { text: text }, encoding: enc }; }, simplify: v => v && v.text ? v.text : null };
const FrameTextList = { parse: (r) => { const enc = r.readEncoding(); const list = []; while (r.hasData()) { const t = r.readStringTerminated(enc); if (t.length > 0) list.push(t); } return { value: { list: list }, encoding: enc }; }, simplify: v => v && v.list && v.list.length ? v.list.join(' / ') : null };
const FrameAscii = { parse: (r) => ({ value: { text: r.readStringTerminated(ascii) }, encoding: ascii }), simplify: v => v && v.text ? v.text : null };
const FrameIdText = { parse: (r) => { const enc = r.readEncoding(); return { value: { id: r.readStringTerminated(enc), text: r.readStringTerminated(enc) }, encoding: enc }; }, simplify: v => v && v.text ? v.text : null };
const FrameIdAscii = { parse: (r) => ({ value: { id: r.readStringTerminated(ascii), text: r.readStringTerminated(ascii) }, encoding: ascii }), simplify: v => v && v.text ? v.text : null };
const FrameLangText = { parse: (r) => { const enc = r.readEncoding(); return { value: { language: removeZeroString(r.readString(3, ascii)).trim(), text: r.readStringTerminated(enc) }, encoding: enc }; }, simplify: v => v && v.text ? v.text : null };
const FrameLangDescText = { parse: (r) => { const enc = r.readEncoding(); return { value: { language: removeZeroString(r.readString(3, ascii)).trim(), id: r.readStringTerminated(enc), text: r.readStringTerminated(enc) }, encoding: enc }; }, simplify: v => v && v.text ? v.text : null };
const FrameBooleanString = { parse: (r) => { const enc = r.readEncoding(); const i = parseInt(r.readStringTerminated(enc), 10); return { value: { bool: i === 1 }, encoding: enc }; }, simplify: v => v ? (v.bool ? 'true' : 'false') : null };
const FramePic = {
    parse: (r, frame, head) => {
        const enc = r.readEncoding(); const mimeType = head.ver <= 2 ? r.readString(3, ascii) : r.readStringTerminated(ascii);
        const pictureType = r.readByte(); const description = r.readStringTerminated(enc);
        const value = { mimeType, pictureType, description };
        if (mimeType === '-->') value.url = r.readStringTerminated(enc); else value.bin = r.rest();
        return { value, encoding: enc };
    }, simplify: v => v ? '<pic type=' + v.pictureType + ';' + v.mimeType + ';' + (v.bin ? (v.bin.length + 'bytes') : v.url) + '>' : null
};

const FrameDefs = {
    'TT2': { title: 'Title', versions: [2], impl: FrameText, upgrade: 'TIT2' }, 'TP1': { title: 'Artist', versions: [2], impl: FrameTextConcatList, upgrade: 'TPE1' },
    'TAL': { title: 'Album', versions: [2], impl: FrameText, upgrade: 'TALB' }, 'TCO': { title: 'Genre', versions: [2], impl: FrameTextConcatList, upgrade: 'TCON' },
    'TYE': { title: 'Year', versions: [2], impl: FrameText, upgrade: 'TYER' }, 'TRK': { title: 'Track', versions: [2], impl: FrameText, upgrade: 'TRCK' },
    'COM': { title: 'Comments', versions: [2], impl: FrameLangDescText, upgrade: 'COMM' }, 'PIC': { title: 'Picture', versions: [2], impl: FramePic, upgrade: 'APIC' },
    'TIT2': { title: 'Title', versions: [3,4], impl: FrameText }, 'TPE1': { title: 'Artist', versions: [3,4], impl: FrameTextConcatList },
    'TPE2': { title: 'Album artist', versions: [3,4], impl: FrameText }, 'TALB': { title: 'Album', versions: [3,4], impl: FrameText },
    'TCON': { title: 'Genre', versions: [3,4], impl: FrameTextConcatList }, 'TRCK': { title: 'Track', versions: [3,4], impl: FrameText },
    'TPOS': { title: 'Disc', versions: [3,4], impl: FrameText }, 'TYER': { title: 'Year', versions: [3], impl: FrameText },
    'TDRC': { title: 'Recording time', versions: [4], impl: FrameText }, 'TDAT': { title: 'Date', versions: [3], impl: FrameText },
    'TIME': { title: 'Time', versions: [3], impl: FrameText }, 'TCOM': { title: 'Composer', versions: [3,4], impl: FrameText },
    'TENC': { title: 'Encoded by', versions: [3,4], impl: FrameText }, 'TPUB': { title: 'Publisher', versions: [3,4], impl: FrameText },
    'TSSE': { title: 'Encoder settings', versions: [3,4], impl: FrameText }, 'TBPM': { title: 'BPM', versions: [3,4], impl: FrameText },
    'TKEY': { title: 'Initial key', versions: [3,4], impl: FrameText }, 'TLAN': { title: 'Language', versions: [3,4], impl: FrameText },
    'TLEN': { title: 'Length', versions: [3,4], impl: FrameText }, 'TMED': { title: 'Media', versions: [3,4], impl: FrameText },
    'TCOP': { title: 'Copyright', versions: [3,4], impl: FrameText }, 'TOAL': { title: 'Original album', versions: [3,4], impl: FrameText },
    'TOPE': { title: 'Original artist', versions: [3,4], impl: FrameText }, 'TORY': { title: 'Original year', versions: [3], impl: FrameText },
    'TDOR': { title: 'Original date', versions: [4], impl: FrameText }, 'TIT1': { title: 'Grouping', versions: [3,4], impl: FrameText },
    'TIT3': { title: 'Subtitle', versions: [3,4], impl: FrameText }, 'TSST': { title: 'Set subtitle', versions: [3,4], impl: FrameText },
    'TEXT': { title: 'Lyricist', versions: [3,4], impl: FrameText }, 'TOLY': { title: 'Original lyricist', versions: [3,4], impl: FrameText },
    'TPE3': { title: 'Conductor', versions: [3,4], impl: FrameText }, 'TPE4': { title: 'Remixer', versions: [3,4], impl: FrameText },
    'TCMP': { title: 'Compilation', versions: [3,4], impl: FrameBooleanString }, 'TSOA': { title: 'Album sort', versions: [4], impl: FrameText },
    'TSOP': { title: 'Artist sort', versions: [4], impl: FrameText }, 'TSOT': { title: 'Title sort', versions: [4], impl: FrameText },
    'TSO2': { title: 'Album artist sort', versions: [3,4], impl: FrameText }, 'TSOC': { title: 'Composer sort', versions: [3,4], impl: FrameText },
    'MVNM': { title: 'Movement', versions: [3,4], impl: FrameText }, 'MVIN': { title: 'Movement number', versions: [3,4], impl: FrameText },
    'GRP1': { title: 'Work', versions: [3,4], impl: FrameText }, 'TMOO': { title: 'Mood', versions: [4], impl: FrameText },
    'TPRO': { title: 'Produced notice', versions: [4], impl: FrameText }, 'TDRL': { title: 'Release time', versions: [3,4], impl: FrameText },
    'TDTG': { title: 'Tagging time', versions: [4], impl: FrameText }, 'TSRC': { title: 'ISRC', versions: [3,4], impl: FrameText },
    'TFLT': { title: 'File type', versions: [3,4], impl: FrameText }, 'TDLY': { title: 'Playlist delay', versions: [3,4], impl: FrameText },
    'TDEN': { title: 'Encoding time', versions: [3,4], impl: FrameText }, 'TOFN': { title: 'Original filename', versions: [3,4], impl: FrameText },
    'TOWN': { title: 'File owner', versions: [3,4], impl: FrameText }, 'TRSN': { title: 'Radio station name', versions: [3,4], impl: FrameText },
    'TRSO': { title: 'Radio station owner', versions: [3,4], impl: FrameText }, 'TRDA': { title: 'Recording dates', versions: [3], impl: FrameText },
    'TSIZ': { title: 'Size', versions: [3], impl: FrameText }, 'WCOM': { title: 'Commercial info', versions: [3,4], impl: FrameAscii },
    'WCOP': { title: 'Copyright URL', versions: [3,4], impl: FrameAscii }, 'WOAF': { title: 'File webpage', versions: [3,4], impl: FrameAscii },
    'WOAR': { title: 'Artist webpage', versions: [3,4], impl: FrameAscii }, 'WOAS': { title: 'Source webpage', versions: [3,4], impl: FrameAscii },
    'WORS': { title: 'Radio station homepage', versions: [3,4], impl: FrameAscii }, 'WPAY': { title: 'Payment URL', versions: [3,4], impl: FrameAscii },
    'WPUB': { title: 'Publisher URL', versions: [3,4], impl: FrameAscii }, 'TXXX': { title: 'User text', versions: [3,4], impl: FrameIdText },
    'WXXX': { title: 'User URL', versions: [3,4], impl: FrameIdText }, 'UFID': { title: 'Unique file ID', versions: [3,4], impl: FrameIdAscii },
    'APIC': { title: 'Attached picture', versions: [3,4], impl: FramePic }, 'COMM': { title: 'Comments', versions: [3,4], impl: FrameLangDescText },
    'USLT': { title: 'Lyrics', versions: [3,4], impl: FrameLangDescText }, 'USER': { title: 'Terms of use', versions: [3,4], impl: FrameLangText },
    'TIPL': { title: 'Involved people', versions: [4], impl: FrameTextList }, 'TMCL': { title: 'Musician credits', versions: [4], impl: FrameTextList },
    'IPLS': { title: 'Involved people', versions: [3], impl: FrameTextList, upgrade: 'TIPL' }
};

function matchFrame(id) {
    const f = FrameDefs[id];
    if (f) return f;
    if (id.length === 4 && id.charAt(0) === 'T' && id !== 'TXXX') return { title: 'Unknown text', versions: [3,4], impl: FrameText };
    if (id.length === 4 && id.charAt(0) === 'W' && id !== 'WXXX') return { title: 'Unknown URL', versions: [3,4], impl: FrameAscii };
    return { title: 'Unknown', versions: [2,3,4], impl: FrameUnknown };
}

function isValidFrameBinId(idbin) {
    let id = idbin; const last = id[id.length - 1];
    if (last === 32 || last === 0) id = id.subarray(0, -1);
    let s = ''; for (let i = 0; i < id.length; i++) s += String.fromCharCode(id[i]);
    if (FrameDefs[s]) return true;
    if (s.length === 4 && (s.charAt(0) === 'T' || s.charAt(0) === 'W')) {
        let ok = true;
        for (let i = 1; i < 4; i++) { const c = s.charCodeAt(i); if (!((c >= 48 && c < 58) || (c >= 65 && c < 91))) { ok = false; break; } }
        if (ok) return true;
    }
    return false;
}

function readFramesInto(data, tag) {
    const markerLength = ID3v2_FRAME_HEADER_LENGTHS.MARKER[tag.head.ver];
    const r = new ByteReader(data); let finish = false, skip = 0;
    while (!finish) {
        let idbin = r.readBuffer(markerLength);
        if (idbin[0] === 0) { r.position -= markerLength; return; }
        while (r.hasData() && !isValidFrameBinId(idbin)) {
            r.position -= (markerLength - 1); skip++; idbin = r.readBuffer(markerLength);
        }
        if (r.hasData() && isValidFrameBinId(idbin)) {
            if (r.unread() < ID3v2_FRAME_HEADER_LENGTHS.SIZE[tag.head.ver]) return;
            skip = readFrameFromReader(r, idbin, tag, skip);
        } else finish = true;
    }
    if (skip > 0) r.position -= (skip + markerLength);
}

function readFrameFromReader(r, idbin, tag, skip) {
    let currentSkip = skip; const markerLength = ID3v2_FRAME_HEADER_LENGTHS.MARKER[tag.head.ver]; const pos = r.position;
    let id = ''; for (let i = 0; i < idbin.length; i++) id += String.fromCharCode(idbin[i]);
    id = removeZeroString(id.trim());
    const frame = { id: id, size: 0, start: 0, end: 0, data: new Uint8Array(0), statusFlags: {}, formatFlags: {} };
    frame.size = r.readUInt(ID3v2_FRAME_HEADER_LENGTHS.SIZE[tag.head.ver]);
    if (tag.head.ver === 4) frame.size = unsynchsafe(frame.size);
    if (ID3v2_FRAME_HEADER_LENGTHS.FLAGS[tag.head.ver] > 0) {
        frame.statusFlags = flagsArr(ID3v2_FRAME_FLAGS1[tag.head.ver], bitarray(r.readByte()));
        frame.formatFlags = flagsArr(ID3v2_FRAME_FLAGS2[tag.head.ver], bitarray(r.readByte()));
    }
    let valid = (!frame.statusFlags.reserved && !frame.formatFlags.reserved2 && !frame.formatFlags.reserved3);
    if (valid && frame.size > r.unread()) valid = false;
    if (valid) {
        if (currentSkip > 0 && tag.frames.length > 0) {
            const last = tag.frames[tag.frames.length - 1];
            const pad = r.data.subarray(pos - currentSkip - markerLength, pos - markerLength);
            const merged = new Uint8Array(last.data.length + pad.length);
            merged.set(last.data, 0); merged.set(pad, last.data.length);
            last.data = merged; last.size = merged.length;
        }
        currentSkip = 0;
        if (frame.size > 0) frame.data = (tag.head.v3 && tag.head.v3.flags.unsynchronisation) ? r.readUnsyncedBuffer(frame.size) : r.readBuffer(frame.size);
        tag.frames.push(frame);
    } else {
        r.position = pos - (markerLength - 1); currentSkip++;
    }
    return currentSkip;
}

function readID3v2Frame(rawFrame, head) {
    const f = matchFrame(rawFrame.id);
    const frame = { id: rawFrame.id, title: f.title, head: { encoding: undefined, statusFlags: rawFrame.statusFlags, formatFlags: rawFrame.formatFlags, size: rawFrame.size }, value: {} };
    try {
        if (rawFrame.formatFlags && rawFrame.formatFlags.encrypted) throw new Error('encrypted');
        if (rawFrame.formatFlags && rawFrame.formatFlags.unsynchronised) rawFrame.data = removeUnsyncBytes(rawFrame.data);
        if (rawFrame.formatFlags && rawFrame.formatFlags.compressed) throw new Error('compressed');
        if (rawFrame.formatFlags && rawFrame.formatFlags.dataLengthIndicator) rawFrame.data = rawFrame.data.subarray(4);
        const reader = new ByteReader(rawFrame.data);
        const result = f.impl.parse(reader, rawFrame, head);
        if (frame.head) frame.head.encoding = result.encoding ? result.encoding.name : undefined;
        frame.value = result.value || { bin: rawFrame.data };
    } catch (e) { frame.invalid = String(e); frame.value = { bin: rawFrame.data }; }
    return frame;
}

function buildID3v2(rawtag) {
    const frames = [];
    for (let i = 0; i < rawtag.frames.length; i++) frames.push(readID3v2Frame(rawtag.frames[i], rawtag.head));
    return { id: 'ID3v2', start: 0, end: rawtag.end, head: rawtag.head, frames: frames };
}

function parseID3v2(bytes) {
    const head = readID3v2Header(bytes, 0);
    if (!head || !head.valid) return null;
    const bodyLen = Math.min(head.size, bytes.length - 10);
    if (bodyLen < 0) return null;
    const body = bytes.subarray(10, 10 + bodyLen);
    const rawtag = { id: 'ID3v2', frames: [], head: head, end: 10 + bodyLen };
    readFramesInto(body, rawtag);
    return buildID3v2(rawtag);
}

const FramesMap = {
    'TALB': 'ALBUM', 'TSOA': 'ALBUMSORT', 'TIT2': 'TITLE', 'TSOT': 'TITLESORT', 'TIT1': 'GROUPING', 'TPE1': 'ARTIST', 'TSOP': 'ARTISTSORT', 'TPE2': 'ALBUMARTIST', 'TSO2': 'ALBUMARTISTSORT',
    'TDRC': 'DATE', 'TOAL': 'ORIGINALALBUM', 'TOPE': 'ORIGINALARTIST', 'TDOR': 'ORIGINALDATE', 'TORY': 'ORIGINALYEAR', 'TCOM': 'COMPOSER', 'TSOC': 'COMPOSERSORT', 'TEXT': 'LYRICIST',
    'TPE3': 'CONDUCTOR', 'TPE4': 'REMIXER', 'TPUB': 'LABEL', 'MVNM': 'MOVEMENTNAME', 'GRP1': 'WORK', 'TIT3': 'SUBTITLE', 'TSST': 'DISCSUBTITLE', 'TCMP': 'COMPILATION', 'TCON': 'GENRE', 'TBPM': 'BPM',
    'TMOO': 'MOOD', 'USLT': 'LYRICS', 'TMED': 'MEDIA', 'TLAN': 'LANGUAGE', 'TCOP': 'COPYRIGHT', 'WCOP': 'LICENSE', 'TENC': 'ENCODEDBY', 'TSSE': 'ENCODERSETTINGS', 'TSRC': 'ISRC', 'WOAR': 'WEBSITE',
    'TKEY': 'KEY', 'TLEN': 'TRACKLENGTH', 'TFLT': 'FILETYPE', 'TOWN': 'FILEOWNER', 'TRSN': 'RADIOSTATIONNAME', 'TRSO': 'RADIOSTATIONOWNER', 'TOFN': 'ORIGINALFILENAME', 'TDLY': 'PLAYLISTDELAY', 'TDEN': 'ENCODINGTIME', 'TSIZ': 'AUDIOSTREAMSIZE',
    'WCOM': 'COMMERCIALINFORMATIONURL', 'WOAF': 'FILEWEBPAGEURL', 'WOAS': 'AUDIOSOURCEWEBPAGEURL', 'WORS': 'RADIOSTATIONWEBPAGEURL', 'WPAY': 'PAYMENTURL', 'WPUB': 'PUBLISHERURL', 'USER': 'TERMSOFUSE', 'APIC': 'PICTURE', 'TRCK': 'TRACKNUMBER', 'MVIN': 'MOVEMENT', 'TPOS': 'DISCNUMBER'
};
const SplitFrameMap = { 'TRCK': ['TRACKNUMBER', 'TRACKTOTAL'], 'MVIN': ['MOVEMENT', 'MOVEMENTTOTAL'], 'TPOS': ['DISCNUMBER', 'DISCTOTAL'] };
const COMMMap = { 'description': 'COMMENT', 'comment': 'COMMENT' };
const TXXXMap = {
    'ORIGINALYEAR': 'ORIGINALYEAR', 'REPLAYGAIN_TRACK_GAIN': 'REPLAYGAIN_TRACK_GAIN', 'REPLAYGAIN_ALBUM_GAIN': 'REPLAYGAIN_ALBUM_GAIN', 'REPLAYGAIN_TRACK_PEAK': 'REPLAYGAIN_TRACK_PEAK', 'REPLAYGAIN_ALBUM_PEAK': 'REPLAYGAIN_ALBUM_PEAK',
    'MusicBrainz Album Id': 'MUSICBRAINZ_ALBUMID', 'MusicBrainz Artist Id': 'MUSICBRAINZ_ARTISTID', 'MusicBrainz Track Id': 'MUSICBRAINZ_TRACKID', 'MusicBrainz Recording Id': 'MUSICBRAINZ_TRACKID', 'MusicBrainz Album Artist Id': 'MUSICBRAINZ_ALBUMARTISTID',
    'ALBUM ARTIST': 'ALBUMARTIST', 'ALBUMARTISTSORT': 'ALBUMARTISTSORT', 'CATALOGNUMBER': 'CATALOGNUMBER', 'ASIN': 'ASIN', 'BARCODE': 'BARCODE', 'SCRIPT': 'SCRIPT', 'LICENSE': 'LICENSE', 'WORK': 'WORK', 'ARTISTS': 'ARTISTS', 'COMPOSERSORT': 'COMPOSERSORT', 'WRITER': 'WRITER', 'ORGANIZATION': 'ORGANIZATION'
};
const UFIDMap = { 'http://musicbrainz.org': 'MUSICBRAINZ_TRACKID' };
const DateUpgradeMap = { 'TYER': 'Year', 'TDAT': 'Date', 'TIME': 'Time' };

function slugIDValue(id, value, mapping) {
    if (value && value.id) return mapping[value.id] || mapping[value.id.toUpperCase()] || (id + '|' + value.id);
    if (value) return id;
    return undefined;
}

function upgrade23DateFramesTov24Date(dateFrames) {
    let year, date, time;
    for (let i = 0; i < dateFrames.length; i++) {
        const f = dateFrames[i];
        if (f.id === 'TYER' || f.id === 'TYE') year = f;
        else if (f.id === 'TDAT' || f.id === 'TDA') date = f;
        else if (f.id === 'TIME' || f.id === 'TIM') time = f;
    }
    if (!year && !date && !time) return;
    const parts = [];
    if (year && year.value && year.value.text) parts.push(year.value.text);
    if (date && date.value && date.value.text) parts.push(date.value.text);
    if (time && time.value && time.value.text) parts.push(time.value.text);
    return { id: 'TDRC', title: 'Recording time', value: { text: parts.join('-') } };
}

function simplifyFrame(frame, dropIDs) {
    const id = frame.id;
    if (dropIDs && dropIDs.indexOf(id) >= 0) return undefined;
    let slug = FramesMap[id];
    if (id === 'UFID') slug = slugIDValue(id, frame.value, UFIDMap);
    else if (id === 'TXXX') slug = slugIDValue(id, frame.value, TXXXMap);
    else if (id === 'COMM') slug = slugIDValue(id, frame.value, COMMMap);
    else if (id === 'WXXX') slug = slugIDValue(id, frame.value, {});
    else if (id === 'TIPL' || id === 'TMCL') {
        const value = frame.value; const known = { 'arranger':'ARRANGER', 'engineer':'ENGINEER', 'DJ-mix':'DJMIXER', 'mix':'MIXER', 'producer':'PRODUCER', 'instrument':'PERFORMER' };
        const list = []; const arr = (value && value.list) ? value.list : [];
        for (let i = 0; i + 1 < arr.length; i += 2) {
            const role = known[arr[i]];
            if (role) list.push({ slug: role, text: arr[i + 1] }); else list.push({ slug: id + '|' + arr[i], text: arr[i + 1] });
        }
        return list;
    }
    if (!slug) return undefined;
    const def = matchFrame(id);
    const text = def.impl.simplify(frame.value);
    if (!text) return undefined;
    if (SplitFrameMap[id]) {
        const names = SplitFrameMap[id]; const parts = text.split('/'); const out = [];
        if (parts[0]) out.push({ slug: names[0], text: parts[0] });
        if (parts[1]) out.push({ slug: names[1], text: parts[1] });
        return out;
    }
    return [{ slug: slug, text: text }];
}

function simplifyTag(tag, dropIDs) {
    const result = {}; const counter = {}; const frames = []; const dateFrames = [];
    for (let i = 0; i < tag.frames.length; i++) {
        const f = tag.frames[i];
        if (DateUpgradeMap[f.id]) dateFrames.push(f); else frames.push(f);
    }
    const dateFrame = upgrade23DateFramesTov24Date(dateFrames);
    if (dateFrame) frames.push(dateFrame);
    for (let i = 0; i < frames.length; i++) {
        const simples = simplifyFrame(frames[i], dropIDs);
        if (!simples) continue;
        for (let j = 0; j < simples.length; j++) {
            const s = simples[j]; const count = (counter[s.slug] || 0) + 1; counter[s.slug] = count;
            const name = s.slug + (count > 1 ? ('|' + count) : '');
            result[name] = s.text;
        }
    }
    return result;
}

/* Разбор тегов из уже загруженного массива байтов */
var parseTagsFromBytes = function (bytes) {
    try {
        const tags = {};
        let v2 = null;
        try { v2 = parseID3v2(bytes); } catch (e) { log('error', `ID3v2 parse failed: ${e.message}`); }
        if (v2) {
            const s = simplifyTag(v2);
            if (s.TITLE) tags.Name = s.TITLE;
            if (s.ARTIST) tags.Artist = s.ARTIST;
            if (s.ALBUMARTIST) tags.AlbumArtist = s.ALBUMARTIST;
            if (s.ALBUM) tags.Album = s.ALBUM;
            if (s.GENRE) {
                const m = s.GENRE.match(/^\((\d+)\)$/);
                tags.Genre = m ? (ID3v1_GENRES[parseInt(m[1], 10)] || s.GENRE) : s.GENRE;
            }
            if (s.DATE) tags.Year = String(s.DATE).slice(0, 4); else if (s.ORIGINALYEAR) tags.Year = String(s.ORIGINALYEAR).slice(0, 4);
            if (s.TRACKNUMBER) tags.Track = s.TRACKNUMBER;
            if (s.DISCNUMBER) tags.Disc = s.DISCNUMBER;
            if (s.COMMENT) tags.Comment = s.COMMENT;
            if (s.COMPOSER) tags.Composer = s.COMPOSER;
            if (s.LYRICS) tags.Lyrics = s.LYRICS;
            if (s.PICTURE) tags.Picture = s.PICTURE;
            if (s.MOOD) tags.Mood = s.MOOD;
            if (s.LABEL) tags.Label = s.LABEL;
            if (s.BPM) tags.BPM = s.BPM;
            if (s.COMPILATION) tags.Compilation = s.COMPILATION;
        }
        if (Object.keys(tags).length === 0 && bytes.length >= 128) {
            try {
                const v1 = readID3v1(bytes.subarray(bytes.length - 128));
                if (v1 && v1.value) {
                    const v = v1.value;
                    if (v.title) tags.Name = v.title;
                    if (v.artist) tags.Artist = v.artist;
                    if (v.album) tags.Album = v.album;
                    if (v.year) tags.Year = v.year;
                    if (v.comment) tags.Comment = v.comment;
                    if (v.track !== undefined && v.track !== 0) tags.Track = String(v.track);
                    if (v.genreIndex !== undefined && v.genreIndex < ID3v1_GENRES.length) tags.Genre = ID3v1_GENRES[v.genreIndex];
                }
            } catch (e) {}
        }
        return tags;
    } catch (e) {
        log('error', `parseTagsFromBytes failed: ${e.message}`);
        return null;
    }
};

/* Синхронное чтение (для CLI) */
var readTags = function (path) {
    try {
        const bytes = loadFileBytes(path);
        return parseTagsFromBytes(bytes) || {};
    } catch (e) {
        log('error', `readTags failed for ${path}: ${e.message}`);
        return {};
    }
};

/* ============================================================
 *  АСИНХРОННЫЙ СКАНЕР КАТАЛОГОВ
 * ============================================================ */
async function walkDirectory(file, ctx) {
    if (ctx.cancellable && ctx.cancellable.is_cancelled()) throw new Error('cancelled');
    let enumerator;
    try {
        enumerator = await file.enumerate_children_async(
            'standard::name,standard::type,standard::size',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT, ctx.cancellable);
    } catch (e) {
        if (ctx.cancellable && ctx.cancellable.is_cancelled()) throw e;
        log('error', `enumerate failed for ${file.get_path()}: ${e.message}`);
        return null;
    }
    const mp3s = []; const dirs = []; let batch;
    do {
        batch = await enumerator.next_files_async(BATCH_SIZE, GLib.PRIORITY_DEFAULT, ctx.cancellable);
        for (const info of batch) {
            const name = info.get_name(); const child = enumerator.get_child(info); const t = info.get_file_type();
            if (t === Gio.FileType.DIRECTORY) dirs.push({ name, file: child });
            else if (t === Gio.FileType.REGULAR && MP3_RE.test(name)) {
                mp3s.push(child.get_path()); // Возвращаем только путь (строку) для портативности
                ctx.fileCount++;
            }
        }
        if (ctx.onProgress) ctx.onProgress(ctx.fileCount);
    } while (batch.length > 0);
    enumerator.close(null);

    const subNodes = {};
    for (const { name, file: d } of dirs) {
        const sub = await walkDirectory(d, ctx);
        if (sub !== null) subNodes[name] = sub;
    }
    const hasSubs = Object.keys(subNodes).length > 0;
    if (mp3s.length === 0 && !hasSubs) return null;
    if (mp3s.length > 0 && !hasSubs) return mp3s;
    if (mp3s.length === 0 && hasSubs) return subNodes;
    const mixed = { '.': mp3s };
    for (const k in subNodes) mixed[k] = subNodes[k];
    return mixed;
}

var scanDirectory = async function(rootPath, onProgress) {
    const rootFile = Gio.File.new_for_path(rootPath);
    const ctx = { cancellable: new Gio.Cancellable(), onProgress, fileCount: 0 };
    return await walkDirectory(rootFile, ctx);
};

/* ============================================================
 *  ПРЕВРАЩЕНИЕ ДЕРЕВА ПУТЕЙ В ДЕРЕВО С ТЕГАМИ
 * ============================================================ */
function applyTagsToTree(node) {
    if (Array.isArray(node)) {
        return node.map(item => {
            const path = typeof item === 'string' ? item : item.path;
            const tags = readTags(path);
            return { name: GLib.path_get_basename(path), path: path, tags: tags };
        });
    }
    if (node && typeof node === 'object') {
        const out = {};
        for (const key in node) {
            out[key] = applyTagsToTree(node[key]);
        }
        return out;
    }
    return node;
}

/* ============================================================
 *  CLI (ЗАПУСК В ТЕРМИНАЛЕ)
 * ============================================================ */
var exports = { readTags, scanDirectory, applyTagsToTree, getRelativePath, getAbsolutePath, parseTagsFromBytes };

const isMain = (typeof System.programPath === 'string' && System.programPath.endsWith('mp3-scanner.js')) ||
               (typeof System.programInvocationName === 'string' && System.programInvocationName.endsWith('mp3-scanner.js'));

if (isMain && typeof ARGV !== 'undefined' && ARGV.length > 0) {
    const command = ARGV[0];
    
    if (command === 'test') {
        if (!ARGV[1]) { print('Usage: gjs mp3-scanner.js test <file.mp3>'); System.exit(1); }
        print(JSON.stringify(readTags(ARGV[1]), null, 2));
    } 
    else if (command === 'scan') {
        const root = ARGV[1];
        const outFile = ARGV[2] || 'tree.json';
        if (!root) { print('Usage: gjs mp3-scanner.js scan <dir> [out.json]'); System.exit(1); }
        
        const absRoot = GLib.canonicalize_filename(root, GLib.get_current_dir());
        const loop = new GLib.MainLoop(null, false);
        print(`Scanning ${absRoot}...`);
        
        scanDirectory(absRoot, (count) => { if (count % 100 === 0) print(`  ...${count} files`); })
            .then(tree => {
                function toRelative(node) {
                    if (Array.isArray(node)) return node.map(f => getRelativePath(absRoot, f));
                    if (node && typeof node === 'object') {
                        const out = {};
                        for (const k in node) out[k] = toRelative(node[k]);
                        return out;
                    }
                    return node;
                }
                const relTree = toRelative(tree);
                GLib.file_set_contents(outFile, JSON.stringify(relTree, null, 2));
                print(`Done. Saved to ${outFile} (relative paths)`);
                loop.quit();
            })
            .catch(e => {
                log('error', e.message);
                loop.quit();
            });
        loop.run();
    } 
    else if (command === 'tags') {
        const inFile = ARGV[1];
        let outFile = ARGV[2];
        if (!inFile) { print('Usage: gjs mp3-scanner.js tags <in.json> [out.json]'); System.exit(1); }
        
        print(`Reading ${inFile}...`);
        try {
            const [ok, data] = GLib.file_get_contents(inFile);
            if (!ok) throw new Error('Could not read ' + inFile);
            
            // Используем ByteArray.toString() для корректного чтения JSON в GJS
            const tree = JSON.parse(ByteArray.toString(data));
            const rootDir = GLib.path_get_dirname(GLib.canonicalize_filename(inFile, GLib.get_current_dir()));
            if (!outFile) outFile = GLib.build_filenamev([rootDir, 'mp3-tag-cache.json']);
            
            const tagCache = {};
            
            // Считаем общее количество файлов для прогресс-бара
            let totalFiles = 0;
            function countFiles(node) {
                if (Array.isArray(node)) totalFiles += node.length;
                else if (node && typeof node === 'object') {
                    for (const k in node) countFiles(node[k]);
                }
            }
            countFiles(tree);
            
            let processedFiles = 0;
            print(`Applying tags to ${totalFiles} files (this may take a while)...`);
            
            function processNode(node) {
                if (Array.isArray(node)) {
                    for (const item of node) {
                        const rel = typeof item === 'string' ? item : item.path;
                        const abs = getAbsolutePath(rootDir, rel);
                        
                        tagCache[rel] = readTags(abs);
                        
                        processedFiles++;
                        // Выводим прогресс каждые 500 файлов и в самом конце
                        if (processedFiles % 500 === 0 || processedFiles === totalFiles) {
                            print(`  Прочитано ${processedFiles} из ${totalFiles}...`);
                        }
                    }
                } else if (node && typeof node === 'object') {
                    for (const k in node) processNode(node[k]);
                }
            }
            processNode(tree);
            
            GLib.file_set_contents(outFile, JSON.stringify(tagCache, null, 2));
            print(`Done. Saved to ${outFile} (relative paths)`);
        } catch (e) {
            log('error', e.message);
            System.exit(1);
        }
    }
    else if (command === 'cacheforce') {
        const root = ARGV[1];
        if (!root) { print('Usage: gjs mp3-scanner.js cacheforce <dir>'); System.exit(1); }
        
        const absRoot = GLib.canonicalize_filename(root, GLib.get_current_dir());
        const loop = new GLib.MainLoop(null, false);
        print(`Scanning ${absRoot}...`);
        
        scanDirectory(absRoot, (count) => { if (count % 100 === 0) print(`  ...${count} files`); })
            .then(tree => {
                function toRel(n) {
                    if (Array.isArray(n)) return n.map(p => getRelativePath(absRoot, p));
                    if (n && typeof n === 'object') {
                        const out = {}; for (const k in n) out[k] = toRel(n[k]); return out;
                    }
                    return n;
                }
                const relTree = toRel(tree);
                const fileCache = GLib.build_filenamev([absRoot, 'mp3-file-cache.json']);
                GLib.file_set_contents(fileCache, JSON.stringify(relTree, null, 2));
                print(`Saved: ${fileCache}`);
                
                print(`Reading ALL tags (force)...`);
                const tagCache = {};
                function extractPaths(n) {
                    if (Array.isArray(n)) return n;
                    if (n && typeof n === 'object') {
                        let res = []; for (const k in n) res = res.concat(extractPaths(n[k])); return res;
                    }
                    return [];
                }
                const relPaths = extractPaths(relTree);
                let idx = 0;
                const idle = () => {
                    const start = Date.now();
                    while (idx < relPaths.length) {
                        const rel = relPaths[idx];
                        tagCache[rel] = readTags(getAbsolutePath(absRoot, rel));
                        idx++;
                        if (idx % 500 === 0) print(`  Прочитано ${idx} из ${relPaths.length}...`);
                        if (Date.now() - start > 100) break;
                    }
                    if (idx >= relPaths.length) {
                        GLib.file_set_contents(GLib.build_filenamev([absRoot, 'mp3-tag-cache.json']),
                                               JSON.stringify(tagCache, null, 2));
                        print(`Done. Saved mp3-tag-cache.json`);
                        loop.quit(); return GLib.SOURCE_REMOVE;
                    }
                    return GLib.SOURCE_CONTINUE;
                };
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, idle);
            })
            .catch(e => { log('error', e.message); loop.quit(); });
        loop.run();
    }
    else if (command === 'cache') {
        const root = ARGV[1];
        if (!root) { print('Usage: gjs mp3-scanner.js cache <dir>'); System.exit(1); }
        
        const absRoot = GLib.canonicalize_filename(root, GLib.get_current_dir());
        const loop = new GLib.MainLoop(null, false);
        print(`Scanning ${absRoot}...`);
        
        scanDirectory(absRoot, (count) => { if (count % 100 === 0) print(`  ...${count} files`); })
            .then(tree => {
                function toRel(n) {
                    if (Array.isArray(n)) return n.map(p => getRelativePath(absRoot, p));
                    if (n && typeof n === 'object') {
                        const out = {}; for (const k in n) out[k] = toRel(n[k]); return out;
                    }
                    return n;
                }
                const relTree = toRel(tree);
                const fileCache = GLib.build_filenamev([absRoot, 'mp3-file-cache.json']);
                GLib.file_set_contents(fileCache, JSON.stringify(relTree, null, 2));
                print(`Saved: ${fileCache}`);
                
                // Загружаем существующий кэш тегов (apply-логика)
                const tagCacheFile = GLib.build_filenamev([absRoot, 'mp3-tag-cache.json']);
                let tagCache = {};
                if (GLib.file_test(tagCacheFile, GLib.FileTest.EXISTS)) {
                    const [ok, data] = GLib.file_get_contents(tagCacheFile);
                    if (ok) try { tagCache = JSON.parse(ByteArray.toString(data)); } catch (e) {}
                }
                
                function extractPaths(n) {
                    if (Array.isArray(n)) return n;
                    if (n && typeof n === 'object') {
                        let res = []; for (const k in n) res = res.concat(extractPaths(n[k])); return res;
                    }
                    return [];
                }
                const allRel = extractPaths(relTree);
                const newRel = allRel.filter(rel => tagCache[rel] === undefined);
                
                if (newRel.length === 0) {
                    print(`No new files. Cache already has ${Object.keys(tagCache).length} entries.`);
                    loop.quit(); return;
                }
                
                print(`Found ${newRel.length} new files (of ${allRel.length}). Reading ID3 (apply)...`);
                let idx = 0;
                const idle = () => {
                    const start = Date.now();
                    while (idx < newRel.length) {
                        const rel = newRel[idx];
                        tagCache[rel] = readTags(getAbsolutePath(absRoot, rel));
                        idx++;
                        if (idx % 500 === 0 || idx === newRel.length) print(`  Прочитано ${idx} из ${newRel.length}...`);
                        if (Date.now() - start > 100) break;
                    }
                    if (idx >= newRel.length) {
                        GLib.file_set_contents(tagCacheFile, JSON.stringify(tagCache, null, 2));
                        print(`Done. Updated mp3-tag-cache.json`);
                        loop.quit(); return GLib.SOURCE_REMOVE;
                    }
                    return GLib.SOURCE_CONTINUE;
                };
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, idle);
            })
            .catch(e => { log('error', e.message); loop.quit(); });
        loop.run();
    }
        else if (command === 'apply') {
        const inFile = ARGV[1];
        let outFile = ARGV[2];
        if (!inFile || !outFile) { print('Usage: gjs mp3-scanner.js apply <in.json> <out.json>'); System.exit(1); }

        print(`Reading tree from ${inFile}...`);
        try {
            const [ok, data] = GLib.file_get_contents(inFile);
            if (!ok) throw new Error('Could not read ' + inFile);
            
            // Читаем дерево (in.json)
            const tree = JSON.parse(ByteArray.toString(data));
            const rootDir = GLib.path_get_dirname(GLib.canonicalize_filename(inFile, GLib.get_current_dir()));

            // Читаем существующий кэш тегов (out.json)
            let tagCache = {};
            if (GLib.file_test(outFile, GLib.FileTest.EXISTS)) {
                print(`Reading existing tags from ${outFile}...`);
                const [ok2, data2] = GLib.file_get_contents(outFile);
                if (ok2) {
                    try { tagCache = JSON.parse(ByteArray.toString(data2)); } catch(e) {}
                }
            }

            const filesToRead = [];

            // Ищем файлы, для которых ещё нет тегов
            function processNode(node) {
                if (Array.isArray(node)) {
                    for (const item of node) {
                        const rel = typeof item === 'string' ? item : item.path;
                        if (tagCache[rel] === undefined) {
                            filesToRead.push(rel);
                        }
                    }
                } else if (node && typeof node === 'object') {
                    for (const k in node) processNode(node[k]);
                }
            }
            processNode(tree);

            const total = filesToRead.length;
            if (total === 0) {
                print(`No new files found. Tag cache is up to date.`);
                System.exit(0);
            }

            print(`Found ${total} new files. Reading ID3...`);
            
            let processed = 0;
            for (const rel of filesToRead) {
                const abs = getAbsolutePath(rootDir, rel);
                tagCache[rel] = readTags(abs);
                
                processed++;
                if (processed % 500 === 0 || processed === total) {
                    print(`  Прочитано ${processed} из ${total}...`);
                }
            }

            GLib.file_set_contents(outFile, JSON.stringify(tagCache, null, 2));
            print(`Done. Updated ${outFile}`);
        } catch (e) {
            log('error', e.message);
            System.exit(1);
        }
    }
    else if (command === '-h' || command === '--help') {
        print(`Usage: gjs mp3-scanner.js <command> [options]`);
        print(`Commands:`);
        print(`  test <file.mp3>          - print ID3 tags for one file as JSON`);
        print(`  scan <dir> [out.json]    - scan a directory and save its tree to a JSON file`);
        print(`  tags <in.json> [out.json]- read ID3 tags for all files in a tree JSON and save to another JSON`);
        print(`  cache <dir>              - scan + apply: read ID3 only for new files`);
        print(`  cacheforce <dir>         - scan + tags : read ID3 for ALL files (long!)`);
        print(`  apply <in.json> <out.json> - add tags ONLY for new files in in.json that are missing in out.json`);
        System.exit(0);
    } else {
        print('Usage: gjs mp3-scanner.js <command> [options]');
        print('Type `gjs mp3-scanner.js --help` for more information.');
        System.exit(1);
    }
}
