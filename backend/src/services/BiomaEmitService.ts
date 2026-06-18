/**
 * Emisión DTE (factura/boleta) reutilizable desde API, auto-emit y cola webhook.
 */
import { BiomaFacturacionService } from './BiomaFacturacionService';
import { BiomaShopifyService } from './BiomaShopifyService';
import { SiiFacturacionService } from './SiiFacturacionService';
import { SiiCredentialsService } from './SiiCredentialsService';
import { SII_RUT_CONSUMIDOR_FINAL } from '../utils/biomaOrderAttrs';

export type BiomaEmitStep = 'abrir' | 'rellenar' | 'emitir';

export interface BiomaEmitResult {
  success: boolean;
  step: BiomaEmitStep;
  error?: string;
  result?: Awaited<ReturnType<typeof SiiFacturacionService.emitirFactura>>;
  row?: Awaited<ReturnType<typeof BiomaFacturacionService.findEmision>>;
  pdfUrl?: string | null;
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
    SiiFacturacionService.assertSiiAvailable();

    const scraperStep = opts.scraperStep ?? 'emitir';
    const isEmit = scraperStep === 'emitir';
    const session = SiiFacturacionService.getSession(opts.sessionId);
    if (!session) {
      return { success: false, step: scraperStep, error: 'Sesión SII no encontrada o expirada' };
    }

    const order = await BiomaShopifyService.getOrder(orderId);
    if (!order) {
      return { success: false, step: scraperStep, error: 'Pedido no encontrado en Shopify' };
    }

    const row = await BiomaFacturacionService.upsertFromShopify(order);
    const tipoCodigo = opts.tipoCodigo || row.tipoCodigo || 33;
    const isBoleta = tipoCodigo === 39 || tipoCodigo === 41;

    const templateInfo = await BiomaFacturacionService.resolveTemplateInfo({
      rutReceptor: isBoleta ? null : row.rutReceptor,
      tipoCodigo,
    });
    // Boletas: formulario nuevo tipo 39 (no copiar factura 33 como plantilla).
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
          rutReceptor: row.rutReceptor || (isBoleta ? SII_RUT_CONSUMIDOR_FINAL : ''),
          razonSocial: row.razonSocial || (isBoleta ? row.customerName || 'Consumidor Final' : ''),
          giroReceptor: row.giroReceptor || (isBoleta ? 'Particular' : ''),
          comunaReceptor: row.comunaReceptor || '',
          ciudadReceptor: row.ciudadReceptor || '',
          dirReceptor: row.dirReceptor || '',
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
      };
    }

    const siiCodigo = result.siiCodigo || codigoTemplate;
    const siiFolio = result.folio ?? null;

    const updated = await BiomaFacturacionService.setStatus(orderId, 'emitted', {
      siiFolio,
      siiCodigo,
      emittedAt: new Date(),
      lastError: null,
    });

    try {
      await BiomaShopifyService.markDteEmitted(orderId, tipoCodigo);
    } catch (tagErr: any) {
      console.error('[bioma emit] tag swap failed:', tagErr?.message || tagErr);
    }

    return {
      success: true,
      step: 'emitir',
      result,
      row: updated ?? undefined,
      pdfUrl: siiCodigo ? `/api/bioma/pdf/${encodeURIComponent(orderId)}` : null,
    };
  }
}
