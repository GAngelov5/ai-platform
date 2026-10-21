import type { Connector } from "./types.js";

/** Server-side registry; the model can only reach connectors through capabilities bound here. */
export class ConnectorRegistry {
  private readonly byId = new Map<string, Connector>();

  constructor(connectors: readonly Connector[] = []) {
    for (const c of connectors) this.register(c);
  }

  register(c: Connector): void {
    if (this.byId.has(c.id)) throw new Error(`connector ${c.id} already registered`);
    this.byId.set(c.id, c);
  }

  get(id: string): Connector | undefined {
    return this.byId.get(id);
  }

  list(): Connector[] {
    return [...this.byId.values()];
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled(this.list().map((c) => c.close()));
  }
}
