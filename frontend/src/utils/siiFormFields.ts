/** Límites del formulario MiPyme (EFXP_*), alineados con el backend. */
export const SII_EFXP_NMB_MAX = 40;
export const SII_EFXP_DSC_ITEM_MAX = 500;

export type SiiCharMeta = {
  length: number;
  max: number;
  over: boolean;
  helper: string;
};

export function siiCharMeta(text: string, max: number): SiiCharMeta {
  const length = (text || '').length;
  const over = length > max;
  return {
    length,
    max,
    over,
    helper: over
      ? `Excede ${max} caracteres — el SII truncará o rechazará`
      : `${length}/${max} caracteres`,
  };
}

/** Vista previa de cómo quedará EFXP_NMB en el SII (misma lógica que el scraper). */
export function previewNombreEnSii(texto: string, max = SII_EFXP_NMB_MAX): string {
  const t = (texto || '').trim();
  if (!t || t.length <= max) return t;
  const head = t.slice(0, max);
  const sp = head.lastIndexOf(' ');
  const cut = sp >= Math.floor(max * 0.45) ? sp : max;
  return t.slice(0, cut).trim();
}

/** Etiquetas legibles del formulario MiPyme (sin códigos internos EFXP_*). */
export const SII_MIPYME_FIELDS = {
  nombre: 'Nombre',
  descripcionExtendida: 'Descripción extendida',
  cantidad: 'Cantidad',
  precioUnitario: 'Precio unitario',
  subtotalLinea: 'Subtotal línea',
  subtotal: 'Subtotal',
  descuentoGlobalPct: 'Descuento global',
  montoNeto: 'Monto neto',
  iva: 'IVA',
  total: 'Total',
  formaPago: 'Forma de pago',
} as const;
