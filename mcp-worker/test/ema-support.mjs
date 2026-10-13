import { vi } from 'vitest';

export function memoryKv() {
  const map = new Map();
  return {
    map,
    async put(key, value, options = {}) { map.set(key, { value, metadata: options.metadata }); },
    async get(key) {
      const entry = map.get(key);
      if (!entry) return null;
      return typeof entry.value === 'string' ? entry.value : entry.value;
    },
    async getWithMetadata(key) {
      const entry = map.get(key);
      return entry ? { value: entry.value instanceof Uint8Array ? entry.value.buffer.slice(entry.value.byteOffset, entry.value.byteOffset + entry.value.byteLength) : entry.value, metadata: entry.metadata } : { value: null, metadata: null };
    },
    async delete(key) { map.delete(key); },
  };
}

export function fakeEma(handlers = {}) {
  return { call: vi.fn(async (name, data) => {
    if (!handlers[name]) throw new Error(`unexpected EMA call ${name}`);
    return handlers[name](data);
  }) };
}
