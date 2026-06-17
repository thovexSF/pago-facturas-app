import { Router } from 'express';
import { SiiFacturacionController } from '../controllers/SiiFacturacionController';

const router = Router();

router.post('/session/create', SiiFacturacionController.createSession);
router.delete('/session/:sessionId', SiiFacturacionController.closeSession);
router.post('/session/close-all', SiiFacturacionController.closeAllSessions);
router.get('/block-status', SiiFacturacionController.blockStatus);
router.post('/block-status/clear', SiiFacturacionController.clearBlock);
router.get('/debug', SiiFacturacionController.debug);
router.get('/preview/:codigo', SiiFacturacionController.getPreview);
router.get('/pdf/:codigo', SiiFacturacionController.servePdf);
router.post('/sync', SiiFacturacionController.syncFacturas);
router.get('/db/facturas', SiiFacturacionController.getFacturasDB);
router.delete('/db/facturas', SiiFacturacionController.deleteFacturasDB);
router.post('/sync-historico/start', SiiFacturacionController.syncHistoricoStart);
router.get('/sync-historico/status', SiiFacturacionController.syncHistoricoStatus);
router.get('/contactos', SiiFacturacionController.getContactosSII);
router.post('/contactos/extract', SiiFacturacionController.extractContactosSII);
router.post('/contactos/:rutReceptor/import', SiiFacturacionController.importContacto);
router.get('/empresas-disponibles', SiiFacturacionController.listEmpresasDisponibles);
router.get('/empresas', SiiFacturacionController.getEmpresas);
router.get('/facturas', SiiFacturacionController.getFacturas);
router.get('/ultima-por-cliente', SiiFacturacionController.getUltimaFacturaPorCliente);
router.post('/detalle/refresh', SiiFacturacionController.refreshDetalle);
router.get('/detalle/:codigo', SiiFacturacionController.getDetalle);
router.post('/emitir', SiiFacturacionController.emitirFactura);

export default router;
