/**
 * Cola de emisión automática tras webhook orders/paid.
 * Facturas → sesión MiPyme; boletas → sesión e-Boleta.
 */
import { BiomaEmitService } from './BiomaEmitService';
import { BiomaFacturacionService } from './BiomaFacturacionService';
import { SiiFacturacionService } from './SiiFacturacionService';
import { EBoletaService } from './EBoletaService';
import { boletaViaEBoleta } from '../utils/biomaOrderAttrs';

type AutoEmitKind = 'factura' | 'boleta';

interface QueueJob {
  orderId: string;
  kind: AutoEmitKind;
}

export class BiomaAutoEmitService {
  private static queue: QueueJob[] = [];
  private static processing = false;
  private static mipymeSessionId: string | null = null;
  private static eboletaSessionId: string | null = null;

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

  private static async getMipymeSessionId(): Promise<string> {
    if (this.mipymeSessionId) {
      const existing = SiiFacturacionService.getSession(this.mipymeSessionId);
      if (existing) return this.mipymeSessionId;
    }
    const empresaRut = BiomaFacturacionService.getEmpresaRutConfig();
    this.mipymeSessionId = await SiiFacturacionService.createSession(empresaRut);
    console.log(`[bioma auto-emit] sesión MiPyme: ${this.mipymeSessionId}`);
    return this.mipymeSessionId;
  }

  private static async getEboletaSessionId(): Promise<string> {
    if (this.eboletaSessionId) return this.eboletaSessionId;
    const empresaRut = BiomaFacturacionService.getEmpresaRutConfig();
    this.eboletaSessionId = await EBoletaService.createSession(empresaRut);
    console.log(`[bioma auto-emit] sesión e-Boleta: ${this.eboletaSessionId}`);
    return this.eboletaSessionId;
  }

  private static async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const job = this.queue.shift()!;
      try {
        const sessionId =
          job.kind === 'boleta' && boletaViaEBoleta()
            ? await this.getEboletaSessionId()
            : await this.getMipymeSessionId();

        if (job.kind === 'factura') {
          SiiFacturacionService.assertSiiAvailable();
        }

        console.log(`[bioma auto-emit] emitiendo ${job.kind} ${job.orderId}…`);
        const out = await BiomaEmitService.emitOrder(job.orderId, {
          sessionId,
          scraperStep: 'emitir',
        });
        if (out.success) {
          console.log(
            `[bioma auto-emit] OK ${job.orderId} folio=${out.row?.siiFolio ?? '—'} (${out.channel})`,
          );
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
