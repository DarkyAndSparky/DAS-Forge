// A reader for the isolated-thread test: no PDF library, it just proves the module is loaded in the worker and called.
export default async function stub(buffer, opts) {
  return { format: 'pdf', text: `stub:${buffer.length}:${opts.macros}`, blocks: [], metadata: {}, safety: {}, warnings: [], truncated: false };
}
