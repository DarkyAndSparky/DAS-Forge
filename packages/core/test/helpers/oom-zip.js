// A "file" that eats memory until the worker's ceiling stops it: for the worker-thread tests.
export const zip = { async read() { const keep = []; for (;;) keep.push(new Array(1_000_000).fill(1)); } };
