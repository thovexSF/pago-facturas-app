import crypto from 'crypto';
import { Request, Response } from 'express';
import { BiomaShopifyService } from '../services/BiomaShopifyService';

function getWebhookSecret(): string | null {
  return (
    process.env.BIOMA_SHOPIFY_WEBHOOK_SECRET?.trim() ||
    process.env.BIOMA_SHOPIFY_API_CLIENT_SECRET?.trim() ||
    process.env.SHOPIFY_API_SECRET?.trim() ||
    null
  );
}

function verifyShopifyHmac(req: Request, secret: string): boolean {
  const raw = req.body as Buffer;
  if (!Buffer.isBuffer(raw)) return false;
  const hmacHeader = req.get('X-Shopify-Hmac-Sha256') || '';
  const computed = crypto.createHmac('sha256', secret).update(raw).digest('base64');
  return !!hmacHeader && computed === hmacHeader;
}

export class BiomaShopifyWebhookController {
  private static async handleRawWebhook(
    req: Request,
    res: Response,
    handler: (payload: Record<string, unknown>) => Promise<unknown>,
  ) {
    const secret = getWebhookSecret();
    if (!secret) {
      console.error('[bioma webhook] Falta BIOMA_SHOPIFY_API_CLIENT_SECRET para HMAC');
      return res.status(500).send('Webhook secret not configured');
    }
    if (!verifyShopifyHmac(req, secret)) {
      console.warn(`[bioma webhook] HMAC inválido (${req.path})`);
      return res.status(401).send('Unauthorized');
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse((req.body as Buffer).toString('utf8'));
    } catch {
      return res.status(400).send('Invalid JSON');
    }
    try {
      const result = await handler(payload);
      return res.status(200).json(result ?? { ok: true });
    } catch (err: any) {
      console.error(`[bioma webhook] ${req.path} error:`, err?.message || err);
      return res.status(500).send('Error');
    }
  }

  /**
   * POST /api/bioma/webhooks/orders-paid
   * Body raw (Buffer) — registrar ANTES de express.json() en server.ts.
   */
  static async ordersPaid(req: Request, res: Response) {
    return BiomaShopifyWebhookController.handleRawWebhook(req, res, async (payload) => {
      const result = await BiomaShopifyService.handleOrderPaidWebhook({
        admin_graphql_api_id: payload.admin_graphql_api_id as string | undefined,
        name: payload.name as string | undefined,
      });
      if (result.tagged) {
        const extra = result.autoQueued ? ' (auto-emit encolado)' : '';
        console.log(`[bioma webhook] orders/paid ${result.orderName} → ${result.kind}${extra}`);
      } else if (result.reason) {
        console.log(`[bioma webhook] orders/paid ${result.orderName ?? '?'} omitido: ${result.reason}`);
      }
      return result;
    });
  }

  /**
   * POST /api/bioma/webhooks/orders-updated
   * Respaldo si orders/paid no está registrado o Flow lo consume primero.
   */
  static async ordersUpdated(req: Request, res: Response) {
    return BiomaShopifyWebhookController.handleRawWebhook(req, res, async (payload) => {
      const financialStatus = String(payload.financial_status || '').toLowerCase();
      if (financialStatus !== 'paid') {
        return { skipped: true, reason: `financial_status=${financialStatus}` };
      }
      const orderGid = payload.admin_graphql_api_id as string | undefined;
      if (!orderGid) return { skipped: true, reason: 'sin gid' };

      const order = await BiomaShopifyService.getOrder(orderGid);
      if (!order) return { skipped: true, reason: 'pedido no encontrado' };

      const result = await BiomaShopifyService.processPaidOrder(order);
      if (result.tagged) {
        console.log(`[bioma webhook] orders/updated ${result.orderName} → ${result.kind}`);
      }
      return result;
    });
  }
}
