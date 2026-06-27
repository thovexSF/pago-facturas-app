import { Router } from 'express';
import { BiomaFacturacionController } from '../controllers/BiomaFacturacionController';

const router = Router();

router.post('/marcar-emitida/:orderId', BiomaFacturacionController.marcarEmitida);
router.post('/descartar/:orderId', BiomaFacturacionController.descartar);
router.post('/preparar-nc/:orderId', BiomaFacturacionController.prepararNc);
router.post('/limpiar-aviso-nc/:orderId', BiomaFacturacionController.limpiarAvisoNc);
router.post('/sync-boletas', BiomaFacturacionController.syncBoletas);
router.get('/config', BiomaFacturacionController.config);
router.get('/facturas-realizadas', BiomaFacturacionController.facturasRealizadas);
router.get('/boletas-pendientes', BiomaFacturacionController.boletasPendientes);
router.get('/payload/:orderId', BiomaFacturacionController.payload);
router.post('/scraper/:orderId', BiomaFacturacionController.scraper);
router.get('/template-codigo', BiomaFacturacionController.templateCodigo);
router.get('/pedidos-pendientes', BiomaFacturacionController.pedidosPendientes);
router.post('/sync/:orderId', BiomaFacturacionController.sync);
router.get('/emision/:orderId', BiomaFacturacionController.getEmision);
router.post('/preview/:orderId', BiomaFacturacionController.preview);
router.post('/emitir/:orderId', BiomaFacturacionController.emitir);
router.post('/emitir-cola', BiomaFacturacionController.emitirCola);
router.get('/emitir-cola/status', BiomaFacturacionController.emitirColaStatus);
router.post('/pdf/sync-pendientes', BiomaFacturacionController.syncPdfsPendientes);
router.post('/pdf/:orderId/fetch', BiomaFacturacionController.fetchPdf);
router.get('/pdf/:orderId', BiomaFacturacionController.pdf);
router.get('/email-draft/:orderId', BiomaFacturacionController.emailDraft);
router.get('/whatsapp-link/:orderId', BiomaFacturacionController.whatsappLink);
router.post('/whatsapp-sent/:orderId', BiomaFacturacionController.whatsappSent);

export default router;
