/** A problem with a document, with a stable `code` for the caller to turn into its own message. */
export class DocumentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DocumentError';
    this.code = code;
  }
}
