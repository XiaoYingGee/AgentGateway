export type { IMAdapter } from "../../core/types.js";

/** P5: health check mixin for IM adapters */
export abstract class BaseIMAdapter {
  protected healthy = true;

  isHealthy(): boolean {
    return this.healthy;
  }
}
