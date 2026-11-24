# @das-forge/documents-pdf

PDF reader for the `documents` module of `@das-forge/core`. It lives in its own package so that the core keeps no PDF
library: an application that never reads PDF installs nothing extra. The parsing is done by [unpdf](https://github.com/unjs/unpdf) (MIT, PDF.js inside), an optional peer dependency.

```
npm install @das-forge/documents-pdf unpdf
```

```js
import { readDocument, readDocumentIsolated } from '@das-forge/core/documents';
import readPdf from '@das-forge/documents-pdf';

// in the main thread
const doc = await readDocument(buffer, { readers: { pdf: readPdf } });

// for files from people you do not trust: own thread, memory and time limits
const doc2 = await readDocumentIsolated(buffer, { readerModules: { pdf: '@das-forge/documents-pdf' } });
```

The result has the shape of the other readers: `{ format: 'pdf', text, blocks, metadata, safety, warnings, truncated }`; a block is
one page: `{ type: 'paragraph', text, page }`.

Rules (the same as for word-processor files): a password-protected file is refused (`ENCRYPTED`); scripts are refused
(`MACROS`) unless `macros: 'ignore'`, and are never run; links are never followed (`externalLinks: 'refuse'` refuses a file
that has any); attached files are listed (`embedded: 'refuse'` refuses them); at most 1000 pages and 2 000 000 characters
(`limits: { maxPages, maxChars }`). Warnings: `HIDDEN_TEXT` (text that paints nothing, such as the recognised-text layer of a
scan), `NO_TEXT_LAYER` (a scan: no text recognition is done here), `TRUNCATED`.

Not verified against a real PDF yet: the tests use a stand-in for unpdf. Run them against the real library before relying on it.
