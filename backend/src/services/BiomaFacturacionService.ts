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
  extractFacturaFieldsFromOrder,
  orderNeedsFactura,
  orderWantsFacturaEmit,
  orderHasFacturaPendienteTag,
  isBoletaTipo,
  eboletaReceptorForSii,
} from '../utils/biomaOrderAttrs';
import {
  computeDescuentoGlobalFromOrder,
  computeMontosValidacion,
  shopifyMontoANetoSii,
  type DescuentoGlobalSii,
  type MontosValidacion,
} from '../utils/biomaMontos';
import { buildTituloCompletoLineaShopify, formatGlosaFacturaSii } from '../utils/biomaGlosas';
import { sanitizeDescripcionParaSii, SiiFacturacionService } from './SiiFacturacionService';

export type { DescuentoGlobalSii, MontosValidacion };

export interface PendingOrderRow {
  shopify: ShopifyOrderForBioma;
  emision: BiomaFacturaEmisionEntity | null;
}

export interface FacturaItemForSii {
  descripcion: string;
  /** Texto largo para checkbox «Descripción» del SII (EFXP_DSC_ITEM_*). */
  descripcionExtendida?: string;
  cantidad: number;
  unidad?: string;
  precioUnitario: number;
  descuento?: number;
  subtotal: number;
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
   * with any existing emission state in our DB. Incluye re-emisiones tras NC
   * y filas pending en DB aunque Shopify haya perdido el tag.
   */
  static async listPending(opts: {
    pageSize?: number;
    after?: string | null;
    maxPages?: number;
  } = {}): Promise<{
    rows: PendingOrderRow[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  }> {
    const pageSize = Math.min(Math.max(opts.pageSize ?? 100, 1), 250);
    const maxPages = Math.min(Math.max(opts.maxPages ?? 5, 1), 10);
    const rowsMap = new Map<string, PendingOrderRow>();

    let after: string | null = opts.after ?? null;
    let lastPageInfo: { hasNextPage: boolean; endCursor: string | null } = {
      hasNextPage: false,
      endCursor: null,
    };

    for (let page = 0; page < maxPages; page++) {
      const { orders, pageInfo } = await BiomaShopifyService.listPending({
        pageSize,
        after,
      });
      lastPageInfo = pageInfo;

      for (const shopify of orders) {
        if (!orderWantsFacturaEmit(shopify)) continue;
        const emision = await this.upsertFromShopify(shopify);
        if (emision.status === 'emitted' || emision.status === 'dismissed') continue;
        await this.ensureFacturaTag(shopify);
        rowsMap.set(shopify.id, { shopify, emision });
      }

      if (!pageInfo.hasNextPage) break;
      after = pageInfo.endCursor;
    }

    const dbPending = await this.repo
      .createQueryBuilder('e')
      .where('e.empresa_rut = :empresaRut', { empresaRut: this.empresaRut })
      .andWhere('e.tipo_codigo = :tipo', { tipo: 33 })
      .andWhere('e.status IN (:...statuses)', {
        statuses: ['pending', 'error', 'drafting', 'emitting'],
      })
      .orderBy('e.shopify_order_number', 'DESC', 'NULLS LAST')
      .getMany();

    for (const emision of dbPending) {
      if (rowsMap.has(emision.shopifyOrderId)) continue;
      const order = await BiomaShopifyService.getOrder(emision.shopifyOrderId);
      if (!order) continue;
      const refreshed = await this.upsertFromShopify(order);
      if (refreshed.status === 'emitted' || refreshed.status === 'dismissed') continue;
      if (!orderWantsFacturaEmit(order) && refreshed.tipoCodigo !== 33) continue;
      await this.ensureFacturaTag(order);
      rowsMap.set(order.id, { shopify: order, emision: refreshed });
    }

    const rows = [...rowsMap.values()].sort((a, b) => {
      const na = a.shopify.orderNumber ?? 0;
      const nb = b.shopify.orderNumber ?? 0;
      return nb - na;
    });

    return { rows, pageInfo: lastPageInfo };
  }

  private static async ensureFacturaTag(order: ShopifyOrderForBioma): Promise<void> {
    if (orderHasFacturaPendienteTag(order.tags)) return;
    await BiomaShopifyService.addTags(order.id, ['factura']).catch(() => {});
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
    let folio = data.siiFolio;

    if (data.siiCodigo) {
      try {
        const rut = this.getEmpresaRutConfig();
        const sessionId = await SiiFacturacionService.createSession(rut);
        const session = SiiFacturacionService.getSession(sessionId);
        if (session?.axiosClient) {
          const resolved = await SiiFacturacionService.resolveFolioForCodigo(
            session.axiosClient,
            String(data.siiCodigo),
            tipo,
          );
          if (resolved && resolved > 0) folio = resolved;
        }
      } catch (e: any) {
        console.warn('[bioma] registerEmittedHistorica resolve folio:', e?.message || e);
      }
    }

    const updated = await this.setStatus(shopifyOrderId, 'emitted', {
      siiFolio: folio,
      siiCodigo: data.siiCodigo ?? row.siiCodigo,
      tipoCodigo: tipo,
      emittedAt: row.emittedAt ?? new Date(),
      lastError: null,
    });
    if (!updated) throw new Error('No se pudo actualizar el registro');
    await BiomaShopifyService.markDteEmitted(shopifyOrderId, tipo, folio);
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
        if (orderWantsFacturaEmit(order)) {
          skipped++;
          continue;
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
      qb.andWhere('(e.shopify_processed_at IS NULL OR e.shopify_processed_at >= :since)', {
        since,
      });
    }

    qb.orderBy('e.shopify_order_number', 'DESC', 'NULLS LAST')
      .addOrderBy('e.shopify_processed_at', 'DESC', 'NULLS LAST');

    const total = await qb.getCount();
    const rows = await qb.skip(skip).take(pageSize).getMany();
    return { rows, total, page, pageSize, syncStats, daysBack };
  }

  /**
   * Maps a Shopify order's line items into the SII items shape (precio neto por línea).
   * Descuentos a nivel pedido van al campo «Descuento global» del formulario MiPyme.
   */
  static buildItemsFromOrder(
    order: ShopifyOrderForBioma,
    tipoCodigo = 33,
  ): FacturaItemForSii[] {
    const items: FacturaItemForSii[] = order.lineItems.map((li) => {
      const cantidad = Math.max(1, Math.round(li.quantity || 1));
      const lineNetBruto = Math.round(li.netSubtotal);
      const lineDiscBruto = Math.round(li.totalDiscountAmount || 0);
      let subtotalBruto = lineNetBruto + lineDiscBruto;
      if (subtotalBruto <= lineNetBruto && li.originalUnitPriceAmount > 0) {
        subtotalBruto = Math.round(li.originalUnitPriceAmount) * cantidad;
      }
      const subtotal = shopifyMontoANetoSii(subtotalBruto, tipoCodigo);
      const precioUnitario = Math.max(
        1,
        cantidad ? Math.round(subtotal / cantidad) : Math.max(1, subtotal),
      );
      const descripcion = sanitizeDescripcionParaSii(
        formatGlosaFacturaSii(li.title, li.variantTitle),
      );
      const tituloCompleto = sanitizeDescripcionParaSii(
        buildTituloCompletoLineaShopify(li.title, li.variantTitle),
      );
      const descripcionExtendida =
        tituloCompleto.length > descripcion.length &&
        tituloCompleto.toUpperCase() !== descripcion.toUpperCase()
          ? tituloCompleto
          : undefined;
      return {
        descripcion,
        descripcionExtendida,
        cantidad,
        unidad: this.defaultUnidad,
        precioUnitario,
        descuento: 0,
        subtotal: precioUnitario * cantidad,
      };
    });

    const shippingBruto = Math.round(order.shippingTotal || 0);
    if (shippingBruto > 0) {
      const shippingNeto = shopifyMontoANetoSii(shippingBruto, tipoCodigo);
      items.push({
        descripcion: sanitizeDescripcionParaSii('DESPACHO ENVIO'),
        cantidad: 1,
        unidad: this.defaultUnidad,
        precioUnitario: Math.max(1, shippingNeto),
        descuento: 0,
        subtotal: Math.max(1, shippingNeto),
      });
    }

    return items;
  }

  /** Descuento global SII cuando el total Shopify es menor que la suma de líneas netas. */
  static buildDescuentoGlobal(
    order: ShopifyOrderForBioma,
    items: FacturaItemForSii[],
    tipoCodigo = 33,
  ): DescuentoGlobalSii | null {
    return computeDescuentoGlobalFromOrder(order, items, tipoCodigo);
  }

  /** Compara totales factura vs Shopify para preview y bloqueo de emisión. */
  static validateMontos(
    order: ShopifyOrderForBioma,
    items: FacturaItemForSii[],
    tipoCodigo = 33,
    descuentoGlobal?: DescuentoGlobalSii | null,
  ): MontosValidacion {
    return computeMontosValidacion(order, items, tipoCodigo, {
      descuentoGlobalNeto: descuentoGlobal?.montoNeto,
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
    if (existing?.status === 'dismissed') return existing;

    // Tag `factura` en Shopify = pendiente de emitir (incl. re-emisión tras NC)
    if (existing?.status === 'emitted' && orderHasFacturaPendienteTag(order.tags)) {
      existing.status = 'pending';
      existing.siiFolio = null;
      existing.siiCodigo = null;
      existing.siiTrackId = null;
      existing.emittedAt = null;
      existing.pdfPublicUrl = null;
      existing.lastError = null;
      await this.repo.save(existing);
    }

    const wantsFactura = orderWantsFacturaEmit(order);
    const facturaFields = extractFacturaFieldsFromOrder(order);

    let tipoCodigo: number;
    if (existing?.status === 'emitted') {
      tipoCodigo = existing.tipoCodigo ?? 33;
    } else if (wantsFactura) {
      tipoCodigo = 33;
    } else {
      tipoCodigo = existing?.tipoCodigo ?? 39;
    }

    const isBoleta = isBoletaTipo(tipoCodigo);
    const cf = isBoleta ? eboletaReceptorForSii() : null;

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
      rutReceptor: isBoleta ? cf!.rut : facturaFields.rut,
      razonSocial: isBoleta ? cf!.razonSocial : facturaFields.razon,
      giroReceptor: isBoleta ? null : facturaFields.giro,
      comunaReceptor: isBoleta ? null : order.shippingAddress?.city || null,
      ciudadReceptor: isBoleta ? null : order.shippingAddress?.province || null,
      dirReceptor: isBoleta ? null : order.shippingAddress?.address1 || null,
      customerPhone,
      customerName,
      customerEmail: order.customer?.email || null,
      items: this.buildItemsFromOrder(order, tipoCodigo).map((it) => ({
        descripcion: it.descripcion,
        cantidad: it.cantidad,
        precioUnitario: it.precioUnitario,
        subtotal: it.subtotal,
      })),
      tipoCodigo,
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

  /** Quita un pedido de facturas pendientes (ya facturado fuera del módulo, duplicado, etc.). */
  static async dismissPending(
    shopifyOrderId: string,
    opts: { removeShopifyTag?: boolean } = {},
  ): Promise<BiomaFacturaEmisionEntity> {
    let row = await this.findEmision(shopifyOrderId);
    if (!row) {
      const order = await BiomaShopifyService.getOrder(shopifyOrderId);
      if (!order) throw new Error('Pedido no encontrado en Shopify');
      row = await this.upsertFromShopify(order);
    }
    const updated = await this.setStatus(shopifyOrderId, 'dismissed', { lastError: null });
    if (!updated) throw new Error('No se pudo descartar el pedido');
    if (opts.removeShopifyTag !== false) {
      await BiomaShopifyService.removeTags(shopifyOrderId, ['factura']).catch(() => {});
    }
    return updated;
  }

  /**
   * Devuelve un pedido emitido a facturas pendientes para re-emitir tras NC manual en MiPyme.
   * No emite la NC — solo prepara Shopify + DB.
   */
  static async prepararReemisionNotaCredito(
    shopifyOrderId: string,
  ): Promise<{
    row: BiomaFacturaEmisionEntity;
    avisoNc: string;
    folioAnterior: number | null;
  }> {
    const row = await this.findEmision(shopifyOrderId);
    if (!row) throw new Error('Sin registro de emisión');
    if (row.status !== 'emitted') {
      throw new Error('Solo aplica a documentos ya emitidos (pestaña Realizadas)');
    }
    const tipo = row.tipoCodigo ?? 33;
    if (isBoletaTipo(tipo)) {
      throw new Error('Nota de crédito manual aplica a facturas (MiPyme), no boletas e-Boleta');
    }

    const folioAnterior = row.siiFolio;
    await BiomaShopifyService.revertFacturaForNotaCredito(shopifyOrderId, folioAnterior);

    await this.setStatus(shopifyOrderId, 'pending', {
      siiFolio: null,
      siiCodigo: null,
      siiTrackId: null,
      emittedAt: null,
      pdfPublicUrl: null,
      tipoCodigo: 33,
      lastError: null,
    });

    const order = await BiomaShopifyService.getOrder(shopifyOrderId);
    if (!order) throw new Error('Pedido no encontrado en Shopify');
    const updated = await this.upsertFromShopify(order);

    const avisoNc = folioAnterior
      ? `Aviso: si corresponde, emite la nota de crédito en MiPyme (SII) anulando la factura folio ${folioAnterior}. El pedido ya está en Facturas pendientes para re-emitir.`
      : 'Aviso: si corresponde, emite la nota de crédito en MiPyme (SII). El pedido ya está en Facturas pendientes para re-emitir.';

    return { row: updated, avisoNc, folioAnterior };
  }

  /** Quita aviso NC guardado en lastError (legacy) — no bloquea re-emisión. */
  static async clearNcAvisoEmision(shopifyOrderId: string): Promise<void> {
    const row = await this.findEmision(shopifyOrderId);
    if (!row?.lastError) return;
    const t = row.lastError.toLowerCase();
    if (!t.includes('nota de crédito') && !t.includes('nota de credito') && !t.includes('nc pendiente')) {
      return;
    }
    await this.setStatus(shopifyOrderId, row.status, { lastError: null });
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

  /** URL pública del PDF (e-Boleta o enlace al backend si hay código SII). */
  static pdfLinkForRow(row: BiomaFacturaEmisionEntity): string | null {
    if (row.pdfPublicUrl) return row.pdfPublicUrl;
    const base = BiomaFacturacionService.publicBaseUrl();
    if (!base || !row.siiCodigo) return null;
    return `${base}/api/bioma/pdf/${encodeURIComponent(row.shopifyOrderId)}`;
  }

  private static publicBaseUrl(): string | null {
    const raw =
      process.env.BIOMA_PUBLIC_URL ||
      process.env.PUBLIC_APP_URL ||
      process.env.RAILWAY_PUBLIC_DOMAIN;
    if (!raw) return null;
    const trimmed = raw.replace(/\/$/, '');
    return trimmed.startsWith('http') ? trimmed : `https://${trimmed}`;
  }

  private static customerMessageContext(row: BiomaFacturaEmisionEntity): {
    nombre: string;
    numero: string;
    folio: string;
    dte: string;
    dteCapitalized: string;
    pdfUrl: string | null;
  } {
    const nombre =
      row.customerName?.split(/\s+/)[0] ||
      row.razonSocial?.split(/\s+/)[0] ||
      'cliente';
    const numero =
      row.shopifyOrderName ||
      (row.shopifyOrderNumber != null ? `#${row.shopifyOrderNumber}` : 'tu pedido');
    const folio = row.siiFolio != null ? String(row.siiFolio) : '';
    const boleta = isBoletaTipo(row.tipoCodigo);
    const dte = boleta ? 'boleta' : 'factura';
    const dteCapitalized = boleta ? 'Boleta' : 'Factura';
    const pdfUrl = BiomaFacturacionService.pdfLinkForRow(row);
    return { nombre, numero, folio, dte, dteCapitalized, pdfUrl };
  }

  private static applyMessageTemplate(
    template: string,
    ctx: ReturnType<typeof BiomaFacturacionService.customerMessageContext>,
  ): string {
    const folioPart = ctx.folio ? ` (folio ${ctx.folio})` : '';
    const pdfPart = ctx.pdfUrl
      ? `\n\nDescargar PDF: ${ctx.pdfUrl}`
      : '\n\nAdjunta el PDF desde el módulo de facturación si el cliente lo necesita.';
    return template
      .replace(/\{nombre\}/g, ctx.nombre)
      .replace(/\{numero\}/g, ctx.numero)
      .replace(/\{folio\}/g, ctx.folio)
      .replace(/\{folio_part\}/g, folioPart)
      .replace(/\{dte\}/g, ctx.dte)
      .replace(/\{pdf_url\}/g, ctx.pdfUrl || '')
      .replace(/\{pdf_part\}/g, pdfPart);
  }

  /** Build the wa.me URL and message for a given emission row. */
  static buildWhatsAppLink(row: BiomaFacturaEmisionEntity): {
    url: string | null;
    text: string;
    phone: string | null;
  } {
    const ctx = BiomaFacturacionService.customerMessageContext(row);
    const defaultMsg =
      process.env.BIOMA_WHATSAPP_MESSAGE_TEMPLATE ||
      'Hola {nombre}, te enviamos tu {dte} electrónica del pedido {numero}{folio_part}.{pdf_part}\n\n☕ Cualquier consulta nos avisas.\n— Bioma Coffee Roasters';
    const text = BiomaFacturacionService.applyMessageTemplate(defaultMsg, ctx);
    const phone = row.customerPhone;
    const url = phone ? `https://wa.me/${phone}?text=${encodeURIComponent(text)}` : null;
    return { url, text, phone };
  }

  /** Abre el cliente de correo en modo borrador (mailto). */
  static buildEmailDraft(row: BiomaFacturaEmisionEntity): {
    url: string | null;
    to: string | null;
    subject: string;
    body: string;
  } {
    const ctx = BiomaFacturacionService.customerMessageContext(row);
    const to = row.customerEmail?.trim() || null;
    const folioPart = ctx.folio ? ` — folio ${ctx.folio}` : '';
    const subjectTemplate =
      process.env.BIOMA_EMAIL_SUBJECT_TEMPLATE ||
      '{dte_capitalized} pedido {numero}{folio_part} — Bioma Coffee Roasters';
    const subject = subjectTemplate
      .replace(/\{numero\}/g, ctx.numero)
      .replace(/\{folio\}/g, ctx.folio)
      .replace(/\{folio_part\}/g, folioPart)
      .replace(/\{dte\}/g, ctx.dte)
      .replace(/\{dte_capitalized\}/g, ctx.dteCapitalized);

    const bodyTemplate =
      process.env.BIOMA_EMAIL_BODY_TEMPLATE ||
      'Hola {nombre},\n\nTe enviamos la {dte} electrónica de tu pedido {numero}{folio_part}.{pdf_part}\n\nCualquier consulta nos avisas.\n\nSaludos,\nBioma Coffee Roasters';
    const body = BiomaFacturacionService.applyMessageTemplate(bodyTemplate, ctx);

    if (!to) return { url: null, to: null, subject, body };

    const params = new URLSearchParams();
    params.set('subject', subject);
    params.set('body', body);
    const url = `mailto:${to}?${params.toString()}`;
    return { url, to, subject, body };
  }
}
