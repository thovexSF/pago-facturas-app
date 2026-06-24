/**
 * BiomaFacturacionService — orchestrates the bridge between Shopify orders and
 * the SII portal scraper. Listing pending orders, persisting emission state,
 * triggering preview/emit through SiiFacturacionService, and tagging back the
 * Shopify order.
 *
 * The actual SII portal interaction stays in SiiFacturacionService — this
 * service only owns the Shopify side and the bioma_factura_emisiones table.
 */

import { AppDataSource } from '../config/database';
import {
  BiomaFacturaEmisionEntity,
  BiomaFacturaStatus,
} from '../entities/BiomaFacturaEmisionEntity';
import { SiiFacturaEntity } from '../entities/SiiFacturaEntity';
import {
  BiomaShopifyService,
  ShopifyOrderForBioma,
} from './BiomaShopifyService';
import {
  BIOMA_FACTURA_ATTR,
  getOrderCustomAttribute,
  orderNeedsFactura,
  parseCustomerNote,
  isBoletaTipo,
  boletaReceptorForSii,
  eboletaReceptorForSii,
} from '../utils/biomaOrderAttrs';
import { sanitizeDescripcionParaSii } from './SiiFacturacionService';

export interface PendingOrderRow {
  shopify: ShopifyOrderForBioma;
  emision: BiomaFacturaEmisionEntity | null;
}

export interface FacturaItemForSii {
  descripcion: string;
  cantidad: number;
  unidad?: string;
  precioUnitario: number;
  descuento?: number;
  subtotal: number;
}

/** Reads a custom attribute by key (case-insensitive) from a Shopify order. */
function attr(order: ShopifyOrderForBioma, key: string): string {
  return getOrderCustomAttribute(order.customAttributes, key);
}

/**
 * Normalises a Chilean phone number into a wa.me-friendly form (digits only,
 * country code included). Returns null if there is nothing usable.
 *
 * Examples:
 *   "+56 9 2181 6517" -> "56921816517"
 *   "9 2181 6517"     -> "56921816517"
 *   "921816517"       -> "56921816517"
 */
export function normalizePhoneForWhatsApp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let digits = raw.replace(/\D+/g, '');
  if (!digits) return null;
  if (digits.startsWith('56')) return digits;
  if (digits.length === 9) return `56${digits}`; // 9XXXXXXXX
  if (digits.length === 8) return `569${digits}`; // missing the leading 9
  if (digits.startsWith('0')) digits = digits.replace(/^0+/, '');
  return digits.startsWith('56') ? digits : `56${digits}`;
}

/** IVA Chile — precios Shopify B2C vienen con IVA incluido; el SII tipo 33 espera neto. */
const IVA_CHILE_FACTOR = 1.19;

function shopifyMontoANetoSii(montoBruto: number, tipoCodigo: number): number {
  if (montoBruto <= 0) return 0;
  if (tipoCodigo !== 33) return Math.round(montoBruto);
  return Math.round(montoBruto / IVA_CHILE_FACTOR);
}

export class BiomaFacturacionService {
  private static get repo() {
    return AppDataSource.getRepository(BiomaFacturaEmisionEntity);
  }

  private static get empresaRut(): string {
    const v = process.env.BIOMA_EMPRESA_RUT;
    if (!v) {
      throw new Error(
        'BIOMA_EMPRESA_RUT no configurado (RUT del emisor en SII, ej. 76123456-7)',
      );
    }
    return v;
  }

  /** Default Spanish unit text used in SII line items. */
  private static get defaultUnidad(): string {
    return process.env.BIOMA_DEFAULT_UNIDAD || 'UN';
  }

  /** Returns the existing emission row for a Shopify order id, if any. */
  static async findEmision(shopifyOrderId: string): Promise<BiomaFacturaEmisionEntity | null> {
    return this.repo.findOne({ where: { shopifyOrderId } });
  }

  /** Normaliza RUT para comparar en DB (sin puntos, guión ni espacios). */
  static normalizeRutKey(raw: string | null | undefined): string | null {
    if (!raw?.trim()) return null;
    return raw.replace(/\./g, '').replace(/-/g, '').replace(/\s/g, '').toLowerCase();
  }

  /**
   * Resolves how to open the SII emit form for a Shopify order.
   *
   *   1. `BIOMA_FACTURA_TEMPLATE_CODIGO` env (override manual / pruebas)
   *   2. Última factura emitida por Bioma al mismo RUT receptor
   *   3. Última factura syncada en `sii_facturas` al mismo RUT receptor
   *   4. Factura nueva vacía (`source: 'nueva'`, sin código plantilla)
   */
  static async resolveTemplateCodigo(opts?: {
    rutReceptor?: string | null;
    tipoCodigo?: number;
  }): Promise<string | null> {
    const info = await this.resolveTemplateInfo(opts);
    return info.codigo;
  }

  /** Metadata de plantilla o modo «factura nueva». */
  static async resolveTemplateInfo(opts?: {
    rutReceptor?: string | null;
    tipoCodigo?: number;
  }): Promise<{
    codigo: string | null;
    folio?: number | null;
    fecha?: string | null;
    templateCliente?: string | null;
    source?: 'env' | 'cliente_emision' | 'cliente_sii' | 'nueva';
  }> {
    const override = process.env.BIOMA_FACTURA_TEMPLATE_CODIGO?.trim();
    if (override) {
      return { codigo: override, source: 'env' };
    }

    const tipoCodigo = opts?.tipoCodigo ?? 33;

    if (isBoletaTipo(tipoCodigo)) {
      return {
        codigo: null,
        source: 'nueva',
        templateCliente: 'Boleta e-Boleta · consumidor final (eboleta.sii.cl)',
      };
    }

    const rutKey = this.normalizeRutKey(opts?.rutReceptor);

    if (rutKey) {
      const ourForClient = await this.repo
        .createQueryBuilder('e')
        .where('e.empresa_rut = :empresaRut', { empresaRut: this.empresaRut })
        .andWhere('e.status = :status', { status: 'emitted' })
        .andWhere('e.sii_codigo IS NOT NULL')
        .andWhere(
          `LOWER(REPLACE(REPLACE(REPLACE(COALESCE(e.rut_receptor, ''), '.', ''), '-', ''), ' ', '')) = :rutKey`,
          { rutKey },
        )
        .orderBy('e.emitted_at', 'DESC')
        .getOne();

      if (ourForClient?.siiCodigo) {
        return {
          codigo: ourForClient.siiCodigo,
          folio: ourForClient.siiFolio,
          templateCliente: ourForClient.razonSocial,
          source: 'cliente_emision',
        };
      }

      const siiRepo = AppDataSource.getRepository(SiiFacturaEntity);
      const siiForClient = await siiRepo
        .createQueryBuilder('f')
        .where('f.empresa_rut = :empresaRut', { empresaRut: this.empresaRut })
        .andWhere('f.tipo_codigo = :tipoCodigo', { tipoCodigo })
        .andWhere(
          `LOWER(REPLACE(REPLACE(REPLACE(COALESCE(f.rut_receptor, ''), '.', ''), '-', ''), ' ', '')) = :rutKey`,
          { rutKey },
        )
        .orderBy('f.fecha', 'DESC')
        .addOrderBy('f.folio', 'DESC')
        .getOne();

      if (siiForClient?.codigo) {
        return {
          codigo: siiForClient.codigo,
          folio: siiForClient.folio,
          fecha: siiForClient.fecha ? String(siiForClient.fecha) : null,
          templateCliente: siiForClient.razonSocial,
          source: 'cliente_sii',
        };
      }
    }

    return {
      codigo: null,
      source: 'nueva',
      templateCliente: opts?.rutReceptor ? 'Factura nueva (sin historial para este RUT)' : 'Factura nueva',
    };
  }

  static getEmpresaRutConfig(): string {
    return this.empresaRut;
  }

  /**
   * Lists pending Shopify orders (tagged `factura`, not yet emitted) joined
   * with any existing emission state in our DB.
   */
  static async listPending(opts: {
    pageSize?: number;
    after?: string | null;
  } = {}): Promise<{
    rows: PendingOrderRow[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  }> {
    const { orders, pageInfo } = await BiomaShopifyService.listPending({
      pageSize: opts.pageSize ?? 50,
      after: opts.after,
    });

    const ids = orders.map((o) => o.id);
    const existing = ids.length
      ? await this.repo
          .createQueryBuilder('e')
          .where('e.shopify_order_id IN (:...ids)', { ids })
          .getMany()
      : [];
    const byId = new Map(existing.map((e) => [e.shopifyOrderId, e]));

    const rows: PendingOrderRow[] = orders
      .filter((shopify) => orderNeedsFactura(shopify.customAttributes, shopify.note || shopify.customer?.note))
      .map((shopify) => ({
        shopify,
        emision: byId.get(shopify.id) ?? null,
      }))
      .filter((row) => row.emision?.status !== 'emitted');

    return { rows, pageInfo };
  }

  /**
   * Registra emisión histórica (ya facturada en SII fuera del módulo o duplicado evitado).
   */
  static async registerEmittedHistorica(
    shopifyOrderId: string,
    data: { siiFolio: number; siiCodigo?: string | null; tipoCodigo?: number },
  ): Promise<BiomaFacturaEmisionEntity> {
    const order = await BiomaShopifyService.getOrder(shopifyOrderId);
    if (!order) throw new Error('Pedido no encontrado en Shopify');
    const row = await this.upsertFromShopify(order);
    const tipo = data.tipoCodigo ?? row.tipoCodigo ?? 33;
    const updated = await this.setStatus(shopifyOrderId, 'emitted', {
      siiFolio: data.siiFolio,
      siiCodigo: data.siiCodigo ?? row.siiCodigo,
      tipoCodigo: tipo,
      emittedAt: row.emittedAt ?? new Date(),
      lastError: null,
    });
    if (!updated) throw new Error('No se pudo actualizar el registro');
    await BiomaShopifyService.markDteEmitted(shopifyOrderId, tipo, data.siiFolio);
    return updated;
  }

  /**
   * Importa pedidos B2C pagados (sin toggle/RUT factura) como boletas pendientes.
   * Cubre históricos y pedidos donde Flow etiquetó `factura` a todos.
   */
  static async syncBoletasFromShopify(opts: {
    maxPages?: number;
    daysBack?: number;
  } = {}): Promise<{
    scanned: number;
    registered: number;
    skipped: number;
  }> {
    let scanned = 0;
    let registered = 0;
    let skipped = 0;
    let after: string | null = null;
    const maxPages = opts.maxPages ?? 15;
    const daysBack = opts.daysBack ?? 14;

    for (let page = 0; page < maxPages; page++) {
      const { orders, pageInfo } = await BiomaShopifyService.listPaidOrders({
        pageSize: 50,
        after,
        daysBack,
      });
      if (!orders.length && !pageInfo.hasNextPage) break;

      for (const order of orders) {
        scanned++;
        if (orderNeedsFactura(order.customAttributes, order.note || order.customer?.note)) {
          skipped++;
          continue;
        }
        const existing = await BiomaFacturacionService.findEmision(order.id);
        if (existing?.tipoCodigo === 33 && existing.status !== 'emitted') {
          await BiomaFacturacionService.setTipoCodigo(order.id, 39);
        }
        const result = await BiomaShopifyService.registerBoletaOrder(order);
        if (result.tagged) registered++;
        else skipped++;
      }

      if (!pageInfo.hasNextPage) break;
      after = pageInfo.endCursor;
    }

    console.log(
      `[bioma] syncBoletas: scanned=${scanned} registered=${registered} skipped=${skipped}`,
    );
    return { scanned, registered, skipped };
  }

  /** Facturas/boletas ya emitidas (desde nuestra DB, no sync masivo SII avanzado). */
  static async listRealizadas(opts: {
    page?: number;
    pageSize?: number;
  } = {}): Promise<{
    rows: BiomaFacturaEmisionEntity[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 100);
    const page = Math.max(opts.page ?? 1, 1);
    const skip = (page - 1) * pageSize;

    const qb = this.repo
      .createQueryBuilder('e')
      .where('e.empresa_rut = :empresaRut', { empresaRut: this.empresaRut })
      .andWhere('e.status = :status', { status: 'emitted' })
      .orderBy('e.emitted_at', 'DESC', 'NULLS LAST')
      .addOrderBy('e.updated_at', 'DESC');

    const total = await qb.getCount();
    const rows = await qb.skip(skip).take(pageSize).getMany();
    return { rows, total, page, pageSize };
  }

  /** Boletas pendientes de emitir (tipo 39). Sincroniza desde Shopify si sync=true. */
  static async listBoletasPendientes(opts: {
    page?: number;
    pageSize?: number;
    sync?: boolean;
    maxSyncPages?: number;
    /** Solo pedidos desde hace N días (default 14 = «esta semana»). 0 = sin filtro fecha. */
    daysBack?: number;
  } = {}): Promise<{
    rows: BiomaFacturaEmisionEntity[];
    total: number;
    page: number;
    pageSize: number;
    syncStats?: { scanned: number; registered: number; skipped: number };
    daysBack?: number;
  }> {
    const daysBack = opts.daysBack ?? 14;
    let syncStats: { scanned: number; registered: number; skipped: number } | undefined;
    if (opts.sync !== false) {
      syncStats = await this.syncBoletasFromShopify({
        maxPages: opts.maxSyncPages ?? 15,
        daysBack: daysBack > 0 ? daysBack : 365,
      });
    }
    const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 100);
    const page = Math.max(opts.page ?? 1, 1);
    const skip = (page - 1) * pageSize;

    const qb = this.repo
      .createQueryBuilder('e')
      .where('e.empresa_rut = :empresaRut', { empresaRut: this.empresaRut })
      .andWhere('e.tipo_codigo IN (:...tipos)', { tipos: [39, 41] })
      .andWhere('e.status IN (:...statuses)', {
        statuses: ['pending', 'error', 'drafting', 'emitting'],
      });

    if (daysBack > 0) {
      const since = new Date();
      since.setDate(since.getDate() - daysBack);
      since.setHours(0, 0, 0, 0);
      qb.andWhere('e.shopify_processed_at >= :since', { since });
    }

    qb.orderBy('e.shopify_order_number', 'DESC', 'NULLS LAST')
      .addOrderBy('e.shopify_processed_at', 'DESC', 'NULLS LAST');

    const total = await qb.getCount();
    const rows = await qb.skip(skip).take(pageSize).getMany();
    return { rows, total, page, pageSize, syncStats, daysBack };
  }

  /**
   * Maps a Shopify order's line items into the SII items shape.
   * Each line collapses discount into the unit price so subtotal matches.
   * Para factura afecta (33), convierte precios Shopify (IVA incluido) a neto SII.
   */
  static buildItemsFromOrder(order: ShopifyOrderForBioma, tipoCodigo = 33): FacturaItemForSii[] {
    return order.lineItems.map((li) => {
      const cantidad = Math.max(1, Math.round(li.quantity || 1));
      const subtotalBruto = Math.round(li.netSubtotal);
      const subtotal = shopifyMontoANetoSii(subtotalBruto, tipoCodigo);
      const precioUnitario = cantidad ? Math.round(subtotal / cantidad) : subtotal;
      const descripcionParts = [li.title?.trim()].filter(Boolean) as string[];
      if (li.variantTitle && li.variantTitle !== 'Default Title') {
        descripcionParts.push(li.variantTitle);
      }
      return {
        descripcion: sanitizeDescripcionParaSii(descripcionParts.join(' - ')).slice(0, 80),
        cantidad,
        unidad: this.defaultUnidad,
        precioUnitario,
        descuento: 0,
        subtotal,
      };
    });
  }

  /**
   * Creates or refreshes the `bioma_factura_emisiones` row from the current
   * Shopify order state. Idempotent. Status is left as-is when present.
   */
  static async upsertFromShopify(
    order: ShopifyOrderForBioma,
  ): Promise<BiomaFacturaEmisionEntity> {
    const existing = await this.findEmision(order.id);
    const tipoCodigo = orderNeedsFactura(order.customAttributes, order.note || order.customer?.note) ? 33 : 39;
    const effectiveTipo = existing?.status === 'emitted' ? existing.tipoCodigo : tipoCodigo;
    const isBoleta = isBoletaTipo(effectiveTipo);
    const cf = isBoleta ? eboletaReceptorForSii() : boletaReceptorForSii();

    const noteData = parseCustomerNote(order.note || order.customer?.note || '');
    const shippingPhone = order.shippingAddress?.phone ?? null;
    const customerPhone = normalizePhoneForWhatsApp(
      shippingPhone || order.customer?.phone || null,
    );
    const customerName =
      [order.customer?.firstName, order.customer?.lastName].filter(Boolean).join(' ').trim() ||
      order.shippingAddress?.name ||
      null;

    const data: Partial<BiomaFacturaEmisionEntity> = {
      shopifyOrderId: order.id,
      shopifyOrderName: order.name,
      shopifyOrderNumber: order.orderNumber,
      shopifyProcessedAt: order.processedAt ? new Date(order.processedAt) : null,
      empresaRut: this.empresaRut,
      rutReceptor: isBoleta ? cf.rut : attr(order, BIOMA_FACTURA_ATTR.rut) || noteData.rut || null,
      razonSocial: isBoleta
        ? cf.razonSocial
        : attr(order, BIOMA_FACTURA_ATTR.razon) || noteData.razon || null,
      giroReceptor: isBoleta ? null : attr(order, BIOMA_FACTURA_ATTR.giro) || noteData.giro || null,
      comunaReceptor: isBoleta ? null : order.shippingAddress?.city || null,
      ciudadReceptor: isBoleta ? null : order.shippingAddress?.province || null,
      dirReceptor: isBoleta ? null : order.shippingAddress?.address1 || null,
      customerPhone,
      customerName,
      customerEmail: order.customer?.email || null,
      items: this.buildItemsFromOrder(order, effectiveTipo).map((it) => ({
        descripcion: it.descripcion,
        cantidad: it.cantidad,
        precioUnitario: it.precioUnitario,
        subtotal: it.subtotal,
      })),
      tipoCodigo: effectiveTipo,
    };

    if (existing) {
      Object.assign(existing, data);
      return this.repo.save(existing);
    }
    const created = this.repo.create({ ...data, status: 'pending' });
    return this.repo.save(created);
  }

  static async setTipoCodigo(shopifyOrderId: string, tipoCodigo: number): Promise<void> {
    const row = await this.findEmision(shopifyOrderId);
    if (!row || row.status === 'emitted') return;
    row.tipoCodigo = tipoCodigo;
    await this.repo.save(row);
  }

  static async setStatus(
    shopifyOrderId: string,
    status: BiomaFacturaStatus,
    extra: Partial<BiomaFacturaEmisionEntity> = {},
  ): Promise<BiomaFacturaEmisionEntity | null> {
    const row = await this.findEmision(shopifyOrderId);
    if (!row) return null;
    row.status = status;
    Object.assign(row, extra);
    return this.repo.save(row);
  }

  /** Mark `whatsappSentAt` once the user opens the wa.me link. */
  static async markWhatsAppSent(
    shopifyOrderId: string,
  ): Promise<BiomaFacturaEmisionEntity | null> {
    const row = await this.findEmision(shopifyOrderId);
    if (!row) return null;
    row.whatsappSentAt = new Date();
    return this.repo.save(row);
  }

  /** Build the wa.me URL and message for a given emission row. */
  static buildWhatsAppLink(row: BiomaFacturaEmisionEntity): {
    url: string | null;
    text: string;
    phone: string | null;
  } {
    const defaultMsg =
      process.env.BIOMA_WHATSAPP_MESSAGE_TEMPLATE ||
      'Hola {nombre}, te enviamos tu factura electrónica por el pedido {numero}. ☕ Cualquier consulta nos avisas. — Bioma Coffee Roasters';
    const nombre = row.customerName?.split(' ')[0] || 'cliente';
    const numero = row.shopifyOrderName || (row.shopifyOrderNumber ? `#${row.shopifyOrderNumber}` : '');
    const text = defaultMsg.replace('{nombre}', nombre).replace('{numero}', numero);
    const phone = row.customerPhone;
    const url = phone ? `https://wa.me/${phone}?text=${encodeURIComponent(text)}` : null;
    return { url, text, phone };
  }
}
