import type { FacturaEmitPreviewData, MontosValidacionPreview } from '../components/FacturaEmitPreview';

export const FACTURA_DRAFT_KEY = (orderId: string) => `bioma_factura_draft_v2_${orderId}`;

export type FacturaEditDraft = FacturaEmitPreviewData;

const IVA_CHILE_FACTOR = 1.19;

function shopifyMontoANetoSii(montoBruto: number, tipoCodigo: number): number {
  if (montoBruto <= 0) return 0;
  if (tipoCodigo !== 33) return Math.round(montoBruto);
  return Math.round(montoBruto / IVA_CHILE_FACTOR);
}

export interface TotalesFacturaPreview {
  montoNeto: number;
  descuentoGlobalNeto: number;
  descuentoGlobalPct: number;
  netoImponible: number;
  iva: number;
  total: number;
  showDescuentoGlobal: boolean;
}

/** Cuadra neto, descuento global e IVA para que el total = total Shopify. */
function cuadrarFacturaConShopify(
  subtotalLineasNeto: number,
  shopifyTotalBruto: number,
  tipoCodigo = 33,
) {
  const total = Math.round(shopifyTotalBruto);
  const netoImponible = shopifyMontoANetoSii(total, tipoCodigo);
  const descuentoGlobalNeto = Math.max(0, subtotalLineasNeto - netoImponible);
  const iva = tipoCodigo === 33 ? total - netoImponible : 0;
  const descuentoGlobalPct =
    subtotalLineasNeto > 0 && descuentoGlobalNeto > 0
      ? Math.round((descuentoGlobalNeto / subtotalLineasNeto) * 10000) / 100
      : 0;
  return {
    montoNeto: subtotalLineasNeto,
    descuentoGlobalNeto,
    descuentoGlobalPct,
    netoImponible,
    iva,
    total,
    showDescuentoGlobal: descuentoGlobalNeto > 0,
  };
}

/** Totales SII: monto neto (líneas) → descuento global → IVA → total. */
export function computeTotalesFacturaPreview(
  items: Array<{ cantidad: number; precioUnitario: number }>,
  opts: {
    shopifyTotal: number;
    totalDiscounts?: number;
    descuentoGlobal?: { montoNeto: number; porcentaje?: number } | null;
    tipoCodigo?: number;
  },
): TotalesFacturaPreview {
  const tipoCodigo = opts.tipoCodigo ?? 33;
  const subtotalLineas = items.reduce((s, it) => s + (it.cantidad || 0) * (it.precioUnitario || 0), 0);
  return cuadrarFacturaConShopify(subtotalLineas, Math.round(opts.shopifyTotal || 0), tipoCodigo);
}

export function payloadToDraft(payload: FacturaEmitPreviewData): FacturaEditDraft {
  return {
    rutReceptor: payload.rutReceptor ?? '',
    razonSocial: payload.razonSocial ?? '',
    giroReceptor: payload.giroReceptor ?? '',
    comunaReceptor: payload.comunaReceptor ?? '',
    ciudadReceptor: payload.ciudadReceptor ?? '',
    dirReceptor: payload.dirReceptor ?? '',
    fechaEmision: payload.fechaEmision || new Date().toISOString().split('T')[0],
    tipoCodigo: payload.tipoCodigo ?? 33,
    descuentoGlobal: payload.descuentoGlobal ?? null,
    items: payload.items.map((it) => ({
      ...it,
      subtotal: Math.round((it.cantidad || 1) * (it.precioUnitario || 0)),
    })),
    useDescripcionExtendida: payload.useDescripcionExtendida ?? false,
    formaPago: payload.formaPago ?? 'contado',
  };
}

export function normalizeDraftItems(
  items: FacturaEditDraft['items'],
): FacturaEditDraft['items'] {
  return items.map((it, i) => {
    const cantidad = Math.max(1, Math.round(Number(it.cantidad) || 1));
    const precioUnitario = Math.max(1, Math.round(Number(it.precioUnitario) || 1));
    return {
      numero: i + 1,
      descripcion: String(it.descripcion || '').trim() || `Ítem ${i + 1}`,
      tituloExtendido: it.tituloExtendido,
      descripcionExtendida: it.descripcionExtendida,
      cantidad,
      precioUnitario,
      subtotal: cantidad * precioUnitario,
    };
  });
}

export interface DescuentoGlobalPreview {
  montoNeto: number;
  porcentaje: number;
  glosa: string;
  /** Subtotal neto de líneas antes del descuento global (precio lista). */
  subtotalLista: number;
}

/** Descuento global SII para preview / emisión. */
export function resolveDescuentoGlobalPreview(
  items: FacturaEditDraft['items'],
  shopifyTotal: number,
  tipoCodigo: number,
  opts?: { glosa?: string; totalDiscounts?: number },
): DescuentoGlobalPreview | null {
  if (tipoCodigo !== 33 || !shopifyTotal || items.length === 0) return null;

  const subtotalLineas = items.reduce((s, it) => s + (it.cantidad || 0) * (it.precioUnitario || 0), 0);
  const cuadrado = cuadrarFacturaConShopify(subtotalLineas, Math.round(shopifyTotal), tipoCodigo);
  if (cuadrado.descuentoGlobalNeto <= 0) return null;

  return {
    montoNeto: cuadrado.descuentoGlobalNeto,
    porcentaje: cuadrado.descuentoGlobalPct,
    subtotalLista: cuadrado.montoNeto,
    glosa: opts?.glosa || 'Descuento pedido',
  };
}

export function computeDescuentoGlobalPreview(
  items: FacturaEditDraft['items'],
  shopifyTotal: number,
  tipoCodigo: number,
  opts?: { glosa?: string; totalDiscounts?: number },
): FacturaEditDraft['descuentoGlobal'] {
  const dr = resolveDescuentoGlobalPreview(items, shopifyTotal, tipoCodigo, opts);
  if (!dr) return null;
  return { montoNeto: dr.montoNeto, porcentaje: dr.porcentaje, glosa: dr.glosa };
}

export function computePreviewMontos(
  items: FacturaEditDraft['items'],
  tipoCodigo: number,
  shopifyTotal: number,
  opts?: {
    descuentoGlobal?: FacturaEditDraft['descuentoGlobal'];
    tolerancia?: number;
    totalDiscounts?: number;
  },
): MontosValidacionPreview {
  const totales = computeTotalesFacturaPreview(items, {
    shopifyTotal,
    totalDiscounts: opts?.totalDiscounts,
    descuentoGlobal: opts?.descuentoGlobal,
    tipoCodigo,
  });

  const tolerancia = opts?.tolerancia ?? 2;
  const diff = totales.total - shopifyTotal;
  const issues: string[] = [];

  if (Math.abs(diff) > tolerancia) {
    issues.push(
      `Total factura (${totales.total}) ≠ Shopify (${shopifyTotal}). Diferencia ${diff > 0 ? '+' : ''}${diff}.`,
    );
  }
  if (totales.descuentoGlobalNeto > 0) {
    issues.push(
      `Descuento global SII: $${totales.descuentoGlobalNeto.toLocaleString('es-CL')} neto (${totales.descuentoGlobalPct}%).`,
    );
  }

  return {
    ok: Math.abs(diff) <= tolerancia,
    diff,
    shopify: {
      total: shopifyTotal,
      shipping: 0,
      totalDiscounts: Math.round(opts?.totalDiscounts ?? 0),
      lineDiscounts: 0,
    },
    factura: {
      neto: totales.netoImponible,
      iva: totales.iva,
      total: totales.total,
      subtotalLineas: totales.montoNeto,
      descuentoGlobalNeto: totales.descuentoGlobalNeto,
      descuentoGlobalPct: totales.descuentoGlobalPct,
    },
    issues,
  };
}
