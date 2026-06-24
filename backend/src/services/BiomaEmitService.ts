/**
 * Emisión DTE (factura/boleta) reutilizable desde API, auto-emit y cola webhook.
 */
import { BiomaFacturacionService } from './BiomaFacturacionService';
import { BiomaShopifyService } from './BiomaShopifyService';
import { SiiFacturacionService } from './SiiFacturacionService';
import { SiiCredentialsService } from './SiiCredentialsService';
import { EBoletaService } from './EBoletaService';
import { EBoletaSessionService } from './EBoletaSessionService';
import { boletaReceptorForSii, boletaViaEBoleta } from '../utils/biomaOrderAttrs';

export type BiomaEmitStep = 'abrir' | 'rellenar' | 'emitir';

export interface BiomaEmitResult {
  success: boolean;
  step: BiomaEmitStep;
  error?: string;
  result?: Awaited<ReturnType<typeof SiiFacturacionService.emitirFactura>>;
  row?: Awaited<ReturnType<typeof BiomaFacturacionService.findEmision>>;
  pdfUrl?: string | null;
  channel?: 'mipyme' | 'eboleta';
}

export class BiomaEmitService {
  static async emitOrder(
    orderId: string,
    opts: {
      sessionId: string;
      scraperStep?: BiomaEmitStep;
      codigoOriginal?: string | null;
      tipoCodigo?: number;
      fechaEmision?: string;
      esperarMsEnPreview?: number;
    },
  ): Promise<BiomaEmitResult> {
    const scraperStep = opts.scraperStep ?? 'emitir';
    const isEmit = scraperStep === 'emitir';

    const order = await BiomaShopifyService.getOrder(orderId);
    if (!order) {
      return { success: false, step: scraperStep, error: 'Pedido no encontrado en Shopify' };
    }

    const row = await BiomaFacturacionService.upsertFromShopify(order);
    const tipoCodigo = opts.tipoCodigo || row.tipoCodigo || 33;
    const isBoleta = tipoCodigo === 39 || tipoCodigo === 41;

    if (isBoleta && boletaViaEBoleta()) {
      return this.emitBoletaEBoleta(orderId, order, row, opts.sessionId, scraperStep, tipoCodigo);
    }

    SiiFacturacionService.assertSiiAvailable();

    const session = SiiFacturacionService.getSession(opts.sessionId);
    if (!session) {
      return { success: false, step: scraperStep, error: 'Sesión SII no encontrada o expirada' };
    }

    const templateInfo = await BiomaFacturacionService.resolveTemplateInfo({
      rutReceptor: isBoleta ? null : row.rutReceptor,
      tipoCodigo,
    });
    const codigoTemplate = isBoleta
      ? null
      : (opts.codigoOriginal && String(opts.codigoOriginal).trim()) ||
        templateInfo.codigo ||
        null;

    if (scraperStep === 'rellenar') {
      await BiomaFacturacionService.setStatus(orderId, 'drafting');
    } else if (isEmit) {
      await BiomaFacturacionService.setStatus(orderId, 'emitting');
    }

    const items = BiomaFacturacionService.buildItemsFromOrder(order, tipoCodigo).map((it, i) => ({
      numero: i + 1,
      descripcion: it.descripcion,
      cantidad: it.cantidad,
      precioUnitario: it.precioUnitario,
    }));

    await SiiFacturacionService.ensureBrowserForSession(session);
    const { page: emitPage, reused } = await SiiFacturacionService.acquireScraperPage(session);
    const reusedPtrTkn =
      reused &&
      !!session.playwrightReady &&
      /listadoEmitidos|mipeAdminDocsEmi/i.test(emitPage.url());

    const cf = boletaReceptorForSii();

    let result: Awaited<ReturnType<typeof SiiFacturacionService.emitirFactura>> | undefined;
    try {
      const creds = SiiCredentialsService.getInstance().getCredentials();
      result = await SiiFacturacionService.emitirFactura(
        emitPage,
        {
          codigoOriginal: codigoTemplate,
          empresaRut: session.empresaRut,
          tipoCodigo,
          fechaEmision: opts.fechaEmision || new Date().toISOString().split('T')[0],
          items,
          rutReceptor: isBoleta ? cf.rut : (row.rutReceptor || ''),
          razonSocial: isBoleta ? cf.razonSocial : (row.razonSocial || ''),
          giroReceptor: isBoleta ? '' : (row.giroReceptor || ''),
          comunaReceptor: isBoleta ? '' : (row.comunaReceptor || ''),
          ciudadReceptor: isBoleta ? '' : (row.ciudadReceptor || ''),
          dirReceptor: isBoleta ? '' : (row.dirReceptor || ''),
        },
        {
          detenerEnPreview: !isEmit,
          previewSoloFormulario: scraperStep === 'rellenar',
          scraperStep,
          skipEmpresaSelect: !!session.playwrightReady,
          skipPtrTkn: reusedPtrTkn,
          esperarMsEnPreview: Number.isFinite(opts.esperarMsEnPreview)
            ? opts.esperarMsEnPreview
            : undefined,
          firmaClave: creds?.firmaClave,
        },
      );
    } finally {
      if (!result?.success && !result?.detenidoEnPreview) {
        await emitPage.close().catch(() => {});
        if (session.scraperPage === emitPage) session.scraperPage = undefined;
      }
    }

    if (!result?.success) {
      await BiomaFacturacionService.setStatus(orderId, 'error', {
        lastError: result?.error || 'Scraper falló sin mensaje',
      });
      return {
        success: false,
        step: scraperStep,
        error: result?.error || 'Scraper falló sin mensaje',
        result,
        channel: 'mipyme',
      };
    }

    if (!isEmit) {
      if (scraperStep === 'rellenar') {
        await BiomaFacturacionService.setStatus(orderId, 'drafting', { lastError: null });
      }
      return {
        success: true,
        step: scraperStep,
        result,
        row: await BiomaFacturacionService.findEmision(orderId),
        channel: 'mipyme',
      };
    }

    if (!result?.folio && result?.detenidoEnPreview) {
      await BiomaFacturacionService.setStatus(orderId, 'drafting', {
        lastError: result.error || 'Firma manual pendiente',
      });
      return {
        success: false,
        step: scraperStep,
        error: result.error,
        result,
        channel: 'mipyme',
      };
    }

    const siiCodigo = result.siiCodigo || codigoTemplate;
    let siiFolio = result.folio ?? null;

    if (siiCodigo && session.axiosClient) {
      const resolved = await SiiFacturacionService.resolveFolioForCodigo(
        session.axiosClient,
        String(siiCodigo),
        tipoCodigo,
      );
      if (resolved && resolved > 0 && resolved !== siiFolio) {
        console.log(
          `[bioma emit] folio corregido ${siiFolio ?? '—'} → ${resolved} (CODIGO ${siiCodigo})`,
        );
        siiFolio = resolved;
      }
      await SiiFacturacionService.ensureFacturaRowStub(session.empresaRut, String(siiCodigo), {
        tipoCodigo,
        folio: siiFolio ?? undefined,
      });
      SiiFacturacionService.refreshDetalleEnDb(
        session.empresaRut,
        String(siiCodigo),
        session.axiosClient,
        tipoCodigo,
      ).catch((e) => console.warn('[bioma emit] refreshDetalle:', e?.message || e));
      if (session.context) {
        SiiFacturacionService.downloadPdf(session.context, String(siiCodigo), session.empresaRut)
          .catch((e) => console.warn('[bioma emit] PDF post-emit:', e?.message || e));
      }
    }

    const updated = await BiomaFacturacionService.setStatus(orderId, 'emitted', {
      siiFolio,
      siiCodigo,
      emittedAt: new Date(),
      lastError: null,
    });

    try {
      if (siiFolio && siiFolio > 0) {
        await BiomaShopifyService.markDteEmitted(orderId, tipoCodigo, siiFolio);
      }
    } catch (tagErr: any) {
      console.error('[bioma emit] tag swap failed:', tagErr?.message || tagErr);
    }

    if (siiCodigo && session?.context) {
      SiiFacturacionService.downloadPdf(session.context, siiCodigo).catch((e: any) =>
        console.warn('[bioma emit] PDF download after emit failed (will retry in background):', e?.message),
      );
    }

    return {
      success: true,
      step: 'emitir',
      result,
      row: updated ?? undefined,
      pdfUrl: siiCodigo ? `/api/bioma/pdf/${encodeURIComponent(orderId)}` : null,
      channel: 'mipyme',
    };
  }

  private static async emitBoletaEBoleta(
    orderId: string,
    order: Awaited<ReturnType<typeof BiomaShopifyService.getOrder>>,
    row: Awaited<ReturnType<typeof BiomaFacturacionService.upsertFromShopify>>,
    sessionId: string,
    scraperStep: BiomaEmitStep,
    tipoCodigo: number,
  ): Promise<BiomaEmitResult> {
    if (scraperStep !== 'emitir') {
      return {
        success: false,
        step: scraperStep,
        error: 'e-Boleta solo soporta emisión directa (no preview/rellenar por scraper MiPyme)',
        channel: 'eboleta',
      };
    }

    if (!EBoletaSessionService.getSession(sessionId)) {
      return {
        success: false,
        step: scraperStep,
        error:
          'Sesión e-Boleta no encontrada. En la pestaña Boletas, crea sesión e-Boleta (no MiPyme).',
        channel: 'eboleta',
      };
    }

    await BiomaFacturacionService.setStatus(orderId, 'emitting');

    const builtItems = BiomaFacturacionService.buildItemsFromOrder(order!, tipoCodigo);
    const montoTotal = Math.round(order!.total || builtItems.reduce((s, it) => s + it.subtotal, 0));

    const out = await EBoletaService.emitBoleta(sessionId, {
      tipoCodigo,
      items: builtItems.map((it) => ({
        descripcion: it.descripcion,
        cantidad: it.cantidad,
        precioUnitario: it.precioUnitario,
      })),
      montoTotal,
      detalleLabel: `${row.shopifyOrderName} — ${builtItems[0]?.descripcion || 'Venta'}`,
      customerEmail: row.customerEmail,
      customerPhone: row.customerPhone,
    });

    if (!out.success || !out.folio) {
      await BiomaFacturacionService.setStatus(orderId, 'error', {
        lastError: out.error || 'Emisión e-Boleta falló',
      });
      return {
        success: false,
        step: 'emitir',
        error: out.error || 'Emisión e-Boleta falló',
        channel: 'eboleta',
      };
    }

    const updated = await BiomaFacturacionService.setStatus(orderId, 'emitted', {
      siiFolio: out.folio,
      siiCodigo: out.dte ? String(out.dte).slice(0, 255) : null,
      pdfPublicUrl: out.pdfPublicUrl ?? null,
      emittedAt: new Date(),
      lastError: null,
    });

    try {
      await BiomaShopifyService.markDteEmitted(orderId, tipoCodigo, out.folio);
    } catch (tagErr: any) {
      console.error('[bioma emit] tag swap failed:', tagErr?.message || tagErr);
    }

    const pdfUrl = out.pdfPublicUrl
      ? `/api/bioma/pdf/${encodeURIComponent(orderId)}`
      : null;

    return {
      success: true,
      step: 'emitir',
      row: updated ?? undefined,
      pdfUrl,
      channel: 'eboleta',
    };
  }
}
