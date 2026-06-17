/** Agrupa campos EFXP_* del snapshot SII para mostrar en modal estilo DTE (sin duplicar líneas de detalle). */

export type DteExtendidoBloque = 'emisor' | 'receptor' | 'transporte' | 'totales' | 'otros';

const LABEL_OVERRIDES: Record<string, string> = {
  CANT_DET: 'Cantidad líneas detalle',
  EFXP_FCH_EMIS: 'Fecha de emisión',
  EFXP_FMA_PAGO: 'Forma de pago',
  EFXP_MNT_NETO: 'Monto neto',
  EFXP_IVA: 'IVA',
  EFXP_MNT_TOTAL: 'Monto total',
  EFXP_SUBTOTAL: 'Subtotal',
  EFXP_RZN_SOC: 'Razón social',
  EFXP_GIRO_EMIS: 'Giro',
  EFXP_EMAIL_EMISOR: 'Correo electrónico',
  EFXP_FONO_EMISOR: 'Teléfono',
  EFXP_DIR_ORIGEN_DEFUALT: 'Dirección',
  EFXP_DIR_ORIGEN_DEFAULT: 'Dirección',
  EFXP_CMNA_ORIGEN: 'Comuna',
  EFXP_CIUDAD_ORIGEN: 'Ciudad',
  EFXP_ACTECO: 'Actividad económica (código)',
  EFXP_CDG_SII_SUCUR: 'Código sucursal SII',
  EFXP_NMB_SUC: 'Nombre sucursal SII',
  EFXP_RUT_RECEP: 'RUT receptor (cuerpo)',
  EFXP_DV_RECEP: 'RUT receptor (DV)',
  EFXP_RZN_SOC_RECEP: 'Razón social receptor',
  EFXP_DIR_RECEP: 'Dirección receptor',
  EFXP_CMNA_RECEP: 'Comuna receptor',
  EFXP_CIUDAD_RECEP: 'Ciudad receptor',
  EFXP_GIRO_RECEP: 'Giro receptor',
  EFXP_DIR_RECEP_DEFUALT: 'Dirección receptor (formulario)',
  EFXP_GIRO_RECEP_DEFUALT: 'Giro receptor (formulario)',
  EFXP_DIR_RECEP_DEFAULT: 'Dirección receptor (formulario)',
  EFXP_GIRO_RECEP_DEFAULT: 'Giro receptor (formulario)',
  EFXP_REFERENCIAS_RESUMEN: 'Referencias',
};

function etiquetaCampo(key: string): string {
  if (LABEL_OVERRIDES[key]) return LABEL_OVERRIDES[key];
  return key
    .replace(/^EFXP_/, '')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function clasificarCampo(key: string): DteExtendidoBloque {
  const k = key.toUpperCase();
  if (esCampoLineaDetalleEfxp(key)) return 'otros';
  if (/TRANSPORT|CHOFER|PATENTE|TRASLADO|RUT_TRAN|DV_TRAN|NMB_TRAN|FURGON|RUT_CHOF|DV_CHOF|NMB_CHOF/i.test(k)) {
    return 'transporte';
  }
  if (
    /RECEP|CONTACTO|MAIL_REC|FONO_REC|EMAIL_REC|TP_REC|IND_REC|TIPO.*REC|DIR_DEST|CMNA_DEST|CIUDAD_DEST/i.test(k) &&
    !/EMIS/i.test(k)
  ) {
    return 'receptor';
  }
  if (
    /EMIS|_EMI|TP_VENTA|MAIL_EM|EMAIL_EM|FONO_EM|DIR_EMIS|DIR_ORIGEN|CMNA_ORIGEN|CIUDAD_ORIGEN|CMNA_EMIS|CIUDAD_EMIS|RZN.*EMIS|GIRO.*EMIS|SUC_SII|CDG_SUC|NMB_SUC|ACTECO/i.test(
      k
    ) ||
    k === 'EFXP_RZN_SOC' ||
    k === 'EFXP_GIRO'
  ) {
    return 'emisor';
  }
  if (
    /MNT_|SUBTOTAL|IVA|FMA_PAGO|FCH_EMIS|FOLIO|NUM_FOLIO|NRO_FOLIO|IMP_ADIC|IMPTO|TOTAL|DESCUENTO|TIPO_DOC|PTDC/i.test(k)
  ) {
    return 'totales';
  }
  return 'otros';
}

function esCampoLineaDetalleEfxp(key: string): boolean {
  return /^EFXP_(NMB|QTY|PRC|SUBT|PCTD|UNMD|CDG|COD|CODITEM|COD_INT|IND|ID|DSC_ITEM|DSC_LIN|ITEM_NMB|DSC_DET)_\d+/i.test(
    key
  );
}

const FMA_PAGO_UI: Record<string, string> = {
  '1': 'Contado',
  '2': 'Crédito',
  '3': 'Sin costo',
  '901': 'Contado',
  '902': 'Crédito',
};

/** Si el API dejó vacío giro/dir/forma, intenta otra clave EFXP_* del snapshot. */
/**
 * Texto para el recuadro tipo DTE (sucursal emisora). El código SII no es ciudad: es ID interno;
 * si existe EFXP_NMB_SUC o comuna/ciudad origen, se muestran junto al código.
 */
export function textoSucursalEmisorCuadro(
  ext: Record<string, string> | null | undefined,
  emisorRows: Array<{ key: string; value: string }>
): string {
  const val = (pred: (ku: string) => boolean): string => {
    for (const r of emisorRows) {
      const ku = r.key.toUpperCase();
      if (pred(ku) && r.value.trim()) return r.value.trim();
    }
    if (!ext || typeof ext !== 'object') return '';
    for (const [k, v] of Object.entries(ext)) {
      const ku = k.toUpperCase();
      const t = String(v ?? '').trim();
      if (t && pred(ku)) return t;
    }
    return '';
  };

  const nmb = val((k) => /NMB_SUC/.test(k));
  const cmna = val((k) => /CMNA_(ORIGEN|EMIS)/.test(k) && !/RECEP/i.test(k));
  const ciu = val((k) => /CIUDAD_(ORIGEN|EMIS)/.test(k) && !/RECEP/i.test(k));
  const cod = val((k) => /CDG_SII_SUCUR|CDG_SUC/.test(k));

  const parts: string[] = [];
  if (nmb) parts.push(nmb);
  if (cmna) parts.push(cmna);
  if (ciu && normUno(ciu) !== normUno(cmna)) parts.push(ciu);
  if (cod) parts.push(`Código sucursal SII: ${cod}`);
  return parts.join(' · ');
}

function normUno(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function pickCampoDesdeExtendido(
  ext: Record<string, string> | null | undefined,
  kind: 'giro' | 'dir' | 'formaPago'
): string {
  if (!ext || typeof ext !== 'object') return '';
  const entries = Object.entries(ext);

  const match = (patterns: RegExp[], anti?: RegExp[]) => {
    for (const [k, v] of entries) {
      const t = (v || '').trim();
      if (!t) continue;
      const ku = k.toUpperCase();
      if (anti?.some((re) => re.test(ku))) continue;
      if (patterns.some((re) => re.test(ku))) return t;
    }
    return '';
  };

  if (kind === 'giro') {
    return match(
      [/GIRO.*RECEP|GIRO_RCP|GIRO_RECEP_DEFUALT|GIRO_RECEP_DEFAULT/i],
      [/GIRO.*EMIS|GIRO.*EMI[^O]/i]
    );
  }
  if (kind === 'dir') {
    return match(
      [/DIR.*RECEP|DIREC.*RECEP|DOMICILIO.*RECEP|DIR_RCP|DIR_RECEP_DEFUALT|DIR_RECEP_DEFAULT/i],
      [/CMNA|CIUDAD|MAIL|FONO|EMAIL/i]
    );
  }
  const dsc = match([/DSC_FMA|GLS_FMA|DESC_FMA|FMA_PAGO_DESC|FORMA.*PAGO.*DESC/i]);
  if (dsc) return dsc;
  const code = match([/^EFXP_FMA_PAGO$/i, /^EFXP_FORMA_PAGO$/i, /^EFXP_FMA_PGO$/i]);
  if (code && /^\d+$/.test(code)) return FMA_PAGO_UI[code] || code;
  return code;
}

export function partitionDetalleExtendido(
  ext: Record<string, string> | null | undefined
): Record<DteExtendidoBloque, Array<{ key: string; label: string; value: string }>> {
  const out: Record<DteExtendidoBloque, Array<{ key: string; label: string; value: string }>> = {
    emisor: [],
    receptor: [],
    transporte: [],
    totales: [],
    otros: [],
  };
  if (!ext || typeof ext !== 'object') return out;

  for (const [key, value] of Object.entries(ext)) {
    if (!value || !String(value).trim()) continue;
    if (esCampoLineaDetalleEfxp(key)) continue;
    const bloque = clasificarCampo(key);
    out[bloque].push({ key, label: etiquetaCampo(key), value: String(value).trim() });
  }
  return out;
}
