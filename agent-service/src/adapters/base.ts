export type { AgentAdapter, SessionContext } from "../types.js";

import type { AgentAdapter } from "../types.js";

/**
 * A simple registry that maps adapter names to adapter instances.
 * Allows the main server to look up the correct backend by name.
 */
export class AdapterRegistry {
  private adapters = new Map<string, AgentAdapter>();

  register(adapter: AgentAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  get(name: string): AgentAdapter | undefined {
    return this.adapters.get(name);
  }

  list(): string[] {
    return [...this.adapters.keys()];
  }
}
