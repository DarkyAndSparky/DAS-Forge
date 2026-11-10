// A "file" that makes the reader spin forever: for the worker-thread tests.
export const zip = { async read() { for (;;) { /* never returns */ } } };
