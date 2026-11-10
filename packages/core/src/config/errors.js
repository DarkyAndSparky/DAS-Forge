/**
 * Unified validation-error shape agreed in §7.5:
 *   { error: 'VALIDATION_ERROR', fields: [{ path, message, code }] }
 *
 * This is the SAME shape core/http uses for request-body validation errors,
 * so app code and UI form handling only need to understand one error format.
 */
export class ConfigValidationError extends Error {
  constructor(zodError, { sourcePath } = {}) {
    // One field per unknown key, with the key in the path ("server.prot"),
    // instead of one "Unrecognized key" line for the whole parent object.
    const fields = zodError.issues.flatMap((issue) =>
      issue.code === 'unrecognized_keys' && Array.isArray(issue.keys)
        ? issue.keys.map((key) => ({
            path: [...issue.path, key].join('.'),
            message: `Unknown setting "${key}" (typo or removed option?)`,
            code: issue.code,
          }))
        : [{ path: issue.path.join('.'), message: issue.message, code: issue.code }]
    );

    const summary = fields.map((f) => `${f.path || '(root)'}: ${f.message}`).join('; ');
    super(`Invalid configuration${sourcePath ? ` in ${sourcePath}` : ''}: ${summary}`);

    this.name = 'ConfigValidationError';
    this.error = 'VALIDATION_ERROR';
    this.fields = fields;
    this.sourcePath = sourcePath;
  }
}
