import type { ShopifyOrderForBioma } from '../services/BiomaShopifyService';

/** IVA Chile — precios Shopify B2C vienen con IVA incluido; el SII tipo 33 espera neto. */
export const IVA_CHILE_FACTOR = 1.19;

/** Tolerancia en pesos chilenos por redondeo línea a línea. */
export const MONTOS_TOLERANCIA_CLP = 2;

export function shopifyMontoANetoSii(montoBruto: number, tipoCodigo: number): number {
  if (montoBruto <= 0) return 0;
  if (tipoCodigo !== 33) return Math.round(montoBruto);
  return Math.round(montoBruto / IVA_CHILE_FACTOR);
}

/** Cuadra neto, descuento global e IVA para que el total = total Shopify (sin drift de redondeo). */
export function cuadrarFacturaConShopify(
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
    subtotalLineas: subtotalLineasNeto,
    descuentoGlobalNeto,
    descuentoGlobalPct,
    netoImponible,
    iva,
    total,
  };
}

export interface DescuentoGlobalSii {
  /** Monto neto del descuento (CLP, sin IVA). */
  montoNeto: number;
  /** Porcentaje sobre subtotal neto de líneas (MiPyme acepta % en descuento global). */
  porcentaje: number;
  glosa: string;
}

/** Descuento a nivel pedido Shopify → campo «Descuento global» del formulario SII. */
export function computeDescuentoGlobalFromOrder(
  order: ShopifyOrderForBioma,
  items: FacturaItemMontos[],
  tipoCodigo = 33,
): DescuentoGlobalSii | null {
  if (tipoCodigo !== 33 || items.length === 0 || !order.total) return null;

  const subtotalLineas = items.reduce((s, it) => s + (it.subtotal || 0), 0);
  const cuadrado = cuadrarFacturaConShopify(subtotalLineas, Math.round(order.total), tipoCodigo);
  if (cuadrado.descuentoGlobalNeto <= 0) return null;

  return {
    montoNeto: cuadrado.descuentoGlobalNeto,
    porcentaje: cuadrado.descuentoGlobalPct,
    glosa: `Descuento pedido ${order.name}`,
  };
}

export function netoSiiATotalBruto(neto: number, tipoCodigo: number): number {
  if (neto <= 0) return 0;
  if (tipoCodigo !== 33) return Math.round(neto);
  return Math.round(neto * IVA_CHILE_FACTOR);
}

export interface MontosValidacion {
  ok: boolean;
  diff: number;
  tolerancia: number;
  shopify: {
    total: number;
    subtotal: number;
    tax: number;
    shipping: number;
    totalDiscounts: number;
    lineItemsBruto: number;
    lineDiscounts: number;
  };
  factura: {
    neto: number;
    iva: number;
    total: number;
    subtotalLineas?: number;
    descuentoGlobalNeto?: number;
    descuentoGlobalPct?: number;
  };
  ajusteNeto: number;
  issues: string[];
}

export interface FacturaItemMontos {
  descripcion: string;
  subtotal: number;
}

export function computeMontosValidacion(
  order: ShopifyOrderForBioma,
  items: FacturaItemMontos[],
  tipoCodigo = 33,
  opts?: { ajusteNeto?: number; descuentoGlobalNeto?: number },
): MontosValidacion {
  const shopifyTotal = Math.round(order.total || 0);
  const lineItemsBruto = order.lineItems.reduce((s, li) => s + Math.round(li.netSubtotal || 0), 0);
  const lineDiscounts = order.lineItems.reduce(
    (s, li) => s + Math.round(li.totalDiscountAmount || 0),
    0,
  );

  const subtotalLineas = items.reduce((s, it) => s + (it.subtotal || 0), 0);
  const cuadrado = cuadrarFacturaConShopify(subtotalLineas, shopifyTotal, tipoCodigo);
  const neto = cuadrado.netoImponible;
  const iva = cuadrado.iva;
  const facturaTotal = cuadrado.total;
  const descuentoGlobalNeto = cuadrado.descuentoGlobalNeto;
  const subtotalLista = cuadrado.subtotalLineas;
  const diff = facturaTotal - shopifyTotal;
  const tolerancia = MONTOS_TOLERANCIA_CLP;
  const ok = Math.abs(diff) <= tolerancia;

  const issues: string[] = [];
  if (!ok) {
    issues.push(
      `Total factura (${facturaTotal.toLocaleString('es-CL')}) ≠ total Shopify (${shopifyTotal.toLocaleString('es-CL')}). Diferencia: ${diff > 0 ? '+' : ''}${diff.toLocaleString('es-CL')}.`,
    );
  }

  const subtotalShopify = Math.round(order.totalNet || 0);
  if (subtotalShopify > 0 && Math.abs(lineItemsBruto - subtotalShopify) > tolerancia) {
    issues.push(
      `Suma líneas Shopify (${lineItemsBruto.toLocaleString('es-CL')}) ≠ subtotal pedido (${subtotalShopify.toLocaleString('es-CL')}). Puede haber descuento a nivel pedido.`,
    );
  }

  if (descuentoGlobalNeto > 0) {
    issues.push(
      `Descuento global SII: $${descuentoGlobalNeto.toLocaleString('es-CL')} neto (sobre subtotal $${subtotalLista.toLocaleString('es-CL')}).`,
    );
  } else if (Math.round(order.totalDiscounts || 0) > 0) {
    issues.push(
      `Descuento total en Shopify: $${Math.round(order.totalDiscounts).toLocaleString('es-CL')}.`,
    );
  }

  if (
    Math.round(order.shippingTotal || 0) > 0 &&
    !items.some((it) => /env[ií]o|despacho|shipping/i.test(it.descripcion))
  ) {
    issues.push(
      `Pedido incluye envío $${Math.round(order.shippingTotal).toLocaleString('es-CL')} — debe reflejarse en la factura.`,
    );
  }

  if (opts?.ajusteNeto && opts.ajusteNeto !== 0) {
    issues.push(
      `Ajuste automático neto ${opts.ajusteNeto > 0 ? '+' : ''}${opts.ajusteNeto.toLocaleString('es-CL')} para cuadrar con Shopify.`,
    );
  }

  return {
    ok,
    diff,
    tolerancia,
    shopify: {
      total: shopifyTotal,
      subtotal: subtotalShopify,
      tax: Math.round(order.totalTax || 0),
      shipping: Math.round(order.shippingTotal || 0),
      totalDiscounts: Math.round(order.totalDiscounts || 0),
      lineItemsBruto,
      lineDiscounts,
    },
    factura: {
      neto,
      iva,
      total: facturaTotal,
      subtotalLineas: subtotalLista,
      descuentoGlobalNeto,
      descuentoGlobalPct: cuadrado.descuentoGlobalPct,
    },
    ajusteNeto: opts?.ajusteNeto ?? 0,
    issues,
  };
}
