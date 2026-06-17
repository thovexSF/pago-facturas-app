import 'reflect-metadata';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import express from 'express';
import cors from 'cors';
import { AppDataSource } from './config/database';
import siiFacturacionRoutes from './routes/sii-facturacion.routes';
import biomaFacturacionRoutes from './routes/bioma-facturacion.routes';
import { BiomaShopifyWebhookController } from './controllers/BiomaShopifyWebhookController';
import { SiiFacturacionService } from './services/SiiFacturacionService';

const MONOREPO_ROOT = path.join(__dirname, '..', '..');
const PAGO_DIR = path.join(MONOREPO_ROOT, 'apps', 'pago-facturas');
const FRONTEND_DIST = path.join(MONOREPO_ROOT, 'frontend', 'dist');

dotenv.config({ path: path.join(MONOREPO_ROOT, '.env') });
dotenv.config({ path: path.join(process.cwd(), '.env') });

const PORT = parseInt(process.env.PORT || '3890', 10);

async function shutdown(signal: string) {
  console.log(`\n[server] ${signal} recibido — cerrando browsers y sesiones...`);
  try {
    await SiiFacturacionService.closeAllSessions();
  } catch (e) {
    console.error('[server] Error cerrando sesiones:', e);
  }
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGUSR2', () => void shutdown('SIGUSR2'));

async function main() {
  await AppDataSource.initialize();

  const app = express();
  app.use(cors({ origin: true }));

  app.post(
    '/api/bioma/webhooks/orders-paid',
    express.raw({ type: 'application/json' }),
    BiomaShopifyWebhookController.ordersPaid,
  );

  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'bioma-facturacion' });
  });

  app.use('/api/sii-facturacion', siiFacturacionRoutes);
  app.use('/api/bioma', biomaFacturacionRoutes);

  // UI emisión SII (Vite build con base /sii/)
  if (fs.existsSync(FRONTEND_DIST)) {
    app.use('/sii', express.static(FRONTEND_DIST, { index: 'index.html' }));
    app.get('/sii/*', (_req, res) => {
      res.sendFile(path.join(FRONTEND_DIST, 'index.html'));
    });
  }

  // Facturas por pagar (app Railway original)
  const pagoPath = path.join(PAGO_DIR, 'server-postgres.js');
  if (fs.existsSync(pagoPath)) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app: pagoApp, initPagoFacturas } = require(path.join(__dirname, 'mount-pago.cjs'));
    app.use(pagoApp);
    await initPagoFacturas();
    console.log('[server] Módulo pago-facturas montado en /');
  } else {
    console.warn('[server] apps/pago-facturas no encontrado — solo APIs SII');
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Bioma Facturación http://0.0.0.0:${PORT}`);
    console.log(`  · Facturas por pagar  → /`);
    if (fs.existsSync(FRONTEND_DIST)) console.log(`  · Facturación SII      → /sii`);
    console.log(`  · API Bioma/SII        → /api/bioma, /api/sii-facturacion`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
