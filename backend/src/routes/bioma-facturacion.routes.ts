import { Router } from 'express';
import { BiomaFacturacionController } from '../controllers/BiomaFacturacionController';

const router = Router();

router.get('/payload/:orderId', BiomaFacturacionController.payload);
router.post('/scraper/:orderId', BiomaFacturacionController.scraper);
router.get('/template-codigo', BiomaFacturacionController.templateCodigo);
router.get('/pedidos-pendientes', BiomaFacturacionController.pedidosPendientes);
router.post('/sync/:orderId', BiomaFacturacionController.sync);
router.get('/emision/:orderId', BiomaFacturacionController.getEmision);
router.post('/preview/:orderId', BiomaFacturacionController.preview);
router.post('/emitir/:orderId', BiomaFacturacionController.emitir);
router.post('/pdf/:orderId/fetch', BiomaFacturacionController.fetchPdf);
router.get('/pdf/:orderId', BiomaFacturacionController.pdf);
router.get('/whatsapp-link/:orderId', BiomaFacturacionController.whatsappLink);
router.post('/whatsapp-sent/:orderId', BiomaFacturacionController.whatsappSent);

export default router;
