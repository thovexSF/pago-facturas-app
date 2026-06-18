/** Claves de atributos de pedido Shopify ↔ checkout Bioma. */
export const BIOMA_FACTURA_ATTR = {
  enabled: '_factura_enabled',
  rut: '_rut_empresa',
  razon: '_razon_social',
  giro: '_giro_empresa',
} as const;

/** RUT estándar SII para boleta a consumidor final (sin datos de factura en checkout). */
export const SII_RUT_CONSUMIDOR_FINAL = '66666666-6';

/** Tag al emitir factura (incluye folio SII). */
export function facturaEmitidaTag(folio: number): string {
  return `factura #${folio}`;
}

/** Tag al emitir boleta. */
export function boletaEmitidaTag(folio: number): string {
  return `boleta #${folio}`;
}

/** Tags legacy o con folio = ya emitido en Shopify. */
export function isDteEmitidoShopifyTag(tag: string): boolean {
  const t = tag.trim().toLowerCase();
  return (
    t === 'facturado' ||
    t === 'boletado' ||
    /^factura #\d+$/.test(t) ||
    /^boleta #\d+$/.test(t)
  );
}

export function orderHasEmitidoShopifyTag(tags: string[]): boolean {
  return tags.some((tag) => isDteEmitidoShopifyTag(tag));
}

/** Pedido que requiere factura (toggle checkout o RUT en atributos / manual). */
export function orderNeedsFactura(attrs: Array<{ key: string; value: string }>): boolean {
  if (orderWantsFactura(attrs)) return true;
  return !!getOrderCustomAttribute(attrs, BIOMA_FACTURA_ATTR.rut);
}

export function getOrderCustomAttribute(
  attrs: Array<{ key: string; value: string }>,
  key: string,
): string {
  const found = attrs.find((a) => a.key?.toLowerCase() === key.toLowerCase());
  return (found?.value ?? '').trim();
}

export function orderWantsFactura(attrs: Array<{ key: string; value: string }>): boolean {
  const v = getOrderCustomAttribute(attrs, BIOMA_FACTURA_ATTR.enabled).toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'si';
}
