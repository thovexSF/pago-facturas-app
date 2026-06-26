import type { FacturaEditDraft } from './facturaPreview';

/** Campos editables del borrador (sin precios — siempre vienen de Shopify). */
export type FacturaDraftMeta = Pick<
  FacturaEditDraft,
  | 'rutReceptor'
  | 'razonSocial'
  | 'giroReceptor'
  | 'comunaReceptor'
  | 'ciudadReceptor'
  | 'dirReceptor'
  | 'fechaEmision'
  | 'useDescripcionExtendida'
>;

export function mergeDraftMeta(base: FacturaEditDraft, saved: Partial<FacturaEditDraft>): FacturaEditDraft {
  const items = base.items.map((bi, i) => {
    const si = saved.items?.[i];
    if (!si) return bi;
    const cantidad = Math.max(1, Math.round(Number(si.cantidad) || bi.cantidad));
    return {
      ...bi,
      descripcion: si.descripcion?.trim() ? si.descripcion : bi.descripcion,
      descripcionExtendida: si.descripcionExtendida ?? bi.descripcionExtendida,
      cantidad,
      precioUnitario: bi.precioUnitario,
      subtotal: bi.precioUnitario * cantidad,
    };
  });

  return {
    ...base,
    rutReceptor: saved.rutReceptor?.trim() || base.rutReceptor,
    razonSocial: saved.razonSocial?.trim() || base.razonSocial,
    giroReceptor: saved.giroReceptor?.trim() || base.giroReceptor,
    comunaReceptor: saved.comunaReceptor?.trim() || base.comunaReceptor,
    ciudadReceptor: saved.ciudadReceptor?.trim() || base.ciudadReceptor,
    dirReceptor: saved.dirReceptor?.trim() || base.dirReceptor,
    fechaEmision: saved.fechaEmision || base.fechaEmision,
    useDescripcionExtendida: saved.useDescripcionExtendida ?? base.useDescripcionExtendida,
    items,
    descuentoGlobal: base.descuentoGlobal,
  };
}

export function draftMetaForStorage(draft: FacturaEditDraft): FacturaEditDraft {
  return {
    ...draft,
    items: draft.items.map((it) => ({
      numero: it.numero,
      cantidad: it.cantidad,
      descripcion: it.descripcion,
      descripcionExtendida: it.descripcionExtendida,
      precioUnitario: 0,
      subtotal: 0,
    })),
    descuentoGlobal: null,
  };
}
