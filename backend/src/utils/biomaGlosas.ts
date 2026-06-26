/**
 * Glosas cortas para factura SII (EFXP_NMB ~40 chars).
 * Ej: "Cafe de Especialidad Colombia - … - 250gr / Grano" → "CAFE ESPECIALIDAD COLOMBIA 250GR"
 */

const SII_GLOSA_MAX = 40;
const ESPECIALIDAD_RE = /cafe\s+de\s+especialidad\s+(.+)/i;
const WEIGHT_RE = /\b(\d+)\s*(kg|kilo|kilos|gr|g|ml|lt|l)\b/i;

function normalizeWeight(num: string, unitRaw: string, context: string): string {
  const unit = unitRaw.toLowerCase();
  if (unit === 'kg' || unit === 'kilo' || unit === 'kilos') return `${num}KG`;
  if (unit === 'ml') return `${num}ML`;
  if (unit === 'lt' || unit === 'l') return `${num}LT`;
  if (unit === 'gr' || (unit === 'g' && new RegExp(`${num}\\s*gr`, 'i').test(context))) {
    return `${num}GR`;
  }
  if (unit === 'g') return `${num}G`;
  return `${num}${unit.toUpperCase()}`;
}

function extractWeight(...sources: string[]): string {
  for (const src of sources) {
    const m = src.match(WEIGHT_RE);
    if (m) return normalizeWeight(m[1], m[2], src);
  }
  return '';
}

/** Origen/región: texto entre «Especialidad» y el primer guión de sabor (hasta 3 palabras). */
function extractOrigenEspecialidad(title: string): string {
  const m = title.match(ESPECIALIDAD_RE);
  if (!m) return '';
  const segment = m[1].split(/\s*-\s*/)[0].trim();
  if (!segment) return '';

  const words = segment.split(/\s+/).filter(Boolean);
  const origin: string[] = [];
  for (const w of words) {
    if (origin.length >= 3) break;
    if (/^[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(w) && w.length > 1) origin.push(w);
    else if (origin.length > 0) break;
  }
  return origin.join(' ');
}

function buildEspecialidadGlosa(origen: string, weight: string): string {
  const base = 'CAFE ESPECIALIDAD';
  const words = origen.split(/\s+/).filter(Boolean);

  for (let n = words.length; n >= 1; n--) {
    const glosa = [base, words.slice(0, n).join(' '), weight]
      .filter(Boolean)
      .join(' ')
      .toUpperCase();
    if (glosa.length <= SII_GLOSA_MAX) return glosa;
  }

  const minimal = [base, weight].filter(Boolean).join(' ').toUpperCase();
  return minimal.slice(0, SII_GLOSA_MAX);
}

/**
 * Convierte título + variante Shopify en glosa factura SII.
 * Prioriza café de especialidad: CAFE ESPECIALIDAD {ORIGEN} {PESO}
 */
/** Título Shopify completo para descripción extendida MiPyme (EFXP_DSC_ITEM_*). */
export function buildTituloCompletoLineaShopify(
  title: string,
  variantTitle?: string | null,
): string {
  const t = (title || '').trim();
  const v = (variantTitle || '').trim();
  if (!t && !v) return '';
  if (!v || t.includes(v)) return t;
  return `${t} - ${v}`;
}

export function formatGlosaFacturaSii(title: string, variantTitle?: string | null): string {
  const t = (title || '').trim();
  const v = (variantTitle || '').trim();
  if (!t && !v) return 'ITEM';

  if (/env[ií]o|despacho|shipping/i.test(t)) {
    return 'DESPACHO ENVIO';
  }

  const weight = extractWeight(v, t);

  if (ESPECIALIDAD_RE.test(t)) {
    return buildEspecialidadGlosa(extractOrigenEspecialidad(t), weight);
  }

  const short = t.split(/\s*-\s*/)[0].trim() || t;
  const glosa = [short, weight].filter(Boolean).join(' ').toUpperCase();
  return glosa.slice(0, SII_GLOSA_MAX);
}
