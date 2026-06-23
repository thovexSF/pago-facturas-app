/** Claves de atributos de pedido Shopify ↔ checkout Bioma. */
export const BIOMA_FACTURA_ATTR = {
  enabled: '_factura_enabled',
  rut: '_rut_empresa',
  razon: '_razon_social',
  giro: '_giro_empresa',
} as const;

/** RUT estándar SII para boleta a consumidor final (sin datos de factura en checkout). */
export const SII_RUT_CONSUMIDOR_FINAL = '66666666-6';

/** Razón social habitual en boleta electrónica sin identificar al comprador. */
export const SII_RAZON_BOLETA_CF = 'Varios';

/** Valores receptor genérico en portal e-Boleta (eboleta.sii.cl). */
export const EBOLETA_RAZON_CF = 'SII Boleta';
export const EBOLETA_COMUNA_CF = 'Santiago';
export const EBOLETA_DIRECCION_CF = 'Santiago';

export function isBoletaTipo(tipoCodigo: number): boolean {
  return tipoCodigo === 39 || tipoCodigo === 41;
}

export function boletaReceptorForSii(): { rut: string; razonSocial: string } {
  return { rut: SII_RUT_CONSUMIDOR_FINAL, razonSocial: SII_RAZON_BOLETA_CF };
}

/** Receptor consumidor final para emisión vía e-Boleta SII. */
export function eboletaReceptorForSii(): {
  rut: string;
  razonSocial: string;
  direccion: string;
  comuna: string;
} {
  return {
    rut: SII_RUT_CONSUMIDOR_FINAL,
    razonSocial: EBOLETA_RAZON_CF,
    direccion: EBOLETA_DIRECCION_CF,
    comuna: EBOLETA_COMUNA_CF,
  };
}

export function boletaViaEBoleta(): boolean {
  const v = String(process.env.BIOMA_BOLETA_VIA || 'eboleta').trim().toLowerCase();
  return v !== 'mipyme';
}

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

/** Pedido que requiere factura (toggle checkout o RUT en atributos / manual / nota cliente). */
export function orderNeedsFactura(
  attrs: Array<{ key: string; value: string }>,
  customerNote?: string | null,
): boolean {
  if (orderWantsFactura(attrs)) return true;
  if (getOrderCustomAttribute(attrs, BIOMA_FACTURA_ATTR.rut)) return true;
  if (customerNote && parseCustomerNote(customerNote).rut) return true;
  return false;
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

/**
 * Parsea las notas del cliente buscando datos de facturación.
 * Formatos soportados (case-insensitive):
 *   RUT: 77.515.574-4
 *   Razón Social: Comercial Universal SPA
 *   Giro: Venta de café
 */
export function parseCustomerNote(note: string): {
  rut: string;
  razon: string;
  giro: string;
} {
  const result = { rut: '', razon: '', giro: '' };
  if (!note) return result;
  for (const line of note.split(/[\n|;/]/)) {
    const trimmed = line.trim();
    const match = trimmed.match(/^(rut|raz[oó]n\s*social|giro)\s*[:=]\s*(.+)/i);
    if (!match) continue;
    const key = match[1].toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const value = match[2].trim();
    if (key === 'rut') result.rut = value.replace(/\./g, '').replace(/\s*-\s*/, '-');
    else if (key.startsWith('razon')) result.razon = value;
    else if (key === 'giro') result.giro = value;
  }
  return result;
}
