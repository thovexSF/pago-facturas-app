/**
 * Cola de emisión automática tras webhook orders/paid.
 * Una emisión a la vez; reutiliza sesión SII del servidor.
 */
import { BiomaEmitService } from './BiomaEmitService';
import { BiomaFacturacionService } from './BiomaFacturacionService';
import { SiiFacturacionService } from './SiiFacturacionService';

type AutoEmitKind = 'factura' | 'boleta';

interface QueueJob {
  orderId: string;
  kind: AutoEmitKind;
}

export class BiomaAutoEmitService {
  private static queue: QueueJob[] = [];
  private static processing = false;
  private static serverSessionId: string | null = null;

  static isAutoEmitFacturaEnabled(): boolean {
    return /^(1|true|yes)$/i.test(String(process.env.BIOMA_AUTO_EMIT || '').trim());
  }

  static isAutoEmitBoletaEnabled(): boolean {
    return /^(1|true|yes)$/i.test(String(process.env.BIOMA_AUTO_EMIT_BOLETA || '').trim());
  }

  static enqueue(orderId: string, kind: AutoEmitKind): void {
    if (this.queue.some((j) => j.orderId === orderId)) return;
    this.queue.push({ orderId, kind });
    console.log(`[bioma auto-emit] encolado ${kind} ${orderId} (cola=${this.queue.length})`);
    void this.processQueue();
  }

  private static async getServerSessionId(): Promise<string> {
    if (this.serverSessionId) {
      const existing = SiiFacturacionService.getSession(this.serverSessionId);
      if (existing) return this.serverSessionId;
    }
    const empresaRut = BiomaFacturacionService.getEmpresaRutConfig();
    this.serverSessionId = await SiiFacturacionService.createSession(empresaRut);
    console.log(`[bioma auto-emit] sesión SII servidor: ${this.serverSessionId}`);
    return this.serverSessionId;
  }

  private static async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const job = this.queue.shift()!;
      try {
        SiiFacturacionService.assertSiiAvailable();
        const sessionId = await this.getServerSessionId();
        console.log(`[bioma auto-emit] emitiendo ${job.kind} ${job.orderId}…`);
        const out = await BiomaEmitService.emitOrder(job.orderId, {
          sessionId,
          scraperStep: 'emitir',
        });
        if (out.success) {
          console.log(`[bioma auto-emit] OK ${job.orderId} folio=${out.row?.siiFolio ?? '—'}`);
        } else {
          console.warn(`[bioma auto-emit] falló ${job.orderId}: ${out.error}`);
        }
      } catch (err: any) {
        console.error(`[bioma auto-emit] error ${job.orderId}:`, err?.message || err);
      }
      await new Promise((r) => setTimeout(r, 8000));
    }

    this.processing = false;
  }
}
