import { Request, Response } from 'express';
import { BiomaFacturacionService } from '../services/BiomaFacturacionService';
import { BiomaShopifyService } from '../services/BiomaShopifyService';
import { BiomaEmitService } from '../services/BiomaEmitService';
import { BiomaAutoEmitService } from '../services/BiomaAutoEmitService';
import { SiiFacturacionService } from '../services/SiiFacturacionService';

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

  // GET /api/bioma/config — auto-emisión y empresa
  static async config(_req: Request, res: Response) {
    try {
      return res.json({
        success: true,
        empresaRut: BiomaFacturacionService.getEmpresaRutConfig(),
        autoEmitFactura: BiomaAutoEmitService.isAutoEmitFacturaEnabled(),
        autoEmitBoleta: BiomaAutoEmitService.isAutoEmitBoletaEnabled(),
        boletaVia: process.env.BIOMA_BOLETA_VIA || 'eboleta',
      });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err?.message || String(err) });
    }
  }

  // GET /api/bioma/facturas-realizadas
  static async facturasRealizadas(req: Request, res: Response) {
    try {
      const page = req.query.page ? parseInt(String(req.query.page), 10) : 1;
      const pageSize = req.query.pageSize ? parseInt(String(req.query.pageSize), 10) : 50;
      const data = await BiomaFacturacionService.listRealizadas({
        page: Number.isFinite(page) ? page : 1,
        pageSize: Number.isFinite(pageSize) ? pageSize : 50,
      });
      return res.json({ success: true, ...data });
    } catch (err: any) {
      console.error('[bioma] facturasRealizadas error:', err?.message || err);
      return res.status(500).json({ success: false, error: err?.message || String(err) });
    }
  }

  // GET /api/bioma/boletas-pendientes
  static async boletasPendientes(req: Request, res: Response) {
    try {
      const page = req.query.page ? parseInt(String(req.query.page), 10) : 1;
      const pageSize = req.query.pageSize ? parseInt(String(req.query.pageSize), 10) : 50;
      const sync = req.query.sync !== '0' && req.query.sync !== 'false';
      const daysBackRaw = req.query.daysBack != null ? parseInt(String(req.query.daysBack), 10) : 14;
      const daysBack = Number.isFinite(daysBackRaw) ? daysBackRaw : 14;
      const data = await BiomaFacturacionService.listBoletasPendientes({
        page: Number.isFinite(page) ? page : 1,
        pageSize: Number.isFinite(pageSize) ? pageSize : 50,
        sync,
        maxSyncPages: daysBack > 30 ? 25 : 15,
        daysBack,
      });
      return res.json({ success: true, ...data });
    } catch (err: any) {
      console.error('[bioma] boletasPendientes error:', err?.message || err);
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

  // POST /api/bioma/marcar-emitida/:orderId — asociar folio histórico sin re-emitir
  static async marcarEmitida(req: Request, res: Response) {
    const orderId = req.params.orderId;
    const { siiFolio, siiCodigo, tipoCodigo } = req.body || {};
    const folio = parseInt(String(siiFolio), 10);
    if (!orderId) return res.status(400).json({ error: 'orderId requerido' });
    if (!Number.isFinite(folio) || folio <= 0) {
      return res.status(400).json({ error: 'siiFolio requerido (número de folio SII)' });
    }
    try {
      const row = await BiomaFacturacionService.registerEmittedHistorica(orderId, {
        siiFolio: folio,
        siiCodigo: siiCodigo ? String(siiCodigo).trim() : null,
        tipoCodigo: tipoCodigo ? parseInt(String(tipoCodigo), 10) : undefined,
      });
      return res.json({
        success: true,
        row,
        message: `Pedido asociado a factura #${folio}. Tag Shopify actualizado.`,
      });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err?.message || String(err) });
    }
  }

  // POST /api/bioma/sync-boletas — importar B2C pagados como boletas pendientes
  static async syncBoletas(req: Request, res: Response) {
    try {
      const stats = await BiomaFacturacionService.syncBoletasFromShopify({
        maxPages: req.body?.maxPages ?? 5,
      });
      const data = await BiomaFacturacionService.listBoletasPendientes({ pageSize: 50 });
      return res.json({ success: true, stats, ...data });
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
        rutReceptor: row.tipoCodigo === 39 || row.tipoCodigo === 41 ? null : row.rutReceptor,
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
    const orderId = req.params.orderId;
    const { sessionId, codigoOriginal, tipoCodigo, fechaEmision, esperarMsEnPreview } =
      req.body || {};
    if (!orderId) return res.status(400).json({ error: 'orderId requerido' });
    if (!sessionId) return res.status(400).json({ error: 'sessionId requerido' });

    const tipo = tipoCodigo ? parseInt(String(tipoCodigo), 10) : undefined;
    const isBoletaEmit = tipo === 39 || tipo === 41;

    if (!isBoletaEmit) {
      try {
        SiiFacturacionService.assertSiiAvailable();
      } catch (err: any) {
        return res.status(429).json({ success: false, error: err?.message || String(err) });
      }
    }

    const { scraperStep } = flags;

    try {
      const out = await BiomaEmitService.emitOrder(orderId, {
        sessionId,
        scraperStep,
        codigoOriginal,
        tipoCodigo,
        fechaEmision,
        esperarMsEnPreview: Number.isFinite(parseInt(String(esperarMsEnPreview), 10))
          ? parseInt(String(esperarMsEnPreview), 10)
          : undefined,
      });

      if (!out.success) {
        const status = out.result?.detenidoEnPreview ? 200 : 502;
        return res.status(status).json({
          success: false,
          error: out.error,
          step: scraperStep,
          result: out.result,
          message: out.error,
        });
      }

      if (scraperStep !== 'emitir') {
        const templateInfo = await BiomaFacturacionService.resolveTemplateInfo({
          rutReceptor: out.row?.rutReceptor,
          tipoCodigo: tipoCodigo || out.row?.tipoCodigo || 33,
        });
        return res.json({
          success: true,
          step: scraperStep,
          result: out.result,
          template: templateInfo,
          row: out.row,
          message: out.result?.aviso,
        });
      }

      return res.json({
        success: true,
        step: 'emitir',
        result: out.result,
        row: out.row,
        pdfUrl: out.pdfUrl,
      });
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
      if (!row) {
        return res.status(404).json({ error: 'Factura aún no emitida o sin código SII' });
      }
      if (row.pdfPublicUrl) {
        return res.redirect(307, row.pdfPublicUrl);
      }
      if (!row.siiCodigo) {
        return res.status(404).json({ error: 'Sin PDF disponible (e-Boleta sin URL o sin código MiPyme)' });
      }
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
