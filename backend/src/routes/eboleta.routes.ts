import { Router } from 'express';
import { EBoletaController } from '../controllers/EBoletaController';

const router = Router();

router.get('/config', EBoletaController.config);
router.post('/session/create', EBoletaController.createSession);
router.post('/session/close-all', EBoletaController.closeAll);
router.delete('/session/:sessionId', EBoletaController.closeSession);

export default router;
