/** Claves de atributos de pedido Shopify ↔ checkout Bioma. */
export const BIOMA_FACTURA_ATTR = {
  enabled: '_factura_enabled',
  rut: '_rut_empresa',
  razon: '_razon_social',
  giro: '_giro_empresa',
} as const;

/** RUT estándar SII para boleta a consumidor final (sin datos de factura en checkout). */
export const SII_RUT_CONSUMIDOR_FINAL = '66666666-6';

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
