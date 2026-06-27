/**
 * Mutex global para operaciones SII — compartido entre Clientes (MiPyme) y Proveedores (RCV).
 * El SII suele rechazar o invalidar sesiones concurrentes del mismo RUT.
 */
export class SiiGlobalMutex {
  private static depth = 0;
  private static currentLabel: string | null = null;

  static beginOp(label: string): void {
    this.depth++;
    this.currentLabel = label;
    console.log(`[SII mutex] +1 (${label}) depth=${this.depth}`);
  }

  static endOp(label: string): void {
    this.depth = Math.max(0, this.depth - 1);
    if (this.depth === 0) this.currentLabel = null;
    console.log(`[SII mutex] -1 (${label}) depth=${this.depth}`);
  }

  static isBusy(): boolean {
    return this.depth > 0;
  }

  static getBusyLabel(): string | null {
    return this.currentLabel;
  }

  static forceReset(): void {
    this.depth = 0;
    this.currentLabel = null;
    console.log('[SII mutex] force reset');
  }

  static async waitForSlot(pollMs = 1500, maxWaitMs = 120000): Promise<boolean> {
    const t0 = Date.now();
    while (this.isBusy()) {
      if (Date.now() - t0 > maxWaitMs) return false;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return true;
  }

  static async runExclusive<T>(
    label: string,
    fn: () => Promise<T>,
    maxWaitMs = 120000,
  ): Promise<T> {
    const ok = await this.waitForSlot(1500, maxWaitMs);
    if (!ok) {
      throw new Error('Ya hay una operación SII en curso, intenta en unos minutos');
    }
    this.beginOp(label);
    try {
      return await fn();
    } finally {
      this.endOp(label);
    }
  }
}
