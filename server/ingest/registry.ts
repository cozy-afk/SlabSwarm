// Adapter registry. Adapters are stateless fetchers; the runner owns all
// ledger writes. Unknown and duplicate ids fail loudly.

import type { IngestAdapter } from './types.ts';

export class AdapterRegistry {
  private readonly adapters = new Map<string, IngestAdapter>();

  constructor(adapters: IngestAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: IngestAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`duplicate adapter id: ${adapter.id}`);
    }
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): IngestAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`unknown adapter: ${id}`);
    return adapter;
  }

  list(): IngestAdapter[] {
    return [...this.adapters.values()];
  }
}
