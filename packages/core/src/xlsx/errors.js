/** A problem with a spreadsheet, with a stable `code` for the caller to turn into its own message. */
export class XlsxError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'XlsxError';
    this.code = code;
  }
}
