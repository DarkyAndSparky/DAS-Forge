/**
 * A very small PostgreSQL client for the tests (simple + extended query protocol, text format, trust authentication over a
 * unix socket), shaped like the part of `pg` that the driver uses: `new Pool().query / connect / end`.
 * Used only when no real `pg` is installed (set DAS_TEST_PG_SOCKET_DIR and DAS_TEST_PG_PORT); with `pg` and
 * DAS_TEST_POSTGRES_URL the tests use the real thing.
 */
import net from 'node:net';

const cstr = (s) => Buffer.concat([Buffer.from(String(s), 'utf8'), Buffer.from([0])]);
const i32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const i16 = (n) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const msg = (type, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from(type), i32(body.length + 4), body]); };

function parseValue(oid, text) {
  if (text === null) return null;
  if (oid === 16) return text === 't';
  if ([20, 21, 23, 26, 700, 701].includes(oid)) return Number(text);
  if (oid === 114 || oid === 3802) return JSON.parse(text);
  if (oid === 17) return Buffer.from(text.slice(2), 'hex');
  return text;
}

class Connection {
  constructor(options) { this.options = options; this.buf = Buffer.alloc(0); this.waiters = []; }
  async open() {
    const path = `${this.options.dir}/.s.PGSQL.${this.options.port}`;
    this.socket = net.connect(path);
    this.socket.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.pump(); });
    await new Promise((resolve, reject) => { this.socket.once('connect', resolve); this.socket.once('error', reject); });
    const params = Buffer.concat([cstr('user'), cstr(this.options.user ?? 'postgres'), cstr('database'), cstr(this.options.database ?? 'postgres'), Buffer.from([0])]);
    this.socket.write(Buffer.concat([i32(params.length + 8), i32(196608), params]));
    await this.readUntilReady();
  }
  pump() { while (this.waiters.length > 0 && this.take()) { /* each waiter consumes messages */ } }
  take() {
    if (this.buf.length < 5) return false;
    const len = this.buf.readInt32BE(1);
    if (this.buf.length < len + 1) return false;
    const m = { type: String.fromCharCode(this.buf[0]), body: this.buf.subarray(5, len + 1) };
    this.buf = this.buf.subarray(len + 1);
    this.waiters[0](m);
    return true;
  }
  next() { return new Promise((resolve) => { this.waiters.push((m) => { this.waiters.shift(); resolve(m); }); this.pump(); }); }
  async readUntilReady() {
    const out = { rows: [], rowCount: 0, error: null, fields: [] };
    for (;;) {
      const m = await this.next();
      if (m.type === 'T') {
        let o = 2; out.fields = [];
        for (let i = 0; i < m.body.readInt16BE(0); i += 1) {
          const end = m.body.indexOf(0, o);
          const name = m.body.toString('utf8', o, end);
          out.fields.push({ name, oid: m.body.readInt32BE(end + 7) });
          o = end + 19;
        }
      } else if (m.type === 'D') {
        const n = m.body.readInt16BE(0); let o = 2; const row = {};
        for (let i = 0; i < n; i += 1) {
          const len = m.body.readInt32BE(o); o += 4;
          let v = null;
          if (len >= 0) { v = m.body.toString('utf8', o, o + len); o += len; }
          row[out.fields[i].name] = parseValue(out.fields[i].oid, v);
        }
        out.rows.push(row);
      } else if (m.type === 'C') {
        const tag = m.body.toString('utf8', 0, m.body.length - 1).split(' ');
        const last = Number(tag[tag.length - 1]);
        out.rowCount = Number.isFinite(last) ? last : 0;
      } else if (m.type === 'E') {
        const fields = {}; let o = 0;
        while (m.body[o] !== 0) { const k = String.fromCharCode(m.body[o]); const end = m.body.indexOf(0, o + 1); fields[k] = m.body.toString('utf8', o + 1, end); o = end + 1; }
        out.error = Object.assign(new Error(fields.M), { code: fields.C, table: fields.t, column: fields.c, constraint: fields.n, detail: fields.D });
      } else if (m.type === 'Z') {
        if (out.error) throw out.error;
        return out;
      }
    }
  }
  async query(text, values) {
    if (!values || values.length === 0) {
      this.socket.write(msg('Q', cstr(text)));
      return this.readUntilReady();
    }
    const binds = values.map((v) => (v === null ? i32(-1) : (() => { const b = Buffer.from(Buffer.isBuffer(v) ? `\\x${v.toString('hex')}` : typeof v === 'boolean' ? (v ? 't' : 'f') : String(v), 'utf8'); return Buffer.concat([i32(b.length), b]); })()));
    this.socket.write(Buffer.concat([
      msg('P', cstr(''), cstr(text), i16(0)),
      msg('B', cstr(''), cstr(''), i16(0), i16(values.length), ...binds, i16(0)),
      msg('D', Buffer.from('P'), cstr('')),
      msg('E', cstr(''), i32(0)),
      msg('S'),
    ]));
    return this.readUntilReady();
  }
  close() { this.socket.end(); }
}

export class Pool {
  constructor(options) { this.options = options; this.free = []; }
  async connect() {
    const c = this.free.pop() ?? new Connection(this.options);
    if (!c.socket) await c.open();
    return { query: (t, v) => c.query(t, v), release: (err) => { if (err) c.close(); else this.free.push(c); } };
  }
  async query(text, values) {
    const client = await this.connect();
    try { return await client.query(text, values); } finally { client.release(); }
  }
  async end() { for (const c of this.free) c.close(); this.free = []; }
}

export const types = { getTypeParser: () => (x) => x };
