import { describe, it, expect } from 'vitest';

import { createMultipartUpload } from '../src/files/multipart.js';

/** A stand-in for multer: only the surface createMultipartUpload touches. Real parsing is covered over HTTP by the workshop smoke test. */
function fakeMulter(behaviour) {
  const m = (options) => {
    m.lastOptions = options;
    return { single: (field) => (req, res, cb) => behaviour(req, field, cb) };
  };
  m.memoryStorage = () => ({ kind: 'memory' });
  return m;
}
const multerError = (code, field) => Object.assign(new Error(code), { name: 'MulterError', code, field });

function run(mw, headers = { 'content-type': 'multipart/form-data; boundary=x' }) {
  const req = { headers };
  const res = { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  let nextArg = 'not-called';
  mw(req, res, (err) => { nextArg = err; });
  return { req, res, get next() { return nextArg; } };
}

describe('createMultipartUpload (multer, in memory)', () => {
  it('needs a positive size limit', () => {
    expect(() => createMultipartUpload({})).toThrow();
    expect(() => createMultipartUpload({ maxBytes: 0 })).toThrow();
  });

  it('refuses anything that is not multipart/form-data with 415, without touching multer', () => {
    let touched = false;
    const mw = createMultipartUpload({ maxBytes: 10, multer: fakeMulter(() => { touched = true; }) });
    for (const type of ['image/png', 'application/json', undefined]) {
      const r = run(mw, type ? { 'content-type': type } : {});
      expect(r.res.statusCode).toBe(415);
      expect(r.res.body.error).toBe('UNSUPPORTED_MEDIA_TYPE');
    }
    expect(touched).toBe(false);
  });

  it('passes limits to multer, keeps the file in memory and exposes it as req.upload', () => {
    const m = fakeMulter((req, field, cb) => {
      expect(field).toBe('logo');
      req.file = { buffer: Buffer.from('abc'), originalname: 'a.png', mimetype: 'image/png', size: 3 };
      cb();
    });
    const r = run(createMultipartUpload({ maxBytes: 1234, field: 'logo', multer: m }));
    expect(m.lastOptions.limits.fileSize).toBe(1234);
    expect(m.lastOptions.limits.files).toBe(1);
    expect(m.lastOptions.storage.kind).toBe('memory');
    expect(r.next).toBe(undefined);
    expect(r.req.upload.buffer.toString()).toBe('abc');
    expect(r.req.upload.originalName).toBe('a.png');
    expect(r.req.upload.declaredType).toBe('image/png');
  });

  it('maps multer limit errors to JSON refusals', () => {
    const cases = [
      ['LIMIT_FILE_SIZE', 413, 'FILE_TOO_LARGE'],
      ['LIMIT_UNEXPECTED_FILE', 400, 'UNEXPECTED_FIELD'],
      ['LIMIT_FILE_COUNT', 400, 'TOO_MANY_PARTS'],
      ['LIMIT_PART_COUNT', 400, 'TOO_MANY_PARTS'],
    ];
    for (const [code, status, error] of cases) {
      const r = run(createMultipartUpload({ maxBytes: 10, multer: fakeMulter((req, f, cb) => cb(multerError(code, 'x'))) }));
      expect(r.res.statusCode).toBe(status);
      expect(r.res.body.error).toBe(error);
    }
  });

  it('a form without a file is 400 NO_FILE; a broken multipart body is 400; other errors go to next()', () => {
    const none = run(createMultipartUpload({ maxBytes: 10, multer: fakeMulter((req, f, cb) => cb()) }));
    expect(none.res.statusCode).toBe(400);
    expect(none.res.body.error).toBe('NO_FILE');

    const broken = run(createMultipartUpload({ maxBytes: 10, multer: fakeMulter((req, f, cb) => cb(new Error('Unexpected end of form'))) }));
    expect(broken.res.statusCode).toBe(400);
    expect(broken.res.body.error).toBe('MALFORMED_MULTIPART');

    const boom = new Error('disk on fire');
    const other = run(createMultipartUpload({ maxBytes: 10, multer: fakeMulter((req, f, cb) => cb(boom)) }));
    expect(other.next).toBe(boom);
  });
});
