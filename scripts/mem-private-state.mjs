/**
 * In-memory private-state provider — Vision 2026-11-01. Same shape as @odatano/contract-kit's InMemoryPrivateStateProvider,
 * which nightgate-tx (escrow-ng) uses. Nothing is written to disk, so there is no password.
 * sworn-escrow keeps no private state between calls: every call gets its sk from .judge-key or the ticket file.
 */
export class InMemoryPrivateStateProvider {
  states = new Map();
  signingKeys = new Map();
  contractAddress = undefined;
  setContractAddress(address) { this.contractAddress = address; }
  async set(id, state) { this.states.set(id, state); }
  async get(id) { return this.states.has(id) ? this.states.get(id) : null; }
  async remove(id) { this.states.delete(id); }
  async clear() { this.states.clear(); }
  async setSigningKey(address, key) { this.signingKeys.set(address, key); }
  async getSigningKey(address) { return this.signingKeys.has(address) ? this.signingKeys.get(address) : null; }
  async removeSigningKey(address) { this.signingKeys.delete(address); }
  async clearSigningKeys() { this.signingKeys.clear(); }
  async exportPrivateStates() { return { privateStates: {}, contractStates: {} }; }
  async importPrivateStates() { return { imported: [], skipped: [], errors: [] }; }
  async exportSigningKeys() { return { signingKeys: {} }; }
  async importSigningKeys() { return { imported: [], skipped: [], errors: [] }; }
}
