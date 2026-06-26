export type FormaPagoMipyme = 'contado' | 'credito';

export const SII_FMA_PAGO_CODE: Record<FormaPagoMipyme, string> = {
  contado: '1',
  credito: '2',
};

export const SII_FMA_PAGO_LABEL: Record<FormaPagoMipyme, string> = {
  contado: 'Contado',
  credito: 'Crédito',
};

export function normalizeFormaPagoMipyme(raw: unknown): FormaPagoMipyme {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  if (s === '2' || s === 'credito' || s === 'credit') return 'credito';
  return 'contado';
}
