import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

/**
 * A stand-in for the `express-session` module, for the fast route tests that run
 * against a hand-written fake app (no sockets, no real Express). It implements
 * only what the platform uses - `Store`, a middleware that reads the session id
 * from `req.cookies[name]` (UNSIGNED here), `req.session.regenerate/save/destroy`
 * and a `cookie.maxAge` - on top of the REAL core session store, so the SQLite
 * side (hashed ids, user_id, expiry) is the real thing. Signing, Set-Cookie
 * attributes and the rest of express-session are exercised over real HTTP by
 * server.smoke.test.js.
 */
export function createFakeExpressSession() {
  class Store extends EventEmitter {}

  const call = (fn) => new Promise((resolve, reject) => fn((err, value) => (err ? reject(err) : resolve(value))));

  function makeCookie(maxAge) {
    let max = maxAge;
    let expires = new Date(Date.now() + maxAge);
    return {
      get maxAge() { return max; },
      set maxAge(ms) { max = ms; expires = new Date(Date.now() + ms); },
      get expires() { return expires; },
      toJSON() { return { originalMaxAge: max, expires: expires.toISOString(), httpOnly: true }; },
    };
  }

  function factory(options) {
    const { store, name, cookie: cookieOptions } = options;

    return (req, res, next) => {
      const attach = (sid, data) => {
        const session = {};
        Object.defineProperty(session, 'cookie', { value: makeCookie(cookieOptions.maxAge), enumerable: true, writable: true });
        Object.assign(session, data);
        const hidden = (key, value) => Object.defineProperty(session, key, { value, enumerable: false });
        hidden('regenerate', (cb) => {
          store.destroy(req.sessionID, () => {
            attach(randomUUID(), {});
            cb();
          });
        });
        hidden('save', (cb) => {
          store.set(req.sessionID, session, (err) => {
            if (!err) res.cookie(name, req.sessionID, { ...cookieOptions });
            cb(err);
          });
        });
        hidden('destroy', (cb) => {
          store.destroy(req.sessionID, (err) => {
            delete req.session;
            cb(err);
          });
        });
        req.sessionID = sid;
        req.session = session;
      };

      const sid = req.cookies?.[name];
      if (!sid) {
        attach(randomUUID(), {});
        return next();
      }
      call((cb) => store.get(sid, cb)).then(
        (stored) => {
          if (stored) {
            const { cookie, ...rest } = stored;
            attach(sid, rest);
            // keep the stored expiry so a later save() does not extend the session
            if (cookie?.expires) req.session.cookie.maxAge = Math.max(0, new Date(cookie.expires).getTime() - Date.now());
          } else {
            attach(randomUUID(), {});
          }
          next();
        },
        (err) => next(err)
      );
    };
  }

  return Object.assign(factory, { Store });
}
