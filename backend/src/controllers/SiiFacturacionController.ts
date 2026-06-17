import { Request, Response } from 'express';
import { SiiFacturacionService } from '../services/SiiFacturacionService';
import { SiiCredentialsService } from '../services/SiiCredentialsService';

// ── Background jobs (sync histórico) ────────────────────────────────────────
interface SyncJob {
  status: 'running' | 'done' | 'error';
  quarter: string;
  quarterIndex: number;
  totalQuarters: number;
  acumulado: number;
  totalEncontradas: number;
  nuevasEnTrimestre: number;
  message: string;
  startedAt: number;
  empresaRut: string;
}

const syncJobs = new Map<string, SyncJob>();

// Limpiar jobs viejos cada 30 min
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, job] of syncJobs) {
    if (job.startedAt < cutoff) syncJobs.delete(id);
  }
}, 30 * 60 * 1000);

export class SiiFacturacionController {

  // POST /api/sii-facturacion/session/create
  static async createSession(req: Request, res: Response) {
    const { empresaRut, deferPlaywright } = req.body;
    if (!empresaRut) return res.status(400).json({ error: 'empresaRut requerido' });
    try {
      const sessionId = await SiiFacturacionService.createSession(empresaRut);

      // Billing: precalienta Playwright + PDFs. Bioma: solo HTTP hasta el primer preview/emit.
      if (!deferPlaywright) {
        const session = SiiFacturacionService.getSession(sessionId);
        if (session) {
          SiiFacturacionService.ensureBrowserForSession(session)
            .then((context) => {
              setTimeout(() => {
                SiiFacturacionService.startBackgroundPdfDownload(context, empresaRut);
              }, 2000);
            })
            .catch((err) => {
              console.warn('[SII] ensureBrowserForSession (background):', err?.message || err);
            });
        }
      }

      return res.json({ success: true, sessionId });
    } catch (err: any) {
      const msg = err?.message || 'Error al crear sesión';
      console.error('[SII] createSession error:', msg, err?.stack?.split('\n')[1] || '');
      return res.status(500).json({ success: false, error: msg });
    }
  }

  // DELETE /api/sii-facturacion/session/:sessionId
  static async closeSession(req: Request, res: Response) {
    const { sessionId } = req.params;
    await SiiFacturacionService.closeSession(sessionId);
    return res.json({ success: true });
  }

  // POST /api/sii-facturacion/session/close-all
  static async closeAllSessions(_req: Request, res: Response) {
    await SiiFacturacionService.closeAllSessions();
    return res.json({ success: true });
  }

  // GET /api/sii-facturacion/block-status
  static async blockStatus(_req: Request, res: Response) {
    return res.json({ success: true, ...SiiFacturacionService.getBlockStatus() });
  }

  // POST /api/sii-facturacion/block-status/clear — solo si ya entraste manual al SII
  static async clearBlock(_req: Request, res: Response) {
    SiiFacturacionService.clearSiiBlock();
    return res.json({ success: true, ...SiiFacturacionService.getBlockStatus() });
  }

  // GET /api/sii-facturacion/debug?sessionId=xxx&empresaRut=xxx
  // Si no hay sessionId, crea una sesión temporal para diagnóstico
  static async debug(req: Request, res: Response) {
    const { sessionId, empresaRut: qEmpresaRut } = req.query as Record<string, string>;
    try {
      let session = sessionId ? SiiFacturacionService.getSession(sessionId) : null;
      let tempSessionId: string | null = null;

      if (!session) {
        const rut = qEmpresaRut || '76189742-K';
        console.log(`[debug] Creando sesión temporal para ${rut}...`);
        tempSessionId = await SiiFacturacionService.createSession(rut);
        session = SiiFacturacionService.getSession(tempSessionId)!;
      }

      const url = `https://www1.sii.cl/cgi-bin/Portal001/mipeAdminDocsEmi.cgi?RUT_RECP=&FOLIO=&RZN_SOC=&FEC_DESDE=&FEC_HASTA=&TPO_DOC=&ESTADO=&ORDEN=&NUM_PAG=1`;
      const axiosRes = await session.axiosClient.get(url, { validateStatus: () => true });
      const html = String(axiosRes.data);

      const codigos = [...html.matchAll(/CODIGO=(\d+)/g)].map(m => m[1]);
      const isLoginPage = html.includes('id="rutcntr"') || html.includes('IngresoRutClave');
      const isQueuePage = html.includes('salaespera') || html.includes('queue-it');

      if (tempSessionId) await SiiFacturacionService.closeSession(tempSessionId).catch(() => {});

      return res.json({
        httpStatus: axiosRes.status,
        htmlLength: html.length,
        codigosFound: [...new Set(codigos)].slice(0, 10),
        isLoginPage,
        isQueuePage,
        finalUrl: axiosRes.request?.res?.responseUrl || '',
        htmlPreview: html.substring(0, 1500).replace(/\s+/g, ' '),
      });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message, stack: err?.stack?.split('\n').slice(0, 3) });
    }
  }

  // GET /api/sii-facturacion/preview/:codigo?sessionId=xxx
  static async getPreview(req: Request, res: Response) {
    const { codigo } = req.params;
    const { sessionId } = req.query as Record<string, string>;
    if (!sessionId) return res.status(400).json({ error: 'sessionId requerido' });
    try {
      const session = SiiFacturacionService.getSession(sessionId);
      if (!session) return res.status(401).json({ error: 'Sesión no encontrada o expirada' });
      const context = await SiiFacturacionService.ensureBrowserForSession(session);
      const { html, resolvedDocUrl } = await SiiFacturacionService.getPreviewHTML(
        session.axiosClient,
        context,
        codigo,
        session.cookieHeader,
        session.empresaRut,
        session.playwrightReady
      );
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('X-SII-Resolved-Doc-Url', encodeURIComponent(resolvedDocUrl));
      return res.send(html);
    } catch (err: any) {
      return res.status(500).json({ error: err?.message });
    }
  }

  // GET /api/sii-facturacion/pdf/:codigo  (sirve el PDF desde DB)
  static async servePdf(req: Request, res: Response) {
    const { codigo } = req.params;
    try {
      const buffer = await SiiFacturacionService.getPdfData(codigo);
      if (!buffer) return res.status(404).json({ error: 'PDF no disponible aún.' });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${codigo}.pdf"`);
      return res.send(buffer);
    } catch (err: any) {
      return res.status(500).json({ error: err?.message });
    }
  }

  // POST /api/sii-facturacion/sync
  // Body: { sessionId, empresaRut, tipoCodigo?, maxDocs? }
  static async syncFacturas(req: Request, res: Response) {
    const { sessionId, empresaRut, tipoCodigo, maxDocs } = req.body;
    if (!sessionId || !empresaRut) return res.status(400).json({ error: 'sessionId y empresaRut requeridos' });
    try {
      const session = SiiFacturacionService.getSession(sessionId);
      if (!session) return res.status(401).json({ error: 'Sesión no encontrada o expirada' });

      const result = await SiiFacturacionService.syncFacturas(
        session.axiosClient,
        empresaRut,
        tipoCodigo ? parseInt(tipoCodigo, 10) : undefined,
        {},
        maxDocs ? parseInt(maxDocs, 10) : undefined
      );

      // Iniciar descarga silenciosa de PDFs en background (no bloquea la respuesta)
      SiiFacturacionService.ensureBrowserForSession(session).then(context => {
        SiiFacturacionService.startBackgroundPdfDownload(context, empresaRut);
      }).catch(() => {});

      return res.json({ success: true, ...result });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err?.message });
    }
  }

  // GET /api/sii-facturacion/db/facturas?empresaRut=xxx&search=yyy&tipoCodigo=33&soloUltima=true
  static async getFacturasDB(req: Request, res: Response) {
    const { empresaRut, search, tipoCodigo, soloUltima } = req.query as Record<string, string>;
    if (!empresaRut) return res.status(400).json({ error: 'empresaRut requerido' });
    try {
      const facturas = await SiiFacturacionService.getFacturasDB(empresaRut, {
        search: search || undefined,
        tipoCodigo: tipoCodigo ? parseInt(tipoCodigo, 10) : undefined,
        soloUltimaPorCliente: soloUltima === 'true',
      });
      return res.json({ success: true, total: facturas.length, facturas });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err?.message });
    }
  }

  // GET /api/sii-facturacion/empresas?sessionId=xxx
  static async getEmpresas(req: Request, res: Response) {
    const { sessionId } = req.query as { sessionId: string };
    if (!sessionId) return res.status(400).json({ error: 'sessionId requerido' });
    try {
      const session = SiiFacturacionService.getSession(sessionId);
      if (!session) return res.status(401).json({ error: 'Sesión no encontrada o expirada' });
      const empresas = await SiiFacturacionService.getEmpresas(session.axiosClient);
      return res.json({ success: true, empresas });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err?.message });
    }
  }

  // GET /api/sii-facturacion/empresas-disponibles — empresas del RUT de acceso (sin sessionId)
  static async listEmpresasDisponibles(_req: Request, res: Response) {
    try {
      const empresas = await SiiFacturacionService.listEmpresasDisponibles();
      return res.json({ success: true, empresas });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err?.message || 'Error al listar empresas' });
    }
  }

  // GET /api/sii-facturacion/facturas?sessionId=xxx&tipoCodigo=33&maxPaginas=10
  static async getFacturas(req: Request, res: Response) {
    const { sessionId, tipoCodigo, fechaDesde, fechaHasta, maxPaginas } = req.query as Record<string, string>;
    if (!sessionId) return res.status(400).json({ error: 'sessionId requerido' });
    try {
      const session = SiiFacturacionService.getSession(sessionId);
      if (!session) return res.status(401).json({ error: 'Sesión no encontrada o expirada' });
      const facturas = await SiiFacturacionService.getFacturasEmitidas(session.axiosClient, {
        tipoCodigo: tipoCodigo ? parseInt(tipoCodigo, 10) : undefined,
        fechaDesde: fechaDesde || undefined,
        fechaHasta: fechaHasta || undefined,
        maxPaginas: maxPaginas ? parseInt(maxPaginas, 10) : 50,
      });
      return res.json({ success: true, total: facturas.length, facturas });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err?.message });
    }
  }

  // GET /api/sii-facturacion/ultima-por-cliente?sessionId=xxx&tipoCodigo=33
  static async getUltimaFacturaPorCliente(req: Request, res: Response) {
    const { sessionId, tipoCodigo, maxPaginas } = req.query as Record<string, string>;
    if (!sessionId) return res.status(400).json({ error: 'sessionId requerido' });
    try {
      const session = SiiFacturacionService.getSession(sessionId);
      if (!session) return res.status(401).json({ error: 'Sesión no encontrada o expirada' });
      const clientes = await SiiFacturacionService.getUltimaFacturaPorCliente(session.axiosClient, {
        tipoCodigo: tipoCodigo ? parseInt(tipoCodigo, 10) : undefined,
        maxPaginas: maxPaginas ? parseInt(maxPaginas, 10) : 50,
      });
      return res.json({ success: true, total: clientes.length, clientes });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err?.message });
    }
  }

  // POST /api/sii-facturacion/detalle/refresh  body: { sessionId, empresaRut, codigo, tipoCodigo? }
  static async refreshDetalle(req: Request, res: Response) {
    const { sessionId, empresaRut, codigo, tipoCodigo } = req.body || {};
    if (!sessionId || !empresaRut || !codigo) {
      return res.status(400).json({ error: 'sessionId, empresaRut y codigo son requeridos' });
    }
    try {
      const session = SiiFacturacionService.getSession(sessionId);
      if (!session) return res.status(401).json({ error: 'Sesión no encontrada o expirada' });
      const det = await SiiFacturacionService.refreshDetalleEnDb(
        empresaRut,
        String(codigo),
        session.axiosClient,
        tipoCodigo !== undefined && tipoCodigo !== null && tipoCodigo !== ''
          ? parseInt(String(tipoCodigo), 10)
          : undefined
      );
      if (!det) {
        return res.status(404).json({
          error: 'No se pudo obtener el detalle (revisa sesión SII o tipo de documento)',
        });
      }
      return res.json({ success: true, detalle: det });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err?.message });
    }
  }

  // GET /api/sii-facturacion/detalle/:codigo?sessionId=xxx&tipoCodigo=33
  static async getDetalle(req: Request, res: Response) {
    const { codigo } = req.params;
    const { sessionId, tipoCodigo } = req.query as Record<string, string>;
    if (!sessionId) return res.status(400).json({ error: 'sessionId requerido' });
    try {
      const session = SiiFacturacionService.getSession(sessionId);
      if (!session) return res.status(401).json({ error: 'Sesión no encontrada o expirada' });
      const detalle = await SiiFacturacionService.getDetalleFactura(
        session.axiosClient, codigo, tipoCodigo ? parseInt(tipoCodigo, 10) : 33
      );
      if (!detalle) return res.status(404).json({ error: 'No se encontró detalle' });
      return res.json({ success: true, detalle });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err?.message });
    }
  }

  // POST /api/sii-facturacion/sync-historico/start  — inicia job en background, devuelve jobId
  static async syncHistoricoStart(req: Request, res: Response) {
    const { sessionId, empresaRut, tipoCodigo } = req.body;
    if (!sessionId || !empresaRut) {
      return res.status(400).json({ error: 'sessionId y empresaRut requeridos' });
    }

    const session = SiiFacturacionService.getSession(sessionId);
    if (!session) {
      return res.status(401).json({ error: 'Sesión no encontrada o expirada' });
    }

    // Evitar duplicados: si ya hay un job running para esta empresa, devolver ese
    for (const [id, job] of syncJobs) {
      if (job.empresaRut === empresaRut && job.status === 'running') {
        return res.json({ success: true, jobId: id, alreadyRunning: true });
      }
    }

    const jobId = `hist_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const job: SyncJob = {
      status: 'running',
      quarter: '',
      quarterIndex: 0,
      totalQuarters: 8,
      acumulado: 0,
      totalEncontradas: 0,
      nuevasEnTrimestre: 0,
      message: 'Login exitoso ✅ — iniciando scraping...',
      startedAt: Date.now(),
      empresaRut,
    };
    syncJobs.set(jobId, job);

    // Ejecutar en background — NO await
    (async () => {
      try {
        const gen = SiiFacturacionService.syncHistoricoGen(
          session.axiosClient,
          empresaRut,
          tipoCodigo ? parseInt(tipoCodigo, 10) : undefined
        );
        for await (const progress of gen) {
          const pct = Math.round((progress.quarterIndex / progress.totalQuarters) * 100);
          Object.assign(job, {
            quarter: progress.quarter,
            quarterIndex: progress.quarterIndex,
            totalQuarters: progress.totalQuarters,
            acumulado: progress.acumulado,
            totalEncontradas: progress.total,
            nuevasEnTrimestre: progress.synced,
            message: `[${pct}%] ${progress.quarter}: ${progress.total} encontradas, +${progress.synced} nuevas | Total acumulado: ${progress.acumulado}`,
          });
        }
        job.status = 'done';
        job.message = `✅ Completado: ${job.acumulado} facturas nuevas sincronizadas en ${job.totalQuarters} trimestres`;
      } catch (err: any) {
        job.status = 'error';
        job.message = err?.message || 'Error desconocido';
      }
    })();

    return res.json({ success: true, jobId });
  }

  // GET /api/sii-facturacion/sync-historico/status?jobId=xxx
  static async syncHistoricoStatus(req: Request, res: Response) {
    const { jobId } = req.query as Record<string, string>;
    if (!jobId) return res.status(400).json({ error: 'jobId requerido' });
    const job = syncJobs.get(jobId);
    if (!job) return res.status(404).json({ error: 'Job no encontrado' });
    return res.json({ success: true, ...job });
  }

  // DELETE /api/sii-facturacion/db/facturas?empresaRut=xxx  — borra todos los docs de una empresa
  static async deleteFacturasDB(req: Request, res: Response) {
    const { empresaRut } = req.query as Record<string, string>;
    if (!empresaRut) return res.status(400).json({ error: 'empresaRut requerido' });
    try {
      const deleted = await SiiFacturacionService.deleteFacturasDB(empresaRut);
      return res.json({ success: true, deleted });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err?.message });
    }
  }

  // GET /api/sii-facturacion/contactos?empresaRut=xxx&search=yyy
  static async getContactosSII(req: Request, res: Response) {
    const { empresaRut, search } = req.query as Record<string, string>;
    try {
      const contactos = await SiiFacturacionService.getContactosSII({
        empresaRut: empresaRut || undefined,
        search: search || undefined,
      });
      return res.json({ success: true, total: contactos.length, contactos });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err?.message });
    }
  }

  // POST /api/sii-facturacion/contactos/extract  body: { empresaRut }
  static async extractContactosSII(req: Request, res: Response) {
    const { empresaRut } = req.body;
    if (!empresaRut) return res.status(400).json({ error: 'empresaRut requerido' });
    try {
      const result = await SiiFacturacionService.extractContactosFromDB(empresaRut);
      return res.json({ success: true, ...result });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err?.message });
    }
  }

  // POST /api/sii-facturacion/contactos/:rutReceptor/import  body: { empresaRut, branchId? }
  static async importContacto(req: Request, res: Response) {
    const { rutReceptor } = req.params;
    const { empresaRut, branchId } = req.body;
    if (!empresaRut) return res.status(400).json({ error: 'empresaRut requerido' });
    try {
      const result = await SiiFacturacionService.importContactoToClients(
        empresaRut, rutReceptor, branchId ? parseInt(branchId, 10) : undefined
      );
      return res.json(result);
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err?.message });
    }
  }

  // POST /api/sii-facturacion/emitir
  static async emitirFactura(req: Request, res: Response) {
    const { sessionId, codigoOriginal, tipoCodigo, fechaEmision, items,
            detenerEnPreview, esperarMsEnPreview,
            comunaReceptor, ciudadReceptor, dirReceptor } =
      req.body || {};
    if (!sessionId || !codigoOriginal || !items?.length) {
      return res.status(400).json({ error: 'sessionId, codigoOriginal e items son requeridos' });
    }
    try {
      const session = SiiFacturacionService.getSession(sessionId);
      if (!session) return res.status(401).json({ error: 'Sesión no encontrada o expirada' });
      const context = await SiiFacturacionService.ensureBrowserForSession(session);
      const emitPage = await context.newPage();
      let result: any;
      const esperarParsed =
        esperarMsEnPreview !== undefined && esperarMsEnPreview !== null && esperarMsEnPreview !== ''
          ? parseInt(String(esperarMsEnPreview), 10)
          : NaN;
      try {
        const creds = SiiCredentialsService.getInstance().getCredentials();
        result = await SiiFacturacionService.emitirFactura(
          emitPage,
          {
            codigoOriginal,
            tipoCodigo: tipoCodigo || 33,
            fechaEmision: fechaEmision || new Date().toISOString().split('T')[0],
            items,
            comunaReceptor: comunaReceptor || '',
            ciudadReceptor: ciudadReceptor || '',
            dirReceptor: dirReceptor || '',
          },
          {
            detenerEnPreview: !!detenerEnPreview,
            esperarMsEnPreview: Number.isFinite(esperarParsed) && esperarParsed > 0 ? esperarParsed : undefined,
            firmaClave: creds?.firmaClave,
          }
        );
      } finally {
        await emitPage.close().catch(() => {});
      }
      return res.json(result);
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err?.message });
    }
  }
}
