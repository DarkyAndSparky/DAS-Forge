import { sendError } from './respond.js';
import { ConfigValidationError } from '../config/errors.js';

/**
 * §4.5j: client-side validation is UX only. The server ALWAYS
 * revalidates with the same (isomorphic) Zod schema - this middleware
 * is the one enforcement point for that rule on the request body.
 *
 * On success, replaces req.body with the parsed+defaulted data (so
 * handlers get the same shape loadConfig() callers get - defaults
 * filled in, no need to re-check for undefined everywhere).
 *
 * On failure, responds with the SAME unified error shape as
 * ConfigValidationError ({error:'VALIDATION_ERROR', fields}), so UI
 * form-error handling only needs to understand one format regardless
 * of whether the failure came from config loading or a request body.
 */
export function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const err = new ConfigValidationError(result.error, { sourcePath: req.path });
      return sendError(req, res, 400, { error: err.error, fields: err.fields });
    }
    req.body = result.data;
    next();
  };
}

/** Same idea, for query-string params. */
export function validateQuery(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      const err = new ConfigValidationError(result.error, { sourcePath: req.path });
      return sendError(req, res, 400, { error: err.error, fields: err.fields });
    }
    req.query = result.data;
    next();
  };
}
