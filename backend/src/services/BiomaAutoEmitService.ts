/**
 * Cola serial de emisión DTE (webhook auto-emit + lote manual desde la UI).
 * Una factura/boleta a la vez para no bloquear el scraper MiPyme/e-Boleta.
 */
import { BiomaEmitService } from './BiomaEmitService';
import { BiomaFacturacionService } from './BiomaFacturacionService';
import { SiiFacturacionService } from './SiiFacturacionService';
import { EBoletaService } from './EBoletaService';
import { EBoletaSessionService } from './EBoletaSessionService';
import { boletaViaEBoleta } from '../utils/biomaOrderAttrs';

type AutoEmitKind = 'factura' | 'boleta';

interface QueueJob {
  orderId: string;
  kind: AutoEmitKind;
  /** Sesión MiPyme/e-Boleta del usuario (lote manual). */
  sessionId?: string;
  source: 'auto' | 'manual';
}

export interface EmitQueueResult {
  orderId: string;
  kind: AutoEmitKind;
  success: boolean;
  folio: number | null;
  error: string | null;
  finishedAt: string;
}

export interface EmitQueueStatus {
  processing: boolean;
  queueLength: number;
  pendingOrderIds: string[];
  current: { orderId: string; kind: AutoEmitKind; source: 'auto' | 'manual' } | null;
  recentResults: EmitQueueResult[];
}

export class BiomaAutoEmitService {
  private static queue: QueueJob[] = [];
  private static processing = false;
  private static currentJob: QueueJob | null = null;
  private static recentResults: EmitQueueResult[] = [];
  private static readonly maxRecentResults = 40;
  private static mipymeSessionId: string | null = null;
  private static eboletaSessionId: string | null = null;

  static isAutoEmitFacturaEnabled(): boolean {
    return /^(1|true|yes)$/i.test(String(process.env.BIOMA_AUTO_EMIT || '').trim());
  }

  static isAutoEmitBoletaEnabled(): boolean {
    return /^(1|true|yes)$/i.test(String(process.env.BIOMA_AUTO_EMIT_BOLETA || '').trim());
  }

  static enqueue(orderId: string, kind: AutoEmitKind): void {
    if (this.isQueued(orderId)) return;
    this.queue.push({ orderId, kind, source: 'auto' });
    console.log(`[bioma emit-queue] encolado auto ${kind} ${orderId} (pendientes=${this.queue.length})`);
    void this.processQueue();
  }

  static enqueueManual(
    orderIds: string[],
    sessionId: string,
    kind: AutoEmitKind,
  ): { enqueued: number; skipped: number; queueLength: number } {
    const sid = String(sessionId || '').trim();
    if (!sid) throw new Error('sessionId requerido');
    this.assertSessionForKind(sid, kind);

    let enqueued = 0;
    let skipped = 0;
    for (const raw of orderIds) {
      const orderId = String(raw || '').trim();
      if (!orderId) {
        skipped++;
        continue;
      }
      if (this.isQueued(orderId)) {
        skipped++;
        continue;
      }
      this.queue.push({ orderId, kind, sessionId: sid, source: 'manual' });
      enqueued++;
    }

    if (enqueued > 0) {
      console.log(
        `[bioma emit-queue] lote manual ${kind}: +${enqueued} (omitidas=${skipped}, pendientes=${this.queue.length})`,
      );
      void this.processQueue();
    }

    return { enqueued, skipped, queueLength: this.queue.length };
  }

  static getStatus(): EmitQueueStatus {
    const pendingOrderIds = [
      ...(this.currentJob ? [this.currentJob.orderId] : []),
      ...this.queue.map((j) => j.orderId),
    ];
    return {
      processing: this.processing,
      queueLength: this.queue.length,
      pendingOrderIds,
      current: this.currentJob
        ? {
            orderId: this.currentJob.orderId,
            kind: this.currentJob.kind,
            source: this.currentJob.source,
          }
        : null,
      recentResults: [...this.recentResults],
    };
  }

  private static isQueued(orderId: string): boolean {
    if (this.currentJob?.orderId === orderId) return true;
    return this.queue.some((j) => j.orderId === orderId);
  }

  private static assertSessionForKind(sessionId: string, kind: AutoEmitKind): void {
    if (kind === 'boleta' && boletaViaEBoleta()) {
      if (!EBoletaSessionService.getSession(sessionId)) {
        throw new Error('Sesión e-Boleta no válida. Vuelve a abrir sesión.');
      }
      return;
    }
    if (!SiiFacturacionService.getSession(sessionId)) {
      throw new Error('Sesión MiPyme no válida. Vuelve a abrir sesión SII.');
    }
  }

  private static pushResult(result: EmitQueueResult): void {
    this.recentResults.push(result);
    if (this.recentResults.length > this.maxRecentResults) {
      this.recentResults.splice(0, this.recentResults.length - this.maxRecentResults);
    }
  }

  private static async getMipymeSessionId(): Promise<string> {
    if (this.mipymeSessionId) {
      const existing = SiiFacturacionService.getSession(this.mipymeSessionId);
      if (existing) return this.mipymeSessionId;
    }
    const empresaRut = BiomaFacturacionService.getEmpresaRutConfig();
    this.mipymeSessionId = await SiiFacturacionService.createSession(empresaRut);
    console.log(`[bioma emit-queue] sesión MiPyme auto: ${this.mipymeSessionId}`);
    return this.mipymeSessionId;
  }

  private static async getEboletaSessionId(): Promise<string> {
    if (this.eboletaSessionId && EBoletaSessionService.getSession(this.eboletaSessionId)) {
      return this.eboletaSessionId;
    }
    const empresaRut = BiomaFacturacionService.getEmpresaRutConfig();
    this.eboletaSessionId = await EBoletaService.createSession(empresaRut);
    console.log(`[bioma emit-queue] sesión e-Boleta auto: ${this.eboletaSessionId}`);
    return this.eboletaSessionId;
  }

  private static async resolveSessionId(job: QueueJob): Promise<string> {
    if (job.sessionId) {
      this.assertSessionForKind(job.sessionId, job.kind);
      return job.sessionId;
    }
    return job.kind === 'boleta' && boletaViaEBoleta()
      ? await this.getEboletaSessionId()
      : await this.getMipymeSessionId();
  }

  private static async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.currentJob = job;
      const finishedAt = new Date().toISOString();

      try {
        if (job.kind === 'factura') {
          SiiFacturacionService.assertSiiAvailable();
        }

        const sessionId = await this.resolveSessionId(job);
        console.log(`[bioma emit-queue] emitiendo ${job.source} ${job.kind} ${job.orderId}…`);

        const out = await BiomaEmitService.emitOrder(job.orderId, {
          sessionId,
          scraperStep: 'emitir',
        });

        if (out.success) {
          console.log(
            `[bioma emit-queue] OK ${job.orderId} folio=${out.row?.siiFolio ?? '—'} (${out.channel})`,
          );
          this.pushResult({
            orderId: job.orderId,
            kind: job.kind,
            success: true,
            folio: out.row?.siiFolio ?? out.result?.folio ?? null,
            error: null,
            finishedAt,
          });
        } else {
          console.warn(`[bioma emit-queue] falló ${job.orderId}: ${out.error}`);
          this.pushResult({
            orderId: job.orderId,
            kind: job.kind,
            success: false,
            folio: null,
            error: out.error || 'Emisión fallida',
            finishedAt,
          });
        }
      } catch (err: any) {
        const msg = err?.message || String(err);
        console.error(`[bioma emit-queue] error ${job.orderId}:`, msg);
        this.pushResult({
          orderId: job.orderId,
          kind: job.kind,
          success: false,
          folio: null,
          error: msg,
          finishedAt,
        });
      } finally {
        this.currentJob = null;
      }

      if (this.queue.length > 0) {
        await new Promise((r) => setTimeout(r, 5000));
      }
    }

    this.processing = false;
  }
}
