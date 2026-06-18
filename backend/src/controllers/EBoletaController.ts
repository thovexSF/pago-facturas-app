import { Request, Response } from 'express';
import { EBoletaService } from '../services/EBoletaService';
import { EBoletaSessionService } from '../services/EBoletaSessionService';
import { BiomaFacturacionService } from '../services/BiomaFacturacionService';

export class EBoletaController {
  private static resolveEmpresaRut(fromBody?: string): string {
    const body = fromBody?.trim();
    if (body) return body;
    const bioma = process.env.BIOMA_EMPRESA_RUT?.trim();
    if (bioma) return bioma;
    throw new Error('empresaRut requerido (BIOMA_EMPRESA_RUT)');
  }

  // POST /api/eboleta/session/create
  static async createSession(req: Request, res: Response) {
    try {
      const empresaRut = EBoletaController.resolveEmpresaRut(req.body?.empresaRut);
      const sessionId = await EBoletaService.createSession(empresaRut);
      return res.json({ success: true, sessionId, channel: 'eboleta' });
    } catch (err: any) {
      console.error('[eboleta] createSession error:', err?.message || err);
      return res.status(500).json({ success: false, error: err?.message || String(err) });
    }
  }

  // DELETE /api/eboleta/session/:sessionId
  static async closeSession(req: Request, res: Response) {
    try {
      await EBoletaSessionService.closeSession(req.params.sessionId);
      return res.json({ success: true });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err?.message || String(err) });
    }
  }

  // POST /api/eboleta/session/close-all
  static async closeAll(_req: Request, res: Response) {
    await EBoletaSessionService.closeAllSessions();
    return res.json({ success: true });
  }

  // GET /api/eboleta/config
  static async config(_req: Request, res: Response) {
    return res.json({
      success: true,
      channel: 'eboleta',
      url: 'https://eboleta.sii.cl/emitir/',
      empresaRut: BiomaFacturacionService.getEmpresaRutConfig(),
    });
  }
}
