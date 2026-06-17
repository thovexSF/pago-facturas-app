import crypto from 'crypto';
import { Request, Response } from 'express';
import { BiomaShopifyService } from '../services/BiomaShopifyService';

export class BiomaShopifyWebhookController {
  /**
   * POST /api/bioma/webhooks/orders-paid
   * Body raw (Buffer) — registrar ANTES de express.json() en server.ts.
   */
  static async ordersPaid(req: Request, res: Response) {
    const secret =
      process.env.BIOMA_SHOPIFY_WEBHOOK_SECRET?.trim() ||
      process.env.BIOMA_SHOPIFY_API_CLIENT_SECRET?.trim() ||
      process.env.SHOPIFY_API_SECRET?.trim();

    if (!secret) {
      console.error('[bioma webhook] Falta BIOMA_SHOPIFY_API_CLIENT_SECRET para HMAC');
      return res.status(500).send('Webhook secret not configured');
    }

    const raw = req.body as Buffer;
    if (!Buffer.isBuffer(raw)) {
      return res.status(400).send('Expected raw body');
    }

    const hmacHeader = req.get('X-Shopify-Hmac-Sha256') || '';
    const computed = crypto.createHmac('sha256', secret).update(raw).digest('base64');
    if (!hmacHeader || computed !== hmacHeader) {
      console.warn('[bioma webhook] HMAC inválido en orders/paid');
      return res.status(401).send('Unauthorized');
    }

    let payload: { admin_graphql_api_id?: string; name?: string };
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      return res.status(400).send('Invalid JSON');
    }

    try {
      const result = await BiomaShopifyService.handleOrderPaidWebhook(payload);
      if (result.tagged) {
        console.log(`[bioma webhook] Pedido ${result.orderName} etiquetado factura`);
      }
      return res.status(200).send('OK');
    } catch (err: any) {
      console.error('[bioma webhook] orders/paid error:', err?.message || err);
      return res.status(500).send('Error');
    }
  }
}
