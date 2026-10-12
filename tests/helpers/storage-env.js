// Almacenamiento del navegador para las pruebas sin navegador: IndexedDB simulado
// (fake-indexeddb) y un Web Storage en memoria. Así los módulos usan las mismas APIs que en la
// aplicación y no necesitan respaldos. scripts/test-runner.mjs lo carga con --require.
require('fake-indexeddb/auto');

class MemoryStorage {
  #items = new Map();
  get length() { return this.#items.size; }
  key(index) { return [...this.#items.keys()][index] ?? null; }
  getItem(key) { return this.#items.has(String(key)) ? this.#items.get(String(key)) : null; }
  setItem(key, value) { this.#items.set(String(key), String(value)); }
  removeItem(key) { this.#items.delete(String(key)); }
  clear() { this.#items.clear(); }
}

for (const name of ['localStorage', 'sessionStorage']) {
  if (!(name in globalThis)) Object.defineProperty(globalThis, name, { value: new MemoryStorage(), configurable: true, writable: true });
}
