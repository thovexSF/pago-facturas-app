import { Router, Request, Response } from 'express';
import { MercadoConfig } from '../services/mercado/MercadoConfig';
import { CafService } from '../services/mercado/CafService';
import { MercadoEmitService } from '../services/mercado/MercadoEmitService';
import { SiiAuthService } from '../services/mercado/SiiAuthService';
import { DteUploadService } from '../services/mercado/DteUploadService';

const router = Router();

router.get('/config', (_req: Request, res: Response) => {
  res.json({
    mode: MercadoConfig.isMercadoMode() ? 'mercado' : 'scraper',
    env: MercadoConfig.getEnv(),
    empresaRut: process.env.BIOMA_EMPRESA_RUT || null,
  });
});

router.post('/caf/import', async (req: Request, res: Response) => {
  try {
    const { cafXml } = req.body;
    if (!cafXml) return res.status(400).json({ error: 'cafXml requerido' });
    const empresaRut = MercadoConfig.getEmisorRut();
    const result = await CafService.importCaf(empresaRut, cafXml);
    res.json({
      ok: true,
      tipoCodigo: result.tipoCodigo,
      folioDesde: result.folioDesde,
      folioHasta: result.folioHasta,
      folioActual: result.folioActual,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/caf/status', async (_req: Request, res: Response) => {
  try {
    const empresaRut = MercadoConfig.getEmisorRut();
    const status = await CafService.getStatus(empresaRut);
    res.json(status);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/auth/test', async (_req: Request, res: Response) => {
  try {
    const token = await SiiAuthService.authenticate();
    res.json({ ok: true, tokenLength: token.length, env: MercadoConfig.getEnv() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/emitir', async (req: Request, res: Response) => {
  try {
    const result = await MercadoEmitService.emitir(req.body);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/dte/:trackId/estado', async (req: Request, res: Response) => {
  try {
    const empresaRut = MercadoConfig.getEmisorRut();
    const result = await DteUploadService.queryEstado(empresaRut, req.params.trackId);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/dte/estado', async (req: Request, res: Response) => {
  try {
    const result = await DteUploadService.queryEstadoDte(req.body);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
