import { Request, Response } from 'express';
import { BiomaFacturacionService } from '../services/BiomaFacturacionService';
import { BiomaShopifyService } from '../services/BiomaShopifyService';
import { SiiFacturacionService } from '../services/SiiFacturacionService';
import { SiiCredentialsService } from '../services/SiiCredentialsService';

/**
 * Endpoints under /api/bioma/* that bridge Shopify orders with the existing
 * SII scraper service.
 */
export class BiomaFacturacionController {
  // GET /api/bioma/template-codigo
  // Returns the SII código that will be auto-used as template for the next emit.
  static async templateCodigo(req: Request, res: Response) {
    try {
      const rutReceptor = req.query.rutReceptor ? String(req.query.rutReceptor) : null;
      const tipoCodigo = req.query.tipoCodigo ? parseInt(String(req.query.tipoCodigo), 10) : 33;
      const info = await BiomaFacturacionService.resolveTemplateInfo({
        rutReceptor,
        tipoCodigo: Number.isFinite(tipoCodigo) ? tipoCodigo : 33,
      });
      return res.json({
        success: true,
        empresaRut: BiomaFacturacionService.getEmpresaRutConfig(),
        ...info,
      });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err?.message || String(err) });
    }
  }

  // GET /api/bioma/pedidos-pendientes?pageSize=50&after=<cursor>
  static async pedidosPendientes(req: Request, res: Response) {
    try {
      const pageSize = req.query.pageSize ? parseInt(String(req.query.pageSize), 10) : 50;
      const after = req.query.after ? String(req.query.after) : null;
      const { rows, pageInfo } = await BiomaFacturacionService.listPending({
        pageSize: Number.isFinite(pageSize) ? pageSize : 50,
        after,
      });
      return res.json({ success: true, rows, pageInfo });
    } catch (err: any) {
      console.error('[bioma] pedidosPendientes error:', err?.message || err);
      return res.status(500).json({ success: false, error: err?.message || String(err) });
    }
  }

  // POST /api/bioma/sync/:orderId
  // Refresh the DB row for a single Shopify order from current Shopify state.
  static async sync(req: Request, res: Response) {
    const orderId = req.params.orderId;
    if (!orderId) return res.status(400).json({ error: 'orderId requerido' });
    try {
      const order = await BiomaShopifyService.getOrder(orderId);
      if (!order) return res.status(404).json({ error: 'Pedido no encontrado en Shopify' });
      const row = await BiomaFacturacionService.upsertFromShopify(order);
      return res.json({ success: true, row, order });
    } catch (err: any) {
      console.error('[bioma] sync error:', err?.message || err);
      return res.status(500).json({ success: false, error: err?.message || String(err) });
    }
  }

  // GET /api/bioma/emision/:orderId
  static async getEmision(req: Request, res: Response) {
    try {
      const row = await BiomaFacturacionService.findEmision(req.params.orderId);
      if (!row) return res.status(404).json({ error: 'Sin registro de emisión' });
      return res.json({ success: true, row });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err?.message || String(err) });
    }
  }

  // GET /api/bioma/payload/:orderId — qué enviaríamos al SII (sin abrir browser)
  static async payload(req: Request, res: Response) {
    const orderId = req.params.orderId;
    if (!orderId) return res.status(400).json({ error: 'orderId requerido' });
    try {
      const order = await BiomaShopifyService.getOrder(orderId);
      if (!order) return res.status(404).json({ error: 'Pedido no encontrado en Shopify' });
      const row = await BiomaFacturacionService.upsertFromShopify(order);
      const items = BiomaFacturacionService.buildItemsFromOrder(
        order,
        row.tipoCodigo || 33,
      ).map((it, i) => ({
        numero: i + 1,
        descripcion: it.descripcion,
        cantidad: it.cantidad,
        precioUnitario: it.precioUnitario,
        subtotal: it.subtotal,
      }));
      const template = await BiomaFacturacionService.resolveTemplateInfo({
        rutReceptor: row.rutReceptor,
        tipoCodigo: row.tipoCodigo || 33,
      });
      return res.json({
        success: true,
        payload: {
          rutReceptor: row.rutReceptor,
          razonSocial: row.razonSocial,
          giroReceptor: row.giroReceptor,
          comunaReceptor: row.comunaReceptor,
          ciudadReceptor: row.ciudadReceptor,
          dirReceptor: row.dirReceptor,
          tipoCodigo: row.tipoCodigo || 33,
          fechaEmision: new Date().toISOString().split('T')[0],
          items,
          template,
        },
        shopify: {
          id: order.id,
          name: order.name,
          total: order.total,
          tags: order.tags,
        },
        emision: row,
      });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err?.message || String(err) });
    }
  }

  // POST /api/bioma/scraper/:orderId  body: { sessionId, step: 'abrir'|'rellenar'|'emitir' }
  static async scraper(req: Request, res: Response) {
    const step = String(req.body?.step || 'abrir') as 'abrir' | 'rellenar' | 'emitir';
    if (!['abrir', 'rellenar', 'emitir'].includes(step)) {
      return res.status(400).json({ error: 'step debe ser abrir, rellenar o emitir' });
    }
    return BiomaFacturacionController.runEmitFlow(req, res, { scraperStep: step });
  }

  // POST /api/bioma/preview/:orderId — alias de scraper rellenar
  static async preview(req: Request, res: Response) {
    req.body = { ...req.body, step: 'rellenar' };
    return BiomaFacturacionController.scraper(req, res);
  }

  // POST /api/bioma/emitir/:orderId — alias de scraper emitir
  static async emitir(req: Request, res: Response) {
    req.body = { ...req.body, step: 'emitir' };
    return BiomaFacturacionController.scraper(req, res);
  }

  private static async runEmitFlow(
    req: Request,
    res: Response,
    flags: { scraperStep: 'abrir' | 'rellenar' | 'emitir' },
  ) {
    try {
      SiiFacturacionService.assertSiiAvailable();
    } catch (err: any) {
      return res.status(429).json({ success: false, error: err?.message || String(err) });
    }
    const orderId = req.params.orderId;
    const { sessionId, codigoOriginal, tipoCodigo, fechaEmision, esperarMsEnPreview } =
      req.body || {};
    if (!orderId) return res.status(400).json({ error: 'orderId requerido' });
    if (!sessionId) return res.status(400).json({ error: 'sessionId requerido (crea una sesión SII primero)' });

    const session = SiiFacturacionService.getSession(sessionId);
    if (!session) return res.status(401).json({ error: 'Sesión SII no encontrada o expirada' });

    const { scraperStep } = flags;
    const isEmit = scraperStep === 'emitir';

    try {
      const order = await BiomaShopifyService.getOrder(orderId);
      if (!order) return res.status(404).json({ error: 'Pedido no encontrado en Shopify' });
      const row = await BiomaFacturacionService.upsertFromShopify(order);

      const templateInfo = await BiomaFacturacionService.resolveTemplateInfo({
        rutReceptor: row.rutReceptor,
        tipoCodigo: tipoCodigo || row.tipoCodigo || 33,
      });
      const codigoTemplate =
        (codigoOriginal && String(codigoOriginal).trim()) ||
        templateInfo.codigo ||
        null;

      if (scraperStep === 'rellenar') {
        await BiomaFacturacionService.setStatus(orderId, 'drafting');
      } else if (isEmit) {
        await BiomaFacturacionService.setStatus(orderId, 'emitting');
      }

      const items = BiomaFacturacionService.buildItemsFromOrder(
        order,
        row.tipoCodigo || 33,
      ).map((it, i) => ({
        numero: i + 1,
        descripcion: it.descripcion,
        cantidad: it.cantidad,
        precioUnitario: it.precioUnitario,
      }));

      const context = await SiiFacturacionService.ensureBrowserForSession(session);
      const { page: emitPage, reused } = await SiiFacturacionService.acquireScraperPage(session);
      const reusedPtrTkn =
        reused &&
        !!session.playwrightReady &&
        /listadoEmitidos|mipeAdminDocsEmi/i.test(emitPage.url());
      let result;
      try {
        const creds = SiiCredentialsService.getInstance().getCredentials();
        result = await SiiFacturacionService.emitirFactura(
          emitPage,
          {
            codigoOriginal: codigoTemplate,
            empresaRut: session.empresaRut,
            tipoCodigo: tipoCodigo || row.tipoCodigo || 33,
            fechaEmision: fechaEmision || new Date().toISOString().split('T')[0],
            items,
            rutReceptor: row.rutReceptor || '',
            razonSocial: row.razonSocial || '',
            giroReceptor: row.giroReceptor || '',
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
            esperarMsEnPreview: Number.isFinite(parseInt(String(esperarMsEnPreview), 10))
              ? parseInt(String(esperarMsEnPreview), 10)
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
        return res.status(502).json({ success: false, error: result?.error, step: scraperStep, result });
      }

      if (!isEmit) {
        if (scraperStep === 'rellenar') {
          await BiomaFacturacionService.setStatus(orderId, 'drafting', { lastError: null });
        }
        return res.json({
          success: true,
          step: scraperStep,
          result,
          template: templateInfo,
          row: await BiomaFacturacionService.findEmision(orderId),
          message: result.aviso,
        });
      }

      if (!result?.folio && result?.detenidoEnPreview) {
        await BiomaFacturacionService.setStatus(orderId, 'drafting', {
          lastError: result.error || 'Firma manual pendiente en Chrome',
        });
        return res.json({
          success: false,
          step: scraperStep,
          result,
          error: result.error,
          message: result.error,
        });
      }

      // Real emit succeeded — persist folio/código y tag Shopify.
      const siiCodigo = result.siiCodigo || codigoTemplate;
      const siiFolio = result.folio ?? null;

      const updated = await BiomaFacturacionService.setStatus(orderId, 'emitted', {
        siiFolio,
        siiCodigo,
        emittedAt: new Date(),
        lastError: null,
      });

      try {
        await BiomaShopifyService.markEmitted(orderId);
      } catch (tagErr: any) {
        console.error('[bioma] tag swap failed (factura emitted but Shopify tag not updated):', tagErr?.message || tagErr);
      }

      return res.json({ success: true, step: 'emitir', result, row: updated, pdfUrl: siiCodigo ? `/api/bioma/pdf/${encodeURIComponent(orderId)}` : null });
    } catch (err: any) {
      console.error('[bioma] emit flow error:', err?.message || err);
      await BiomaFacturacionService.setStatus(orderId, 'error', {
        lastError: err?.message || String(err),
      }).catch(() => {});
      return res.status(500).json({ success: false, error: err?.message || String(err) });
    }
  }

  // POST /api/bioma/pdf/:orderId/fetch — busca PDF en SII y lo guarda
  static async fetchPdf(req: Request, res: Response) {
    const orderId = req.params.orderId;
    const { sessionId } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: 'sessionId requerido' });
    try {
      const row = await BiomaFacturacionService.findEmision(orderId);
      if (!row) return res.status(404).json({ error: 'Sin registro de emisión' });
      const session = SiiFacturacionService.getSession(sessionId);
      if (!session?.context) return res.status(401).json({ error: 'Sesión SII no válida' });

      let codigo = row.siiCodigo;
      if (!codigo && row.rutReceptor) {
        const ultima = await SiiFacturacionService.findUltimaFacturaParaReceptor(
          session.axiosClient,
          row.rutReceptor,
          row.tipoCodigo || 33,
        );
        if (ultima) {
          codigo = ultima.codigo;
          await BiomaFacturacionService.setStatus(orderId, row.status, {
            siiCodigo: ultima.codigo,
            siiFolio: ultima.folio,
          });
        }
      }
      if (!codigo) return res.status(404).json({ error: 'Sin código SII — emite primero o revisa en sii.cl' });

      await SiiFacturacionService.downloadPdf(session.context, codigo);
      return res.json({
        success: true,
        pdfUrl: `/api/bioma/pdf/${encodeURIComponent(orderId)}`,
        siiCodigo: codigo,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message || String(err) });
    }
  }

  // GET /api/bioma/pdf/:orderId
  // Resolves the SII código from our emisiones table, then streams the PDF
  // via the existing SiiFacturacionService PDF cache/fetch.
  static async pdf(req: Request, res: Response) {
    try {
      const row = await BiomaFacturacionService.findEmision(req.params.orderId);
      if (!row || !row.siiCodigo) {
        return res.status(404).json({ error: 'Factura aún no emitida o sin código SII' });
      }
      // Reuse the existing serve-pdf endpoint contract: redirect the client to it.
      // The Sii route mounts as /api/sii-facturacion/pdf/:codigo
      const target = `/api/sii-facturacion/pdf/${encodeURIComponent(row.siiCodigo)}`;
      return res.redirect(307, target);
    } catch (err: any) {
      return res.status(500).json({ error: err?.message || String(err) });
    }
  }

  // GET /api/bioma/whatsapp-link/:orderId
  static async whatsappLink(req: Request, res: Response) {
    try {
      const row = await BiomaFacturacionService.findEmision(req.params.orderId);
      if (!row) return res.status(404).json({ error: 'Sin registro de emisión' });
      const link = BiomaFacturacionService.buildWhatsAppLink(row);
      return res.json({ success: true, ...link });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message || String(err) });
    }
  }

  // POST /api/bioma/whatsapp-sent/:orderId
  static async whatsappSent(req: Request, res: Response) {
    try {
      const row = await BiomaFacturacionService.markWhatsAppSent(req.params.orderId);
      if (!row) return res.status(404).json({ error: 'Sin registro de emisión' });
      return res.json({ success: true, row });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message || String(err) });
    }
  }
}
