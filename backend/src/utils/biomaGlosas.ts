/**
 * Glosas cortas para factura SII (EFXP_NMB ~40 chars).
 * Ej: "Cafe de Especialidad Guatemala - …" + Tamaño 500gr → "CAFE ESPEC. GUATEMALA 500GR"
 */

const SII_GLOSA_MAX = 40;
const WEIGHT_RE =
  /\b(\d+(?:[.,]\d+)?)\s*(kg|kilo?s?|gr(?:amos?)?|g(?:ramos?|rams?)?|ml|lt?|l)\b/i;
const WEIGHT_OPTION_NAME_RE = /tama[nñ]o|peso|size|weight|formato|presentaci[oó]n/i;
const DEFAULT_VARIANT_TITLE = /^default\s+title$/i;

export interface GlosaVariantOption {
  name: string;
  value: string;
}

function foldAccents(s: string): string {
  return (s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeWeight(num: string, unitRaw: string, context: string): string {
  const n = num.replace(',', '.');
  const unit = unitRaw.toLowerCase();
  if (unit === 'kg' || unit === 'kilo' || unit === 'kilos') return `${n}KG`;
  if (unit === 'ml') return `${n}ML`;
  if (unit === 'lt' || unit === 'l') return `${n}LT`;
  if (unit === 'gr' || unit.startsWith('gr') || (unit === 'g' && new RegExp(`${n}\\s*gr`, 'i').test(context))) {
    return `${n}GR`;
  }
  if (unit === 'g' || unit.startsWith('g')) return `${n}G`;
  return `${n}${unit.toUpperCase()}`;
}

function extractWeightFromText(text: string): string {
  const folded = foldAccents(text);
  if (!folded) return '';

  const m = folded.match(WEIGHT_RE);
  if (m) return normalizeWeight(m[1], m[2], folded);

  const compact = folded.match(/(?:^|[^0-9])(\d+(?:[.,]\d+)?)\s*(kg|gr|g)(?:[^a-z]|$)/i);
  if (compact) return normalizeWeight(compact[1], compact[2], folded);

  return '';
}

function extractWeight(
  variantOptions: GlosaVariantOption[] | undefined,
  ...sources: string[]
): string {
  if (variantOptions?.length) {
    for (const opt of variantOptions) {
      if (WEIGHT_OPTION_NAME_RE.test(foldAccents(opt.name))) {
        const w = extractWeightFromText(opt.value);
        if (w) return w;
      }
    }
    for (const opt of variantOptions) {
      const w = extractWeightFromText(opt.value);
      if (w) return w;
    }
  }

  for (const src of sources) {
    const w = extractWeightFromText(src);
    if (w) return w;
  }
  return '';
}

function isUsefulVariant(variantTitle: string): boolean {
  const v = foldAccents(variantTitle);
  return !!v && !DEFAULT_VARIANT_TITLE.test(v);
}

function isCafeEspecialidad(text: string): boolean {
  return /cafe\s+de\s+especialidad/i.test(foldAccents(text));
}

const IGNORE_ORIGIN_WORDS = new Set(['default', 'title', 'grano', 'molido', 'whole', 'ground']);

function extractOrigenWords(segment: string): string {
  const cleaned = segment.replace(/\s*\/\s*.+$/, '').trim();
  const head = cleaned.split(/\s*-\s*/)[0].trim();
  if (!head || DEFAULT_VARIANT_TITLE.test(foldAccents(head))) return '';

  const words = head.split(/\s+/).filter(Boolean);
  const origin: string[] = [];
  for (const w of words) {
    if (origin.length >= 3) break;
    if (IGNORE_ORIGIN_WORDS.has(w.toLowerCase())) continue;
    if (/^[A-Za-z]/.test(w) && w.length > 1) origin.push(w);
    else if (origin.length > 0) break;
  }
  return origin.join(' ');
}

/**
 * Origen desde título/variante/nombre completo/opciones Shopify.
 * Bioma: país en el título del producto o en la variante; peso suele ir en opción «Tamaño».
 */
function extractOrigenEspecialidad(
  sources: string[],
  variantOptions?: GlosaVariantOption[],
): string {
  for (const raw of sources) {
    const folded = foldAccents(raw);
    if (!folded || !isCafeEspecialidad(folded)) continue;

    const tail = folded.replace(/^.*?cafe\s+de\s+especialidad\s*/i, '').replace(/^-\s*/, '').trim();
    if (!tail) continue;

    const origen = extractOrigenWords(tail);
    if (origen) return origen;
  }

  for (const raw of sources) {
    if (!raw || isCafeEspecialidad(raw)) continue;
    if (!isUsefulVariant(raw)) continue;
    const origen = extractOrigenWords(raw);
    if (origen) return origen;
  }

  if (variantOptions?.length) {
    for (const opt of variantOptions) {
      if (/origen|pa[ií]s|country|variedad|region/i.test(foldAccents(opt.name))) {
        const origen = extractOrigenWords(opt.value);
        if (origen) return origen;
      }
    }
  }

  return '';
}

function buildEspecialidadGlosa(origen: string, weight: string): string {
  const base = 'CAFE ESPEC.';
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

function resolveLineDisplayName(
  title: string,
  variantTitle?: string | null,
  lineName?: string | null,
): string {
  const name = (lineName || '').trim();
  if (name) return name;
  return buildTituloCompletoLineaShopify(title, variantTitle);
}

/** Título Shopify completo para descripción extendida MiPyme (EFXP_DSC_ITEM_*). */
export function buildTituloCompletoLineaShopify(
  title: string,
  variantTitle?: string | null,
  lineName?: string | null,
): string {
  const name = (lineName || '').trim();
  if (name) return name;

  const t = (title || '').trim();
  const v = (variantTitle || '').trim();
  if (!t && !v) return '';
  if (!v || t.includes(v) || DEFAULT_VARIANT_TITLE.test(foldAccents(v))) return t;
  return `${t} - ${v}`;
}

/**
 * Convierte título + variante (+ opciones Shopify) en glosa factura SII.
 * Prioriza café de especialidad: CAFE ESPEC. {ORIGEN} {PESO}
 */
export function formatGlosaFacturaSii(
  title: string,
  variantTitle?: string | null,
  lineName?: string | null,
  variantOptions?: GlosaVariantOption[],
  sku?: string | null,
): string {
  const t = (title || '').trim();
  const v = (variantTitle || '').trim();
  const display = resolveLineDisplayName(t, v, lineName);
  if (!t && !v && !display) return 'ITEM';

  const tFold = foldAccents(t);
  const displayFold = foldAccents(display);
  if (/env[ií]o|despacho|shipping/i.test(tFold) || /env[ií]o|despacho|shipping/i.test(displayFold)) {
    return 'DESPACHO ENVIO';
  }

  const weight = extractWeight(variantOptions, v, t, display, sku || '');

  if (isCafeEspecialidad(t) || isCafeEspecialidad(v) || isCafeEspecialidad(display)) {
    const origen = extractOrigenEspecialidad([display, t, v], variantOptions);
    return buildEspecialidadGlosa(origen, weight);
  }

  const short = t.split(/\s*-\s*/)[0].trim() || t;
  const glosa = [short, weight].filter(Boolean).join(' ').toUpperCase();
  return glosa.slice(0, SII_GLOSA_MAX);
}
