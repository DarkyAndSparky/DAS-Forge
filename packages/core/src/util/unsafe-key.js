/** Names that must never be used as a key when copying outside data into a plain object (they reach the object's prototype). */
export const isUnsafeKey = (key) => key === '__proto__' || key === 'constructor' || key === 'prototype';
