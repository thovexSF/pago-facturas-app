/**
 * SiiFacturacionService — Enfoque HÍBRIDO
 *
 * Playwright: login + selección empresa + emitir factura (requiere JS)
 * axios:      todas las operaciones de lectura (10-20x más rápido)
 *
 * URLs clave:
 *  - Login:         https://zeusr.sii.cl/.../IngresoRutClave.html?...
 *  - Sel. empresa:  https://www1.sii.cl/cgi-bin/Portal001/mipeSelEmpresa.cgi
 *  - Listado emit:  https://www1.sii.cl/cgi-bin/Portal001/mipeAdminDocsEmi.cgi
 *  - Copiar doc:    https://www1.sii.cl/cgi-bin/Portal001/mipeGenFacEx.cgi?IGUAL=CODIGO&VALOR={codigo}&PTDC_CODIGO={tipo}
 *  - Preview/emit:  https://www1.sii.cl/cgi-bin/Portal001/mipeDisplayPreView.cgi
 *  - Ver emitido:   mipeGesDocEmi.cgi?ALL_PAGE_ANT=&CODIGO=&csrt= (URL completa desde href del listado)
 *  - PDF directo:   mipeDisplayPDF.cgi?DHDR_CODIGO={codigo} (retorna application/pdf directo)
 */

import { Browser, BrowserContext, Dialog, Frame, Page, chromium } from 'playwright';
import axios, { AxiosInstance } from 'axios';
import * as https from 'https';
import iconv from 'iconv-lite';
import { SiiCredentialsService } from './SiiCredentialsService';
import { AppDataSource } from '../config/database';
import { SiiFacturaEntity } from '../entities/SiiFacturaEntity';
import { SiiContactoEntity } from '../entities/SiiContactoEntity';
import { WorkbenchClient } from '../entities/WorkbenchClient';

// ─── Tipos ─────────────────────────────────────────────────────────────────

export interface SiiEmpresa {
  value: string;   // RUT empresa ej. "99515150-2"
  text: string;    // Nombre ej. "B2B EXPRESS SPA 99515150-2"
}

export interface SiiFactura {
  codigo: string;
  rutReceptor: string;
  razonSocial: string;
  tipoDocumento: string;
  tipoCodigo: number;
  folio: number;
  fecha: string;
  monto: number;
  estado: string;
}

export interface SiiItem {
  numero: number;
  descripcion: string;
  cantidad: number;
  unidad: string;
  precioUnitario: number;
  descuento: number;
  subtotal: number;
  /** Código ítem / interno si el formulario SII lo trae */
  codigo?: string;
  /** % impuesto adicional por línea (si aplica) */
  imptoAdicPct?: number;
}

export interface SiiFacturaDetalle extends SiiFactura {
  items: SiiItem[];
  dirReceptor: string;
  comunaReceptor: string;
  ciudadReceptor: string;
  giroReceptor: string;
  formaPago: string;
  subtotal: number;
  neto: number;
  iva: number;
  total: number;
  /** Todos los EFXP_* no vacíos del HTML copiar documento (emisor, transporte, SII, etc.) */
  detalleExtendido?: Record<string, string>;
}

export interface UltimaFacturaCliente {
  rutReceptor: string;
  razonSocial: string;
  tipoCodigo: number;
  tipoDocumento: string;
  folio: number;
  fecha: string;
  monto: number;
  codigo: string;
}

// ─── Constantes ────────────────────────────────────────────────────────────

const SII_URLS = {
  login: 'https://zeusr.sii.cl//AUT2000/InicioAutenticacion/IngresoRutClave.html?https://misiir.sii.cl/cgi_misii/siihome.cgi',
  /** Tras Zeusr: fija cookies de portal antes de www1 (MIPYME / facturación). */
  siiHome: 'https://misiir.sii.cl/cgi_misii/siihome.cgi',
  /** Cierra sesión en Zeusr; reduce sesiones concurrentes que el SII limita. */
  logoutZeusr: 'https://zeusr.sii.cl/cgi_AUT2000/CAutSalida.cgi',
  selEmpresa: 'https://www1.sii.cl/cgi-bin/Portal001/mipeSelEmpresa.cgi',
  listadoEmitidos: 'https://www1.sii.cl/cgi-bin/Portal001/mipeAdminDocsEmi.cgi',
  copiarDoc: 'https://www1.sii.cl/cgi-bin/Portal001/mipeGenFacEx.cgi',
  /** Formulario vacío (sin copiar documento previo). */
  nuevaFactura: 'https://www1.sii.cl/cgi-bin/Portal001/mipeGenFacEx.cgi',
  preview: 'https://www1.sii.cl/cgi-bin/Portal001/mipeDisplayPreView.cgi',
} as const;

/** URL del formulario EFXP: copiar documento o factura nueva según haya código plantilla. */
function buildEmitFormUrl(tipoCodigo: number, codigoOriginal?: string | null): string {
  const codigo = codigoOriginal?.trim();
  if (codigo) {
    return `${SII_URLS.copiarDoc}?IGUAL=CODIGO&VALOR=${encodeURIComponent(codigo)}&PTDC_CODIGO=${tipoCodigo}`;
  }
  return `${SII_URLS.nuevaFactura}?PTDC_CODIGO=${tipoCodigo}`;
}

// ─── Sesiones ───────────────────────────────────────────────────────────────

interface SiiSession {
  browser: Browser | null;
  /** Contexto Playwright con cookies de la sesión activa */
  context: BrowserContext | null;
  axiosClient: AxiosInstance;
  cookieHeader: string;
  empresaRut: string;
  /** Última actividad (touch). */
  ts: number;
  /** Inicio de sesión SII — caducidad ~55 min desde aquí. */
  startedAt: number;
  /** Credenciales guardadas para re-login Playwright bajo demanda */
  credentials?: { rut: string; password: string };
  /** true si el browser ya hizo login completo (ptrTkn disponible) */
  playwrightReady?: boolean;
  /** Listado MiPyme validado al crear la sesión (HTTP o Playwright). */
  listadoVerifiedAt?: number;
  /** Pestaña Playwright reutilizable entre pasos abrir/rellenar/emitir (mismo tab = ptrTkn válido). */
  scraperPage?: Page;
}

/** Tiempo máximo de sesión SII (el portal expira ~60 min). */
export const SII_SESSION_MAX_AGE_MS = 55 * 60 * 1000;

const sessions = new Map<string, SiiSession>();

/** Serializa ensureBrowserForSession por sesión (evita dos logins Playwright concurrentes). */
const ensureBrowserPromises = new WeakMap<SiiSession, Promise<BrowserContext>>();

/** Pausa global tras bloqueo SII (501, cuenta bloqueada, etc.) — evita empeorar el ban. */
interface SiiBlockState {
  blockedUntil: number;
  reason: string;
  since: number;
}
let siiBlockState: SiiBlockState | null = null;
const SII_BLOCK_COOLDOWN_MS =
  (parseInt(process.env.SII_BLOCK_COOLDOWN_MINUTES || '120', 10) || 120) * 60 * 1000;

/** Cache de empresas disponibles — se renueva cada 2 horas o al llamar explícitamente a invalidateEmpresasCache() */
let empresasCache: { empresas: SiiEmpresa[]; ts: number } | null = null;
const EMPRESAS_CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 h

/**
 * Si hay una llamada a listEmpresasDisponibles en vuelo, se reutiliza su promesa.
 * Evita que múltiples requests concurrentes lancen cada uno un login al SII.
 */
let listEmpresasEnVuelo: Promise<SiiEmpresa[]> | null = null;

/** Cooldown tras error: evita reintentar inmediatamente si SII bloqueó (30 s). */
let listEmpresasErrorTs = 0;
const EMPRESAS_ERROR_COOLDOWN_MS = 30_000;

/**
 * Browser/context de Playwright que quedó disponible tras listEmpresasDisponibles.
 * createSession lo reutiliza para no abrir un segundo browser.
 */
let playwrightContextDisponible: { browser: Browser; context: BrowserContext; ts: number } | null = null;
const PW_CONTEXT_TTL_MS = 5 * 60 * 1000; // 5 min — suficiente para que createSession lo use

// ─── Helpers ────────────────────────────────────────────────────────────────

/** El SII entrega HTML en windows-1252 / ISO-8859-1; axios por defecto asume UTF-8 y rompe apóstrofos (0x92 →). */
function decodeSiiHtmlResponseBody(data: unknown, contentType: string): string | Buffer {
  if (data == null || data === '') return '';
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
  const ct = contentType.toLowerCase();
  if (ct.includes('application/pdf') || ct.includes('application/octet-stream')) {
    return buf;
  }
  try {
    return iconv.decode(buf, 'windows-1252');
  } catch {
    return iconv.decode(buf, 'iso-8859-1');
  }
}

function buildAxiosClient(cookieHeader: string): AxiosInstance {
  return axios.create({
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    maxRedirects: 5,
    timeout: 20000,
    validateStatus: () => true,
    responseType: 'arraybuffer',
    transformResponse: [
      (data, headers) =>
        decodeSiiHtmlResponseBody(data, String(headers?.['content-type'] ?? '')),
    ],
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
      'Accept-Language': 'es-CL,es;q=0.9',
      'Cookie': cookieHeader,
    },
  });
}

/** RUT para POST login SII: `12345678-9`, `123456789` o con puntos. */
function parseRutForSiiLogin(username: string): { rutcntr: string; rut: string; dv: string } {
  const t = username.trim().replace(/\./g, '').replace(/\s/g, '');
  const d = t.lastIndexOf('-');
  if (d >= 0) {
    const rut = t.slice(0, d);
    const dv = t.slice(d + 1).toUpperCase();
    if (!rut || !dv) throw new Error('SII: RUT inválido (partes vacías)');
    return { rutcntr: `${rut}-${dv}`, rut, dv };
  }
  if (t.length >= 2) {
    const rut = t.slice(0, -1);
    const dv = t.slice(-1).toUpperCase();
    if (!/^\d+$/.test(rut)) throw new Error('SII: cuerpo del RUT debe ser numérico');
    return { rutcntr: `${rut}-${dv}`, rut, dv };
  }
  throw new Error('SII: RUT demasiado corto (ej. 12345678-9)');
}

function makeSiiLoginHttpAxios(): AxiosInstance {
  return axios.create({
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    maxRedirects: 0,
    validateStatus: () => true,
    timeout: 45000,
    responseType: 'arraybuffer',
    transformResponse: [
      (data, headers) => decodeSiiHtmlResponseBody(data, String(headers?.['content-type'] ?? '')),
    ],
  });
}

function hasSiiAuthCookies(cookieHeader: string): boolean {
  if (!cookieHeader) return false;
  const h = cookieHeader.toLowerCase();
  return (
    h.includes('token=') ||
    h.includes('csessionid=') ||
    h.includes('jsessionid=') ||
    h.includes('autentia') ||
    /session[a-z0-9_]*=/i.test(cookieHeader)
  );
}

function htmlIndicaExcesoSesionesSii(html: string): boolean {
  return /superado el m[aá]ximo de sesiones|m[aá]ximo de sesiones autenticadas/i.test(html.slice(0, 120000));
}

const MENSAJE_EXCESO_SESIONES_SII =
  'El SII indica demasiadas sesiones abiertas para su RUT. Cierre sesión en el portal (Cerrar sesión), elimine la sesión en esta app (cerrar sesión del workbench), cierre pestañas del SII en el navegador y espere unos minutos antes de volver a entrar.';

/** Formulario típico de login (Zeusr / re-login). */
function htmlEsFormularioLoginSii(html: string): boolean {
  const s = html.slice(0, 80000).toLowerCase();
  return (
    s.includes('ingresorutclave') ||
    (s.includes('id="rutcntr"') && s.includes('id="clave"')) ||
    (s.includes('name="rutcntr"') && s.includes('name="clave"'))
  );
}

function htmlPareceSalaEsperaOrAntibot(html: string): boolean {
  const s = html.slice(0, 80000).toLowerCase();
  return (
    s.includes('queue-it') ||
    s.includes('salaespera') ||
    s.includes('imperva') ||
    s.includes('needs javascript') ||
    s.includes('checking your browser') ||
    s.includes('cf-browser-verification') ||
    s.includes('datadome') ||
    s.includes('captcha')
  );
}

/** Mensaje legible si el HTML sigue siendo login Zeusr tras POST. */
function detectarMensajeErrorLoginZeusr(html: string): string | null {
  const s = html.slice(0, 120000);
  const text = s
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
  const low = text.toLowerCase();
  if (low.includes('clave incorrecta') || low.includes('contraseña incorrecta') || low.includes('password incorrect'))
    return 'Clave incorrecta (rechazada por el SII).';
  if (low.includes('rut incorrecto') || low.includes('rut no válido')) return 'RUT incorrecto según el SII.';
  if (low.includes('cuenta bloqueada') || low.includes('bloqueada temporalmente'))
    return 'Cuenta bloqueada o temporalmente suspendida (SII).';
  if (low.includes('no se encuentra registrado')) return 'RUT no registrado en el SII.';
  if (low.includes('debe ingresar') && low.includes('clave')) return 'El SII solicita volver a ingresar credenciales.';
  return null;
}

/** Campos hidden del formulario Zeusr (tokens); el SII a veces exige todos en el POST. */
function extractSiiZeusrLoginFormFields(html: string): Map<string, string> {
  const fields = new Map<string, string>();
  const lower = html.toLowerCase();
  let idx = 0;
  while (idx < html.length) {
    const formStart = lower.indexOf('<form', idx);
    if (formStart < 0) break;
    const formEnd = lower.indexOf('</form>', formStart);
    if (formEnd < 0) break;
    const slice = html.slice(formStart, formEnd);
    if (!/\brutcntr\b/i.test(slice)) {
      idx = formEnd + 7;
      continue;
    }
    const inputRe = /<input\b([^>]+)>/gi;
    let m: RegExpExecArray | null;
    while ((m = inputRe.exec(slice)) !== null) {
      const tag = m[1];
      const nameM =
        tag.match(/\bname\s*=\s*"([^"]*)"/i) ||
        tag.match(/\bname\s*=\s*'([^']*)'/i) ||
        tag.match(/\bname\s*=\s*([^\s>/]+)/i);
      const name = nameM?.[1]?.trim();
      if (!name) continue;
      const typeM = tag.match(/\btype\s*=\s*"([^"]*)"/i) || tag.match(/\btype\s*=\s*'([^']*)'/i);
      const type = (typeM?.[1] || 'text').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'image') continue;
      const valueM =
        tag.match(/\bvalue\s*=\s*"([^"]*)"/i) ||
        tag.match(/\bvalue\s*=\s*'([^']*)'/i) ||
        tag.match(/\bvalue\s*=\s*([^\s>/]+)/i);
      const value = valueM?.[1] ?? '';
      fields.set(name, value);
    }
    break;
  }
  return fields;
}

function buildZeusrLoginPostBodyFromScraped(
  scraped: Map<string, string>,
  referencia: string,
  codeFieldName: string,
  creds: { rutcntr: string; rut: string; dv: string; clave: string }
): string {
  if (scraped.size === 0) {
    return new URLSearchParams({
      rutcntr: creds.rutcntr,
      rut: creds.rut,
      dv: creds.dv,
      clave: creds.clave,
      referencia,
      [codeFieldName]: '',
    }).toString();
  }
  const params = new URLSearchParams();
  for (const [k, v] of scraped) params.set(k, v);
  params.set('rutcntr', creds.rutcntr);
  params.set('rut', creds.rut);
  params.set('dv', creds.dv);
  params.set('clave', creds.clave);
  params.set('referencia', referencia);
  if (!scraped.has(codeFieldName)) params.set(codeFieldName, '');
  return params.toString();
}

/**
 * Tras GET mipeSelEmpresa el SII puede redirigir a Zeusr (re-login, representación, etc.).
 * RepresentacionNoAut = RUT sin representación electrónica para operar MIPYME en nombre de terceros.
 */
function explicarFalloAccesoMipymeTrasSelEmpresa(finalUrl: string, htmlEmp: string): string | null {
  const u = finalUrl.toLowerCase();
  const h = htmlEmp.slice(0, 100000).toLowerCase();
  if (
    u.includes('representacionnoaut') ||
    h.includes('representacionnoaut') ||
    h.includes('representación no autorizada') ||
    h.includes('representacion no autorizada') ||
    (h.includes('representacion') && /\bno\s+aut/i.test(h))
  ) {
    return (
      'El SII devolvió “representación no autorizada” (página RepresentacionNoAut). ' +
      'El RUT configurado en SII_USERNAME no tiene representación electrónica vigente para ingresar al MIPYME/facturación de empresas de terceros, o falta aceptar la representación en Mi SII. ' +
      'Revise en misiir.sii.cl que exista representación activa para las empresas que necesita; si solo opera a título personal, use ese RUT sin actuar como representante de otras sociedades.'
    );
  }
  if (
    u.includes('ingresorutclave') ||
    (u.includes('zeusr.sii.cl') && htmlEsFormularioLoginSii(htmlEmp)) ||
    u.includes('zeus.sii.cl/aut2000')
  ) {
    return (
      'Al abrir la selección de empresa el SII redirigió al login (sesión no aceptada para www1/MIPYME o caducada). ' +
      'No es necesariamente clave incorrecta: a veces falta representación, o el acceso programático no replica el flujo del navegador. ' +
      'Si en el navegador entra bien, pruebe el flujo con Playwright; si allí también sale representación, debe regularizarla en Mi SII.'
    );
  }
  return null;
}

/** Respuesta coherente tras GET mipeSelEmpresa (selector, portal MIPYME o ya dentro sin re-login). */
function htmlPareceSeleccionEmpresaSii(html: string, selEmpresaFinalUrl: string): boolean {
  if (htmlEsFormularioLoginSii(html)) return false;
  const s = html.slice(0, 120000).toLowerCase();
  const u = selEmpresaFinalUrl.toLowerCase();
  if (/<select\b[^>]*>/i.test(html)) return true;
  if (s.includes('mipeselempresa')) return true;
  if (s.includes('rut_emp') || s.includes('seleccione empresa')) return true;
  if (u.includes('www1.sii.cl') && (s.includes('mipe') || s.includes('portal001'))) return true;
  // Respuesta sustancial en www1 sin formulario Zeusr (a veces el HTML no incluye "mipe" en el corte inicial)
  if (u.includes('www1.sii.cl') && html.length >= 2000 && !s.includes('error 501') && !s.includes('<title>error</title>'))
    return true;
  return false;
}

function parseEmpresasSelHtml(html: string): SiiEmpresa[] {
  const empresas: SiiEmpresa[] = [];
  const seen = new Set<string>();
  const re = /<option\b[^>]*>([\s\S]*?)<\/option>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const fullTag = m[0];
    const inner = m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const dq = fullTag.match(/\bvalue\s*=\s*"([^"]*)"/i);
    const sq = fullTag.match(/\bvalue\s*=\s*'([^']*)'/i);
    const uq = fullTag.match(/\bvalue\s*=\s*([^\s>'"]+)/i);
    const value = (dq?.[1] ?? sq?.[1] ?? uq?.[1] ?? '').trim();
    if (!value || /selecciona|seleccione|elija/i.test(inner)) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    empresas.push({ value, text: inner || value });
  }
  return empresas;
}

function rutEmpresaMapKey(rut: string): string {
  return rut.replace(/\./g, '').replace(/-/g, '').replace(/\s/g, '').toLowerCase();
}

function normalizarRutEmpresaValor(raw: string): string | null {
  const t = raw.replace(/\s/g, '').trim();
  if (!t) return null;
  const u = t.replace(/\./g, '');
  const conGuion = u.match(/^(\d{7,8})-([\dkK])$/i);
  if (conGuion) return `${conGuion[1]}-${conGuion[2].toUpperCase()}`;
  // Sin guión: último carácter es el DV (ej. 780151293 → 78015129-3)
  const sinGuion = u.match(/^(\d{7,8})([\dkK])$/i);
  if (sinGuion) return `${sinGuion[1]}-${sinGuion[2].toUpperCase()}`;
  return null;
}

/** Separa RUT receptor en cuerpo + DV para campos EFXP_RUT_RECEP / EFXP_DV_RECEP del SII. */
function splitRutForSiiForm(raw: string): { body: string; dv: string } | null {
  const norm = normalizarRutEmpresaValor(raw);
  if (!norm) return null;
  const [body, dv] = norm.split('-');
  return body && dv ? { body, dv } : null;
}

function extraerRutsNormalizadosEnTexto(texto: string): string[] {
  const out: string[] = [];
  const re = /\b(?:\d{1,2}\.\d{3}\.\d{3}-\s*[\dkK]|\d{7,8}-\s*[\dkK])\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(texto)) !== null) {
    const n = normalizarRutEmpresaValor(m[0].replace(/\s/g, ''));
    if (n) out.push(n);
  }
  return out;
}

/** RUTs en HTML/attrs (select, radios, data-*, href, texto) — complementa parseEmpresasSelHtml. */
function parseEmpresasRutsDesdeHtmlAmplio(html: string): SiiEmpresa[] {
  const map = new Map<string, SiiEmpresa>();
  const add = (raw: string, etiqueta?: string) => {
    const n = normalizarRutEmpresaValor(raw);
    if (!n) return;
    const k = rutEmpresaMapKey(n);
    const lab = (etiqueta || '').replace(/\s+/g, ' ').trim();
    if (map.has(k)) {
      const cur = map.get(k)!;
      if (cur.text === n && lab.length > n.length) map.set(k, { value: n, text: lab });
      return;
    }
    map.set(k, { value: n, text: lab.length ? lab : n });
  };

  const attrRe = /\b(?:value|data-value|data-rut|data-rutempresa)\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(html)) !== null) {
    add(m[1]);
    for (const r of extraerRutsNormalizadosEnTexto(m[1])) add(r);
  }

  const optRe = /<option\b[^>]*>([\s\S]*?)<\/option>/gi;
  while ((m = optRe.exec(html)) !== null) {
    const inner = m[1].replace(/<[^>]+>/g, ' ');
    for (const r of extraerRutsNormalizadosEnTexto(inner)) add(r, inner.replace(/\s+/g, ' ').trim());
  }

  for (const hm of html.matchAll(/[?&][A-Z_]*RUT[A-Z_]*=(\d{7,8}-[\dkK])/gi)) {
    add(hm[1]);
  }

  const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  const chunk = (bodyMatch ? bodyMatch[1] : html).slice(0, 280000);
  for (const r of extraerRutsNormalizadosEnTexto(chunk)) add(r);

  return [...map.values()];
}

function mergeEmpresasPreferirPrimera(primero: SiiEmpresa[], segundo: SiiEmpresa[]): SiiEmpresa[] {
  const outMap = new Map<string, SiiEmpresa>();
  for (const e of segundo) {
    const k = rutEmpresaMapKey(e.value);
    if (!outMap.has(k)) outMap.set(k, e);
  }
  for (const e of primero) outMap.set(rutEmpresaMapKey(e.value), e);
  return [...outMap.values()];
}

function urlEsVistaPreviaMipeSii(url: string): boolean {
  return /mipedisplaypreview/i.test(url);
}

async function tieneControlGuardarPreviaSii(target: Page | Frame): Promise<boolean> {
  const visFirst = async (sel: string): Promise<boolean> => {
    const loc = target.locator(sel).first();
    if ((await loc.count()) === 0) return false;
    return loc.isVisible().catch(() => false);
  };
  // Botón clásico GUARDAR
  if (await visFirst('input[name="GUARDAR"]')) return true;
  if (await visFirst('input[name="guardar"]')) return true;
  // Nuevo flujo SII: mipeDisplayPreView.cgi usa btnSign (Firmar)
  if (await visFirst('input[name="btnSign"]')) return true;
  if (await visFirst('input[name="btnCorregir"]')) return true;
  const subs = target.locator('input[type="submit"], input[type="button"], input[type="image"]');
  const n = await subs.count();
  for (let i = 0; i < n && i < 24; i++) {
    const el = subs.nth(i);
    const val = (await el.getAttribute('value').catch(() => '')) || '';
    const alt = (await el.getAttribute('alt').catch(() => '')) || '';
    if ((/guardar|firmar|btnSign/i.test(val) || /guardar|firmar/i.test(alt)) && (await el.isVisible().catch(() => false))) return true;
  }
  const byRole = target.getByRole('button', { name: /guardar|firmar/i });
  if ((await byRole.count()) > 0 && (await byRole.first().isVisible().catch(() => false))) return true;
  return false;
}

async function extraerPistaErrorPaginaEmitirSii(pg: Page): Promise<string | null> {
  const raw = await pg
    .$eval('body', (el: any) => (el.innerText || '').replace(/\s+/g, ' ').trim())
    .catch(() => '');
  if (!raw) return null;
  if (/sesi[oó]n.*expir|debe ingresar.*clave|ingresorutclave|inicioautenticaci[oó]n|iniciar sesi[oó]n/i.test(raw))
    return 'El SII parece haber pedido login otra vez o la sesión caducó. Cierre sesión en el workbench y vuelva a iniciar.';
  if (htmlIndicaExcesoSesionesSii(raw)) return MENSAJE_EXCESO_SESIONES_SII;
  const snip = raw.match(/.{0,35}(error|rechaz|inv[aá]lid|no puede|alerta|advertencia).{0,220}/i);
  return snip ? snip[0].trim().slice(0, 380) : null;
}

/** El SII a veces deja la URL en mipeGenFacEx pero ya muestra vista previa (GUARDAR, folio). */
async function paginaPareceVistaPreviaFacturaSii(p: Page): Promise<boolean> {
  try {
    const u = p.url();
    if (urlEsVistaPreviaMipeSii(u)) return true;
    if (await tieneControlGuardarPreviaSii(p)) return true;
    const txt = await p.$eval('body', (el: any) => (el.innerText || '').replace(/\s+/g, ' ')).catch(() => '');
    if (
      /vista\s+previa|previsualizaci[oó]n|documento\s+tributario\s+electr/i.test(txt) &&
      /guardar|folio\s*:/i.test(txt)
    ) {
      return true;
    }
    for (const fr of p.frames()) {
      try {
        if (urlEsVistaPreviaMipeSii(fr.url())) return true;
        if (await tieneControlGuardarPreviaSii(fr)) return true;
      } catch {
        /* frame detached / cross-origin */
      }
    }
  } catch {
    return false;
  }
  return false;
}

async function encontrarPaginaVistaPreviaEmitir(ctx: BrowserContext): Promise<Page | null> {
  for (const p of ctx.pages()) {
    if (await paginaPareceVistaPreviaFacturaSii(p)) return p;
  }
  return null;
}

async function esperarVistaPreviaTrasValidarVisualizar(
  page: Page,
  ctx: BrowserContext,
  submitAction: () => Promise<void>
): Promise<Page | null> {
  const pollMs = 280;

  const pollUntil = async (ms: number): Promise<Page | null> => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const hit = await encontrarPaginaVistaPreviaEmitir(ctx);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return null;
  };

  await page.locator('button[name="Button_Update"]').first().scrollIntoViewIfNeeded().catch(() => {});
  await page.locator('form[name="VIEW_EFXP"], form#VIEW_EFXP').first().scrollIntoViewIfNeeded().catch(() => {});

  await submitAction();
  await page.waitForLoadState('load', { timeout: 30000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1200));

  let hit = await pollUntil(52000);
  if (hit) return hit;

  const stillForm = await page.$('form[name="VIEW_EFXP"], form#VIEW_EFXP');
  if (stillForm) {
    await page
      .evaluate(() => {
        const g = globalThis as unknown as {
          VIEW_EFXP?: { submit?: () => void };
          document?: { querySelector: (s: string) => { requestSubmit?: () => void; submit: () => void } | null };
        };
        if (typeof g.VIEW_EFXP?.submit === 'function') g.VIEW_EFXP.submit();
        else {
          const form = g.document?.querySelector('form[name="VIEW_EFXP"], form#VIEW_EFXP') ?? null;
          if (form && typeof form.requestSubmit === 'function') form.requestSubmit();
          else if (form) form.submit();
        }
      })
      .catch(() => {});
    await page.waitForLoadState('load', { timeout: 30000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
    hit = await pollUntil(30000);
    if (hit) return hit;
  }

  return encontrarPaginaVistaPreviaEmitir(ctx);
}

/** Login HTTP hasta GET mipeSelEmpresa (HTML con &lt;select&gt; de empresas). */
async function siiHttpLoginUpToSelEmpresaHtml(
  username: string,
  password: string
): Promise<{
  htmlEmp: string;
  http: AxiosInstance;
  getCookieHeader: () => string;
  mergeCookies: (setCookieHeader: string | string[] | undefined) => void;
  followRedirects: (initialRes: any, initialUrl: string) => Promise<{ res: any; finalUrl: string }>;
  baseHeaders: Record<string, string>;
}> {
  const { rutcntr, rut, dv } = parseRutForSiiLogin(username);
  const cookieStore = new Map<string, string>();

  function mergeCookies(setCookieHeader: string | string[] | undefined) {
    if (!setCookieHeader) return;
    const arr = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
    for (const cookieStr of arr) {
      const [nameValue] = cookieStr.split(';');
      const eqIdx = nameValue.indexOf('=');
      if (eqIdx < 0) continue;
      const name = nameValue.substring(0, eqIdx).trim();
      const value = nameValue.substring(eqIdx + 1).trim();
      if (name) cookieStore.set(name, value);
    }
  }

  function getCookieHeader() {
    return [...cookieStore.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  const baseHeaders = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'es-CL,es;q=0.9,en;q=0.8',
  };

  const http = makeSiiLoginHttpAxios();

  async function followRedirects(initialRes: any, initialUrl: string): Promise<{ res: any; finalUrl: string }> {
    let res = initialRes;
    let currentUrl = initialUrl;
    let count = 0;
    while (
      (res.status === 301 ||
        res.status === 302 ||
        res.status === 303 ||
        res.status === 307 ||
        res.status === 308) &&
      count < 12
    ) {
      mergeCookies(res.headers['set-cookie']);
      const location: string | undefined = res.headers['location'];
      if (!location) break;
      const nextUrl = location.startsWith('http') ? location : new URL(location, currentUrl).href;
      console.log(`[SII HTTP] redirect ${res.status} → ${nextUrl.substring(0, 80)}`);
      res = await http.get(nextUrl, { headers: { ...baseHeaders, Cookie: getCookieHeader() } });
      currentUrl = nextUrl;
      count++;
    }
    mergeCookies(res.headers['set-cookie']);
    return { res, finalUrl: currentUrl };
  }

  console.log('[SII HTTP] GET login page...');
  const step1 = await http.get(SII_URLS.login, { headers: baseHeaders });
  mergeCookies(step1.headers['set-cookie']);

  const html1 = typeof step1.data === 'string' ? step1.data : String(step1.data);
  if (htmlPareceSalaEsperaOrAntibot(html1)) {
    throw new Error(
      'SII login HTTP: página de acceso muestra sala de espera o protección anti-bot (Queue-it/Imperva/etc.). Pruebe desde otra red o use el flujo con navegador (Playwright).'
    );
  }
  const loginUrlParts = SII_URLS.login.split('?');
  const referencia =
    loginUrlParts.length > 1 ? loginUrlParts.slice(1).join('?') : 'https://misiir.sii.cl/cgi_misii/siihome.cgi';

  const codeMatch =
    html1.match(/<input[^>]*id="code"[^>]*name="(\d+)"/i) ||
    html1.match(/<input[^>]*name="(\d+)"[^>]*id="code"/i);
  const codeFieldName = codeMatch?.[1] ?? '411';

  const scrapedFields = extractSiiZeusrLoginFormFields(html1);
  console.log(`[SII HTTP] referencia="${referencia}", codeField="${codeFieldName}", formFields=${scrapedFields.size}, cookies: ${cookieStore.size}`);

  const postPayload = buildZeusrLoginPostBodyFromScraped(scrapedFields, referencia, codeFieldName, {
    rutcntr,
    rut,
    dv,
    clave: password,
  });

  console.log('[SII HTTP] POST credenciales...');
  const postRes = await http.post(
    'https://zeusr.sii.cl/cgi_AUT2000/CAutInicio.cgi',
    postPayload,
    {
      headers: {
        ...baseHeaders,
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: SII_URLS.login,
        Origin: 'https://zeusr.sii.cl',
        Cookie: getCookieHeader(),
      },
    }
  );
  const { res: loginRes, finalUrl: loginUrl } = await followRedirects(
    postRes,
    'https://zeusr.sii.cl/cgi_AUT2000/CAutInicio.cgi'
  );
  console.log(`[SII HTTP] Login final URL: ${loginUrl}, status: ${loginRes.status}`);

  const loginBodyAfterPost = typeof loginRes.data === 'string' ? loginRes.data : String(loginRes.data);
  if (htmlIndicaExcesoSesionesSii(loginBodyAfterPost)) {
    throw new Error(MENSAJE_EXCESO_SESIONES_SII);
  }
  if (htmlPareceSalaEsperaOrAntibot(loginBodyAfterPost)) {
    throw new Error(
      'SII login HTTP: tras enviar credenciales aparece sala de espera o anti-bot. El login programático no puede continuar en este entorno.'
    );
  }
  const loginUrlLow = loginUrl.toLowerCase();
  if (loginUrlLow.includes('zeusr.sii.cl') && htmlEsFormularioLoginSii(loginBodyAfterPost)) {
    const det = detectarMensajeErrorLoginZeusr(loginBodyAfterPost);
    throw new Error(
      det ||
        'Login Zeusr: el SII sigue mostrando el formulario de acceso (RUT/clave incorrectos, o faltan campos del formulario).'
    );
  }

  const cookiesAfterLogin = getCookieHeader();
  if (!hasSiiAuthCookies(cookiesAfterLogin)) {
    console.warn(
      `[SII HTTP] No se detectaron cookies token/csessionid/jsessionid (${cookieStore.size} cookies guardadas); se valida con misiir + mipeSelEmpresa…`
    );
  }

  console.log('[SII HTTP] GET misiir siihome (enlazar sesión con portal MIPYME)...');
  const homeGetRaw = await http.get(SII_URLS.siiHome, {
    headers: {
      ...baseHeaders,
      Cookie: getCookieHeader(),
      Referer: loginUrl,
    },
  });
  await followRedirects(homeGetRaw, SII_URLS.siiHome);

  console.log('[SII HTTP] GET selEmpresa...');
  const empGetRaw = await http.get(SII_URLS.selEmpresa, {
    headers: {
      ...baseHeaders,
      Cookie: getCookieHeader(),
      Referer: SII_URLS.siiHome,
      Origin: 'https://www1.sii.cl',
    },
  });
  const { res: empGet, finalUrl: selEmpresaFinalUrl } = await followRedirects(empGetRaw, SII_URLS.selEmpresa);
  const htmlEmp = typeof empGet.data === 'string' ? empGet.data : String(empGet.data);

  if (htmlIndicaExcesoSesionesSii(htmlEmp)) {
    throw new Error(MENSAJE_EXCESO_SESIONES_SII);
  }

  if (!htmlPareceSeleccionEmpresaSii(htmlEmp, selEmpresaFinalUrl)) {
    const especifico = explicarFalloAccesoMipymeTrasSelEmpresa(selEmpresaFinalUrl, htmlEmp);
    if (especifico) throw new Error(especifico);
    const loginBody =
      typeof loginRes.data === 'string' ? loginRes.data : String(loginRes.data);
    const snippet = loginBody.substring(0, 500).replace(/\s+/g, ' ');
    throw new Error(
      `Login SII HTTP: la sesión no llegó a empresa MIPYME. URL final selEmpresa: ${selEmpresaFinalUrl}. Login POST terminó en: ${loginUrl}. Tras selEmpresa no hay selector/portal. Login body: ${snippet}`
    );
  }

  return { htmlEmp, http, getCookieHeader, mergeCookies, followRedirects, baseHeaders };
}

function emitidoDocUrl(codigo: string): string {
  return `https://www1.sii.cl/cgi-bin/Portal001/mipeGesDocEmi.cgi?CODIGO=${encodeURIComponent(codigo)}`;
}

/** Misma pág. 1 que getFacturasEmitidas — el SII a veces exige Referer desde el listado. */
function listadoEmitidosRefererPage1(): string {
  const params = new URLSearchParams({
    RUT_RECP: '',
    FOLIO: '',
    RZN_SOC: '',
    FEC_DESDE: '',
    FEC_HASTA: '',
    TPO_DOC: '',
    ESTADO: '',
    ORDEN: '',
    NUM_PAG: '1',
  });
  return `${SII_URLS.listadoEmitidos}?${params}`;
}

function emitidoFetchExtraHeaders(refererListado?: string): Record<string, string> {
  return {
    Referer: refererListado || listadoEmitidosRefererPage1(),
    Origin: 'https://www1.sii.cl',
  };
}

function absolutizeGesDocHref(href: string): string {
  const cleaned = href.replace(/&amp;/g, '&').trim();
  if (/^https?:\/\//i.test(cleaned)) return cleaned;
  return new URL(cleaned, 'https://www1.sii.cl/cgi-bin/Portal001/').href;
}

/**
 * Enlace real desde el listado (incluye csrt, ALL_PAGE_ANT, etc.).
 * Solo retorna el link si tiene csrt — sin csrt el SII devuelve ptr NULL 501.
 * Si ptrTkn no está activo, el servidor no genera csrt en los hrefs y hay que
 * usar Playwright para obtenerlo via flujo real de navegación.
 */
function findGesDocEmiLinkForCodigo(html: string, codigo: string): string | null {
  const re = /href=["']([^"']*mipeGesDocEmi\.cgi\?[^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = absolutizeGesDocHref(m[1]);
    try {
      const u = new URL(href);
      if (u.searchParams.get('CODIGO') === codigo && u.searchParams.has('csrt')) return href;
    } catch {
      if ((href.includes(`CODIGO=${codigo}`) || href.includes(`CODIGO=${codigo}&`)) && href.includes('csrt=')) return href;
    }
  }
  return null;
}

async function setEmitidoPlaywrightCookies(
  page: Page,
  cookieHeader: string | undefined
): Promise<void> {
  if (!cookieHeader?.trim()) return;
  const parsed = cookieHeader.split(';')
    .map(c => {
      const eqIdx = c.indexOf('=');
      if (eqIdx === -1) return null;
      return {
        name: c.substring(0, eqIdx).trim(),
        value: c.substring(eqIdx + 1).trim(),
      };
    })
    .filter((c): c is { name: string; value: string } => c !== null && c.name.length > 0);
  if (parsed.length === 0) return;

  const domains = ['.sii.cl', 'www1.sii.cl', 'www4.sii.cl', 'zeusr.sii.cl'];
  for (const domain of domains) {
    const cookies = parsed.map((c) => ({ ...c, domain, path: '/' }));
    await page.context().addCookies(cookies).catch(() => {});
  }
}

function isLoginLikeHtml(html: string): boolean {
  // Chequear el INPUT del formulario de login, no solo menciones del string.
  // Las páginas válidas del SII incluyen 'rutcntr' e 'IngresoRutClave' en los
  // scripts del header de navegación (responsive_barranav.js), generando falsos positivos.
  return html.includes('id="rutcntr"') || html.includes("id='rutcntr'");
}

/** Bloqueo duro del SII (anti-bot / navegador dañado) — distinto de Error 501 por sesión sin ptrTkn. */
function isSiiHardBlockHtml(html: string): boolean {
  const h = html.toLowerCase().replace(/&nbsp;/gi, ' ').replace(/\u00a0/g, ' ');
  return (
    h.includes('no ha sido bien recepcionado') ||
    /\b02\.35\.\d/.test(html) ||
    (h.includes('mesa de ayuda telef') && h.includes('está dañado')) ||
    (h.includes('proveedor de internet') && h.includes('está dañado'))
  );
}

/** Página de error SII (datacenter/navegador automático, sesión sin ptrTkn, etc.) */
function isSiiRejectionOrBlockHtml(html: string): boolean {
  return isSiiHardBlockHtml(html) || SiiFacturacionService.isSiiPtrTknErrorHtml(html);
}

/** Listado de emitidos cargado y usable (ptrTkn / empresa OK). Acepta listado vacío sin filas CODIGO. */
function htmlListadoEmitidosOperativo(html: string): boolean {
  if (!html?.trim() || isLoginLikeHtml(html)) return false;
  if (SiiFacturacionService.isSiiPtrTknErrorHtml(html) || isSiiHardBlockHtml(html)) return false;
  if (/ingresorutclave\.cgi/i.test(html)) return false;

  const h = html.toLowerCase();

  if (h.includes('mipeadmindocsemi')) return true;
  if (h.includes('docs emitidos') || h.includes('documentos emitidos')) return true;
  if (/codigo=\d{4,}/i.test(html)) return true;

  // Formulario de consulta del listado (con o sin resultados)
  const hasListadoForm =
    (h.includes('fec_desde') || h.includes('fec_hasta')) &&
    (h.includes('num_pag') || h.includes('tpo_doc') || h.includes('rut_recp'));
  if (hasListadoForm && h.includes('mipe')) return true;

  if (h.includes('rut_recp') && h.includes('rzn_soc') && h.includes('portal001')) return true;
  if (h.includes('mipegesdocemi') || h.includes('mipegenfacex')) return true;

  if (h.includes('portal001') && h.includes('mipe') && html.length > 1800) {
    if (
      h.includes('folio') ||
      h.includes('estado') ||
      h.includes('emitid') ||
      h.includes('consulta') ||
      h.includes('buscar')
    ) {
      return true;
    }
  }

  return false;
}

function listadoEmitidosUrlPagina1(): string {
  return listadoEmitidosRefererPage1();
}

function dialogIndicaEmpresaNoSeleccionada(msg: string): boolean {
  const m = msg.toLowerCase();
  return m.includes('no ha seleccionado una empresa') || m.includes('no ha seleccionado empresa');
}

function normalizeEmitidoHtml(html: string): string {
  let out = html;
  if (!/<base[\s>]/i.test(out)) {
    out = out.replace(/<head[^>]*>/i, (m) => `${m}<base href="https://www1.sii.cl/">`);
  }
  out = out.replace(/href="\//g, 'href="https://www1.sii.cl/');
  out = out.replace(/src="\//g, 'src="https://www1.sii.cl/');
  out = out.replace(/action="\//g, 'action="https://www1.sii.cl/');
  return out;
}

function parseMonto(str: string): number {
  const n = parseInt((str || '0').replace(/[^\d]/g, ''), 10);
  return isNaN(n) ? 0 : n;
}

function detectTipoCodigo(tipoText: string): number {
  const raw = tipoText || '';
  const t = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (/boleta/i.test(raw) && /exenta/i.test(raw)) return 41;
  if (/\bboleta\b/i.test(raw)) return 39;
  if (/nota\s+de\s+credito|nota.*credito/i.test(t)) return 61;
  if (/nota\s+de\s+debito|nota.*debito/i.test(t)) return 56;
  if (/guia|despacho/i.test(t)) return 52;
  if (/liquidacion/i.test(t)) return 43;
  if (/factura\s+de\s+compra|compra\s+electron/i.test(t)) return 46;
  if (/exportacion/i.test(t)) {
    if (/credito/i.test(t)) return 112;
    if (/debito/i.test(t)) return 111;
    return 110;
  }
  if (/exenta/i.test(raw)) return 34;
  if (/electronica|factura/i.test(t)) return 33;
  return 33;
}

const HTML_ENTITY_NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

/** Decodifica &#38;, &#43;, &amp;, etc. (el SII escapa símbolos en tablas y forms). */
function decodeHtmlEntities(raw: string): string {
  if (!raw) return raw;
  return raw
    .replace(/&#x([0-9a-f]+);/gi, (full, h) => {
      const cp = parseInt(h, 16);
      if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return full;
      try {
        return String.fromCodePoint(cp);
      } catch {
        return full;
      }
    })
    .replace(/&#(\d+);/g, (full, d) => {
      const cp = parseInt(d, 10);
      if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return full;
      try {
        return String.fromCodePoint(cp);
      } catch {
        return full;
      }
    })
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (full, name) => HTML_ENTITY_NAMED[name.toLowerCase()] ?? full);
}

function decodeFacturaEntityForApi(f: SiiFacturaEntity): SiiFacturaEntity {
  const out = { ...f };
  const dec = (s: string | null | undefined) => (s ? decodeHtmlEntities(s) : s);
  out.razonSocial = dec(out.razonSocial) ?? out.razonSocial;
  out.tipoDocumento = dec(out.tipoDocumento) ?? out.tipoDocumento;
  out.estado = dec(out.estado) ?? out.estado;
  out.dirReceptor = dec(out.dirReceptor) ?? out.dirReceptor;
  out.comunaReceptor = dec(out.comunaReceptor) ?? out.comunaReceptor;
  out.ciudadReceptor = dec(out.ciudadReceptor) ?? out.ciudadReceptor;
  out.giroReceptor = dec(out.giroReceptor) ?? out.giroReceptor;
  out.formaPago = dec(out.formaPago) ?? out.formaPago;
  if (out.items?.length) {
    out.items = out.items.map((it) => ({
      ...it,
      descripcion: decodeHtmlEntities(it.descripcion || ''),
      unidad: decodeHtmlEntities(it.unidad || ''),
      codigo: it.codigo ? decodeHtmlEntities(it.codigo) : it.codigo,
    }));
  }
  if (out.detalleExtendido && typeof out.detalleExtendido === 'object') {
    const decExt: Record<string, string> = {};
    for (const [k, v] of Object.entries(out.detalleExtendido)) {
      decExt[k] = typeof v === 'string' ? decodeHtmlEntities(v) : String(v);
    }
    out.detalleExtendido = decExt;
  }
  return out;
}

/** Misma factura (tipo+folio) puede aparecer 2+ veces con distinto CODIGO interno SII — dejamos un registro (mejor detalle/PDF). */
function dedupeSiiFacturasPorTipoYFolio(rows: SiiFacturaEntity[]): SiiFacturaEntity[] {
  const sinFolio: SiiFacturaEntity[] = [];
  const porClave = new Map<string, SiiFacturaEntity>();
  const score = (r: SiiFacturaEntity) =>
    (r.detalleCompleto ? 4 : 0) +
    (r.hasPdf ? 2 : 0) +
    (r.rutReceptor ? 1 : 0) +
    r.id / 1e9;
  for (const f of rows) {
    if (!f.folio || f.folio <= 0) {
      sinFolio.push(f);
      continue;
    }
    const k = `${f.tipoCodigo ?? 33}-${f.folio}`;
    const prev = porClave.get(k);
    if (!prev || score(f) >= score(prev)) porClave.set(k, f);
  }
  const merged = [...sinFolio, ...porClave.values()];
  merged.sort((a, b) => {
    const df = (b.folio || 0) - (a.folio || 0);
    if (df !== 0) return df;
    return b.id - a.id;
  });
  return merged;
}

/** En el listado SII, mismo tipo+folio puede venir con dos CODIGO — una sola fila al persistir. */
function dedupeListaSiiPorTipoYFolio(items: SiiFactura[]): SiiFactura[] {
  const sinFolio: SiiFactura[] = [];
  const map = new Map<string, SiiFactura>();
  const score = (f: SiiFactura) =>
    (f.rutReceptor ? 2 : 0) + (f.razonSocial?.length ?? 0) + (parseInt(f.codigo, 10) || 0) / 1e15;
  for (const f of items) {
    if (!f.folio || f.folio <= 0) {
      sinFolio.push(f);
      continue;
    }
    const k = `${f.tipoCodigo ?? 33}-${f.folio}`;
    const prev = map.get(k);
    if (!prev || score(f) > score(prev)) map.set(k, f);
  }
  return [...sinFolio, ...map.values()];
}

/** Extrae filas <tr> con sus <td> (texto plano) y <a href> */
function parseTableRows(html: string): Array<{ cells: string[]; links: string[] }> {
  const rows: Array<{ cells: string[]; links: string[] }> = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trM: RegExpExecArray | null;
  while ((trM = trRe.exec(html)) !== null) {
    const inner = trM[1];
    const cells: string[] = [];
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let tdM: RegExpExecArray | null;
    while ((tdM = tdRe.exec(inner)) !== null) {
      const plain = tdM[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      cells.push(decodeHtmlEntities(plain));
    }
    const links: string[] = [];
    const aRe = /href=["']([^"']+)["']/gi;
    let aM: RegExpExecArray | null;
    while ((aM = aRe.exec(inner)) !== null) {
      links.push(aM[1]);
    }
    if (cells.length > 0) rows.push({ cells, links });
  }
  return rows;
}

/** Extrae atributo de un tag HTML (con o sin comillas) */
function getAttr(tag: string, attr: string): string | null {
  // Con comillas dobles o simples: name="X" | name='X'
  const q = tag.match(new RegExp(`${attr}=["']([^"']*)["']`, 'i'));
  if (q) return q[1];
  // Sin comillas: name=X (hasta espacio o >)
  const u = tag.match(new RegExp(`${attr}=([^\\s>]+)`, 'i'));
  if (u) return u[1];
  return null;
}

/** Une valores al mapa con nombre en MAYÚSCULAS; no pisa un valor previo no vacío con uno vacío. */
function mergeFormField(map: Map<string, string>, rawName: string | null, rawValue: string): void {
  if (!rawName || !String(rawName).trim()) return;
  const key = String(rawName).trim().toUpperCase();
  const v = decodeHtmlEntities(rawValue ?? '').trim();
  const prev = map.get(key);
  if (v) {
    map.set(key, v);
  } else if (prev === undefined) {
    map.set(key, '');
  }
}

/** Extrae todos los valores de inputs/textareas/selects por nombre del HTML */
function parseFormFields(html: string): Map<string, string> {
  const map = new Map<string, string>();

  // <input ...>
  const inputRe = /<input([^>]*?)>/gi;
  let m: RegExpExecArray | null;
  while ((m = inputRe.exec(html)) !== null) {
    const attrs = m[1];
    let fieldName = getAttr(attrs, 'name');
    if (!fieldName) {
      const id = getAttr(attrs, 'id');
      if (id && /^EFXP_/i.test(id)) fieldName = id;
    }
    const value = getAttr(attrs, 'value') ?? '';
    if (fieldName) mergeFormField(map, fieldName, value);
  }

  // <textarea name="X">valor</textarea>
  const taRe = /<textarea([^>]*)>([\s\S]*?)<\/textarea>/gi;
  while ((m = taRe.exec(html)) !== null) {
    let fieldName = getAttr(m[1], 'name');
    if (!fieldName) {
      const id = getAttr(m[1], 'id');
      if (id && /^EFXP_/i.test(id)) fieldName = id;
    }
    if (fieldName) mergeFormField(map, fieldName, m[2].trim());
  }

  // <select name="X"> — selected por atributo, texto de option selected, o primera option con value
  const selectRe = /<select([^>]*)>([\s\S]*?)<\/select>/gi;
  while ((m = selectRe.exec(html)) !== null) {
    const name = getAttr(m[1], 'name');
    if (!name) continue;
    const block = m[2];
    let chosen = '';
    const selOpt =
      block.match(/<option[^>]*\bselected\b[^>]*value=["']([^"']*)["']/i) ||
      block.match(/<option[^>]*value=["']([^"']*)["'][^>]*\bselected\b/i);
    if (selOpt) chosen = selOpt[1] ?? '';
    if (!String(chosen).trim()) {
      const selText = block.match(/<option[^>]*\bselected\b[^>]*>([^<]*)</i);
      if (selText) chosen = selText[1].trim();
    }
    if (!String(chosen).trim()) {
      const firstVal = block.match(/<option[^>]*value=["']([^"']+)["']/i);
      if (firstVal) chosen = firstVal[1];
    }
    mergeFormField(map, name, chosen);
  }
  return map;
}

/**
 * El SII embebe los valores de detalle en `datosArray[i] = [ ['EFXP_NMB_01','x'], ...]` dentro de un
 * <script>; los <input> suelen ir vacíos hasta que corre el JS en el navegador. Axios solo ve el HTML.
 * Algunas respuestas usan comillas dobles o otro espaciado; si no hay `datosArray[0]`, se ancla en EFXP_NMB_01.
 */
function extractDatosArrayScriptChunk(html: string): string {
  const candidates: number[] = [];
  const i0 = html.indexOf('datosArray[0]');
  if (i0 >= 0) candidates.push(i0);
  const i1 = html.search(/datosArray\s*\[\s*0\s*\]\s*=\s*\[/);
  if (i1 >= 0) candidates.push(i1);
  const i2 = html.search(/datosArray\s*\[\s*0\s*\]/);
  if (i2 >= 0) candidates.push(i2);
  let start = candidates.length ? Math.min(...candidates) : -1;
  if (start < 0) {
    const nm = html.search(/['"]EFXP_NMB_0?1['"]\s*,/);
    if (nm < 0) return '';
    start = Math.max(0, nm - 14000);
  }
  const end = html.indexOf('</script>', start);
  return end > start ? html.slice(start, end) : html.slice(start, start + 280000);
}

function mergeEfxpKeyValuePairsFromChunk(chunk: string, campos: Map<string, string>): number {
  let n = 0;
  const run = (re: RegExp) => {
    const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    let m: RegExpExecArray | null;
    while ((m = r.exec(chunk)) !== null) {
      const keyRaw = m[1].trim();
      if (!/^EFXP_/i.test(keyRaw)) continue;
      const rawInner = m[2].replace(/\\'/g, "'").replace(/\\"/g, '"');
      const v = decodeHtmlEntities(rawInner).trim();
      if (!v) continue;
      mergeFormField(campos, keyRaw, m[2]);
      n++;
    }
  };
  run(/\[\s*'([^']+)'\s*,\s*'((?:[^'\\]|\\.)*)'\s*\]/g);
  run(/\[\s*"([^"]+)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*\]/g);
  return n;
}

function augmentCamposFromDatosArrayScript(html: string, campos: Map<string, string>): number {
  const chunk = extractDatosArrayScriptChunk(html);
  if (!chunk) return 0;
  return mergeEfxpKeyValuePairsFromChunk(chunk, campos);
}

/** Forma de pago a veces solo en `var arrPagos = [ ['2','Crédito',''], ...]`; el <select> lo inserta printFormaDePago(). */
function augmentFormaPagoFromArrPagosScript(html: string, campos: Map<string, string>): void {
  const get = (k: string) => (campos.get(k) || '').trim();
  if (get('EFXP_DSC_FMA_PAGO') || get('EFXP_GLS_FMA_PAGO')) return;
  if (get('EFXP_FMA_PAGO') && !/^0+$/.test(get('EFXP_FMA_PAGO'))) return;

  const idx = html.indexOf('var arrPagos');
  if (idx < 0) return;
  const slice = html.slice(idx, idx + 4000);
  const bra = slice.indexOf('[');
  const end = slice.indexOf('];', bra);
  if (bra < 0 || end < 0) return;
  const inner = slice.slice(bra, end);
  const re = /\[\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) {
    const a = decodeHtmlEntities(m[1]).trim();
    const b = decodeHtmlEntities(m[2]).trim();
    const c = decodeHtmlEntities(m[3]).trim();
    const textCand = [b, c, a].find((t) => t && !/^\d+$/.test(t) && t.length >= 2);
    if (textCand) {
      mergeFormField(campos, 'EFXP_DSC_FMA_PAGO', textCand);
      return;
    }
    const code = a || b;
    if (code && SII_FMA_PAGO_GLOSA[code]) {
      mergeFormField(campos, 'EFXP_FMA_PAGO', code);
      return;
    }
  }
}

/** arrReferencias (orden de compra, etc.) no siempre tiene inputs visibles en el HTML estático. */
function augmentReferenciasResumenFromScript(html: string, campos: Map<string, string>): void {
  if ((campos.get('EFXP_REFERENCIAS_RESUMEN') || '').trim()) return;
  const idx = html.indexOf('var arrReferencias');
  if (idx < 0) return;
  const slice = html.slice(idx, Math.min(idx + 12000, html.length));
  const innerM = slice.match(/var\s+arrReferencias\s*=\s*\[([\s\S]*?)\]\s*;/);
  if (!innerM) return;
  const inner = innerM[1];
  const rowRe =
    /\[\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*\]/g;
  const parts: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(inner)) !== null) {
    const tipo = m[1].trim();
    const c3 = decodeHtmlEntities(m[3]).trim();
    const c4 = decodeHtmlEntities(m[4]).trim();
    if (!c3 && !c4) continue;
    if (c3.startsWith('PO') && c4) {
      parts.push(`Orden de compra N° ${c3} del ${c4}`);
    } else if (tipo === '801' && c3 && c4) {
      parts.push(`Orden de compra N° ${c3} del ${c4}`);
    } else {
      const line = [c3, c4].filter(Boolean).join(' · ');
      if (line) parts.push(line);
    }
  }
  if (parts.length) mergeFormField(campos, 'EFXP_REFERENCIAS_RESUMEN', parts.join(' | '));
}

function escapeReVarName(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Literal `var nombre = [ ... ];` con corchetes anidados y strings entre comillas. */
function extractVarArrayAfterAssignment(html: string, varName: string): string {
  const re = new RegExp(`var\\s+${escapeReVarName(varName)}\\s*=\\s*`, 'i');
  const m = html.match(re);
  if (!m || m.index === undefined) return '';
  let i = m.index + m[0].length;
  while (i < html.length && /\s/.test(html[i])) i++;
  if (html[i] !== '[') return '';
  let depth = 0;
  const start = i;
  let inStr: '"' | "'" | null = null;
  let esc = false;
  for (; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (c === '\\') {
        esc = true;
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = c;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  return '';
}

/** Matriz JS `[[ "a","b" ], ...]` → filas de strings (mín. 2 celdas por fila). */
function parseJsNestedStringMatrix(body: string): string[][] {
  const rows: string[][] = [];
  let i = 0;
  const decode = (s: string) => decodeHtmlEntities(s);
  const readString = (): string | null => {
    while (i < body.length && /\s/.test(body[i])) i++;
    const q = body[i];
    if (q !== '"' && q !== "'") return null;
    i++;
    let buf = '';
    let esc = false;
    while (i < body.length) {
      const c = body[i++];
      if (esc) {
        if (c === 'n') buf += '\n';
        else if (c === 'r') buf += '\r';
        else if (c === 't') buf += '\t';
        else buf += c;
        esc = false;
        continue;
      }
      if (c === '\\') {
        esc = true;
        continue;
      }
      if (c === q) return decode(buf);
      buf += c;
    }
    return null;
  };
  while (i < body.length) {
    while (i < body.length && body[i] !== '[') i++;
    if (i >= body.length) break;
    i++;
    const cells: string[] = [];
    while (i < body.length) {
      while (i < body.length && /[\s,]/.test(body[i])) i++;
      if (body[i] === ']') {
        i++;
        break;
      }
      const s = readString();
      if (s === null) break;
      cells.push(s);
    }
    if (cells.length >= 2) rows.push(cells);
  }
  return rows;
}

/**
 * Algunas respuestas no traen el bloque `datosArray[0]` en el trozo que leemos; otros <script> sí tienen pares EFXP_*.
 */
function augmentCamposFromLooseEfxpScriptPairs(html: string, campos: Map<string, string>): void {
  const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let sm: RegExpExecArray | null;
  while ((sm = scriptRe.exec(html)) !== null) {
    const body = sm[1];
    if (!/EFXP_NMB_\d+/i.test(body)) continue;
    mergeEfxpKeyValuePairsFromChunk(body, campos);
  }
}

/** Dirección y giro del receptor a veces solo en `recptorDir` / `recptoActEco` (axios no ejecuta JS). */
function augmentReceptorFromRecptorDirActEcoScripts(html: string, campos: Map<string, string>): void {
  const getVal = (k: string) => campos.get(k) || '';
  const dirNow = pickDirReceptorFromCampos(campos, getVal).trim();
  const giroNow = pickGiroReceptorFromCampos(campos, getVal).trim();
  if (dirNow && giroNow) return;

  const innerDir =
    extractVarArrayAfterAssignment(html, 'recptorDir') ||
    extractVarArrayAfterAssignment(html, 'receptorDir');
  const innerGiro =
    extractVarArrayAfterAssignment(html, 'recptoActEco') ||
    extractVarArrayAfterAssignment(html, 'receptoActEco');
  if (!innerDir && !innerGiro) return;

  const dirRows = innerDir ? parseJsNestedStringMatrix(innerDir) : [];
  const giroRows = innerGiro ? parseJsNestedStringMatrix(innerGiro) : [];

  const norm = (s: string) =>
    s
      .replace(/\./g, '')
      .replace(/;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toUpperCase();

  const comunaRec = getVal('EFXP_CMNA_RECEP').trim();
  const ciudadRec = getVal('EFXP_CIUDAD_RECEP').trim();
  const cn = norm(comunaRec);
  const cin = norm(ciudadRec);

  const isPlaceholderDirRow = (row: string[]) =>
    row.length >= 2 && row[0] === '0' && row[1] === '0';
  const isPlaceholderGiroRow = (row: string[]) =>
    row.length >= 2 && row[0] === '0' && row[1] === '0';

  let idx = dirRows.findIndex((row) => {
    if (row.length < 3 || isPlaceholderDirRow(row)) return false;
    const addr = row[0];
    const comuna = row[1];
    const ciudad = row[2] || '';
    if (!addr || addr === '0') return false;
    const c1 = norm(comuna);
    const c2 = norm(ciudad);
    if (cn && (c1 === cn || c1.includes(cn) || cn.includes(c1))) return true;
    if (cin && (c2 === cin || c2.includes(cin) || cin.includes(c2))) return true;
    return false;
  });

  if (idx < 0) {
    idx = dirRows.findIndex((row) => row.length >= 1 && row[0] && row[0] !== '0' && !isPlaceholderDirRow(row));
  }

  if (!dirNow) {
    const row =
      (idx >= 0 ? dirRows[idx] : undefined) ||
      dirRows.find((r) => r[0] && r[0] !== '0' && !isPlaceholderDirRow(r));
    const d = row?.[0]?.trim();
    if (d && d !== '0') mergeFormField(campos, 'EFXP_DIR_RECEP', d);
  }

  if (!giroNow) {
    let g = '';
    const gr = idx >= 0 && idx < giroRows.length ? giroRows[idx] : undefined;
    if (gr && gr.length >= 2 && gr[1] && gr[1] !== '0' && !isPlaceholderGiroRow(gr)) g = gr[1];
    if (!g) {
      const alt = giroRows.find(
        (r) => r.length >= 2 && r[1] && r[1] !== '0' && !isPlaceholderGiroRow(r)
      );
      if (alt) g = alt[1];
    }
    if (g) mergeFormField(campos, 'EFXP_GIRO_RECEP', g);
  }
}

/** Campos de línea de detalle (ya representados en `items`) — no duplicar en vista de pares clave/valor. */
function esCampoLineaDetalleEfxp(key: string): boolean {
  return /^EFXP_(NMB|QTY|PRC|SUBT|PCTD|UNMD|CDG|COD|CODITEM|COD_INT|IND|ID|DSC_ITEM|DSC_LIN|ITEM_NMB|DSC_DET|PCT_IVA_ADIC|IMPTO_ADIC|PCT_IMPTO_ADIC)_\d+/i.test(
    key
  );
}

function efxpSuffixVariants(i: number): string[] {
  const s = String(i);
  return [...new Set([s, s.padStart(2, '0'), s.padStart(3, '0')])];
}

function getValEfxpLine(getVal: (n: string) => string, fieldPrefix: string, i: number): string {
  for (const suf of efxpSuffixVariants(i)) {
    const v = getVal(`${fieldPrefix}${suf}`).trim();
    if (v) return v;
  }
  return '';
}

function discoverEfxpDetalleLineIndices(campos: Map<string, string>): number[] {
  const indices = new Set<number>();
  const reList = [
    /^EFXP_NMB_(\d+)$/i,
    /^EFXP_QTY_(\d+)$/i,
    /^EFXP_PRC_(\d+)$/i,
    /^EFXP_SUBT_(\d+)$/i,
    /^EFXP_DSC_ITEM_(\d+)$/i,
    /^EFXP_DSC_LIN_(\d+)$/i,
    /^EFXP_ITEM_NMB_(\d+)$/i,
    /^EFXP_DSC_DET_(\d+)$/i,
  ];
  for (const k of campos.keys()) {
    for (const re of reList) {
      const m = k.match(re);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > 0 && n < 200) indices.add(n);
      }
    }
  }
  return [...indices].sort((a, b) => a - b);
}

function pickItemCodigoLine(getVal: (n: string) => string, i: number): string {
  const bases = ['EFXP_CDG_', 'EFXP_CODITEM_', 'EFXP_COD_INT_', 'EFXP_COD_'];
  for (const b of bases) {
    const v = getValEfxpLine(getVal, b, i);
    if (v) return v;
  }
  return '';
}

function pickItemImptoLine(getVal: (n: string) => string, i: number): number | undefined {
  for (const suf of efxpSuffixVariants(i)) {
    const raw =
      getVal(`EFXP_PCT_IVA_ADIC_${suf}`) ||
      getVal(`EFXP_IMPTO_ADIC_${suf}`) ||
      getVal(`EFXP_PCT_IMPTO_ADIC_${suf}`);
    const n = parseFloat(String(raw).replace(',', '.'));
    if (Number.isFinite(n) && n !== 0) return n;
  }
  return undefined;
}

function firstPositiveMonto(getVal: (k: string) => string, keys: string[]): number {
  for (const k of keys) {
    const v = parseMonto(getVal(k));
    if (v > 0) return v;
  }
  return 0;
}

function firstNonEmptyTrimmed(getVal: (k: string) => string, keys: string[]): string {
  for (const k of keys) {
    const v = getVal(k).trim();
    if (v) return v;
  }
  return '';
}

function pickFromCamposByRegex(
  campos: Map<string, string>,
  patterns: RegExp[],
  excludeKey?: RegExp
): string {
  for (const [k, v] of campos) {
    const t = (v || '').trim();
    if (!t) continue;
    if (excludeKey && excludeKey.test(k)) continue;
    for (const re of patterns) {
      if (re.test(k)) return t;
    }
  }
  return '';
}

const SII_FMA_PAGO_GLOSA: Record<string, string> = {
  '1': 'Contado',
  '2': 'Crédito',
  '3': 'Sin costo',
  '901': 'Contado',
  '902': 'Crédito',
};

function resolveFormaPagoText(campos: Map<string, string>, getVal: (k: string) => string): string {
  const dsc = firstNonEmptyTrimmed(getVal, [
    'EFXP_DSC_FMA_PAGO',
    'EFXP_GLS_FMA_PAGO',
    'EFXP_FMA_PAGO_DESC',
    'EFXP_DESC_FMA_PAGO',
  ]);
  if (dsc && !/^\d+$/.test(dsc)) return dsc;
  const code = firstNonEmptyTrimmed(getVal, ['EFXP_FMA_PAGO', 'EFXP_FORMA_PAGO', 'EFXP_FMA_PGO']);
  if (code && SII_FMA_PAGO_GLOSA[code]) return SII_FMA_PAGO_GLOSA[code];
  const fromRegex = pickFromCamposByRegex(campos, [/DSC_FMA|GLS_FMA|DESC_FMA|FMA_PAGO_DESC/i]);
  if (fromRegex && !/^\d+$/.test(fromRegex)) return fromRegex;
  return dsc || code || fromRegex;
}

function pickDirReceptorFromCampos(campos: Map<string, string>, getVal: (k: string) => string): string {
  const direct = firstNonEmptyTrimmed(getVal, [
    'EFXP_DIR_RECEP_DEFUALT',
    'EFXP_DIR_RECEP_DEFAULT',
    'EFXP_DIR_RECEP',
    'EFXP_DIRREC',
    'EFXP_DIR_RECEP_E',
    'EFXP_DIR_RECEPTOR',
    'EFXP_DIRECCION_RECEP',
    'EFXP_DIRECCION_REC',
    'EFXP_DOM_RECEP',
    'EFXP_DIR_REC',
    'EFXP_DIREC_RECEP',
    'EFXP_DIR_RCP',
  ]);
  if (direct) return direct;
  return pickFromCamposByRegex(
    campos,
    [/DIR.*RECEP|DIREC.*RECEP|DOMICILIO.*RECEP|DIR_RCP|DEFUALT.*DIR.*REC|DIR.*REC.*DEFUALT/i],
    /CMNA|CIUDAD|MAIL|FONO|EMAIL/i
  );
}

function pickGiroReceptorFromCampos(campos: Map<string, string>, getVal: (k: string) => string): string {
  const direct = firstNonEmptyTrimmed(getVal, [
    'EFXP_GIRO_RECEP_DEFUALT',
    'EFXP_GIRO_RECEP_DEFAULT',
    'EFXP_GIRO_RECEP',
    'EFXP_GIROREC',
    'GIRO_RECEP',
    'EFXP_GIRO_RECEPTOR',
    'EFXP_GIRO_REC',
    'EFXP_GIRO_RSOC',
  ]);
  if (direct) return direct;
  return pickFromCamposByRegex(campos, [/GIRO.*RECEP|GIRO_RCP/i], /EMIS|EMI[^O]|GIRO.*EMIS/i);
}

function buildDetalleItemsFromCampos(campos: Map<string, string>): SiiItem[] {
  const getVal = (n: string) => campos.get(n) || '';
  const discovered = discoverEfxpDetalleLineIndices(campos);
  const cantField = parseInt(getVal('CANT_DET'), 10) || 0;
  const maxDisc = discovered.length ? Math.max(...discovered) : 0;
  const maxI = Math.min(120, Math.max(cantField, maxDisc, 24));

  const items: SiiItem[] = [];
  for (let i = 1; i <= maxI; i++) {
    const nmb = (getValEfxpLine(getVal, 'EFXP_NMB_', i) || '').trim();
    const dscItem = (getValEfxpLine(getVal, 'EFXP_DSC_ITEM_', i) || '').trim();
    const alt =
      (getValEfxpLine(getVal, 'EFXP_DSC_LIN_', i) || '').trim() ||
      (getValEfxpLine(getVal, 'EFXP_ITEM_NMB_', i) || '').trim() ||
      (getValEfxpLine(getVal, 'EFXP_DSC_DET_', i) || '').trim();
    const base = nmb || alt;
    let descripcion = '';
    if (dscItem && base) {
      descripcion =
        dscItem.includes(base) || base.includes(dscItem) ? dscItem : `${base} ${dscItem}`;
    } else {
      descripcion = base || dscItem;
    }
    if (!descripcion) continue;
    const qtyRaw = getValEfxpLine(getVal, 'EFXP_QTY_', i);
    const cantidad = parseFloat(String(qtyRaw).replace(',', '.')) || 1;
    const prc = parseMonto(getValEfxpLine(getVal, 'EFXP_PRC_', i));
    const pctdRaw = getValEfxpLine(getVal, 'EFXP_PCTD_', i);
    const descuento = parseFloat(String(pctdRaw).replace(',', '.')) || 0;
    let subtotal = parseMonto(getValEfxpLine(getVal, 'EFXP_SUBT_', i));
    if (!subtotal && prc > 0) {
      subtotal =
        Math.round(cantidad * prc * (1 - descuento / 100)) || Math.round(cantidad * prc);
    }
    const cod = pickItemCodigoLine(getVal, i);
    const impto = pickItemImptoLine(getVal, i);
    items.push({
      numero: i,
      descripcion,
      cantidad,
      unidad: getValEfxpLine(getVal, 'EFXP_UNMD_', i),
      precioUnitario: prc,
      descuento,
      subtotal,
      ...(cod ? { codigo: cod } : {}),
      ...(impto !== undefined ? { imptoAdicPct: impto } : {}),
    });
  }
  return items;
}

function mergeDetalleFacturaToDbPatch(
  det: SiiFacturaDetalle,
  extra?: Record<string, unknown>
): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    items: det.items,
    dirReceptor: det.dirReceptor,
    comunaReceptor: det.comunaReceptor,
    ciudadReceptor: det.ciudadReceptor,
    giroReceptor: det.giroReceptor,
    formaPago: det.formaPago,
    neto: det.neto,
    iva: det.iva,
    detalleCompleto: true,
    detalleExtendido: det.detalleExtendido ?? null,
    ...extra,
  };
  if ((det.total || 0) > 0) patch.total = det.total;
  else if ((det.monto || 0) > 0) patch.total = det.monto;
  if ((det.monto || 0) > 0) patch.monto = det.monto;
  else if ((det.total || 0) > 0) patch.monto = det.total;
  return patch;
}

/**
 * El sync antes solo reabría detalle si `detalleCompleto` era false; con parser viejo muchas filas
 * quedaron en true sin ítems ni receptor — conviene volver a traer el HTML de copiar documento.
 */
function facturaNecesitaRefetchDetalle(r: {
  detalleCompleto?: boolean;
  items?: unknown;
  monto?: number | null;
  giroReceptor?: string | null;
  dirReceptor?: string | null;
}): boolean {
  if (!r.detalleCompleto) return true;
  const monto = r.monto ?? 0;
  if (monto <= 0) return false;
  const items = r.items;
  const sinLineas = !Array.isArray(items) || items.length === 0;
  if (sinLineas) return true;
  const g = String(r.giroReceptor ?? '').trim();
  const d = String(r.dirReceptor ?? '').trim();
  return !g && !d;
}

/** Resultado de diagnóstico: HTML de mipeGenFacEx.cgi (copiar documento). */
export interface CopiarDocFormInspect {
  kind: 'login' | 'error_501' | 'no_rut_recep' | 'form';
  htmlBytes: number;
  /** Nombres EFXP_* vistos en HTML (atributo name), normalizados a mayúsculas. */
  rawEfxpNamesInHtml: string[];
  /** Nombres que aparecen en HTML pero quedaron vacíos tras parseFormFields (sospecha de valor solo en JS). */
  htmlNamesEmptyInParsedMap: string[];
  parsedFieldCount: number;
  keysSorted: string[];
  nonEmptyEfxp: Record<string, string>;
  lineKeysAll: string[];
  lineKeysNonEmpty: Record<string, string>;
  parsedItemsCount: number;
  pickedReceptor: {
    razonSocial: string;
    rut: string;
    giro: string;
    dir: string;
    comuna: string;
    ciudad: string;
    formaPago: string;
  };
  montosRaw: Record<string, number>;
  /** Pares ['EFXP_*','valor'] extraídos del script datosArray (axios no ejecuta JS). */
  datosArrayPairsMerged: number;
}

function extractRawEfxpInputNamesFromHtml(html: string): string[] {
  const s = new Set<string>();
  const re = /\bname=["']([^"']*EFXP[^"']*)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const n = m[1].trim().toUpperCase();
    if (n) s.add(n);
  }
  return [...s].sort();
}

/**
 * Analiza el HTML de «Copiar documento» sin llamar al SII.
 * Útil para scripts y para ver qué campos trae realmente la respuesta.
 */
export function inspectCopiarDocFormHtml(html: string): CopiarDocFormInspect {
  const loginLike = isLoginLikeHtml(html);
  const err501 = /ERROR\s*:\s*501|ptr NULL|ptrTkn/i.test(html);
  const campos = parseFormFields(html);
  const datosArrayPairsMerged = augmentCamposFromDatosArrayScript(html, campos);
  augmentCamposFromLooseEfxpScriptPairs(html, campos);
  augmentReceptorFromRecptorDirActEcoScripts(html, campos);
  augmentFormaPagoFromArrPagosScript(html, campos);
  augmentReferenciasResumenFromScript(html, campos);
  const getVal = (n: string) => campos.get(n) || '';
  let kind: CopiarDocFormInspect['kind'] = 'form';
  if (loginLike) kind = 'login';
  else if (err501) kind = 'error_501';
  else if (!getVal('EFXP_RUT_RECEP').trim()) kind = 'no_rut_recep';

  const rawEfxpNamesInHtml = extractRawEfxpInputNamesFromHtml(html);
  const htmlNamesEmptyInParsedMap = rawEfxpNamesInHtml.filter((k) => !(campos.get(k) || '').trim());

  const keysSorted = [...campos.keys()].sort();
  const nonEmptyEfxp: Record<string, string> = {};
  for (const k of keysSorted) {
    const v = getVal(k).trim();
    if (v && k.startsWith('EFXP_')) nonEmptyEfxp[k] = v;
  }

  const lineKeysAll = keysSorted.filter((k) =>
    /^EFXP_(NMB|QTY|PRC|SUBT|PCTD|UNMD|CDG|COD|CODITEM|COD_INT|DSC_ITEM|DSC_LIN|ITEM_NMB|DSC_DET)_\d+$/i.test(k) ||
    k === 'CANT_DET'
  );
  const lineKeysNonEmpty: Record<string, string> = {};
  for (const k of lineKeysAll) {
    const v = getVal(k).trim();
    if (v) lineKeysNonEmpty[k] = v;
  }

  const items = buildDetalleItemsFromCampos(campos);
  const dv = getVal('EFXP_DV_RECEP');
  const rutBody = getVal('EFXP_RUT_RECEP');

  return {
    kind,
    htmlBytes: html.length,
    rawEfxpNamesInHtml,
    htmlNamesEmptyInParsedMap,
    parsedFieldCount: campos.size,
    keysSorted,
    nonEmptyEfxp,
    lineKeysAll,
    lineKeysNonEmpty,
    parsedItemsCount: items.length,
    pickedReceptor: {
      razonSocial: getVal('EFXP_RZN_SOC_RECEP'),
      rut: dv ? `${rutBody}-${dv}` : rutBody,
      giro: pickGiroReceptorFromCampos(campos, getVal),
      dir: pickDirReceptorFromCampos(campos, getVal),
      comuna: getVal('EFXP_CMNA_RECEP'),
      ciudad: getVal('EFXP_CIUDAD_RECEP'),
      formaPago: resolveFormaPagoText(campos, getVal),
    },
    montosRaw: {
      EFXP_MNT_NETO: parseMonto(getVal('EFXP_MNT_NETO')),
      EFXP_IVA: parseMonto(getVal('EFXP_IVA')),
      EFXP_MNT_TOTAL: parseMonto(getVal('EFXP_MNT_TOTAL')),
      EFXP_SUBTOTAL: parseMonto(getVal('EFXP_SUBTOTAL')),
    },
    datosArrayPairsMerged,
  };
}

/** Snapshot de inputs EFXP_* y CANT_DET del formulario copiar documento. */
function snapshotEfxpCampos(campos: Map<string, string>): Record<string, string> {
  const o: Record<string, string> = {};
  for (const [k, v] of campos) {
    const t = (v || '').trim();
    if (!t) continue;
    if (k.startsWith('EFXP_') || k === 'CANT_DET') {
      if (esCampoLineaDetalleEfxp(k)) continue;
      o[k] = t;
    }
  }
  return o;
}

/** Ejecuta fn en lotes paralelos con concurrencia limitada */
async function parallelBatch<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency = 6
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(batch.map(fn));
    for (const r of batchResults) {
      results.push(r.status === 'fulfilled' ? r.value : null as any);
    }
    await new Promise(r => setTimeout(r, 150));
  }
  return results;
}

/** Headed solo en local con pantalla; Railway/producción siempre headless. */
function playwrightHeadless(): boolean {
  const wantHeaded = /^(1|true|yes)$/i.test(String(process.env.SII_PLAYWRIGHT_HEADED || '').trim());
  if (!wantHeaded) return true;

  const onRailway = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_ENVIRONMENT_NAME);
  const noDisplay =
    process.platform === 'linux' && !process.env.DISPLAY?.trim();
  const isProd = process.env.NODE_ENV === 'production';

  if (onRailway || noDisplay || isProd) {
    console.warn(
      '[SII] SII_PLAYWRIGHT_HEADED ignorado en este entorno (sin pantalla). Usando headless.',
    );
    return true;
  }
  return false;
}

async function launchBrowser(): Promise<Browser> {
  // En Railway/Alpine se usa el chromium del sistema; en local Playwright descarga el suyo.
  const executablePath =
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    undefined;

  return chromium.launch({
    headless: playwrightHeadless(),
    executablePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--no-first-run',
    ],
  });
}

/** Evita crash ProtocolError si el SII muestra alert() al cerrar la pestaña. */
const pageDialogHandlers = new WeakMap<Page, (dialog: Dialog) => void | Promise<void>>();

function setPageDialogHandler(
  page: Page,
  handler: (dialog: Dialog) => void | Promise<void>
): void {
  const prev = pageDialogHandlers.get(page);
  if (prev) page.off('dialog', prev);
  const wrapped = (dialog: Dialog) => {
    void Promise.resolve(handler(dialog)).catch((err) => {
      console.warn('[SII] dialog handler:', (err as Error)?.message || err);
    });
  };
  page.on('dialog', wrapped);
  pageDialogHandlers.set(page, wrapped);
}

function wireSafeDialogs(
  target: Page | BrowserContext,
  opts?: { capture?: { texto: string } }
): void {
  const attach = (page: Page) => {
    setPageDialogHandler(page, (dialog) => {
      const msg = dialog.message();
      const low = msg.toLowerCase();
      if (opts?.capture) opts.capture.texto = msg;
      if (dialog.type() === 'prompt' && /clave|firma|password|pin/.test(low)) {
        console.log(`[SII] dialog (firma pendiente): ${msg.slice(0, 120)}`);
        return;
      }
      console.log(`[SII] dialog: ${msg.slice(0, 120)}`);
      return dialog.dismiss().catch(() => {});
    });
  };
  if ('on' in target && 'pages' in target) {
    const ctx = target as BrowserContext;
    ctx.on('page', attach);
    for (const p of ctx.pages()) attach(p);
  } else {
    attach(target as Page);
  }
}

const SII_EFXP_NMB_DEFAULT_MAX = 40;
/** Máximo de líneas de detalle al emitir (plantilla copiada puede traer más). */
const SII_EMIT_MAX_LINEAS = parseInt(process.env.SII_EMIT_MAX_LINEAS || '20', 10) || 20;

async function clearEmitFormLineExtended(page: Page, num: string): Promise<void> {
  const descripCheckbox = `input[name="DESCRIP_${num}"], input[name="DESCRIP${num}"]`;
  const chk = await page.$(descripCheckbox);
  if (chk) {
    const checked = await chk.isChecked().catch(() => false);
    if (checked) await chk.click().catch(() => {});
    await page.waitForTimeout(150);
  }
  const extSelectors = [
    `input[name="EFXP_DSC_ITEM_${num}"]`,
    `textarea[name="EFXP_DSC_ITEM_${num}"]`,
    `input[name="EFXP_DSC_LIN_${num}"]`,
    `textarea[name="EFXP_DSC_LIN_${num}"]`,
    `input[name="EFXP_DSC_DET_${num}"]`,
    `textarea[name="EFXP_DSC_DET_${num}"]`,
  ];
  for (const sel of extSelectors) {
    await page
      .$eval(
        sel,
        (node: any) => {
          node.value = '';
          node.dispatchEvent(new Event('change', { bubbles: true }));
        },
      )
      .catch(() => {});
  }
}

async function fillEmitFormLineExtended(
  page: Page,
  num: string,
  texto: string,
): Promise<boolean> {
  const extRaw = sanitizeDescripcionParaSii(texto);
  if (!extRaw) return false;

  const descripCheckbox = `input[name="DESCRIP_${num}"], input[name="DESCRIP${num}"]`;
  const chk = await page.$(descripCheckbox);
  if (chk) {
    const checked = await chk.isChecked().catch(() => false);
    if (!checked) await chk.click().catch(() => {});
    await page.waitForTimeout(250);
  }

  const extSelectors = [
    `textarea[name="EFXP_DSC_ITEM_${num}"]`,
    `input[name="EFXP_DSC_ITEM_${num}"]`,
    `textarea[name="EFXP_DSC_LIN_${num}"]`,
    `input[name="EFXP_DSC_LIN_${num}"]`,
    `textarea[name="EFXP_DSC_DET_${num}"]`,
    `input[name="EFXP_DSC_DET_${num}"]`,
  ];
  for (const sel of extSelectors) {
    if (!(await page.$(sel))) continue;
    const loc = page.locator(sel);
    await loc.click({ timeout: 3000 }).catch(() => {});
    const maxLen = await page
      .$eval(sel, (el: any) => {
        const m = parseInt(el.getAttribute('maxlength') || '', 10);
        return Number.isFinite(m) && m > 0 ? m : 500;
      })
      .catch(() => 500);
    const val = extRaw.slice(0, maxLen);
    await loc.fill(val).catch(() => {});
    await page
      .$eval(sel, (el: any) => {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
      })
      .catch(() => {});
    await loc.press('Tab').catch(() => {});
    console.log(`[SII] emitir — ítem ${num}: descripción extendida (${val.length}ch)`);
    return true;
  }
  return false;
}

async function clearEmitFormLine(page: Page, num: string): Promise<void> {
  await clearEmitFormLineExtended(page, num);
  const fields = ['EFXP_NMB', 'EFXP_PRC', 'EFXP_QTY', 'EFXP_SUBT', 'EFXP_PCTD', 'EFXP_UNMD', 'EFXP_CDG'];
  for (const base of fields) {
    const sel = `input[name="${base}_${num}"], textarea[name="${base}_${num}"]`;
    await page
      .$eval(
        sel,
        (node: any) => {
          node.value = '';
          node.dispatchEvent(new Event('change', { bubbles: true }));
        },
      )
      .catch(() => {});
  }
}

/** Tras copiar documento, borra filas sobrantes de la plantilla (evita exceso de chars/líneas en el SII). */
async function clearUnusedEmitFormLines(page: Page, usedLineCount: number): Promise<void> {
  const cantDetRaw = await page
    .$eval('input[name="CANT_DET"]', (el: any) => String(el.value || '').trim())
    .catch(() => '');
  const cantDet = parseInt(cantDetRaw, 10) || 0;

  let maxIdx = Math.max(usedLineCount, cantDet);
  for (let i = 1; i <= Math.min(SII_EMIT_MAX_LINEAS + 10, 80); i++) {
    const num = String(i).padStart(2, '0');
    if (!(await page.$(`input[name="EFXP_NMB_${num}"]`))) {
      if (i > maxIdx) break;
      continue;
    }
    maxIdx = Math.max(maxIdx, i);
  }

  let cleared = 0;
  for (let i = usedLineCount + 1; i <= maxIdx; i++) {
    const num = String(i).padStart(2, '0');
    if (!(await page.$(`input[name="EFXP_NMB_${num}"]`))) continue;
    await clearEmitFormLine(page, num);
    cleared++;
  }

  if (cantDet > usedLineCount) {
    await page
      .$eval(
        'input[name="CANT_DET"]',
        (el: any, v: string) => {
          el.value = v;
          el.dispatchEvent(new Event('change', { bubbles: true }));
        },
        String(usedLineCount),
      )
      .catch(() => {});
  }

  if (cleared > 0) {
    console.log(`[SII] emitir — ${cleared} fila(s) de plantilla limpiadas (usando ${usedLineCount} líneas)`);
  }
}

/** El formulario EFXP del SII solo acepta ASCII básico; omite tildes, em-dash, etc. */
export function sanitizeDescripcionParaSii(texto: string): string {
  return texto
    .trim()
    .replace(/[\u2013\u2014\u2015\u2212]/g, '-')
    .replace(/[\u2018\u2019\u2032]/g, "'")
    .replace(/[\u201C\u201D\u2033]/g, '"')
    .replace(/\u00A0/g, ' ')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Rellena EFXP_NMB (glosa corta) y opcionalmente EFXP_DSC_ITEM_* (descripción extendida). */
async function fillEmitirItemDescripcion(
  page: Page,
  num: string,
  descripcion: string,
  descripcionExtendida?: string,
): Promise<void> {
  const nmbSel = `input[name="EFXP_NMB_${num}"]`;
  if (!(await page.$(nmbSel))) return;

  const texto = sanitizeDescripcionParaSii(descripcion);
  const extRaw = sanitizeDescripcionParaSii(descripcionExtendida || '');
  const useExt =
    extRaw.length > 0 &&
    extRaw.toUpperCase() !== texto.toUpperCase() &&
    (extRaw.length > texto.length || !extRaw.toUpperCase().includes(texto.toUpperCase()));

  if (useExt) {
    await fillEmitFormLineExtended(page, num, extRaw);
  } else {
    await clearEmitFormLineExtended(page, num);
  }

  const maxNombre = await page
    .$eval(nmbSel, (el: any) => {
      const m = parseInt(el.getAttribute('maxlength') || '', 10);
      return Number.isFinite(m) && m > 0 ? m : SII_EFXP_NMB_DEFAULT_MAX;
    })
    .catch(() => SII_EFXP_NMB_DEFAULT_MAX);

  let nombre = texto;
  if (nombre.length > maxNombre) {
    let cut = maxNombre;
    const head = texto.slice(0, maxNombre);
    const sp = head.lastIndexOf(' ');
    if (sp >= Math.floor(maxNombre * 0.45)) cut = sp;
    nombre = texto.slice(0, cut).trim();
    if (!useExt && texto.length > nombre.length) {
      await fillEmitFormLineExtended(page, num, texto);
    }
  }

  const loc = page.locator(nmbSel);
  await loc.click({ timeout: 3000 }).catch(() => {});
  await loc.fill('').catch(() => {});
  await loc.fill(nombre).catch(async () => {
    await page.$eval(
      nmbSel,
      (el: any, v: string) => {
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      },
      nombre,
    );
  });
  await page
    .$eval(nmbSel, (el: any) => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    })
    .catch(() => {});
  await loc.press('Tab').catch(() => {});

  const applied = await page
    .$eval(nmbSel, (el: any) => String(el.value || '').trim())
    .catch(() => '');
  if (applied && applied !== nombre) {
    console.warn(`[SII] emitir — ítem ${num}: glosa esperada "${nombre}" pero formulario tiene "${applied}"`);
  } else {
    console.log(`[SII] emitir — ítem ${num}: glosa "${nombre}"${useExt ? ' + extendida' : ''}`);
  }
}

export interface SiiEmitFormLineSnapshot {
  numero: number;
  nombre: string;
  descripcionExtendida: string;
  cantidad: number;
  precioUnitario: number;
  subtotal: number;
}

export interface SiiEmitFormTotalesSnapshot {
  subtotal: number;
  descuentoGlobalPct: number;
  descuentoGlobalMonto: number;
  neto: number;
  iva: number;
  total: number;
}

/** Lectura del formulario MiPyme tras rellenar (retroalimentación real del SII). */
export interface SiiEmitFormSnapshot {
  capturedAt: string;
  lineas: SiiEmitFormLineSnapshot[];
  totales: SiiEmitFormTotalesSnapshot;
  descuentoGlobalPctField: string;
  warnings: string[];
}

async function snapshotEmitFormFromPage(
  page: Page,
  usedLineCount: number,
): Promise<SiiEmitFormSnapshot> {
  const raw = await page
    .evaluate((lineCount) => {
      const doc = (globalThis as any).document;
      if (!doc) return null;
      const read = (name: string) => {
        const el = doc.querySelector(`input[name="${name}"], textarea[name="${name}"]`) as any;
        return el ? String(el.value || '').trim() : '';
      };
      const parseMonto = (s: string) => parseInt(String(s || '').replace(/\D/g, ''), 10) || 0;
      const parseNum = (s: string) => parseFloat(String(s || '').replace(',', '.')) || 0;
      const norm = (s: string) =>
        String(s || '')
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '');

      const lineas: Array<{
        numero: number;
        nombre: string;
        descripcionExtendida: string;
        cantidad: number;
        precioUnitario: number;
        subtotal: number;
      }> = [];
      for (let i = 1; i <= lineCount; i++) {
        const num = String(i).padStart(2, '0');
        const nombre = read(`EFXP_NMB_${num}`);
        if (!nombre && i > lineCount) continue;
        const descripcionExtendida =
          read(`EFXP_DSC_ITEM_${num}`) ||
          read(`EFXP_DSC_LIN_${num}`) ||
          read(`EFXP_DSC_DET_${num}`);
        lineas.push({
          numero: i,
          nombre,
          descripcionExtendida,
          cantidad: parseNum(read(`EFXP_QTY_${num}`)) || 1,
          precioUnitario: parseMonto(read(`EFXP_PRC_${num}`)),
          subtotal: parseMonto(read(`EFXP_SUBT_${num}`)),
        });
      }

      let descuentoGlobalPctField = '';
      let descuentoGlobalPct = 0;
      for (const tr of doc.querySelectorAll('tr')) {
        const cells = [...tr.querySelectorAll('td, th')];
        const labelIdx = cells.findIndex((c: any) =>
          norm(c.textContent || '').includes('descuento global'),
        );
        if (labelIdx < 0) continue;
        for (let i = labelIdx + 1; i < cells.length; i++) {
          const cellText = norm(cells[i].textContent || '');
          if (cellText.includes('monto') && !cellText.includes('%')) continue;
          const input = cells[i].querySelector('input:not([type="hidden"])') as any;
          if (!input?.name) continue;
          descuentoGlobalPctField = input.name;
          descuentoGlobalPct = parseNum(input.value);
          break;
        }
        if (descuentoGlobalPctField) break;
      }

      const pctCandidates = [
        'EFXP_PCT_DESCUENTO_GLOBAL',
        'EFXP_PCTD_GLOB',
        'EFXP_PCTD_GLOBAL',
        'EFXP_PCTD',
      ];
      if (!descuentoGlobalPctField) {
        for (const name of pctCandidates) {
          const v = read(name);
          if (v) {
            descuentoGlobalPctField = name;
            descuentoGlobalPct = parseNum(v);
            break;
          }
        }
      }

      const subtotal = parseMonto(read('EFXP_SUBTOTAL'));
      const neto = parseMonto(read('EFXP_MNT_NETO'));
      const iva = parseMonto(read('EFXP_IVA'));
      const total = parseMonto(read('EFXP_MNT_TOTAL'));
      let descuentoGlobalMonto = 0;
      if (subtotal > 0 && neto > 0 && neto < subtotal) {
        descuentoGlobalMonto = subtotal - neto;
      }

      return {
        lineas,
        totales: {
          subtotal,
          descuentoGlobalPct,
          descuentoGlobalMonto,
          neto,
          iva,
          total,
        },
        descuentoGlobalPctField,
      };
    }, usedLineCount)
    .catch(() => null);

  const warnings: string[] = [];
  if (!raw) {
    return {
      capturedAt: new Date().toISOString(),
      lineas: [],
      totales: {
        subtotal: 0,
        descuentoGlobalPct: 0,
        descuentoGlobalMonto: 0,
        neto: 0,
        iva: 0,
        total: 0,
      },
      descuentoGlobalPctField: '',
      warnings: ['No se pudo leer el formulario SII'],
    };
  }

  for (const ln of raw.lineas) {
    if (!ln.nombre) warnings.push(`Línea ${ln.numero}: nombre vacío en el SII`);
  }
  if (raw.totales.subtotal > 0 && raw.totales.descuentoGlobalMonto <= 0 && raw.totales.descuentoGlobalPct <= 0) {
    warnings.push('Descuento global en 0 en el formulario SII');
  }

  return {
    capturedAt: new Date().toISOString(),
    lineas: raw.lineas,
    totales: raw.totales,
    descuentoGlobalPctField: raw.descuentoGlobalPctField,
    warnings,
  };
}

export interface DescuentoGlobalEmitParams {
  montoNeto: number;
  porcentaje: number;
  glosa: string;
}

async function readEmitInputValue(page: Page, fieldName: string): Promise<string> {
  const sel = `input[name="${fieldName}"]`;
  return page
    .$eval(sel, (el: any) => String(el.value || '').trim())
    .catch(() => '');
}

/** Localiza el input % de la fila «Descuento Global» del resumen MiPyme. */
async function discoverDescuentoGlobalPctField(page: Page): Promise<string | null> {
  return page
    .evaluate(() => {
      const doc = (globalThis as any).document;
      if (!doc) return null as string | null;
      const norm = (s: string) =>
        String(s || '')
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '');

      for (const tr of doc.querySelectorAll('tr')) {
        const cells = [...tr.querySelectorAll('td, th')];
        const labelIdx = cells.findIndex((c) => norm(c.textContent || '').includes('descuento global'));
        if (labelIdx < 0) continue;

        for (let i = labelIdx + 1; i < cells.length; i++) {
          const cellText = norm(cells[i].textContent || '');
          if (cellText.includes('monto') && !cellText.includes('%')) continue;
          const input = cells[i].querySelector(
            'input:not([type="hidden"]):not([type="button"]):not([type="submit"])',
          ) as any;
          if (!input?.name || input.disabled || input.readOnly) continue;
          return input.name as string;
        }
      }

      for (const node of doc.querySelectorAll('td, th, label, span')) {
        const t = norm(node.textContent || '');
        if (!t.includes('descuento global') || t.length > 60) continue;
        const row = (node as any).closest?.('tr');
        if (!row) continue;
        for (const input of row.querySelectorAll('input:not([type="hidden"])') as any[]) {
          if (!input?.name || input.disabled || input.readOnly) continue;
          const cell = norm(input.closest?.('td, th')?.textContent || '');
          if (cell.includes('monto') && !cell.includes('%')) continue;
          return input.name as string;
        }
      }
      return null;
    })
    .catch(() => null);
}

async function verifyDescuentoGlobalEnFormulario(
  page: Page,
  dr: DescuentoGlobalEmitParams,
): Promise<boolean> {
  const subtotalRaw = await readEmitInputValue(page, 'EFXP_SUBTOTAL');
  const netoRaw = await readEmitInputValue(page, 'EFXP_MNT_NETO');
  const subtotal = parseInt(subtotalRaw.replace(/\D/g, ''), 10) || 0;
  const neto = parseInt(netoRaw.replace(/\D/g, ''), 10) || 0;
  if (subtotal > 0 && neto > 0 && neto < subtotal) {
    const descAplicado = subtotal - neto;
    if (Math.abs(descAplicado - Math.round(dr.montoNeto)) <= 10) return true;
  }

  const pctField = await discoverDescuentoGlobalPctField(page);
  if (pctField) {
    const v = await readEmitInputValue(page, pctField);
    const n = parseFloat(v.replace(',', '.'));
    if (n > 0) return true;
  }
  return false;
}

/** Rellena el descuento global del formulario MiPyme (fila Sub Total → Descuento Global %). */
async function fillDescuentoGlobalSii(
  page: Page,
  dr: DescuentoGlobalEmitParams,
  helpers: {
    setFieldSafe: (fieldName: string, value: string) => Promise<void>;
    allInputNames: { name: string; value: string; type: string }[];
  },
): Promise<boolean> {
  if (!dr || dr.montoNeto <= 0) return false;

  const { setFieldSafe } = helpers;
  let allInputNames = helpers.allInputNames;
  const montoStr = String(Math.round(dr.montoNeto));
  const glosa = (dr.glosa || 'Descuento pedido').slice(0, 45);

  const subtotalForm = parseInt(
    (await readEmitInputValue(page, 'EFXP_SUBTOTAL')).replace(/\D/g, ''),
    10,
  );
  let pct = dr.porcentaje > 0 ? dr.porcentaje : 0;
  if (pct <= 0 && subtotalForm > 0) {
    pct = Math.round((dr.montoNeto / subtotalForm) * 10000) / 100;
  }
  if (pct <= 0) {
    console.warn('[SII] emitir — descuento global sin porcentaje calculable');
  }
  const pctStr = String(pct > 0 ? pct : dr.porcentaje).replace('.', ',');

  const fillPctField = async (fieldName: string, via: string): Promise<boolean> => {
    if (!fieldName || pct <= 0) return false;
    const sel = `input[name="${fieldName}"]`;
    if (!(await page.$(sel))) return false;
    await page.click(sel, { timeout: 3000 }).catch(() => {});
    await page.fill(sel, pctStr).catch(() => setFieldSafe(fieldName, pctStr));
    await page
      .$eval(sel, (el: any) => {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
      })
      .catch(() => {});
    await page.locator(sel).press('Tab').catch(() => {});
    await page.waitForTimeout(700);
    console.log(`[SII] emitir — descuento global ${pctStr}% (${via}: ${fieldName})`);
    return verifyDescuentoGlobalEnFormulario(page, dr);
  };

  const fillDrRowMonto = async (suffix: string, via: string): Promise<boolean> => {
    const mov = `EFXP_TPO_MOV_DR_${suffix}`;
    const tpoValor = `EFXP_TPO_VALOR_DR_${suffix}`;
    const valor = `EFXP_VALOR_DR_${suffix}`;
    const glosaField = `EFXP_GLOSA_DR_${suffix}`;
    if (!allInputNames.some((i) => i.name === valor || i.name === mov)) return false;

    for (const chk of allInputNames) {
      if (chk.type !== 'checkbox') continue;
      if (!/CHK.*(?:DR|DESC|REC)|(?:DR|DESC|REC).*CHK/i.test(chk.name)) continue;
      await page
        .$eval(`input[name="${chk.name}"]`, (el: any) => {
          if (!el.checked) {
            el.checked = true;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.click?.();
          }
        })
        .catch(() => {});
      break;
    }

    await setFieldSafe(mov, 'D');
    await setFieldSafe(tpoValor, '$');
    await setFieldSafe(valor, montoStr);
    await setFieldSafe(glosaField, glosa);
    await page.waitForTimeout(700);
    console.log(`[SII] emitir — descuento global $${montoStr} neto (${via}: ${valor})`);
    return verifyDescuentoGlobalEnFormulario(page, dr);
  };

  const fillDrRowPct = async (suffix: string): Promise<boolean> => {
    if (pct <= 0) return false;
    const mov = `EFXP_TPO_MOV_DR_${suffix}`;
    const tpoValor = `EFXP_TPO_VALOR_DR_${suffix}`;
    const valor = `EFXP_VALOR_DR_${suffix}`;
    const glosaField = `EFXP_GLOSA_DR_${suffix}`;
    if (!allInputNames.some((i) => i.name === valor)) return false;
    await setFieldSafe(mov, 'D');
    await setFieldSafe(tpoValor, '%');
    await setFieldSafe(valor, pctStr);
    await setFieldSafe(glosaField, glosa);
    await page.locator(`input[name="${valor}"]`).press('Tab').catch(() => {});
    await page.waitForTimeout(700);
    console.log(`[SII] emitir — descuento global ${pctStr}% (DR fila ${suffix})`);
    return verifyDescuentoGlobalEnFormulario(page, dr);
  };

  // Refrescar inputs tras recalcular subtotal de líneas
  allInputNames = await page
    .evaluate(() => {
      const d = (globalThis as any).document;
      if (!d) return [];
      return Array.from(d.querySelectorAll('input, select, textarea'))
        .map((e: any) => ({
          name: e.name || '',
          value: e.value || '',
          type: e.type || e.tagName.toLowerCase(),
        }))
        .filter((e: any) => e.name);
    })
    .catch(() => allInputNames);

  const drFieldNames = allInputNames
    .filter((i) => /DESC|DCTO|GLOB|PCTD|_DR_/i.test(i.name))
    .map((i) => i.name);
  if (drFieldNames.length) {
    console.log('[SII] emitir — campos descuento en formulario:', drFieldNames.join(', '));
  }

  const pctFieldDom = await discoverDescuentoGlobalPctField(page);
  if (pctFieldDom && (await fillPctField(pctFieldDom, 'fila Descuento Global'))) return true;

  const pctCandidates = [
    'EFXP_PCT_DESCUENTO_GLOBAL',
    'EFXP_PCTD_GLOB',
    'EFXP_PCTD_GLOBAL',
    'EFXP_PCTD',
    'EFXP_PCT_DESC',
    'EFXP_PCT_DCTO',
    'EFXP_DCTO_PCT',
    'EFXP_PCT_DESCUENTO',
    'EFXP_DCTO_GLOB',
    'EFXP_DESCUENTO_GLOBAL',
    'EFXP_PCTD_GLO',
    'EFXP_DCTO_GLO',
  ];
  for (const name of pctCandidates) {
    if (!allInputNames.some((i) => i.name === name)) continue;
    if (await fillPctField(name, 'campo')) return true;
  }

  const pctField = allInputNames.find(
    (i) =>
      /GLOB.*PCT|PCT.*GLOB|DCTO.*GLOB|DESC.*GLOB|PCTD_G/i.test(i.name) && !/_\d{2}$/.test(i.name),
  );
  if (pctField && (await fillPctField(pctField.name, 'patrón'))) return true;

  for (const suffix of ['01', '1']) {
    if (await fillDrRowMonto(suffix, 'DscRcgGlobal $')) return true;
  }

  for (const suffix of ['01', '1']) {
    if (await fillDrRowPct(suffix)) return true;
  }

  const montoCandidates = [
    'EFXP_MNT_DESCUENTO_GLOBAL',
    'EFXP_MNT_DCTO_GLOB',
    'EFXP_DCTO_GLOB_MNT',
    'EFXP_MNT_DCTO',
  ];
  for (const name of montoCandidates) {
    if (!allInputNames.some((i) => i.name === name)) continue;
    await setFieldSafe(name, montoStr);
    await page.locator(`input[name="${name}"]`).press('Tab').catch(() => {});
    await page.waitForTimeout(700);
    if (await verifyDescuentoGlobalEnFormulario(page, dr)) {
      console.log(`[SII] emitir — descuento global monto $${montoStr} (${name})`);
      return true;
    }
  }

  if (drFieldNames.length) {
    console.warn('[SII] emitir — campos descuento detectados pero no rellenados:', drFieldNames.join(', '));
  } else {
    console.warn('[SII] emitir — no se encontró campo de descuento global en el formulario');
  }
  return false;
}

async function safeClosePage(page: Page): Promise<void> {
  if (page.isClosed()) return;
  try {
    await page.waitForTimeout(500);
  } catch {
    /* page closing */
  }
  try {
    await page.close();
  } catch {
    /* ignore */
  }
}

/** Bloquea recursos cosméticos (NO bloquear queue-it/salaespera — necesarios para auth SII) */
async function enableFastMode(page: Page): Promise<void> {
  await page.route('**/*', (route) => {
    const type = route.request().resourceType();
    const url  = route.request().url();
    if (
      type === 'image' ||
      type === 'font'  ||
      type === 'media' ||
      type === 'stylesheet' ||
      url.includes('google-analytics') ||
      url.includes('omniture') ||
      url.includes('dtm.') ||
      url.includes('launch-')
    ) {
      route.abort().catch(() => {});
    } else {
      route.continue().catch(() => {});
    }
  });
}

// ─── Clase principal ────────────────────────────────────────────────────────

export class SiiFacturacionService {

  /** Estado de bloqueo temporal del SII (demasiados logins / Error 501). */
  static getBlockStatus(): {
    blocked: boolean;
    reason?: string;
    blockedUntil?: number;
    blockedSince?: number;
    retryAfterMinutes?: number;
    retryAfterSeconds?: number;
  } {
    if (!siiBlockState || Date.now() >= siiBlockState.blockedUntil) {
      siiBlockState = null;
      return { blocked: false };
    }
    const msLeft = siiBlockState.blockedUntil - Date.now();
    return {
      blocked: true,
      reason: siiBlockState.reason,
      blockedUntil: siiBlockState.blockedUntil,
      blockedSince: siiBlockState.since,
      retryAfterMinutes: Math.max(1, Math.ceil(msLeft / 60_000)),
      retryAfterSeconds: Math.max(0, Math.ceil(msLeft / 1000)),
    };
  }

  static markSiiBlocked(reason: string): void {
    siiBlockState = {
      blockedUntil: Date.now() + SII_BLOCK_COOLDOWN_MS,
      reason,
      since: Date.now(),
    };
    console.warn(
      `[SII] Bloqueo detectado — pausando automatización ${Math.round(SII_BLOCK_COOLDOWN_MS / 60_000)} min: ${reason}`,
    );
    void SiiFacturacionService.closeAllSessions();
  }

  static clearSiiBlock(): void {
    siiBlockState = null;
    console.log('[SII] Bloqueo manualmente limpiado (solo usar si ya entraste al SII a mano).');
  }

  static assertSiiAvailable(): void {
    const st = SiiFacturacionService.getBlockStatus();
    if (!st.blocked) return;
    throw new Error(
      `El SII bloqueó el acceso (${st.reason}). ` +
        `NO reintentes desde el workbench — empeora el bloqueo. ` +
        `Espera ~${st.retryAfterMinutes} min, entra manualmente en https://www.sii.cl y solo vuelve aquí cuando el login manual funcione.`,
    );
  }

  // ── Login (Puppeteer) ─────────────────────────────────────────────────────

  static async login(page: Page, username: string, password: string): Promise<boolean> {
    const { rutcntr } = parseRutForSiiLogin(username);
    await page.goto(SII_URLS.login, { waitUntil: 'load', timeout: 60000 });

    // El SII usa Queue-it (sala de espera) que puede redirigir antes de mostrar el login.
    // Esperamos hasta 90s para que Queue-it complete su redirección y aparezca #rutcntr.
    try {
      await page.waitForSelector('#rutcntr', { timeout: 90000 });
    } catch {
      const currentUrl = page.url();
      const isQueueIt = currentUrl.includes('salaespera') || currentUrl.includes('queue-it') || currentUrl.includes('Queue-it');
      throw new Error(`Login SII: form no encontrado tras 90s. URL: ${currentUrl}${isQueueIt ? ' (Queue-it bloqueando IP de datacenter)' : ''}`);
    }

    // El blur dispara el JS formatoRut que popula los campos hidden rut/dv
    await page.fill('#rutcntr', '');
    await page.type('#rutcntr', rutcntr, { delay: 20 });
    await page.dispatchEvent('#rutcntr', 'blur');
    await page.waitForTimeout(200);

    await page.fill('#clave', '');
    await page.type('#clave', password, { delay: 20 });
    await page.click('#bt_ingresar');
    await page.waitForLoadState('load', { timeout: 25000 }).catch(() => {});

    const url = page.url();
    return url.includes('siihome.cgi') || !url.includes('IngresoRutClave');
  }

  static async selectEmpresa(page: Page, empresaRut: string): Promise<boolean> {
    const rutNorm = normalizarRutEmpresaValor(empresaRut) ?? empresaRut;
    const dialogCapture = { texto: '' };
    wireSafeDialogs(page, { capture: dialogCapture });

    await page.goto(SII_URLS.selEmpresa, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const sel = await page.$('select').catch(() => null);
    if (!sel) return true; // cuenta personal, no requiere selección

    const options: { value: string; text: string }[] = await page
      .$$eval('select option', (opts) =>
        (opts as Array<{ value?: string; textContent?: string | null }>)
          .map((o) => ({ value: String(o.value || '').trim(), text: String(o.textContent || '').trim() }))
          .filter((o) => o.value && !/selecciona|seleccione|elija/i.test(o.text)),
      )
      .catch(() => []);

    const targetKey = rutNorm.replace(/\./g, '').replace(/-/g, '').toLowerCase();
    const match = options.find((o) => {
      const v = o.value.replace(/\./g, '').replace(/-/g, '').toLowerCase();
      return v === targetKey;
    });

    const valueToSelect = match?.value || rutNorm;
    console.log(`[SII] selectEmpresa: eligiendo ${valueToSelect} (${match ? 'match en select' : 'fallback directo'})`);
    await page.selectOption('select', valueToSelect).catch(async () => {
      await page.selectOption('select', { value: valueToSelect }).catch(async () => {
        await page.selectOption('select', { label: rutNorm });
      });
    });
    await page.waitForTimeout(400);

    dialogCapture.texto = '';
    const btn = await page.$('input[type="submit"], button[type="submit"]');
    if (btn) {
      await btn.click();
      await page.waitForLoadState('load', { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(800);
    }

    if (dialogIndicaEmpresaNoSeleccionada(dialogCapture.texto)) {
      console.warn('[SII] selectEmpresa: SII indicó empresa no seleccionada');
      return false;
    }

    const postHtml = await page.content().catch(() => '');
    if (htmlListadoEmitidosOperativo(postHtml)) return true;
    if (!/<select\b[^>]*>/i.test(postHtml)) return true;

    console.warn('[SII] selectEmpresa: sigue en selector de empresa tras el POST');
    return false;
  }

  /**
   * El SII exige visitar el listado de emitidos en el mismo tab/contexto antes de
   * mipeGenFacEx (copiar documento). Si no, responde Error 501 ptr NULL (ptrTkn).
   */
  static async ensurePtrTknOnPage(page: Page, empresaRut?: string, opts?: { skipEmpresaSelect?: boolean }): Promise<void> {
    if (empresaRut && !opts?.skipEmpresaSelect) {
      const ok = await this.selectEmpresa(page, empresaRut);
      if (!ok) {
        throw new Error(
          'No se pudo seleccionar la empresa en MiPyme. Cierra sesión en el workbench, vuelve a sincronizar e intenta de nuevo.',
        );
      }
    }
    const listadoUrl = listadoEmitidosUrlPagina1();
    console.log('[SII] ensurePtrTkn — navegando al listado de emitidos...');
    await page.goto(listadoUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(600);
    await page
      .waitForSelector(
        'input[name="FEC_DESDE"], input[name="NUM_PAG"], input[name="RUT_RECP"], form[name="VIEW_EFXP"]',
        { timeout: 12000 },
      )
      .catch(() => {});
    const html = await page.content().catch(() => '');
    if (isSiiHardBlockHtml(html)) {
      SiiFacturacionService.markSiiBlocked('SII rechazó el navegador automático');
      throw new Error(
        'El SII rechazó la sesión automática (navegador). ' +
          'Detén el workbench, espera y entra manualmente en sii.cl antes de reintentar.',
      );
    }
    if (!htmlListadoEmitidosOperativo(html)) {
      const snippet = html.replace(/\s+/g, ' ').slice(0, 240);
      console.warn(`[SII] ensurePtrTkn — listado no reconocido. URL=${page.url()} snippet=${snippet}`);
      throw new Error(
        'Sesión MiPyme incompleta (listado de emitidos no cargó). ' +
          'Cierra sesión en el workbench, vuelve a sincronizar MiPyme e intenta emitir de nuevo.',
      );
    }
  }

  /** Detecta Error 501 / ptrTkn — fallo de sesión, no bloqueo de cuenta. */
  static isSiiPtrTknErrorHtml(html: string): boolean {
    const h = html.toLowerCase();
    return (
      /error\s*:?\s*501/.test(h) ||
      /ptr\s*null|ptrtkn/i.test(html) ||
      /<title>\s*error\s*501/i.test(h)
    );
  }

  /** Expuesto para validar pestaña Playwright antes de omitir ensurePtrTkn. */
  static isListadoEmitidosOperativoHtml(html: string): boolean {
    return htmlListadoEmitidosOperativo(html);
  }

  // ── Extraer cookies de Playwright para axios ─────────────────────────────

  static async extractCookieHeader(page: Page): Promise<string> {
    const cookies = await page.context().cookies();
    const siiCookies = cookies.filter(c =>
      c.domain.includes('sii.cl') || c.domain.includes('zeusr')
    );
    return siiCookies.map(c => `${c.name}=${c.value}`).join('; ');
  }

  // ── Obtener lista de empresas (axios) ─────────────────────────────────────

  static async getEmpresas(axiosClient: AxiosInstance): Promise<SiiEmpresa[]> {
    const res = await axiosClient.get(SII_URLS.selEmpresa);
    const html = String(res.data);
    return parseEmpresasSelHtml(html);
  }

  private static async collectEmpresasOptionsFromPlaywrightFrames(page: Page): Promise<SiiEmpresa[]> {
    const acc = new Map<string, SiiEmpresa>();
    const readFrame = async (frame: Frame) => {
      const list = await frame.evaluate(() => {
        const g = globalThis as unknown as { document?: { querySelectorAll: (sel: string) => Iterable<unknown> } };
        const d = g.document;
        if (!d) return [] as { value: string; text: string }[];
        const out: { value: string; text: string }[] = [];
        const seen = new Set<string>();
        function normRut(v: string): string | null {
          const u = String(v || '')
            .replace(/\./g, '')
            .trim();
          const m = u.match(/^(\d{7,8})-([\dkK])$/i);
          return m ? `${m[1]}-${m[2].toUpperCase()}` : null;
        }
        function addValue(vRaw: string, label?: string) {
          const n = normRut(vRaw);
          if (!n || seen.has(n)) return;
          const lab = String(label || '')
            .replace(/\s+/g, ' ')
            .trim();
          if (/selecciona|seleccione|elija/i.test(lab) && lab.length < 36) return;
          seen.add(n);
          out.push({ value: n, text: lab.length ? lab : n });
        }
        for (const sel of Array.from(d.querySelectorAll('select'))) {
          const s = sel as { querySelectorAll: (q: string) => Iterable<unknown> };
          for (const o of Array.from(s.querySelectorAll('option'))) {
            const el = o as { value?: string; textContent?: string | null };
            const v = String(el.value || '').trim();
            const t = String(el.textContent || '').replace(/\s+/g, ' ').trim();
            if (!v || /selecciona|seleccione|elija/i.test(t)) continue;
            addValue(v, t || v);
          }
        }
        for (const inp of Array.from(
          d.querySelectorAll('input[type="radio"], input[type="checkbox"], input[type="hidden"]')
        )) {
          const el = inp as { value?: string; getAttribute: (n: string) => string | null };
          const v = String(el.value || el.getAttribute('value') || '').trim();
          if (!normRut(v)) continue;
          const row = (inp as { closest?: (s: string) => { textContent?: string | null } | null }).closest?.('tr, li, div, label');
          addValue(v, row?.textContent || v);
        }
        for (const node of Array.from(d.querySelectorAll('[data-rut], [data-value]'))) {
          const el = node as { getAttribute: (n: string) => string | null; textContent?: string | null };
          const dr = el.getAttribute('data-rut') || el.getAttribute('data-value');
          if (dr) addValue(dr, el.textContent || dr);
        }
        for (const a of Array.from(d.querySelectorAll('a[href*="RUT"], a[href*="rut"], a[href*="Empresa"]'))) {
          const el = a as { getAttribute: (n: string) => string | null; textContent?: string | null };
          const href = el.getAttribute('href') || '';
          const mm = href.match(/(\d{7,8}-[\dkK])/i);
          if (mm) addValue(mm[1], el.textContent || mm[1]);
        }
        return out;
      });
      for (const e of list) {
        const k = rutEmpresaMapKey(e.value);
        if (!acc.has(k)) acc.set(k, e);
      }
    };
    for (const frame of page.frames()) {
      try {
        await readFrame(frame);
      } catch {
        /* frame u origen */
      }
    }
    return [...acc.values()];
  }

  /**
   * Lee &lt;option&gt; reales del DOM (el SII a veces rellena el select con JS tras cargar).
   */
  private static async extractEmpresasDesdePlaywright(username: string, password: string): Promise<SiiEmpresa[]> {
    const browser = await launchBrowser();
    let context: BrowserContext | null = null;
    try {
      const UA =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
      context = await browser.newContext({ userAgent: UA, ignoreHTTPSErrors: true });
      const page = await context.newPage();
      await enableFastMode(page);
      const loginOk = await this.login(page, username, password);
      if (!loginOk) throw new Error('Login SII fallido (Playwright)');
      await page.goto(SII_URLS.siiHome, { waitUntil: 'networkidle', timeout: 60000 }).catch(() =>
        page.goto(SII_URLS.siiHome, { waitUntil: 'domcontentloaded', timeout: 45000 })
      );
      await page.goto(SII_URLS.selEmpresa, { waitUntil: 'networkidle', timeout: 60000 }).catch(() =>
        page.goto(SII_URLS.selEmpresa, { waitUntil: 'domcontentloaded', timeout: 45000 })
      );
      await page.waitForSelector('select', { timeout: 25000 }).catch(() => {});
      await page
        .waitForFunction(() => {
          const doc = (globalThis as unknown as { document: { querySelectorAll: (s: string) => Iterable<unknown> } })
            .document;
          for (const sel of doc.querySelectorAll('select')) {
            const s = sel as { querySelectorAll: (q: string) => Iterable<unknown> };
            for (const o of s.querySelectorAll('option')) {
              const el = o as { value?: string; textContent?: string | null };
              const t = String(el.textContent || '').toLowerCase();
              if (String(el.value || '').trim() && !/selecciona|seleccione|elija/.test(t)) return true;
            }
          }
          return false;
        }, { timeout: 35000 })
        .catch(() => {});
      await new Promise((r) => setTimeout(r, 1500));
      const fromDom = await this.collectEmpresasOptionsFromPlaywrightFrames(page);
      const htmlP = await page.content();
      const empresas = mergeEmpresasPreferirPrimera(fromDom, parseEmpresasRutsDesdeHtmlAmplio(htmlP));
      if (htmlIndicaExcesoSesionesSii(htmlP)) {
        throw new Error(MENSAJE_EXCESO_SESIONES_SII);
      }
      // Guardar context para que createSession lo reutilice (evita 2° login)
      if (context) {
        // Limpiar el context anterior si existe
        if (playwrightContextDisponible) {
          await playwrightContextDisponible.context.close().catch(() => {});
          await playwrightContextDisponible.browser.close().catch(() => {});
        }
        playwrightContextDisponible = { browser, context, ts: Date.now() };
        console.log('[SII] extractEmpresasDesdePlaywright: context guardado para reusar en createSession');
      }
      return empresas;
    } catch (err) {
      // En caso de error, cerrar el browser para no dejar recursos colgados
      if (context) await context.close().catch(() => {});
      await browser.close().catch(() => {});
      throw err;
    }
  }

  /**
   * Empresas vinculadas al RUT de acceso (mipeSelEmpresa), usando credenciales del servidor.
   * No requiere sesión previa. Si el HTML inicial no trae &lt;option&gt;, se usa Playwright (select rellenado por JS).
   */
  /** Fuerza renovación del cache de empresas en la próxima llamada */
  static invalidateEmpresasCache() {
    empresasCache = null;
    listEmpresasErrorTs = 0; // también limpiar cooldown de error
  }

  static async listEmpresasDisponibles(): Promise<SiiEmpresa[]> {
    // Servir desde cache si es reciente (evita múltiples logins al SII)
    if (empresasCache && Date.now() - empresasCache.ts < EMPRESAS_CACHE_TTL_MS) {
      console.log(`[SII] listEmpresasDisponibles: desde cache (${empresasCache.empresas.length} empresas)`);
      return empresasCache.empresas;
    }

    // Cooldown tras error reciente: no volver a martillar el SII si falló hace < 30s
    const msDesdeError = Date.now() - listEmpresasErrorTs;
    if (listEmpresasErrorTs > 0 && msDesdeError < EMPRESAS_ERROR_COOLDOWN_MS) {
      console.warn(`[SII] listEmpresasDisponibles: cooldown tras error (${Math.round(msDesdeError / 1000)}s < 30s), usando fallback DB/env`);
      // Intentar servir desde DB/env sin nuevo login
      return SiiFacturacionService.listEmpresasFallbackSinLogin();
    }

    // Deduplicar llamadas concurrentes: si ya hay una en vuelo, esperar la misma promesa
    if (listEmpresasEnVuelo) {
      console.log('[SII] listEmpresasDisponibles: esperando llamada en vuelo existente...');
      return listEmpresasEnVuelo;
    }

    listEmpresasEnVuelo = SiiFacturacionService.listEmpresasDisponiblesImpl().finally(() => {
      listEmpresasEnVuelo = null;
    });
    return listEmpresasEnVuelo;
  }

  /** Implementación real — solo llamada una vez a la vez gracias al deduplicador de arriba. */
  private static async listEmpresasDisponiblesImpl(): Promise<SiiEmpresa[]> {
    const credService = SiiCredentialsService.getInstance();
    const creds = credService.getCredentials();
    if (!creds) throw new Error('Credenciales SII no configuradas');

    let htmlEmp = '';
    let authHttpOk = false;
    let httpErrMsg = '';
    try {
      const st = await siiHttpLoginUpToSelEmpresaHtml(creds.username, creds.password);
      htmlEmp = st.htmlEmp;
      authHttpOk = true;
    } catch (httpErr: any) {
      httpErrMsg = String(httpErr?.message || httpErr);
      console.warn('[SII] listEmpresasDisponibles: login HTTP hasta sel empresa falló:', httpErrMsg);
    }

    if (htmlEmp && htmlEsFormularioLoginSii(htmlEmp) && !/<option\b/i.test(htmlEmp)) {
      console.warn('[SII] listEmpresasDisponibles: HTTP parece login Zeusr; se sigue con Playwright');
    }

    let empresas = mergeEmpresasPreferirPrimera(
      parseEmpresasSelHtml(htmlEmp),
      parseEmpresasRutsDesdeHtmlAmplio(htmlEmp)
    );

    let authPwOk = false;
    let pwErrMsg = '';
    // Activar Playwright si: (a) HTTP no encontró opciones, o (b) encontró solo RUTs sin nombre
    const todasSinNombre = empresas.length > 0 && empresas.every(e => !e.text || e.text === e.value);
    if (empresas.length === 0 || todasSinNombre) {
      console.log(
        `[SII] listEmpresasDisponibles: ${todasSinNombre ? 'empresas sin nombre' : '0 opciones'} en HTML, intentando DOM con Playwright (max 60s)...`
      );
      try {
        // Timeout de 60s para evitar bloqueo indefinido (Queue-it, lentitud SII, etc.)
        const pwEmpresas = await Promise.race([
          this.extractEmpresasDesdePlaywright(creds.username, creds.password),
          new Promise<SiiEmpresa[]>((_, reject) =>
            setTimeout(() => reject(new Error('Playwright timeout 60s')), 60_000)
          ),
        ]);
        authPwOk = true;
        console.log(`[SII] listEmpresasDisponibles: Playwright → ${pwEmpresas.length} empresa(s)`);
        if (pwEmpresas.length > 0) {
          if (empresas.length === 0) {
            empresas = pwEmpresas;
          } else {
            const pwMap = new Map(pwEmpresas.map(e => [rutEmpresaMapKey(e.value), e]));
            empresas = empresas.map(e => {
              const pw = pwMap.get(rutEmpresaMapKey(e.value));
              return pw && pw.text && pw.text !== pw.value ? pw : e;
            });
          }
        }
      } catch (pwErr: any) {
        pwErrMsg = String(pwErr?.message || pwErr);
        console.warn('[SII] listEmpresasDisponibles: Playwright:', pwErrMsg);
      }
    }

    // ── Fallback 1: empresas desde .env (SII_COMPANY1, SII_COMPANY2, ...) ────
    if (empresas.length === 0) {
      const envEmpresas: SiiEmpresa[] = [];
      for (let i = 1; i <= 20; i++) {
        const rut = process.env[`SII_COMPANY${i}`]?.trim();
        if (!rut) break;
        const norm = normalizarRutEmpresaValor(rut);
        if (norm) envEmpresas.push({ value: norm, text: norm });
      }
      if (envEmpresas.length > 0) {
        console.log(`[SII] listEmpresasDisponibles: usando ${envEmpresas.length} empresa(s) de SII_COMPANYn env`);
        empresas = envEmpresas;
      }
    }

    // ── Fallback 2: empresas conocidas desde la base de datos ─────────────────
    if (empresas.length === 0) {
      try {
        const repo = AppDataSource.getRepository(SiiFacturaEntity);
        const rows: { empresaRut: string }[] = await repo
          .createQueryBuilder('f')
          .select('DISTINCT f.empresaRut', 'empresaRut')
          .getRawMany();
        if (rows.length > 0) {
          console.log(`[SII] listEmpresasDisponibles: usando ${rows.length} empresa(s) desde DB (fallback)`);
          empresas = rows
            .map(r => normalizarRutEmpresaValor(r.empresaRut))
            .filter(Boolean)
            .map(rut => ({ value: rut!, text: rut! }));
        }
      } catch (dbErr: any) {
        console.warn('[SII] listEmpresasDisponibles: error consultando DB:', dbErr?.message);
      }
    }

    if (empresas.length === 0) {
      if (!authHttpOk && !authPwOk) {
        listEmpresasErrorTs = Date.now(); // activar cooldown para no volver a intentar de inmediato
        throw new Error(
          `No se pudo iniciar sesión en el SII para listar empresas. HTTP: ${httpErrMsg || '(sin detalle)'}. Playwright: ${pwErrMsg || 'no ejecutado'}.`
        );
      }
      try {
        const { rutcntr } = parseRutForSiiLogin(creds.username);
        empresas = [{ value: rutcntr, text: `${rutcntr} — RUT de acceso (sin empresas adicionales en el portal)` }];
      } catch {
        listEmpresasErrorTs = Date.now();
        throw new Error(
          'Sesión SII alcanzada pero no hay empresas en el selector y el RUT de acceso (SII_USERNAME) no es válido.'
        );
      }
    }

    // Enriquecer con nombre de empresa desde servicio público SII
    const empresasConNombre = await Promise.all(
      empresas.map(async (e) => {
        if (e.text && e.text !== e.value) return e; // ya tiene nombre
        const nombre = await SiiFacturacionService.fetchNombreEmpresaPublica(e.value);
        return nombre ? { ...e, text: nombre } : e;
      })
    );

    listEmpresasErrorTs = 0; // éxito → limpiar cooldown
    const sorted = empresasConNombre.sort((a, b) => a.value.localeCompare(b.value, 'es'));
    empresasCache = { empresas: sorted, ts: Date.now() };
    return sorted;
  }

  /**
   * Devuelve empresas desde .env (SII_COMPANYn) o DB sin hacer login al SII.
   * Usado durante el cooldown de error para no bloquear el UI con mensajes de fallo.
   */
  private static async listEmpresasFallbackSinLogin(): Promise<SiiEmpresa[]> {
    const empresas: SiiEmpresa[] = [];
    // 1. Desde .env
    for (let i = 1; i <= 20; i++) {
      const rut = process.env[`SII_COMPANY${i}`]?.trim();
      if (!rut) break;
      const norm = normalizarRutEmpresaValor(rut);
      if (norm) empresas.push({ value: norm, text: norm });
    }
    if (empresas.length > 0) return empresas;
    // 2. Desde DB
    try {
      const repo = AppDataSource.getRepository(SiiFacturaEntity);
      const rows: { empresaRut: string }[] = await repo
        .createQueryBuilder('f')
        .select('DISTINCT f.empresaRut', 'empresaRut')
        .getRawMany();
      for (const r of rows) {
        const rut = normalizarRutEmpresaValor(r.empresaRut);
        if (rut) empresas.push({ value: rut, text: rut });
      }
    } catch { /* DB no disponible */ }
    return empresas;
  }

  /** Consulta el nombre de una empresa en el servicio público del SII (sin autenticación). */
  private static async fetchNombreEmpresaPublica(rut: string): Promise<string | null> {
    try {
      const parsed = normalizarRutEmpresaValor(rut);
      if (!parsed) return null;
      const dashIdx = parsed.lastIndexOf('-');
      const rutBody = parsed.slice(0, dashIdx);
      const dv = parsed.slice(dashIdx + 1);
      const http = axios.create({
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
        timeout: 6000,
        validateStatus: () => true,
        responseType: 'arraybuffer',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
          'Accept-Language': 'es-CL,es;q=0.9',
        },
      });
      // Intentar primero POST, luego GET
      let res = await http.post(
        'https://zeus.sii.cl/cvc_cgi/stc/getstc',
        `RUT=${encodeURIComponent(rutBody)}&DV=${encodeURIComponent(dv)}`,
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      if (res.status !== 200 || !res.data || (res.data as Buffer).length < 10) {
        res = await http.get(
          `https://zeus.sii.cl/cvc_cgi/stc/getstc?RUT=${encodeURIComponent(rutBody)}&DV=${encodeURIComponent(dv)}`
        );
      }
      const html = String(decodeSiiHtmlResponseBody(res.data, String(res.headers['content-type'] ?? '')));
      console.log(`[SII] getstc RUT=${rutBody}-${dv} status=${res.status} snippet=${html.slice(0, 300)}`);
      const m = html.match(/<RS>([^<]+)<\/RS>/i)
        ?? html.match(/<razon_social[^>]*>([^<]+)<\/razon_social>/i)
        ?? html.match(/<nombre[^>]*>([^<]+)<\/nombre>/i)
        ?? html.match(/Raz[oó]n\s+Social[^:]*:\s*([^\n<]+)/i)
        ?? html.match(/<td[^>]*>\s*([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ\s\.,&()-]{4,})\s*<\/td>/i);
      if (m) {
        const nombre = m[1].replace(/\s+/g, ' ').trim();
        if (nombre.length > 1) return nombre;
      }
      return null;
    } catch (err: any) {
      console.warn(`[SII] fetchNombreEmpresaPublica(${rut}):`, err?.message);
      return null;
    }
  }

  // ── Obtener facturas emitidas con paginación (axios) ──────────────────────

  static async getFacturasEmitidas(
    axiosClient: AxiosInstance,
    opts: {
      tipoCodigo?: number;
      fechaDesde?: string;  // YYYY-MM-DD
      fechaHasta?: string;
      maxPaginas?: number;
      /** Si todos los CODIGO de la página ya están en DB, no pedir páginas más antiguas (listado reciente primero). */
      stopIfAllCodigosInDb?: Set<string>;
      /** Mínimo de páginas a traer aunque todos los CODIGOs estén en DB (para corregir datos existentes). */
      minPaginas?: number;
    } = {}
  ): Promise<SiiFactura[]> {
    const { tipoCodigo, fechaDesde, fechaHasta, maxPaginas = 50, stopIfAllCodigosInDb, minPaginas = 0 } = opts;
    const facturas: SiiFactura[] = [];
    let pagina = 1;
    let prevPaginaCodigosKey = '';

    while (pagina <= maxPaginas) {
      const params = new URLSearchParams({
        RUT_RECP: '',
        FOLIO: '',
        RZN_SOC: '',
        FEC_DESDE: fechaDesde ? this.toSiiDate(fechaDesde) : '',
        FEC_HASTA: fechaHasta ? this.toSiiDate(fechaHasta) : '',
        TPO_DOC: tipoCodigo ? String(tipoCodigo) : '',
        ESTADO: '',
        ORDEN: '',
        NUM_PAG: String(pagina),
      });

      const res = await axiosClient.get(`${SII_URLS.listadoEmitidos}?${params}`);
      const html = String(res.data);

      if (htmlIndicaExcesoSesionesSii(html)) {
        console.warn('[SII] getFacturasEmitidas:', MENSAJE_EXCESO_SESIONES_SII);
        break;
      }

      // Detección robusta de CODIGOs (confirma que la página tiene datos)
      const codigosEnPagina = [...new Set(
        [...html.matchAll(/CODIGO=(\d+)/g)].map(m => m[1])
      )];
      if (codigosEnPagina.length === 0) {
        // Loguear el motivo para diagnóstico
        if (html.includes('id="rutcntr"') || html.includes('IngresoRutClave')) {
          console.warn('[SII] getFacturasEmitidas: redirigió a LOGIN — sesión inválida o expirada');
        } else if (html.includes('salaespera') || html.includes('queue')) {
          console.warn('[SII] getFacturasEmitidas: en sala de espera (queue-it)');
        } else if (html.length < 500) {
          console.warn(`[SII] getFacturasEmitidas: respuesta muy corta (${html.length} bytes) — pág ${pagina}`);
        } else {
          // Primer chunk para diagnóstico
          console.warn(`[SII] getFacturasEmitidas: sin CODIGO en pág ${pagina}. HTML(500): ${html.substring(0, 500).replace(/\s+/g, ' ')}`);
        }
        if (pagina === 1) console.warn('[SII] getFacturasEmitidas: primera página sin datos → sesión o empresa incorrecta?');
        break;
      }

      const rows = parseTableRows(html);
      // Filas de datos: al menos 4 celdas Y contienen un CODIGO en sus links
      const filasDatos = rows.filter(r =>
        r.cells.length >= 4 &&
        (r.links.some(l => l.includes('CODIGO=')) || r.cells.join(' ').includes('CODIGO='))
      );

      for (const row of filasDatos) {
        // Buscar CODIGO en los links o en el texto de la fila
        const linkCodigo = row.links.find(l => l.includes('CODIGO='))
          || row.cells.find(c => c.includes('CODIGO='));
        if (!linkCodigo) continue;
        const codigoM = linkCodigo.match(/CODIGO=(\d+)/);
        if (!codigoM) continue;

        // Extraer datos por posición (el primer TD suele ser acción, luego datos)
        // Ignoramos la primera celda si parece ser botón/link (pocas letras)
        const dataCells = row.cells.filter((c, i) => i > 0 || c.length > 5);
        const [col0, col1, col2, col3, col4, col5, col6] = dataCells;

        // El SII usa layouts distintos según el tipo de documento:
        //   Tipo 33 (7 celdas): [rut | razonSocial | tipoDoc | folio | fecha | monto | estado]
        //   Tipo 34/52 (6 celdas): [rut+razonSocial_juntos | tipoDoc | folio | fecha | monto | estado]
        //
        // Detección: si col1 parece un nombre de tipo de documento, el primer campo combina rut+nombre.
        const isTipoDocText = (s: string) =>
          /(factura|electronica|electrónica|exenta|gu[ií]a|nota|despacho|cr[eé]dito|d[eé]bito|boleta|liquidaci[oó]n|compra|exportaci[oó]n)/i.test(
            s || ''
          );
        const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}/.test((s || '').trim());

        let rutReceptorParsed: string, razonSocialParsed: string, tipoDocParsed: string;
        let folio: number, fecha: string, montoStr: string, estado: string;

        if (isTipoDocText(col1)) {
          // Formato compacto: col0 = "RUT NombreEmpresa" (rut y nombre en una sola celda)
          const rutM = (col0 || '').match(/^(\d{7,8}-[\dKk])\s*(.*)/);
          rutReceptorParsed  = rutM ? rutM[1] : (col0 || '').trim();
          razonSocialParsed  = rutM?.[2]?.trim() || '';
          tipoDocParsed      = (col1 || '').trim();
          folio    = parseInt(col2 || '0', 10) || 0;
          fecha    = (col3 || '').trim();
          montoStr = col4 || '0';
          estado   = (col5 || '').trim();
        } else {
          // Formato estándar: col0=rut, col1=razonSocial, col2=tipoDoc
          rutReceptorParsed = (col0 || '').trim();
          razonSocialParsed = (col1 || '').trim();
          tipoDocParsed     = (col2 || '').trim();
          if (isDate(col3)) {
            // Sin columna Folio
            folio    = 0;
            fecha    = (col3 || '').trim();
            montoStr = col4 || '0';
            estado   = (col5 || '').trim();
          } else {
            folio    = parseInt(col3 || '0', 10) || 0;
            fecha    = (col4 || '').trim();
            montoStr = col5 || '0';
            estado   = (col6 || '').trim();
          }
        }

        facturas.push({
          codigo: codigoM[1],
          rutReceptor: rutReceptorParsed,
          razonSocial: razonSocialParsed,
          tipoDocumento: tipoDocParsed,
          tipoCodigo: detectTipoCodigo(tipoDocParsed),
          folio,
          fecha,
          monto: parseMonto(montoStr),
          estado,
        });
      }

      // Si encontramos CODIGOs pero ninguna fila parseó bien, construir desde CODIGOs directos
      if (filasDatos.length === 0 && codigosEnPagina.length > 0) {
        for (const codigo of codigosEnPagina) {
          if (!facturas.find(f => f.codigo === codigo)) {
            facturas.push({
              codigo,
              rutReceptor: '', razonSocial: '', tipoDocumento: '',
              tipoCodigo: 33, folio: 0, fecha: '', monto: 0, estado: '',
            });
          }
        }
      }

      if (stopIfAllCodigosInDb && codigosEnPagina.length > 0 && pagina >= minPaginas) {
        const todosYaEnDb = codigosEnPagina.every((c) => stopIfAllCodigosInDb.has(c));
        if (todosYaEnDb) {
          console.log(
            `[SII] getFacturasEmitidas: parada anticipada (pág. ${pagina}) — sin documentos nuevos respecto a la DB`
          );
          break;
        }
      }

      const pagKey = [...codigosEnPagina].sort().join(',');
      if (pagina > 1 && pagKey && pagKey === prevPaginaCodigosKey) {
        console.warn(`[SII] getFacturasEmitidas: pág. ${pagina} repite la misma lista — fin paginación`);
        break;
      }
      prevPaginaCodigosKey = pagKey;

      // Menos de 10 CODIGOs en la página: última página del SII (listado típico ~30; última es corta)
      if (codigosEnPagina.length > 0 && codigosEnPagina.length < 10) break;

      pagina++;
      await new Promise(r => setTimeout(r, 250)); // respetar el servidor
    }

    return facturas;
  }

  /**
   * URL de visualización tal como la entrega el listado: ALL_PAGE_ANT, CODIGO, csrt (anti-replay).
   * Sin eso el SII puede responder 501 ptr NULL / error 02.35.
   */
  static async resolveEmitidoDocumentUrl(
    axiosClient: AxiosInstance,
    codigo: string,
    opts: { tipoCodigo?: number; fechaDesde?: string; fechaHasta?: string; maxPaginas?: number } = {}
  ): Promise<{ docUrl: string; refererListado: string }> {
    const { tipoCodigo, fechaDesde, fechaHasta, maxPaginas = 40 } = opts;
    let pagina = 1;
    let prevEmitidoPagKey = '';

    while (pagina <= maxPaginas) {
      const params = new URLSearchParams({
        RUT_RECP: '',
        FOLIO: '',
        RZN_SOC: '',
        FEC_DESDE: fechaDesde ? this.toSiiDate(fechaDesde) : '',
        FEC_HASTA: fechaHasta ? this.toSiiDate(fechaHasta) : '',
        TPO_DOC: tipoCodigo ? String(tipoCodigo) : '',
        ESTADO: '',
        ORDEN: '',
        NUM_PAG: String(pagina),
      });
      const listUrl = `${SII_URLS.listadoEmitidos}?${params}`;
      const res = await axiosClient.get(listUrl, { timeout: 45000, validateStatus: () => true });
      const html = String(res.data);
      const found = findGesDocEmiLinkForCodigo(html, codigo);
      if (found) {
        console.log(`[SII] resolveEmitido: enlace con token desde listado pág. ${pagina}`);
        return { docUrl: found, refererListado: listUrl };
      }
      const codigosEnPagina = [...new Set([...html.matchAll(/CODIGO=(\d+)/g)].map((m) => m[1]))];
      if (codigosEnPagina.length === 0) break;
      const pagKey = [...codigosEnPagina].sort().join(',');
      if (pagina > 1 && pagKey && pagKey === prevEmitidoPagKey) break;
      prevEmitidoPagKey = pagKey;
      if (codigosEnPagina.length > 0 && codigosEnPagina.length < 10) break;
      pagina++;
      await new Promise((r) => setTimeout(r, 250));
    }

    console.warn(`[SII] resolveEmitido: sin href en listado para CODIGO=${codigo}, usando solo CODIGO=`);
    return { docUrl: emitidoDocUrl(codigo), refererListado: listadoEmitidosRefererPage1() };
  }

  // ── Obtener última factura por cliente (axios) ────────────────────────────

  static async getUltimaFacturaPorCliente(
    axiosClient: AxiosInstance,
    opts: { tipoCodigo?: number; maxPaginas?: number } = {}
  ): Promise<UltimaFacturaCliente[]> {
    const todas = await this.getFacturasEmitidas(axiosClient, opts);
    const mapa = new Map<string, SiiFactura>();
    for (const f of todas) {
      if (!f.rutReceptor) continue;
      const actual = mapa.get(f.rutReceptor);
      if (!actual || f.folio > actual.folio) mapa.set(f.rutReceptor, f);
    }
    return Array.from(mapa.values())
      .sort((a, b) => b.folio - a.folio)
      .map(f => ({
        rutReceptor: f.rutReceptor,
        razonSocial: f.razonSocial,
        tipoCodigo: f.tipoCodigo,
        tipoDocumento: f.tipoDocumento,
        folio: f.folio,
        fecha: f.fecha,
        monto: f.monto,
        codigo: f.codigo,
      }));
  }

  // ── Obtener detalle de factura vía "Copiar Documento" (axios) ─────────────

  /** Un intento con PTDC_CODIGO fijo */
  private static getDetalleFacturaConTipo(
    axiosClient: AxiosInstance,
    codigo: string,
    tipoCodigo: number
  ): Promise<SiiFacturaDetalle | null> {
    return this.parseDetalleCopiarDocHtml(axiosClient, codigo, tipoCodigo);
  }

  private static async parseDetalleCopiarDocHtml(
    axiosClient: AxiosInstance,
    codigo: string,
    tipoCodigo: number
  ): Promise<SiiFacturaDetalle | null> {
    const url = `${SII_URLS.copiarDoc}?IGUAL=CODIGO&VALOR=${codigo}&PTDC_CODIGO=${tipoCodigo}`;
    const res = await axiosClient.get(url, {
      timeout: 45000,
      validateStatus: () => true,
      headers: emitidoFetchExtraHeaders(),
    });
    const html = String(res.data);
    if (res.status >= 400 || isLoginLikeHtml(html)) return null;

    const campos = parseFormFields(html);
    augmentCamposFromDatosArrayScript(html, campos);
    augmentCamposFromLooseEfxpScriptPairs(html, campos);
    augmentReceptorFromRecptorDirActEcoScripts(html, campos);
    augmentFormaPagoFromArrPagosScript(html, campos);
    augmentReferenciasResumenFromScript(html, campos);
    const getVal = (name: string) => campos.get(name) || '';

    const rutRecep = getVal('EFXP_RUT_RECEP');
    if (!rutRecep) return null;

    const items = buildDetalleItemsFromCampos(campos);

    const sumLineas = items.reduce((acc, it) => {
      const st = it.subtotal > 0 ? it.subtotal : Math.round(it.cantidad * it.precioUnitario);
      return acc + st;
    }, 0);

    let neto = firstPositiveMonto(getVal, [
      'EFXP_MNT_NETO',
      'EFXP_TOT_NETO',
      'EFXP_VALOR_NETO',
      'EFXP_NETO',
      'MNT_NETO',
    ]);
    let iva = firstPositiveMonto(getVal, [
      'EFXP_IVA',
      'EFXP_VALOR_IVA',
      'EFXP_MNT_IVA',
      'EFXP_IVA_RECUP',
    ]);
    let total = firstPositiveMonto(getVal, [
      'EFXP_MNT_TOTAL',
      'EFXP_MNT_TOT',
      'EFXP_TOT_DOC',
      'EFXP_TOTAL',
      'EFXP_MNT_TOT_DOC',
    ]);
    if (neto === 0 && sumLineas > 0) neto = sumLineas;
    if (total === 0 && neto > 0 && iva > 0) total = neto + iva;
    if (total === 0 && neto > 0 && iva === 0 && tipoCodigo === 34) total = neto;
    if (total === 0 && sumLineas > 0) total = iva > 0 ? sumLineas + iva : sumLineas;

    const montoParsed = total > 0 ? total : firstPositiveMonto(getVal, ['EFXP_MNT_TOTAL', 'EFXP_MNT_TOT', 'EFXP_TOTAL']);

    if (tipoCodigo === 33 && montoParsed > 0 && neto === 0 && iva === 0) {
      neto = Math.round(montoParsed / 1.19);
      iva = Math.max(0, montoParsed - neto);
    }

    if (items.length === 0 && montoParsed > 0) {
      const sample = [...campos.keys()]
        .filter((k) => /EFXP_(NMB|QTY|PRC|SUBT|MNT|IVA|TOT)/i.test(k))
        .slice(0, 45);
      console.warn(`[SII] parseDetalle codigo=${codigo}: sin líneas, monto≈${montoParsed}. Claves: ${sample.join(', ')}`);
    }

    const dvRecep = getVal('EFXP_DV_RECEP');
    const folioRaw =
      getVal('EFXP_FOLIO') ||
      getVal('EFXP_NUM_FOLIO') ||
      getVal('EFXP_NRO_FOLIO') ||
      getVal('NUM_FOLIO');
    const folio = parseInt(folioRaw.replace(/\D/g, ''), 10) || 0;

    return {
      codigo,
      rutReceptor: dvRecep ? `${rutRecep}-${dvRecep}` : rutRecep,
      razonSocial: getVal('EFXP_RZN_SOC_RECEP'),
      tipoDocumento: tipoCodigo === 33 ? 'Factura Electronica'
        : tipoCodigo === 34 ? 'Factura Exenta Electronica'
        : tipoCodigo === 39 ? 'Boleta Electronica'
        : tipoCodigo === 41 ? 'Boleta Exenta Electronica'
        : tipoCodigo === 43 ? 'Liquidacion Factura Electronica'
        : tipoCodigo === 46 ? 'Factura de Compra Electronica'
        : tipoCodigo === 52 ? 'Guia de Despacho Electronica'
        : tipoCodigo === 61 ? 'Nota de Credito Electronica'
        : tipoCodigo === 56 ? 'Nota de Debito Electronica'
        : tipoCodigo === 110 ? 'Factura de Exportacion Electronica'
        : tipoCodigo === 111 ? 'Nota de Debito de Exportacion Electronica'
        : tipoCodigo === 112 ? 'Nota de Credito de Exportacion Electronica'
        : `Documento Tipo ${tipoCodigo}`,
      tipoCodigo,
      folio,
      fecha: getVal('EFXP_FCH_EMIS'),
      monto: montoParsed,
      estado: '',
      items,
      dirReceptor: pickDirReceptorFromCampos(campos, getVal),
      comunaReceptor: getVal('EFXP_CMNA_RECEP'),
      ciudadReceptor: getVal('EFXP_CIUDAD_RECEP'),
      giroReceptor: pickGiroReceptorFromCampos(campos, getVal),
      formaPago: resolveFormaPagoText(campos, getVal),
      subtotal:
        firstPositiveMonto(getVal, ['EFXP_SUBTOTAL', 'EFXP_MNT_SUBT']) || sumLineas || neto,
      neto,
      iva,
      total: total > 0 ? total : montoParsed,
      detalleExtendido: snapshotEfxpCampos(campos),
    } as SiiFacturaDetalle;
  }

  static async getDetalleFactura(
    axiosClient: AxiosInstance,
    codigo: string,
    tipoCodigo: number = 33
  ): Promise<SiiFacturaDetalle | null> {
    const ordenTipos = [tipoCodigo, 33, 34, 43, 46, 52, 61, 56, 39, 41, 110, 111, 112].filter(
      (t, i, a) => a.indexOf(t) === i
    );
    for (const tc of ordenTipos) {
      const det = await this.getDetalleFacturaConTipo(axiosClient, codigo, tc);
      if (det) return det;
    }
    return null;
  }

  /** Trae detalle del SII y lo guarda en sii_facturas (ítems, totales, etc.) */
  static async refreshDetalleEnDb(
    empresaRut: string,
    codigo: string,
    axiosClient: AxiosInstance,
    tipoCodigo?: number
  ): Promise<SiiFacturaDetalle | null> {
    const det = await this.getDetalleFactura(axiosClient, codigo, tipoCodigo ?? 33);
    if (!det) return null;
    const repo = AppDataSource.getRepository(SiiFacturaEntity);
    const patch = mergeDetalleFacturaToDbPatch(det, {
      razonSocial: det.razonSocial,
      rutReceptor: det.rutReceptor,
      tipoDocumento: det.tipoDocumento,
      tipoCodigo: det.tipoCodigo,
    });
    if (det.fecha) patch.fecha = det.fecha;
    if (det.folio > 0) patch.folio = det.folio;
    await repo.upsert(
      { empresaRut, codigo, ...patch },
      { conflictPaths: ['empresaRut', 'codigo'] },
    );
    return det;
  }

  // ── Emitir factura replicando la anterior (Puppeteer) ─────────────────────

  static async emitirFactura(
    page: Page,
    params: {
      /** Si se omite, abre factura nueva vacía (PTDC_CODIGO sin copiar). */
      codigoOriginal?: string | null;
      tipoCodigo: number;
      fechaEmision: string;  // YYYY-MM-DD
      items: Array<{
        numero: number;
        descripcion: string;
        descripcionExtendida?: string;
        cantidad?: number;
        precioUnitario?: number;
      }>;
      /** RUT emisor Bioma — asegura empresa seleccionada antes de copiar documento */
      empresaRut?: string;
      /** Datos del receptor (pedido Shopify); sobrescriben los de la plantilla */
      rutReceptor?: string;
      razonSocial?: string;
      giroReceptor?: string;
      comunaReceptor?: string;
      ciudadReceptor?: string;
      dirReceptor?: string;
      /** Descuento global MiPyme (Shopify order-level discount). */
      descuentoGlobal?: DescuentoGlobalEmitParams | null;
    },
    opts?: {
      /** No pulsar Guardar ni completar firma; útil para probar hasta la pantalla previa a la clave. */
      detenerEnPreview?: boolean;
      /** Con detenerEnPreview: solo rellena el formulario y deja Chrome abierto (sin «Validar y visualizar»). */
      previewSoloFormulario?: boolean;
      /** Si > 0 y el navegador es visible (SII_PLAYWRIGHT_HEADED=1), espera ms antes de cerrar la pestaña. */
      esperarMsEnPreview?: number;
      /** Clave de firma electrónica SII para el paso GUARDAR. Requerida para emitir en modo headless. */
      firmaClave?: string;
      /** Bioma: abrir | rellenar | emitir — avance incremental del scraper */
      scraperStep?: 'abrir' | 'rellenar' | 'emitir';
      /** Si la sesión Playwright ya eligió empresa, no repetir selectEmpresa. */
      skipEmpresaSelect?: boolean;
      /** Si el tab ya visitó el listado emitidos (ptrTkn), omitir ensurePtrTkn. */
      skipPtrTkn?: boolean;
    }
  ): Promise<{
    success: boolean;
    folio?: number;
    siiCodigo?: string;
    error?: string;
    detenidoEnPreview?: boolean;
    previewUrl?: string;
    /** Informativo cuando success y detenidoEnPreview (no es fallo). */
    aviso?: string;
    /** Campos leídos del formulario tras rellenar (retroalimentación real). */
    formSnapshot?: SiiEmitFormSnapshot;
  }> {
    const { codigoOriginal, tipoCodigo, fechaEmision, items, empresaRut,
      rutReceptor, razonSocial, giroReceptor, comunaReceptor, ciudadReceptor, dirReceptor,
      descuentoGlobal } = params;
    const detenerEnPreview = !!opts?.detenerEnPreview;
    const previewSoloFormulario = !!opts?.previewSoloFormulario;
    const scraperStep = opts?.scraperStep || 'emitir';
    const esperarMs =
      typeof opts?.esperarMsEnPreview === 'number' && opts.esperarMsEnPreview > 0
        ? opts.esperarMsEnPreview
        : parseInt(process.env.SII_EMITIR_PREVIEW_WAIT_MS || '0', 10) || 0;
    // Clave de firma: usa la opción pasada, o la variable de entorno, o vacío
    const firmaClave = opts?.firmaClave ?? process.env.SII_FIRMA_CLAVE?.trim() ?? '';

    const ultimoDialogoSii = { texto: '' };
    wireSafeDialogs(page, { capture: ultimoDialogoSii });
    const t0 = Date.now();
    const lockHeavyEmit = !detenerEnPreview;
    if (lockHeavyEmit) SiiFacturacionService.beginHeavySiiOp('emitir');

    try {
    if (!opts?.skipPtrTkn) {
      await this.ensurePtrTknOnPage(page, opts?.skipEmpresaSelect ? undefined : empresaRut);
    } else {
      console.log('[SII] emitir — reutilizando tab con ptrTkn (sin listado emitidos)');
    }

    const url = buildEmitFormUrl(tipoCodigo, codigoOriginal);
    const modo = codigoOriginal?.trim() ? `copiar ${codigoOriginal}` : 'factura nueva';

    const loadEmitForm = async (): Promise<{ pageUrl: string; pageTitle: string; pageHtml: string }> => {
      console.log(`[SII] emitir — navegando a formulario (${modo}): ${url}`);
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
        referer: SII_URLS.listadoEmitidos,
      }).catch(async () => {
        await page.goto(url, { waitUntil: 'commit', timeout: 60000, referer: SII_URLS.listadoEmitidos });
      });
      await page.waitForTimeout(400);
      const pageUrl = page.url();
      const pageTitle = await page.title().catch(() => '?');
      const pageHtml = await page.content().catch(() => '');
      console.log(`[SII] emitir — URL actual: ${pageUrl} | título: ${pageTitle}`);
      return { pageUrl, pageTitle, pageHtml };
    };

    let { pageUrl, pageHtml } = await loadEmitForm();

    if (SiiFacturacionService.isSiiPtrTknErrorHtml(pageHtml)) {
      console.warn('[SII] emitir — Error 501 al copiar; reintentando ensurePtrTkn + empresa...');
      try {
        await this.ensurePtrTknOnPage(page, empresaRut);
        ({ pageUrl, pageHtml } = await loadEmitForm());
      } catch (retryErr: any) {
        return {
          success: false,
          error: retryErr?.message || 'Sesión MiPyme incompleta al copiar documento. Cierra sesión, sincroniza de nuevo e intenta emitir.',
        };
      }
    }

    if (isSiiHardBlockHtml(pageHtml)) {
      SiiFacturacionService.markSiiBlocked('SII rechazó copiar documento');
      return {
        success: false,
        error:
          'El SII rechazó el navegador automático. Espera unos minutos, entra manualmente en sii.cl y vuelve a intentar.',
      };
    }

    if (SiiFacturacionService.isSiiPtrTknErrorHtml(pageHtml)) {
      return {
        success: false,
        error:
          'Sesión MiPyme incompleta (Error 501 al abrir el formulario). Cierra sesión en el workbench, vuelve a sincronizar MiPyme e intenta emitir de nuevo.',
      };
    }

    // Verificar si la sesión expiró o hay redirección a login
    if (pageUrl.includes('IngresoRutClave') || pageUrl.includes('AUT2000')) {
      return { success: false, error: 'Sesión SII expirada durante emisión. Vuelve a sincronizar para renovar la sesión.' };
    }

    // Esperar el formulario VIEW_EFXP — si no aparece, loguear el HTML para diagnóstico
    const formFound = await page.waitForSelector('form[name="VIEW_EFXP"], form#VIEW_EFXP, form', { timeout: 25000 })
      .then(() => true)
      .catch(() => false);

    if (!formFound) {
      const snippet = await page.evaluate(() => (globalThis as any).document?.body?.innerHTML?.slice(0, 800) ?? '').catch(() => '');
      console.error(`[SII] emitir — formulario NO encontrado. HTML snippet: ${snippet}`);
      const hint = codigoOriginal?.trim()
        ? `Verifica que el código ${codigoOriginal} pertenezca a la empresa seleccionada.`
        : 'El SII no devolvió el formulario de factura nueva.';
      return { success: false, error: `El formulario de emisión no cargó (URL: ${pageUrl}). ${hint}` };
    }
    console.log(`[SII] emitir — formulario VIEW_EFXP encontrado`);

    if (scraperStep === 'abrir') {
      return {
        success: true,
        detenidoEnPreview: true,
        previewUrl: page.url(),
        aviso: codigoOriginal?.trim()
          ? 'Paso 1 OK: formulario copiado abierto en Chrome. Siguiente: Rellenar datos del pedido.'
          : 'Paso 1 OK: formulario de factura nueva abierto en Chrome. Siguiente: Rellenar datos del pedido.',
      };
    }

    // Sobrescribir receptor del pedido Shopify (la plantilla trae otro cliente)
    const waitEmitFormReady = async () => {
      await page.waitForSelector('form[name="VIEW_EFXP"], form#VIEW_EFXP', { timeout: 30000, state: 'attached' });
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(400);
    };

    const readEmitFormField = async (fieldName: string): Promise<string> => {
      const sel = `input[name="${fieldName}"], select[name="${fieldName}"], textarea[name="${fieldName}"]`;
      return page
        .$eval(sel, (node: any) => String(node.value || '').trim())
        .catch(() => '');
    };

    const setFieldSafe = async (fieldName: string, value: string) => {
      if (!value?.trim()) return;
      const sel = `input[name="${fieldName}"], select[name="${fieldName}"], textarea[name="${fieldName}"]`;
      try {
        await page.waitForSelector(sel, { state: 'attached', timeout: 10000 });
        const el = await page.$(sel);
        if (!el) return;
        const tag = await el.evaluate((node: any) => node.tagName?.toLowerCase() || '');
        const type = await el.evaluate((node: any) => node.type?.toLowerCase() || '');
        const isHidden = type === 'hidden' || !(await el.isVisible().catch(() => false));
        if (tag === 'select') {
          await page.selectOption(sel, { label: value.trim() }).catch(async () => {
            await page.selectOption(sel, value.trim()).catch(() => {});
          });
        } else if (isHidden) {
          await page.$eval(sel, (node: any, v: string) => {
            node.value = v;
            node.dispatchEvent(new Event('change', { bubbles: true }));
          }, value.trim());
        } else {
          await page.fill(sel, value.trim());
          await page.$eval(sel, (node: any) => {
            node.dispatchEvent(new Event('change', { bubbles: true }));
            node.dispatchEvent(new Event('input', { bubbles: true }));
          });
        }
      } catch (err: any) {
        console.warn(`[SII] emitir — campo ${fieldName}:`, err?.message || err);
      }
    };

    const rutSplit = rutReceptor ? splitRutForSiiForm(rutReceptor) : null;
    let siiRazon = '';
    let siiGiro = '';
    let siiDir = '';
    let siiComuna = '';
    let siiCiudad = '';
    if (rutSplit) {
      const rutActual = await readEmitFormField('EFXP_RUT_RECEP');
      const dvActual = (await readEmitFormField('EFXP_DV_RECEP')).toUpperCase();
      const rutYaOk =
        rutActual.replace(/\./g, '') === rutSplit.body.replace(/\./g, '') &&
        dvActual === rutSplit.dv.toUpperCase();
      if (!rutYaOk) {
        // Cambiar RUT dispara recarga del formulario en el SII — esperar antes de seguir
        const navDone = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() =>
          page.waitForLoadState('domcontentloaded', { timeout: 25000 }).catch(() => {}),
        );
        await setFieldSafe('EFXP_RUT_RECEP', rutSplit.body);
        await setFieldSafe('EFXP_DV_RECEP', rutSplit.dv);
        await page.locator('input[name="EFXP_DV_RECEP"]').press('Tab').catch(() => {});
        await navDone;
        await waitEmitFormReady();
      } else {
        console.log('[SII] emitir — RUT receptor ya coincide, omitiendo recarga SII');
      }
      const postRutHtml = await page.content().catch(() => '');
      if (isSiiRejectionOrBlockHtml(postRutHtml)) {
        SiiFacturacionService.markSiiBlocked('SII rechazó al cambiar RUT receptor');
        return { success: false, error: 'El SII rechazó la consulta del RUT receptor. Espera e intenta manual en sii.cl.' };
      }
      siiRazon = await readEmitFormField('EFXP_RZN_SOC_RECEP');
      siiGiro =
        (await readEmitFormField('EFXP_GIRO_RECEP')) ||
        (await readEmitFormField('EFXP_GIRO_RECEP_DEFUALT'));
      siiDir = await readEmitFormField('EFXP_DIR_RECEP');
      siiComuna = await readEmitFormField('EFXP_CMNA_RECEP');
      siiCiudad = await readEmitFormField('EFXP_CIUDAD_RECEP');
      console.log(`[SII] emitir — receptor RUT: ${rutSplit.body}-${rutSplit.dv}`);
      if (siiRazon) console.log(`[SII] emitir — razón social SII (sin sobrescribir): ${siiRazon}`);
    }
    if (!siiRazon && razonSocial) {
      await setFieldSafe('EFXP_RZN_SOC_RECEP', razonSocial);
      console.log(`[SII] emitir — razón social (fallback pedido): ${razonSocial}`);
    }
    if (!siiGiro && giroReceptor) {
      await setFieldSafe('EFXP_GIRO_RECEP', giroReceptor);
      console.log(`[SII] emitir — giro receptor (fallback pedido): ${giroReceptor}`);
    } else if (siiGiro) {
      console.log(`[SII] emitir — giro receptor SII (sin sobrescribir): ${siiGiro}`);
    }
    if (!siiComuna && comunaReceptor) await setFieldSafe('EFXP_CMNA_RECEP', comunaReceptor);
    if (!siiCiudad && ciudadReceptor) await setFieldSafe('EFXP_CIUDAD_RECEP', ciudadReceptor);
    if (!siiDir && dirReceptor) {
      await setFieldSafe('EFXP_DIR_RECEP', dirReceptor);
      await setFieldSafe('EFXP_DIR_RECEP_DEFUALT', dirReceptor);
    } else if (siiDir) {
      console.log(`[SII] emitir — dirección SII (sin sobrescribir): ${siiDir}`);
    }

    // Fecha de emisión
    await page.$eval('input[name="EFXP_FCH_EMIS"]', (el: any, v: string) => { el.value = v; }, fechaEmision)
      .catch(() => {});

    // ── Ítems ────────────────────────────────────────────────────────────────
    // El formulario SII arranca con 2 filas visibles. Si hay más ítems hay que
    // clickear "AGREGA_DETALLE" para que aparezca cada fila adicional.
    const agregarFilaSii = async (numStr: string) => {
      const descSel = `input[name="EFXP_NMB_${numStr}"]`;
      if (await page.$(descSel)) return; // fila ya existe
      // Clickear el botón de agregar fila y esperar a que aparezca
      const addBtn = await page.$('input[name="AGREGA_DETALLE"], button[name="AGREGA_DETALLE"]');
      if (addBtn) {
        await addBtn.click();
        // Esperar hasta 3s a que aparezca la nueva fila
        await page.waitForSelector(descSel, { timeout: 3000 }).catch(() => {});
        console.log(`[SII] emitir — fila ${numStr} agregada con AGREGA_DETALLE`);
      } else {
        console.warn(`[SII] emitir — no se encontró AGREGA_DETALLE para fila ${numStr}`);
      }
    };

    for (const item of items) {
      const num = String(item.numero).padStart(2, '0');

      // Asegurar que la fila existe antes de llenarla
      await agregarFilaSii(num);

      await fillEmitirItemDescripcion(page, num, item.descripcion, item.descripcionExtendida);

      if (item.precioUnitario !== undefined && item.precioUnitario > 0) {
        const prcSel = `input[name="EFXP_PRC_${num}"]`;
        if (await page.$(prcSel)) {
          await page.$eval(prcSel, (el: any, v: string) => {
            el.value = v;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }, String(item.precioUnitario));
        }
      } else {
        console.warn(`[SII] emitir — línea ${num} sin precio válido (>0), omitiendo PRC`);
      }

      if (item.cantidad !== undefined) {
        const qtySel = `input[name="EFXP_QTY_${num}"]`;
        if (await page.$(qtySel)) {
          await page.$eval(qtySel, (el: any, v: string) => {
            el.value = v;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }, String(item.cantidad));
        }
      }
    }

    if (items.length > 0) {
      const lastNum = String(items[items.length - 1].numero).padStart(2, '0');
      const lastQtySel = `input[name="EFXP_QTY_${lastNum}"]`;
      const lastPrcSel = `input[name="EFXP_PRC_${lastNum}"]`;
      const lastSel = (await page.$(lastQtySel)) ? lastQtySel : lastPrcSel;
      await page.locator(lastSel).press('Tab').catch(() => {});
      await page.waitForTimeout(600);
    }

    await clearUnusedEmitFormLines(page, items.length);

    // ── Rellenar ciudad/comuna emisor y receptor (campos requeridos por el SII) ──
    // Primero escanear TODOS los inputs del form para encontrar los nombres reales
    const allInputNames: { name: string; value: string; type: string }[] = await page.evaluate(() => {
      const d = (globalThis as any).document;
      if (!d) return [];
      return Array.from(d.querySelectorAll('input, select, textarea')).map((e: any) => ({
        name: e.name || '',
        value: e.value || '',
        type: e.type || e.tagName.toLowerCase(),
      })).filter((e: any) => e.name);
    }).catch(() => []);
    if (/^(1|true|yes)$/i.test(String(process.env.SII_DEBUG || '').trim())) {
      console.log('[SII] emitir — inputs form:', allInputNames.length);
    }

    // Función genérica: rellena el primer input cuyo name matchee el patrón
    const fillByPattern = async (pattern: RegExp, value: string) => {
      if (!value) return false;
      const match = allInputNames.find(i => pattern.test(i.name));
      if (!match) return false;
      await page.$eval(
        `input[name="${match.name}"], select[name="${match.name}"]`,
        (el: any, v: string) => {
          if (!el.value || el.value.trim() === '') {
            el.value = v;
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        },
        value,
      ).catch(() => {});
      return true;
    };

    // Helper: rellena campo por nombre exacto si está vacío
    const fillExactIfEmpty = async (fieldName: string, value: string) => {
      if (!value) return;
      await page.$eval(
        `input[name="${fieldName}"], select[name="${fieldName}"], textarea[name="${fieldName}"]`,
        (el: any, v: string) => {
          if (!el.value || el.value.trim() === '') {
            el.value = v;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
        },
        value,
      ).catch(() => {});
    };

    // ── Receptor ─────────────────────────────────────────────────────────────
    await fillByPattern(/ciudad.*recep|recep.*ciudad/i, ciudadReceptor || '');
    await fillByPattern(/cmna.*recep|recep.*cmna|comuna.*recep|recep.*comuna/i, comunaReceptor || '');
    if (dirReceptor) await fillByPattern(/dir.*recep|recep.*dir/i, dirReceptor);

    const ciudadRecField = allInputNames.find((i) => i.name === 'EFXP_CIUDAD_RECEP');
    if (ciudadRecField && !ciudadRecField.value.trim()) {
      const ciudadFill = (ciudadReceptor || '').trim() || 'SANTIAGO';
      await fillExactIfEmpty('EFXP_CIUDAD_RECEP', ciudadFill);
      console.log('[SII] emitir — ciudad receptor rellenada con:', ciudadFill);
    }

    // Giro receptor: el SII usa EFXP_GIRO_RECEP vacío pero EFXP_GIRO_RECEP_DEFUALT con el valor correcto
    const giroRecDefault = allInputNames.find(i => /giro.*recep.*defualt|giro.*recep.*default/i.test(i.name));
    const giroRecValue = giroRecDefault?.value?.trim() || '';
    await fillExactIfEmpty('EFXP_GIRO_RECEP', giroRecValue);
    console.log('[SII] emitir — giro receptor default:', giroRecValue);

    // ── Emisor ───────────────────────────────────────────────────────────────
    // El campo ciudad del emisor se llama EFXP_CIUDAD_ORIGEN (no EMIS)
    // La comuna se llama EFXP_CMNA_ORIGEN (generalmente ya viene llena)
    const ciudadOrigenField = allInputNames.find(i => i.name === 'EFXP_CIUDAD_ORIGEN');
    const comunaOrigenField = allInputNames.find(i => i.name === 'EFXP_CMNA_ORIGEN');
    console.log('[SII] emitir — ciudad origen:', ciudadOrigenField?.value, '| comuna origen:', comunaOrigenField?.value);

    if (ciudadOrigenField && !ciudadOrigenField.value.trim()) {
      // Derivar ciudad desde la comuna (Las Condes, Providencia, Vitacura, etc. → SANTIAGO)
      const comuna = (comunaOrigenField?.value || '').trim().toUpperCase();
      const ciudadDerived = comuna ? 'SANTIAGO' : 'SANTIAGO'; // La mayoría de empresas son RM
      await fillExactIfEmpty('EFXP_CIUDAD_ORIGEN', ciudadDerived);
      console.log('[SII] emitir — ciudad origen rellenada con:', ciudadDerived);
    }
    // Comuna origen: rellenar solo si está vacía (generalmente ya viene)
    if (comunaOrigenField && !comunaOrigenField.value.trim()) {
      await fillExactIfEmpty('EFXP_CMNA_ORIGEN', 'SANTIAGO');
    }

    if (descuentoGlobal && descuentoGlobal.montoNeto > 0) {
      const filled = await fillDescuentoGlobalSii(page, descuentoGlobal, {
        setFieldSafe,
        allInputNames,
      });
      if (!filled) {
        const msg = `No se pudo rellenar el descuento global ($${descuentoGlobal.montoNeto.toLocaleString('es-CL')} neto) en el formulario SII. Revisa el campo «Descuento Global» antes de emitir.`;
        console.warn(`[SII] emitir — ${msg}`);
        if (scraperStep === 'emitir' && !detenerEnPreview) {
          return { success: false, error: msg };
        }
      }
    }

    const formSnapshot = await snapshotEmitFormFromPage(page, items.length);

    // Preview Bioma paso 2: dejar formulario rellenado abierto (sin Validar)
    if (detenerEnPreview && previewSoloFormulario) {
      const previewUrl = page.url();
      if (esperarMs > 0) {
        await new Promise((r) => setTimeout(r, esperarMs));
      }
      return {
        success: true,
        detenidoEnPreview: true,
        previewUrl,
        formSnapshot,
        aviso:
          'Paso 2 OK: formulario rellenado en Chrome. Revisa glosas, descuento global e ítems antes de Emitir.',
      };
    }

    // El SII usa type="button" + VIEW_EFXP.submit() («Validar y visualizar»), no type="submit".
    // Buscar en la página principal y en todos los frames (el SII a veces usa iframes).
    type FrameLike = { $: (sel: string) => Promise<unknown>; $eval: (sel: string, fn: (el: any) => string, ...args: any[]) => Promise<string>; evaluate: (fn: () => string) => Promise<string>; frames?: () => FrameLike[] };
    let submitAction: (() => Promise<void>) | null = null;
    let submitFrame: FrameLike = page as unknown as FrameLike;

    const SUBMIT_SELECTORS = [
      'button[name="Button_Update"]',
      'input[name="Button_Update"]',
      'input[type="button"][value*="Validar"]',
      'input[type="button"][value*="validar"]',
      'input[type="submit"]',
      'button[type="submit"]',
      'button[onclick*="VIEW_EFXP"]',
      'button[onclick*="submit"]',
      'input[onclick*="VIEW_EFXP"]',
    ];

    // Recolectar todos los frames (principal + sub-frames)
    const allFrames: FrameLike[] = [page as unknown as FrameLike];
    for (const f of page.frames()) {
      if (f !== (page as any)) allFrames.push(f as unknown as FrameLike);
    }

    // Esperar a que aparezca al menos un botón en la página antes de buscar
    await page.waitForSelector('button, input[type="button"], input[type="submit"]', { timeout: 10000 }).catch(() => {});

    for (const frame of allFrames) {
      const frameUrl = await (frame as any).url?.() ?? 'main';
      for (const sel of SUBMIT_SELECTORS) {
        const el = await (frame as any).$(sel).catch(() => null);
        if (el) {
          console.log(`[SII] emitir — botón envío encontrado: ${sel} en frame ${frameUrl}`);
          submitAction = () => (el as any).click();
          submitFrame = frame;
          break;
        }
      }
      if (submitAction) break;
      // Buscar por texto «Validar» en cualquier botón/input del frame
      const byText = await (frame as any).evaluate(() => {
        const d = (globalThis as any).document;
        if (!d) return [];
        const els = Array.from(d.querySelectorAll('button, input[type="button"], input[type="submit"]'));
        return els.map((e: any) => ({ tag: e.tagName, name: e.name || '', value: e.value || '', text: (e.textContent || '').trim().slice(0, 60) }));
      }).catch(() => [] as any[]);
      console.log(`[SII] emitir — botones en frame [${frameUrl}]: ${JSON.stringify(byText)}`);
      const match = (byText as any[]).find((b: any) => /validar|visualizar|Button_Update|guardar/i.test(b.text + b.value + b.name));
      if (match) {
        const found = await (frame as any).$(`${match.tag.toLowerCase()}[name="${match.name}"], ${match.tag.toLowerCase()}[value="${match.value}"]`).catch(() => null);
        if (found) {
          console.log(`[SII] emitir — botón por texto encontrado:`, match);
          submitAction = () => (found as any).click();
          submitFrame = frame;
          break;
        }
      }
    }

    if (!submitAction) {
      // Diagnóstico: listar todos los botones de todos los frames para depuración
      const diag = await Promise.all(allFrames.map(async (frame) => {
        return (frame as any).evaluate(() => {
          const d = (globalThis as any).document;
          if (!d) return [];
          const els = Array.from(d.querySelectorAll('button, input[type="button"], input[type="submit"]'));
          return els.map((e: any) => `${e.tagName}[name=${e.name}][value=${e.value}]: ${(e.textContent||'').trim().slice(0,40)}`);
        }).catch(() => []);
      }));
      console.error('[SII] emitir — NO se encontró botón envío. Botones detectados:', JSON.stringify(diag));
      return { success: false, error: 'No se encontró botón de envío (esperado Validar y visualizar / Button_Update)' };
    }

    const ctx = page.context();
    let workPage: Page | null = null;
    workPage = await esperarVistaPreviaTrasValidarVisualizar(page, ctx, submitAction);
    const previewUrl = workPage?.url() ?? page.url();

    if (!workPage || !(await paginaPareceVistaPreviaFacturaSii(workPage))) {
      const hint = await extraerPistaErrorPaginaEmitirSii(page);
      const dlg = ultimoDialogoSii.texto.trim();
      return {
        success: false,
        error:
          dlg
            ? `SII (alert): ${dlg}`
            : hint ||
              `Tras «Validar y visualizar» no apareció la vista previa (URL: ${previewUrl}). Reinicie el backend si el mensaje parece desactualizado. SII_PLAYWRIGHT_HEADED=1, revisar fecha/montos o reabrir sesión.`,
      };
    }

    const pageText = await workPage.$eval('body', (el: any) => el.innerText).catch(() => '');
    const folioMatch = pageText.match(/[Ff]olio[:\s]+(\d+)/);
    const folio = folioMatch ? parseInt(folioMatch[1], 10) : undefined;

    if (detenerEnPreview) {
      if (esperarMs > 0) {
        await new Promise((r) => setTimeout(r, esperarMs));
      }
      return {
        success: true,
        folio,
        detenidoEnPreview: true,
        previewUrl,
        aviso:
          esperarMs > 0
            ? `Esperados ${Math.round(esperarMs / 1000)}s con el navegador abierto (SII_PLAYWRIGHT_HEADED=1) para firmar o revisar.`
            : 'Detenido en vista previa (sin Guardar). En headless no puedes ingresar la clave; en local usa SII_PLAYWRIGHT_HEADED=1 y opcional SII_EMITIR_PREVIEW_WAIT_MS=120000.',
      };
    }

    // Si no hay clave de firma configurada, no podemos firmar en headless — detener en preview
    if (!firmaClave) {
      return {
        success: false,
        folio,
        detenidoEnPreview: true,
        previewUrl,
        error: 'SII_FIRMA_CLAVE no configurada. Agrega la clave de firma en el .env para emitir facturas en modo automático.',
      };
    }

    // Firmar siempre en la pestaña de vista previa (mipeDisplayPreView), no en el formulario EFXP.
    const ctx2 = workPage.context();
    const previewPage =
      ctx2.pages().find((p) => /mipeDisplayPreView/i.test(p.url()) && !p.isClosed()) ?? workPage;
    console.log(`[SII] emitir — páginas en contexto antes de firmar: ${ctx2.pages().map(p => p.url()).join(' | ')}`);

    const FIRMAR_SEL = 'input[name="btnSign"], input[value="Firmar"]';
    let guardarBtn = await previewPage.$(FIRMAR_SEL).catch(() => null);
    let guardarFrame: Page | Frame = previewPage;
    if (!guardarBtn) {
      const GUARDAR_SEL = [
        'input[name="GUARDAR"]',
        'input[name="guardar"]',
        'input[value*="Guardar"]',
        'input[value*="guardar"]',
        'input[type="image"][alt*="Guardar"]',
        'button[value*="Guardar"]',
        'input[type="submit"][value*="Guardar"]',
      ].join(', ');
      guardarBtn = await previewPage.$(GUARDAR_SEL).catch(() => null);
    }
    if (!guardarBtn) {
      for (const fr of previewPage.frames()) {
        guardarBtn = await fr.$(FIRMAR_SEL).catch(() => null);
        if (guardarBtn) { guardarFrame = fr; break; }
      }
    }
    if (!guardarBtn) {
      // Diagnóstico: listar todos los inputs/buttons del workPage y sus frames para depuración
      const diagG = await Promise.all([workPage, ...workPage.frames()].map(async f => {
        const items = await f.evaluate(() => {
          const d = (globalThis as any).document;
          if (!d) return [];
          return Array.from(d.querySelectorAll('input, button')).map((e: any) =>
            `${e.tagName}[name=${e.name}][type=${e.type}][value=${e.value}]`
          );
        }).catch(() => []);
        return { url: f.url?.() ?? 'frame', items };
      }));
      console.error('[SII] emitir — GUARDAR no encontrado. Elementos detectados:', JSON.stringify(diagG));
      return { success: false, folio, previewUrl, error: 'No se encontró el botón Firmar en la vista previa (mipeDisplayPreView).' };
    }
    console.log(`[SII] emitir — botón Firmar encontrado en: ${guardarFrame.url?.() ?? previewPage.url()}`);

    // Manejar el prompt/dialog de clave de firma en CUALQUIER página del contexto
    let dialogoFirmaRespondido = false;
    let errorFirma: string | undefined;
    const paginasConHandler: Page[] = [];
    const onDialogoFirma = async (d: Dialog) => {
      const msg = d.message().toLowerCase();
      console.log(`[SII] emitir dialog (FIRMA): type=${d.type()} msg="${d.message()}"`);
      if (d.type() === 'prompt' || msg.includes('clave') || msg.includes('firma') || msg.includes('password') || msg.includes('pin')) {
        dialogoFirmaRespondido = true;
        console.log(`[SII] emitir — respondiendo prompt de clave con firmaClave`);
        await d.accept(firmaClave).catch(() => {});
      } else if (d.type() === 'alert' || d.type() === 'confirm') {
        errorFirma = d.message();
        console.log(`[SII] emitir — alerta SII post-firma: "${errorFirma}"`);
        await d.dismiss().catch(() => {});
      } else {
        await d.dismiss().catch(() => {});
      }
    };
    const registrarDialogoEnPagina = (p: Page) => {
      setPageDialogHandler(p, onDialogoFirma);
      paginasConHandler.push(p);
    };
    registrarDialogoEnPagina(workPage);
    for (const p of ctx2.pages()) {
      if (p !== workPage) registrarDialogoEnPagina(p);
    }
    // También capturar cualquier nueva página/popup que abra SII al firmar
    const onNuevaPagina = (p: Page) => {
      console.log(`[SII] emitir — nueva página abierta tras btnSign: ${p.url()}`);
      registrarDialogoEnPagina(p);
    };
    ctx2.on('page', onNuevaPagina);

    const htmlFirmaInputSels = [
      'input[type="password"][name*="clave"]',
      'input[type="password"][name*="pass"]',
      'input[type="password"][name*="firma"]',
      'input[type="password"][id*="clave"]',
      'input[type="password"][id*="pass"]',
      'input[type="password"]',  // cualquier password input visible
    ];

    /** Busca input de clave en TODAS las páginas abiertas del contexto */
    const buscarInputClaveEnContexto = async (): Promise<{ page: Page; sel: string } | null> => {
      for (const p of ctx2.pages()) {
        if (p.isClosed()) continue;
        for (const sel of htmlFirmaInputSels) {
          const el = await p.$(sel).catch(() => null);
          if (el && await el.isVisible().catch(() => false)) return { page: p, sel };
        }
      }
      return null;
    };

    try {
      console.log(`[SII] emitir — clickeando btnSign/Firmar (${guardarFrame.url?.() ?? previewPage.url()})…`);
      await guardarBtn.scrollIntoViewIfNeeded().catch(() => {});
      await guardarBtn.click();
      // Algunos flujos SII solo disparan el onclick vía JS directo
      await previewPage.evaluate(() => {
        const btn = (globalThis as any).document?.querySelector('input[name="btnSign"]') as
          | { click?: () => void; onclick?: (ev: Event) => void }
          | null;
        if (btn?.onclick) btn.onclick(new Event('click'));
        else btn?.click?.();
      }).catch(() => {});
      console.log(`[SII] emitir — click en btnSign realizado, esperando prompt/modal de clave…`);
      // onDialogoFirma es el único handler — no usar waitForEvent('dialog') en paralelo
      for (let i = 0; i < 30 && !dialogoFirmaRespondido && !errorFirma; i++) {
        await new Promise((r) => setTimeout(r, 400));
      }
      // Dump diagnóstico solo con SII_DEBUG=1
      await new Promise(r => setTimeout(r, 400));
      const pagesPost = ctx2.pages().filter(p => !p.isClosed());
      console.log(`[SII] emitir — páginas tras click: ${pagesPost.map(p => p.url()).join(' | ')}`);
      if (/^(1|true|yes)$/i.test(String(process.env.SII_DEBUG || '').trim())) {
        for (const pg of pagesPost) {
          const pgTxt = await pg.$eval('body', (el: any) => (el.innerText || '').replace(/\s+/g, ' ').slice(0, 300)).catch(() => '');
          const pgInputs = await pg.evaluate(() => {
            const d = (globalThis as any).document;
            if (!d) return [];
            return Array.from(d.querySelectorAll('input,button')).map((e: any) =>
              `${e.tagName}[name=${e.name}][type=${e.type}][value=${e.value}]`
            );
          }).catch(() => []);
          console.log(`[SII] emitir — página ${pg.url()} inputs:`, JSON.stringify(pgInputs));
          console.log(`[SII] emitir — página ${pg.url()} texto: ${pgTxt}`);
        }
      }

      // El SII puede pedir la clave de firma via:
      //   (a) native browser window.prompt → manejado por onDialogoFirma en cualquier página
      //   (b) modal/página HTML con input[type=password] → hay que buscarlo y llenarlo
      //   (c) nueva pestaña/popup con formulario de clave

      // Esperar hasta 30s: nav en workPage, html-input en cualquier página del contexto, o timeout
      const firmaResult = await Promise.race([
        workPage.waitForNavigation({ waitUntil: 'load', timeout: 29000 }).then(() => {
          console.log(`[SII] emitir — navegación detectada en workPage tras btnSign`);
          return 'nav' as const;
        }).catch(() => 'timeout' as const),
        (async () => {
          const t0 = Date.now();
          while (Date.now() - t0 < 28000) {
            const found = await buscarInputClaveEnContexto();
            if (found) {
              console.log(`[SII] emitir — input clave HTML detectado en página: ${found.page.url()} sel=${found.sel}`);
              return 'html-input' as const;
            }
            // Log periódico de páginas abiertas
            if ((Date.now() - t0) % 5000 < 300) {
              const urls = ctx2.pages().map(p => p.url()).join(' | ');
              console.log(`[SII] emitir — esperando firma… páginas: ${urls}`);
            }
            await new Promise(r => setTimeout(r, 300));
          }
          return 'timeout' as const;
        })(),
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 30000)),
      ]);

      console.log(`[SII] emitir — firmaResult=${firmaResult} dialogoFirma=${dialogoFirmaRespondido}`);

      if (firmaResult === 'html-input') {
        // Llenar el input de clave en la página donde lo encontramos
        const found = await buscarInputClaveEnContexto();
        const targetPage = found?.page ?? workPage;
        console.log(`[SII] emitir — llenando clave en página: ${targetPage.url()}`);
        for (const sel of htmlFirmaInputSels) {
          const el = await targetPage.$(sel).catch(() => null);
          if (el && await el.isVisible().catch(() => false)) {
            await el.fill(firmaClave);
            dialogoFirmaRespondido = true;
            console.log(`[SII] emitir — clave llenada en ${sel}`);
            break;
          }
        }
        // Buscar y clickear el botón de confirmar del modal en esa página
        const confirmSels = [
          'input[name="btnFirmar"]',
          'input[value="Firmar"]',
          'input[value="Aceptar"]',
          'button:has-text("Firmar")',
          'button:has-text("Aceptar")',
          'button:has-text("Confirmar")',
          'button[type="submit"]',
          'input[type="submit"]',
        ];
        for (const sel of confirmSels) {
          const btn = await targetPage.$(sel).catch(() => null);
          if (btn && await btn.isVisible().catch(() => false)) {
            await btn.click();
            console.log(`[SII] emitir — confirmado clave con botón: ${sel}`);
            break;
          }
        }
        // Esperar navegación tras confirmar
        await targetPage.waitForNavigation({ waitUntil: 'load', timeout: 25000 }).catch(() => {});
      }

      // Dar tiempo a que lleguen dialogs/alertas post-firma
      await new Promise((r) => setTimeout(r, 600));

      if (errorFirma) {
        return { success: false, folio, error: `Error de firma SII: ${errorFirma}` };
      }

      // Determinar página final de resultado (puede ser workPage, mipeSendXML o listado)
      let resultPage = workPage;
      for (const p of ctx2.pages()) {
        if (p.isClosed()) continue;
        const u = p.url();
        if (/mipeSendXML/i.test(u)) { resultPage = p; break; }
        if (/mipeAdminDocsEmi|listadoEmitidos|exito|emitid/i.test(u)) { resultPage = p; }
      }

      const urlFinal = resultPage.url();
      const pageTextFinal = await resultPage.$eval('body', (el: any) => el.innerText).catch(() => '');

      // Diagnóstico: dump rápido de todas las páginas del contexto al finalizar
      const pagesDump = ctx2.pages().map(p => `${p.url()}`).join(' | ');
      console.log(`[SII] emitir — páginas tras firma: ${pagesDump}`);
      console.log(`[SII] emitir — URL final: ${urlFinal}`);
      console.log(`[SII] emitir — texto final (primeros 400): ${pageTextFinal.slice(0, 400)}`);

      if (/folio\s*no\s*asignado/i.test(pageTextFinal)) {
        return {
          success: false,
          error: 'El SII no asignó folio. Revisa datos del pedido o emite manualmente en sii.cl.',
        };
      }

      const sendXmlOk = ctx2.pages().some((p) => !p.isClosed() && /mipeSendXML/i.test(p.url()));
      const siiCodigo = (await SiiFacturacionService.extractSiiCodigoFromContext(ctx2)) ?? undefined;
      // No usar `folio` de la vista previa: suele ser el folio de la plantilla copiada, no el asignado.
      let folioFinal = (await SiiFacturacionService.extractFolioFromContext(ctx2).catch(() => null)) ?? undefined;
      if (!folioFinal) {
        const foliosEnTexto = [...pageTextFinal.matchAll(/[Ff]olio[:\s#N°°]*(\d+)/g)]
          .map((m) => parseInt(m[1], 10))
          .filter((n) => Number.isFinite(n) && n > 0);
        if (foliosEnTexto.length) folioFinal = Math.max(...foliosEnTexto);
      }

      const esEmitidoOk =
        (folioFinal && folioFinal > 0) ||
        sendXmlOk ||
        (/enviad.*exitosamente|documento tributario.*enviado/i.test(pageTextFinal)) ||
        (/emitid|DTE emitido|fue enviado|procesado correctamente/i.test(pageTextFinal) &&
          !/folio\s*no\s*asignado/i.test(pageTextFinal)) ||
        /mipeAdminDocsEmi|exito/i.test(urlFinal);

      if (!esEmitidoOk && firmaResult === 'timeout') {
        // Diagnóstico completo en timeout
        const diagAll = await Promise.all(ctx2.pages().filter(p => !p.isClosed()).map(async p => {
          const txt = await p.$eval('body', (el: any) => el.innerText).catch(() => '');
          return { url: p.url(), txt: txt.slice(0, 250) };
        }));
        console.error('[SII] emitir — TIMEOUT firma. Estado páginas:', JSON.stringify(diagAll));
        return {
          success: false,
          folio,
          detenidoEnPreview: true,
          previewUrl: previewPage.url(),
          error: `Firma SII no completada automáticamente. ${dialogoFirmaRespondido ? 'Clave enviada pero sin confirmación' : 'En Chrome (SII_PLAYWRIGHT_HEADED=1) pulsa Firmar e ingresa la clave manualmente, o revisa SII_FIRMA_CLAVE en .env'}`,
        };
      }

      if (!esEmitidoOk) {
        return {
          success: false,
          folio: folioFinal,
          siiCodigo,
          error:
            'La firma se envió pero el SII no confirmó la emisión (sin folio). Revisa en sii.cl antes de reintentar.',
        };
      }

      console.log(
        `[SII] emitir OK — folio=${folioFinal ?? '—'} codigo=${siiCodigo ?? '—'} (${Date.now() - t0}ms)`,
      );
      return { success: true, folio: folioFinal, siiCodigo };
    } finally {
      ctx2.off('page', onNuevaPagina);
      for (const p of paginasConHandler) {
        const wrapped = pageDialogHandlers.get(p);
        if (wrapped) {
          try {
            p.off('dialog', wrapped);
          } catch {
            /* page might be closed */
          }
          pageDialogHandlers.delete(p);
        }
      }
    }
    } finally {
      if (lockHeavyEmit) SiiFacturacionService.endHeavySiiOp('emitir');
    }
  }

  // ── Login HTTP puro (sin Puppeteer) ─────────────────────────────────────
  // Evita Imperva/Queue-it que bloquean browsers headless en IPs de datacenter

  static async loginHTTP(username: string, password: string, empresaRut: string): Promise<string> {
    const st = await siiHttpLoginUpToSelEmpresaHtml(username, password);
    const { htmlEmp, http, getCookieHeader, followRedirects, baseHeaders, mergeCookies } = st;

    // Parsear form action y nombre del select
    const formActionM = htmlEmp.match(/<form[^>]*action="([^"]+)"/i);
    const rawAction = formActionM?.[1] ?? SII_URLS.selEmpresa;
    const formAction = rawAction.startsWith('http') ? rawAction : `https://www1.sii.cl${rawAction.startsWith('/') ? '' : '/'}${rawAction}`;
    const selectNameM = htmlEmp.match(/<select[^>]*name="([^"]+)"/i);
    const selectName = selectNameM?.[1] ?? 'RUT_EMP';

    // Paso 4: POST selección empresa
    const empBody = new URLSearchParams();
    empBody.set(selectName, empresaRut);
    // Incluir inputs hidden del form
    const inputRe2 = /<input([^>]*)>/gi;
    let im: RegExpExecArray | null;
    while ((im = inputRe2.exec(htmlEmp)) !== null) {
      const nameM = im[1].match(/name="([^"]+)"/i);
      const valueM = im[1].match(/value="([^"]+)"/i);
      const typeM = im[1].match(/type="([^"]+)"/i);
      if (nameM && typeM?.[1]?.toLowerCase() !== 'submit') {
        empBody.set(nameM[1], valueM?.[1] ?? '');
      }
    }

    console.log(`[SII HTTP] POST empresa ${empresaRut} → ${formAction}`);
    const empPostRaw = await http.post(formAction, empBody.toString(), {
      headers: {
        ...baseHeaders,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': SII_URLS.selEmpresa,
        'Origin': 'https://www1.sii.cl',
        Cookie: getCookieHeader(),
      },
    });
    const { finalUrl: empFinalUrl } = await followRedirects(empPostRaw, formAction);
    console.log(`[SII HTTP] Empresa final URL: ${empFinalUrl}`);

    // Paso 5: GET listadoEmitidos — valida que la sesión esté operativa (ptrTkn activo).
    console.log('[SII HTTP] GET listadoEmitidos (validar sesión)...');
    const listUrl = listadoEmitidosRefererPage1();
    const listRes = await http.get(listUrl, {
      headers: { ...baseHeaders, Cookie: getCookieHeader(), Referer: SII_URLS.selEmpresa },
    });
    mergeCookies(listRes.headers['set-cookie']);
    const listHtml = String(listRes.data);
    console.log(`[SII HTTP] listadoEmitidos status: ${listRes.status}, bytes: ${listHtml.length}`);

    // Si el SII no devuelve listado operativo, fallback a Playwright (no es bloqueo de cuenta).
    if (!htmlListadoEmitidosOperativo(listHtml)) {
      const snippet = listHtml.replace(/\s+/g, ' ').slice(0, 240);
      console.warn(`[SII HTTP] listado no operativo (${listHtml.length} bytes): ${snippet}`);
      throw new Error(`Login HTTP exitoso pero listado no operativo — requiere Playwright`);
    }

    const finalCookies = getCookieHeader();
    console.log(`[SII HTTP] Login HTTP completo y validado.`);
    return finalCookies;
  }

  // ── Gestión de sesiones ───────────────────────────────────────────────────

  static async createSession(empresaRut: string): Promise<string> {
    SiiFacturacionService.assertSiiAvailable();
    const rutNorm = normalizarRutEmpresaValor(empresaRut) ?? empresaRut;
    const maxAge = SII_SESSION_MAX_AGE_MS;
    for (const [id, s] of sessions.entries()) {
      const started = s.startedAt ?? s.ts;
      if (s.empresaRut === rutNorm && Date.now() - started < maxAge) {
        const probe = await SiiFacturacionService.probeSessionAlive(s);
        if (probe.ok) {
          console.log(`[SII] createSession: reutilizando sesión existente ${id} para ${rutNorm}`);
          s.ts = Date.now();
          return id;
        }
        console.warn(`[SII] createSession: sesión ${id} caducó en SII — creando una nueva`);
        await SiiFacturacionService.closeSession(id).catch(() => {});
        continue;
      }
      if (Date.now() - started >= maxAge) {
        await SiiFacturacionService.closeSession(id).catch(() => {});
      }
    }

    const credService = SiiCredentialsService.getInstance();
    const creds = credService.getCredentials();
    if (!creds) throw new Error('Credenciales SII no configuradas');

    let cookieHeader: string;
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;

    try {
      // Intentar login HTTP primero — no requiere browser, más rápido y funciona en Railway
      console.log('[SII] Intentando login HTTP...');
      cookieHeader = await this.loginHTTP(creds.username, creds.password, rutNorm);
      console.log('[SII] Login HTTP exitoso');
    } catch (httpErr: any) {
      console.warn('[SII] Login HTTP falló, iniciando Playwright:', httpErr.message);
      const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

      // Reutilizar context de listEmpresasDisponibles si está disponible y es reciente
      const pwCtx = playwrightContextDisponible;
      if (pwCtx && Date.now() - pwCtx.ts < PW_CONTEXT_TTL_MS) {
        console.log('[SII] createSession: reutilizando browser de listEmpresasDisponibles');
        browser = pwCtx.browser;
        context = pwCtx.context;
        playwrightContextDisponible = null; // consumir — solo se usa una vez
      } else {
        browser = await launchBrowser();
        context = await browser.newContext({ userAgent: UA, ignoreHTTPSErrors: true });
        wireSafeDialogs(context);
      }
      const page = await context.newPage();
      wireSafeDialogs(page);
      await enableFastMode(page);

      // Si el context viene de listEmpresasDisponibles ya está autenticado — solo seleccionar empresa
      const yaAutenticado = !!(pwCtx && Date.now() - pwCtx.ts < PW_CONTEXT_TTL_MS + 1000);
      if (!yaAutenticado) {
        const loginOk = await this.login(page, creds.username, creds.password);
        if (!loginOk) {
          await SiiFacturacionService.siiLogoutRemoto({ context }).catch(() => {});
          await context.close().catch(() => {});
          await browser.close().catch(() => {});
          throw new Error('Login SII fallido (Playwright)');
        }
      } else {
        console.log('[SII] createSession: context reutilizado — saltando login, yendo directo a selectEmpresa');
        await page.goto(SII_URLS.selEmpresa, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      }

      await this.selectEmpresa(page, rutNorm);

      // Navegar al listado para inicializar ptrTkn en el servidor (necesario para cualquier request)
      console.log('[SII Playwright] Navegando al listado para inicializar ptrTkn...');
      await page.goto(listadoEmitidosRefererPage1(), { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      const pwListHtml = await page.content().catch(() => '');
      if (!htmlListadoEmitidosOperativo(pwListHtml)) {
        await SiiFacturacionService.siiLogoutRemoto({ context }).catch(() => {});
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
        throw new Error('Login Playwright: listado de emitidos no cargó');
      }

      cookieHeader = await this.extractCookieHeader(page);
      await safeClosePage(page);

      // Marcar contexto como listo (ptrTkn activo) — no necesita re-login en ensureBrowserForSession
      const sessionId2 = `sii_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const axiosClient2 = buildAxiosClient(cookieHeader);
      const now = Date.now();
      sessions.set(sessionId2, {
        browser, context, axiosClient: axiosClient2, cookieHeader,
        empresaRut: rutNorm, ts: now, startedAt: now, playwrightReady: true,
        listadoVerifiedAt: now,
      });
      return sessionId2;
    }

    const axiosClient = buildAxiosClient(cookieHeader);
    const sessionId = `sii_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    sessions.set(sessionId, {
      browser, context, axiosClient, cookieHeader, empresaRut: rutNorm, ts: now, startedAt: now,
      listadoVerifiedAt: now,
    });
    return sessionId;
  }

  static sessionExpiresAt(session: SiiSession): number {
    return (session.startedAt ?? session.ts) + SII_SESSION_MAX_AGE_MS;
  }

  /** Comprueba si las cookies HTTP siguen válidas en MiPyme (sin abrir Playwright). */
  static async probeSessionAlive(session: SiiSession): Promise<{ ok: boolean; reason?: string }> {
    try {
      const url = listadoEmitidosRefererPage1();
      const res = await session.axiosClient.get(url, { timeout: 18000, validateStatus: () => true });
      const html = String(res.data || '');
      const finalUrl = String(res.request?.res?.responseUrl || res.config?.url || '');
      if (
        html.includes('id="rutcntr"') ||
        html.includes('IngresoRutClave') ||
        finalUrl.includes('IngresoRutClave') ||
        finalUrl.includes('AUT2000')
      ) {
        return { ok: false, reason: 'Sesión SII expirada — el portal pide login de nuevo' };
      }
      if (isSiiHardBlockHtml(html)) {
        return { ok: false, reason: 'El SII bloqueó el acceso temporalmente' };
      }
      if (!htmlListadoEmitidosOperativo(html) && html.length > 200) {
        return { ok: false, reason: 'Sesión SII inválida — no se pudo abrir el listado de emitidos' };
      }
      return { ok: true };
    } catch (err: any) {
      return { ok: false, reason: err?.message || 'No se pudo verificar la sesión con el SII' };
    }
  }

  static async getSessionStatus(
    sessionId: string,
    opts?: { probe?: boolean },
  ): Promise<{
    valid: boolean;
    exists: boolean;
    expiresAt: number;
    expiresInMs: number;
    playwrightReady?: boolean;
    siiAlive?: boolean;
    reason?: string;
  }> {
    const s = sessions.get(sessionId);
    if (!s) {
      return {
        valid: false,
        exists: false,
        expiresAt: 0,
        expiresInMs: 0,
        reason: 'Sesión no encontrada en el servidor (¿reinicio del backend o cerraste sesión?)',
      };
    }
    const expiresAt = SiiFacturacionService.sessionExpiresAt(s);
    const expiresInMs = expiresAt - Date.now();
    if (expiresInMs <= 0) {
      await SiiFacturacionService.closeSession(sessionId).catch(() => {});
      return {
        valid: false,
        exists: false,
        expiresAt,
        expiresInMs: 0,
        reason: 'Sesión expirada por tiempo (~55 min). Vuelve a iniciar sesión MiPyme.',
      };
    }
    if (opts?.probe) {
      const probe = await SiiFacturacionService.probeSessionAlive(s);
      if (!probe.ok) {
        await SiiFacturacionService.closeSession(sessionId).catch(() => {});
        return {
          valid: false,
          exists: false,
          expiresAt,
          expiresInMs: 0,
          playwrightReady: s.playwrightReady,
          siiAlive: false,
          reason: probe.reason,
        };
      }
      return {
        valid: true,
        exists: true,
        expiresAt,
        expiresInMs,
        playwrightReady: s.playwrightReady,
        siiAlive: true,
      };
    }
    return {
      valid: true,
      exists: true,
      expiresAt,
      expiresInMs,
      playwrightReady: s.playwrightReady,
    };
  }

  static getSession(sessionId: string): SiiSession | null {
    const s = sessions.get(sessionId);
    if (!s) return null;
    const expiresAt = SiiFacturacionService.sessionExpiresAt(s);
    if (Date.now() >= expiresAt) {
      void SiiFacturacionService.closeSession(sessionId);
      return null;
    }
    s.ts = Date.now();
    return s;
  }

  /**
   * Notifica al SII el cierre de sesión (Zeusr) para liberar cupos de sesiones concurrentes.
   */
  static async siiLogoutRemoto(opts: {
    axiosClient?: AxiosInstance;
    cookieHeader?: string;
    context?: BrowserContext | null;
  }): Promise<void> {
    const url = SII_URLS.logoutZeusr;
    if (opts.axiosClient) {
      await opts.axiosClient.get(url, { timeout: 18000, validateStatus: () => true }).catch(() => {});
    } else if (opts.cookieHeader) {
      const c = buildAxiosClient(opts.cookieHeader);
      await c.get(url, { timeout: 18000, validateStatus: () => true }).catch(() => {});
    }
    if (opts.context) {
      const pg = await opts.context.newPage().catch(() => null);
      if (pg) {
        try {
          await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 18000 }).catch(() => {});
        } finally {
          await pg.close().catch(() => {});
        }
      }
    }
  }

  static async closeSession(sessionId: string): Promise<void> {
    const s = sessions.get(sessionId);
    if (!s) return;
    await SiiFacturacionService.siiLogoutRemoto({
      axiosClient: s.axiosClient,
      cookieHeader: s.cookieHeader,
      context: s.context,
    }).catch(() => {});
    if (s.context) await s.context.close().catch(() => {});
    if (s.browser) await s.browser.close().catch(() => {});
    sessions.delete(sessionId);
  }

  /** Cierra TODAS las sesiones activas (browsers Playwright incluidos). Llamar en shutdown. */
  static async closeAllSessions(): Promise<void> {
    const ids = [...sessions.keys()];
    console.log(`[SII] shutdown: cerrando ${ids.length} sesión(es) activa(s)...`);
    await Promise.allSettled(ids.map((id) => SiiFacturacionService.closeSession(id)));
    console.log('[SII] shutdown: sesiones cerradas.');
  }

  /**
   * Obtiene (o crea) el BrowserContext con login completo para la sesión.
   * Si la sesión fue creada via HTTP, lanza un browser Playwright y hace el login completo
   * para inicializar ptrTkn en el servidor SII. El contexto queda cached en la sesión.
   */
  static async ensureBrowserForSession(session: SiiSession): Promise<BrowserContext> {
    if (session.context) return session.context;

    const inflight = ensureBrowserPromises.get(session);
    if (inflight) return inflight;

    const work = this.ensureBrowserForSessionInner(session);
    ensureBrowserPromises.set(session, work);
    try {
      return await work;
    } finally {
      ensureBrowserPromises.delete(session);
    }
  }

  private static async ensureBrowserForSessionInner(session: SiiSession): Promise<BrowserContext> {
    SiiFacturacionService.assertSiiAvailable();
    if (session.context) return session.context;

    const browser = await launchBrowser();
    session.browser = browser;

    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    const context = await browser.newContext({ userAgent: UA, ignoreHTTPSErrors: true });
    wireSafeDialogs(context);
    session.context = context;

    // Si la sesión ya tiene cookies HTTP, reutilizarlas — evita un segundo login Playwright
    // que suele disparar «Su requerimiento no ha sido bien recepcionado» en el SII.
    if (session.cookieHeader?.trim()) {
      const bootstrapPage = await context.newPage();
      try {
        console.log('[SII] Bootstrap Playwright desde cookies HTTP (sin re-login)...');
        await setEmitidoPlaywrightCookies(bootstrapPage, session.cookieHeader);
        wireSafeDialogs(bootstrapPage);

        const tryListadoEnPage = async (label: string): Promise<boolean> => {
          const listadoUrl = listadoEmitidosRefererPage1();
          console.log(`[SII] Bootstrap: ${label} → ${listadoUrl}`);
          await bootstrapPage.goto(listadoUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await bootstrapPage.waitForTimeout(600);
          const listHtml = await bootstrapPage.content().catch(() => '');
          if (htmlListadoEmitidosOperativo(listHtml)) {
            session.cookieHeader = await this.extractCookieHeader(bootstrapPage);
            session.axiosClient = buildAxiosClient(session.cookieHeader);
            session.playwrightReady = true;
            session.scraperPage = bootstrapPage;
            console.log(`[SII] Playwright listo via cookies HTTP (${label})`);
            return true;
          }
          const snippet = listHtml.replace(/\s+/g, ' ').slice(0, 200);
          console.warn(`[SII] Bootstrap ${label} — listado no reconocido: ${snippet}`);
          return false;
        };

        if (await tryListadoEnPage('listado directo')) return context;

        // Confirmar con axios (misma sesión HTTP) antes de forzar selectEmpresa en Playwright
        if (session.axiosClient) {
          const axRes = await session.axiosClient
            .get(listadoEmitidosRefererPage1(), { validateStatus: () => true })
            .catch(() => null);
          const axHtml = axRes ? String(axRes.data) : '';
          if (htmlListadoEmitidosOperativo(axHtml)) {
            await setEmitidoPlaywrightCookies(bootstrapPage, session.cookieHeader);
            if (await tryListadoEnPage('listado tras probe axios')) return context;
          }
        }

        const preHtml = await bootstrapPage.content().catch(() => '');
        if (!isLoginLikeHtml(preHtml) && !isSiiHardBlockHtml(preHtml)) {
          try {
            await this.ensurePtrTknOnPage(bootstrapPage, session.empresaRut);
            session.cookieHeader = await this.extractCookieHeader(bootstrapPage);
            session.axiosClient = buildAxiosClient(session.cookieHeader);
            session.playwrightReady = true;
            session.scraperPage = bootstrapPage;
            console.log('[SII] Playwright listo via cookies HTTP (tras selectEmpresa)');
            return context;
          } catch (ptrErr: any) {
            console.warn('[SII] Bootstrap ptrTkn falló:', ptrErr?.message || ptrErr);
          }
        }
        console.warn('[SII] Cookies HTTP no bastaron para Playwright — intentando login completo');
      } catch (err: any) {
        console.warn('[SII] Bootstrap HTTP falló:', err?.message || err);
      } finally {
        if (session.scraperPage !== bootstrapPage) {
          await safeClosePage(bootstrapPage);
        }
      }
    }

    // Fallback: login Playwright completo para inicializar ptrTkn.
    const credService = SiiCredentialsService.getInstance();
    const creds = credService.getCredentials();
    if (creds) {
      const loginPage = await context.newPage();
      wireSafeDialogs(loginPage);
      await enableFastMode(loginPage);
      try {
        console.log('[SII] Iniciando Playwright login (ptrTkn)...');
        const ok = await this.login(loginPage, creds.username, creds.password);
        if (ok) {
          await this.ensurePtrTknOnPage(loginPage, session.empresaRut);
          session.playwrightReady = true;
          session.scraperPage = loginPage;
          console.log('[SII] Contexto listo: login Playwright completo, ptrTkn disponible');
        }
      } catch (err: any) {
        console.warn('[SII] Playwright login falló:', err?.message || err);
      } finally {
        if (session.scraperPage !== loginPage) {
          await safeClosePage(loginPage);
        }
      }
    }

    if (!session.playwrightReady) {
      throw new Error(
        'Sesión MiPyme incompleta (listado de emitidos no cargó). ' +
          'Cierra sesión en el workbench, vuelve a sincronizar MiPyme e intenta emitir de nuevo.',
      );
    }
    return context;
  }

  /** Reutiliza la pestaña con ptrTkn ya inicializado (evita listado emitidos duplicado). */
  static async acquireScraperPage(session: SiiSession): Promise<{ page: Page; reused: boolean }> {
    const context = await this.ensureBrowserForSession(session);
    const existing = session.scraperPage;
    if (existing && !existing.isClosed()) {
      return { page: existing, reused: true };
    }
    const page = await context.newPage();
    wireSafeDialogs(page);
    session.scraperPage = page;
    return { page, reused: false };
  }

  static extractSiiCodigoFromPages(ctx: BrowserContext): string | null {
    for (const p of ctx.pages()) {
      if (p.isClosed()) continue;
      const url = p.url();
      const m = url.match(/[?&](?:CODIGO|DHDR_CODIGO)=([^&]+)/i);
      if (m?.[1]) return decodeURIComponent(m[1]);
    }
    return null;
  }

  /** Extrae DHDR_CODIGO desde URLs o HTML (p. ej. mipeSendXML.cgi tras firma exitosa). */
  static async extractSiiCodigoFromContext(ctx: BrowserContext): Promise<string | null> {
    const fromUrl = this.extractSiiCodigoFromPages(ctx);
    if (fromUrl) return fromUrl;
    for (const p of ctx.pages()) {
      if (p.isClosed()) continue;
      const fromHtml = await this.extractSiiCodigoFromPageHtml(p).catch(() => null);
      if (fromHtml) return fromHtml;
    }
    return null;
  }

  private static async extractSiiCodigoFromPageHtml(page: Page): Promise<string | null> {
    const html = await page.content().catch(() => '');
    if (!html) return null;
    const patterns = [
      /DHDR_CODIGO=(\d+)/i,
      /[?&]CODIGO=(\d+)/i,
      /name=["']DHDR_CODIGO["'][^>]*value=["'](\d+)["']/i,
      /value=["'](\d+)["'][^>]*name=["']DHDR_CODIGO["']/i,
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m?.[1]) return m[1];
    }
    return null;
  }

  private static extractFolioFromHtml(html: string): number | null {
    if (!html) return null;
    const fieldPatterns = [
      /name=["']EFXP_FOLIO["'][^>]*value=["'](\d+)["']/i,
      /name=["']EFXP_NUM_FOLIO["'][^>]*value=["'](\d+)["']/i,
      /name=["']EFXP_NRO_FOLIO["'][^>]*value=["'](\d+)["']/i,
      /value=["'](\d+)["'][^>]*name=["']EFXP_FOLIO["']/i,
    ];
    for (const re of fieldPatterns) {
      const m = html.match(re);
      if (m?.[1]) {
        const n = parseInt(m[1], 10);
        if (n > 0) return n;
      }
    }
    return null;
  }

  static async extractFolioFromContext(ctx: BrowserContext): Promise<number | null> {
    const candidates: number[] = [];
    const pages = ctx.pages().filter((p) => !p.isClosed());
    const ordered = [
      ...pages.filter((p) => /mipeSendXML/i.test(p.url())),
      ...pages.filter((p) => !/mipeSendXML/i.test(p.url())),
    ];
    for (const p of ordered) {
      const html = await p.content().catch(() => '');
      const fromField = this.extractFolioFromHtml(html);
      if (fromField) candidates.push(fromField);
      const txt = await p.$eval('body', (el: any) => el.innerText || '').catch(() => '');
      for (const m of txt.matchAll(/[Ff]olio[:\s#N°°]*(\d+)/g)) {
        const n = parseInt(m[1], 10);
        if (n > 0) candidates.push(n);
      }
    }
    if (!candidates.length) return null;
    return Math.max(...candidates);
  }

  /** Folio real desde detalle o listado SII (más fiable que regex en HTML de plantilla). */
  static async resolveFolioForCodigo(
    axiosClient: AxiosInstance,
    codigo: string,
    tipoCodigo = 33,
  ): Promise<number | null> {
    try {
      const det = await this.getDetalleFactura(axiosClient, codigo, tipoCodigo);
      if (det?.folio && det.folio > 0) return det.folio;
    } catch {
      /* detalle puede fallar si el doc es muy reciente */
    }
    try {
      const list = await this.getFacturasEmitidas(axiosClient, { tipoCodigo, maxPaginas: 5 });
      const hit = list.find((f) => String(f.codigo) === String(codigo));
      if (hit?.folio && hit.folio > 0) return hit.folio;
    } catch {
      /* listado */
    }
    return null;
  }

  static async ensureFacturaRowStub(
    empresaRut: string,
    codigo: string,
    partial: Partial<SiiFacturaEntity> = {},
  ): Promise<void> {
    const repo = AppDataSource.getRepository(SiiFacturaEntity);
    const rut = normalizarRutEmpresaValor(empresaRut) ?? empresaRut;
    await repo.upsert(
      { empresaRut: rut, codigo: String(codigo), ...partial },
      { conflictPaths: ['empresaRut', 'codigo'] },
    );
  }

  /** Descarga PDF del SII y lo guarda en sii_facturas (crea fila si no existe). */
  static async fetchPdfToDb(codigo: string, empresaRut?: string): Promise<Buffer | null> {
    const rut =
      normalizarRutEmpresaValor(empresaRut ?? '') ??
      normalizarRutEmpresaValor(process.env.BIOMA_EMPRESA_RUT ?? '') ??
      normalizarRutEmpresaValor(process.env.SII_EMPRESA_RUT ?? '');
    if (!rut) throw new Error('empresaRut no configurado');
    await this.ensureFacturaRowStub(rut, codigo);
    const sessionId = await this.createSession(rut);
    const session = this.getSession(sessionId);
    if (!session) throw new Error('Sesión SII no disponible');
    const ctx = session.context ?? (await this.ensureBrowserForSession(session));
    await this.downloadPdf(ctx, codigo);
    return this.getPdfData(codigo);
  }

  /** Última factura emitida en el listado SII para un RUT receptor (pág. reciente). */
  static async findUltimaFacturaParaReceptor(
    axiosClient: AxiosInstance,
    rutReceptor: string,
    tipoCodigo = 33,
  ): Promise<{ codigo: string; folio: number } | null> {
    const key = rutReceptor.replace(/\./g, '').replace(/-/g, '').replace(/\s/g, '').toLowerCase();
    if (!key) return null;
    const list = await this.getFacturasEmitidas(axiosClient, { tipoCodigo, maxPaginas: 2 });
    for (const f of list) {
      const fk = (f.rutReceptor || '').replace(/\./g, '').replace(/-/g, '').replace(/\s/g, '').toLowerCase();
      if (fk === key && f.codigo && f.folio > 0) {
        return { codigo: f.codigo, folio: f.folio };
      }
    }
    return null;
  }

  // ── Ver factura real en SII ───────────────────────────────────────────────
  // Sesión HTTP + URL completa desde listado (csrt, etc.). Fallback Playwright con BrowserContext.

  static async getPreviewHTML(
    axiosClient: AxiosInstance,
    context: BrowserContext,
    codigo: string,
    cookieHeader?: string,
    empresaRut?: string,
    playwrightLoggedIn?: boolean
  ): Promise<{ html: string; resolvedDocUrl: string }> {
    const { docUrl, refererListado } = await this.resolveEmitidoDocumentUrl(axiosClient, codigo);
    try {
      const res = await axiosClient.get(docUrl, {
        timeout: 90000,
        validateStatus: () => true,
        headers: emitidoFetchExtraHeaders(refererListado),
      });
      const html = String(res.data);
      if (res.status < 400 && !isLoginLikeHtml(html) && !isSiiRejectionOrBlockHtml(html)) {
        return { html: normalizeEmitidoHtml(html), resolvedDocUrl: docUrl };
      }
    } catch {
      /* fallback Playwright */
    }

    const page = await context.newPage();
    try {
      if (playwrightLoggedIn) {
        // Contexto ya tiene login completo: ptrTkn activo, csrt disponible en los hrefs.
        console.log('[SII] getPreviewHTML: usando contexto Playwright con login completo (ptrTkn listo)');
      } else {
        // Fallback: contexto sin login completo — inyectar cookies y seleccionar empresa
        await setEmitidoPlaywrightCookies(page, cookieHeader);
        if (empresaRut) {
          await this.selectEmpresa(page, empresaRut).catch(() => {});
        }
      }

      // Navegar al listado base (inicializa ptrTkn si aún no está) y luego a la página concreta
      await page.goto(SII_URLS.listadoEmitidos, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await page.goto(refererListado, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

      // Buscar el link — el csrt ya viene en el href cuando ptrTkn está activo
      const linkHandle = await page.$(`a[href*="CODIGO=${codigo}"]`).catch(() => null);
      if (linkHandle) {
        await Promise.all([
          page.waitForLoadState('domcontentloaded').catch(() => {}),
          linkHandle.click(),
        ]);
      } else {
        // Fallback: navegar directo si no encontró el link en el listado renderizado
        await page.goto(docUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
      }

      const finalUrl = page.url();
      const html = await page.content();
      if (isSiiRejectionOrBlockHtml(html)) {
        throw new Error(
          'El SII devolvió la página de error (suele bloquear IPs de datacenter o automatización). ' +
            'Prueba obtener el HTML vía sesión local con el script fetchOneFacturaSii.'
        );
      }
      return { html: normalizeEmitidoHtml(html), resolvedDocUrl: finalUrl };
    } finally {
      await page.close().catch(() => {});
    }
  }

  // ── Descargar PDF y guardar en DB como BYTEA ─────────────────────────────
  // Usa mipeDisplayPDF.cgi — endpoint directo del SII que retorna application/pdf.
  // Mucho más rápido que renderizar el HTML con el browser.

  static async downloadPdf(
    context: BrowserContext,
    codigo: string,
    empresaRut?: string,
  ): Promise<void> {
    const pdfUrl = `https://www1.sii.cl/cgi-bin/Portal001/mipeDisplayPDF.cgi?DHDR_CODIGO=${codigo}`;

    // Usamos el request del contexto Playwright: lleva automáticamente las cookies de la sesión
    const response = await context.request.get(pdfUrl, { timeout: 60000 });

    if (!response.ok()) {
      throw new Error(`mipeDisplayPDF devolvió HTTP ${response.status()} para CODIGO=${codigo}`);
    }

    const ct = response.headers()['content-type'] || '';
    if (!ct.includes('pdf') && !ct.includes('octet-stream')) {
      const body = await response.text();
      if (isLoginLikeHtml(body)) throw new Error(`PDF CODIGO=${codigo}: sesión expirada (redirigió al login)`);
      throw new Error(`PDF CODIGO=${codigo}: content-type inesperado "${ct}" — posible error SII`);
    }

    const pdfBuffer = Buffer.from(await response.body());
    const repo = AppDataSource.getRepository(SiiFacturaEntity);
    const rut =
      normalizarRutEmpresaValor(empresaRut ?? '') ??
      normalizarRutEmpresaValor(process.env.BIOMA_EMPRESA_RUT ?? '') ??
      normalizarRutEmpresaValor(process.env.SII_EMPRESA_RUT ?? '');
    if (rut) await this.ensureFacturaRowStub(rut, codigo);

    const updated = await repo
      .createQueryBuilder()
      .update(SiiFacturaEntity)
      .set({ hasPdf: true, pdfData: () => ':data' } as any)
      .setParameter('data', pdfBuffer)
      .where('codigo = :codigo', { codigo })
      .execute();

    if (!updated.affected && rut) {
      await repo.save({
        empresaRut: rut,
        codigo: String(codigo),
        hasPdf: true,
        pdfData: pdfBuffer,
      });
    }

    console.log(`[SII] PDF guardado: CODIGO=${codigo} (${pdfBuffer.length} bytes)`);
  }

  // ── Leer PDF desde DB ─────────────────────────────────────────────────────

  static async getPdfData(codigo: string): Promise<Buffer | null> {
    const repo = AppDataSource.getRepository(SiiFacturaEntity);
    const row = await repo
      .createQueryBuilder('f')
      .select('f.pdfData')
      .where('f.codigo = :codigo', { codigo })
      .getOne();
    return row?.pdfData ?? null;
  }

  // ── Background job: descarga silenciosa de PDFs pendientes ───────────────

  private static _bgJobs = new Set<string>(); // evita jobs duplicados por empresaRut
  private static _heavySiiOps = 0;

  /** Bloquea sync histórico y descarga masiva de PDFs mientras hay emisión/firma activa. */
  static beginHeavySiiOp(label: string): void {
    this._heavySiiOps++;
    console.log(`[SII] heavy op +1 (${label}) depth=${this._heavySiiOps}`);
  }

  static endHeavySiiOp(label: string): void {
    this._heavySiiOps = Math.max(0, this._heavySiiOps - 1);
    console.log(`[SII] heavy op -1 (${label}) depth=${this._heavySiiOps}`);
  }

  static isHeavySiiOpInProgress(): boolean {
    return this._heavySiiOps > 0;
  }

  static async waitForHeavySiiOpSlot(pollMs = 2000, maxWaitMs = 600000): Promise<boolean> {
    const t0 = Date.now();
    while (this.isHeavySiiOpInProgress()) {
      if (Date.now() - t0 > maxWaitMs) return false;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return true;
  }

  static startBackgroundPdfDownload(
    context: BrowserContext,
    empresaRut: string,
  ): void {
    if (this._bgJobs.has(empresaRut)) return; // ya hay un job corriendo
    this._bgJobs.add(empresaRut);

    (async () => {
      if (!(await this.waitForHeavySiiOpSlot())) {
        console.log(`[SII bg] PDF job pospuesto — emisión SII en curso (${empresaRut})`);
        this._bgJobs.delete(empresaRut);
        return;
      }

      const repo = AppDataSource.getRepository(SiiFacturaEntity);
      let consecutiveErrors = 0;

      while (true) {
        if (this.isHeavySiiOpInProgress()) {
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }

        const factura = await repo.findOne({
          where: { empresaRut, hasPdf: false },
          order: { folio: 'DESC' },
        }).catch(() => null);

        if (!factura) break; // todas procesadas

        try {
          await this.downloadPdf(context, factura.codigo);
          consecutiveErrors = 0;
        } catch (err: any) {
          console.warn(`[SII bg] Error PDF CODIGO=${factura.codigo}:`, err?.message);
          consecutiveErrors++;
          if (consecutiveErrors >= 5) break; // deja de intentar si hay fallos seguidos
        }

        await new Promise(r => setTimeout(r, 2000)); // pausa entre descargas
      }
    })()
      .catch(() => {})
      .finally(() => this._bgJobs.delete(empresaRut));
  }

  // ── Sincronizar facturas a DB ─────────────────────────────────────────────
  // Trae lista (2 años) + detalle de las nuevas → guarda en sii_facturas

  static async syncFacturas(
    axiosClient: AxiosInstance,
    empresaRut: string,
    tipoCodigo?: number,
    dateRange: { fechaDesde?: string; fechaHasta?: string } = {},
    maxDocs?: number   // si se indica, detiene la carga al llegar a ese nº de documentos
  ): Promise<{ synced: number; skipped: number; total: number; errors: number }> {
    const repo = AppDataSource.getRepository(SiiFacturaEntity);
    const rango = dateRange.fechaDesde ? `${dateRange.fechaDesde} → ${dateRange.fechaHasta}` : 'sin filtro';

    const existentesEnDb = await repo.find({
      where: { empresaRut },
      select: [
        'codigo',
        'detalleCompleto',
        'tipoCodigo',
        'items',
        'monto',
        'giroReceptor',
        'dirReceptor',
        'folio',
      ],
    });
    const existentesSet = new Set(existentesEnDb.map((r) => r.codigo));
    const necesitaDetalleSet = new Set(
      existentesEnDb.filter((r) => facturaNecesitaRefetchDetalle(r)).map((r) => r.codigo)
    );

    const filtroFecha = !!(dateRange.fechaDesde || dateRange.fechaHasta);
    // Con maxDocs solo hace falta 1 página (el SII devuelve ~30 por página)
    const maxPaginas = maxDocs ? Math.ceil(maxDocs / 20) + 1 : 200;

    // 1. Listado SII — sin filtro de fecha traemos las primeras 10 páginas siempre
    // (para corregir datos de registros existentes), luego parada anticipada si todo ya está en DB.
    // Con filtro de fecha se traen todas las páginas del rango.
    console.log(`[SII sync] ${empresaRut} | ${rango}${maxDocs ? ` | límite ${maxDocs} docs` : ''} | Obteniendo listado...`);
    const todas = await this.getFacturasEmitidas(axiosClient, {
      tipoCodigo,
      fechaDesde: dateRange.fechaDesde,
      fechaHasta: dateRange.fechaHasta,
      maxPaginas,
      stopIfAllCodigosInDb: (filtroFecha || maxDocs) ? undefined : existentesSet,
      minPaginas: filtroFecha ? undefined : 10,
    });

    if (todas.length === 0) {
      // Aun sin documentos nuevos, puede haber existentes sin detalle — intentar reprocesarlos
      if (necesitaDetalleSet.size > 0) {
        const pendientesDetalle = existentesEnDb.filter((r) => necesitaDetalleSet.has(r.codigo));
        console.log(
          `[SII sync] ${empresaRut} | ${rango} | Sin facturas nuevas, reintentando detalle de ${pendientesDetalle.length} documentos (incompleto o sin líneas/receptor)...`
        );
        let errors = 0; let detallesOk = 0;
        await parallelBatch(pendientesDetalle, async (r) => {
          try {
            const det = await this.getDetalleFactura(axiosClient, r.codigo, r.tipoCodigo || 33);
            if (!det) return;
            await repo.update(
              { empresaRut, codigo: r.codigo },
              mergeDetalleFacturaToDbPatch(det)
            );
            detallesOk++;
          } catch { errors++; }
        }, 6);
        console.log(`[SII sync] ${empresaRut} | Detalles pendientes resueltos: ${detallesOk}/${pendientesDetalle.length} | Errores: ${errors}`);
      } else {
        console.log(`[SII sync] ${empresaRut} | ${rango} | Sin facturas en SII`);
      }
      return { synced: 0, skipped: 0, total: 0, errors: 0 };
    }

    // Deduplicar por codigo (el SII a veces repite en paginación) y aplicar límite maxDocs
    const todasMap = new Map<string, SiiFactura>();
    for (const f of todas) todasMap.set(f.codigo, f);
    let todasUnicas = dedupeListaSiiPorTipoYFolio(Array.from(todasMap.values()));
    if (maxDocs && todasUnicas.length > maxDocs) todasUnicas = todasUnicas.slice(0, maxDocs);

    // 2. Nuevas: no están en DB. Refetch detalle: sin detalleCompleto o filas marcadas como incompletas (ítems/receptor).
    const nuevas = todasUnicas.filter((f) => !existentesSet.has(f.codigo));
    const skipped = todasUnicas.length - nuevas.length;

    console.log(`[SII sync] ${empresaRut} | ${rango} | Total SII: ${todasUnicas.length} | Nuevas: ${nuevas.length} | Ya en DB: ${skipped}`);

    // 3. Guardar/actualizar datos de lista para TODOS los documentos encontrados en el listado.
    // El upsert corrige fecha/folio/monto en registros ya existentes (además de insertar los nuevos).
    // detalleCompleto solo se pone false para nuevas — el refetch de detalle lo gobierna facturaNecesitaRefetchDetalle.
    const seenCodigos = new Set<string>();
    const listaRows = todasUnicas
      .filter(f => {
        if (seenCodigos.has(f.codigo)) return false;
        seenCodigos.add(f.codigo);
        return true;
      })
      .map(f => ({
        empresaRut,
        codigo: f.codigo,
        rutReceptor: f.rutReceptor,
        razonSocial: f.razonSocial,
        tipoCodigo: f.tipoCodigo,
        tipoDocumento: f.tipoDocumento,
        folio: f.folio,
        fecha: f.fecha,
        monto: f.monto,
        estado: f.estado,
        // Solo resetear detalleCompleto a false para documentos nuevos
        ...(existentesSet.has(f.codigo) ? {} : { detalleCompleto: false }),
      }));
    for (let i = 0; i < listaRows.length; i += 100) {
      await repo.upsert(listaRows.slice(i, i + 100), { conflictPaths: ['empresaRut', 'codigo'] });
    }

    // Quitar filas viejas mismo tipo+folio con otro CODIGO (duplicado lógico del SII)
    for (const row of listaRows) {
      if (!row.folio || row.folio <= 0) continue;
      await repo
        .createQueryBuilder()
        .delete()
        .from(SiiFacturaEntity)
        .where('empresaRut = :er', { er: empresaRut })
        .andWhere('tipoCodigo = :tc', { tc: row.tipoCodigo ?? 33 })
        .andWhere('folio = :fo', { fo: row.folio })
        .andWhere('codigo != :co', { co: row.codigo })
        .execute();
    }

    // 4. Obtener detalle: nuevas + existentes que necesitan reparseo y aparecen en este listado
    const refetchEnListado = todasUnicas.filter((f) => necesitaDetalleSet.has(f.codigo));
    const paraDetalle = [...nuevas, ...refetchEnListado];

    let errors = 0;
    let detallesOk = 0;
    await parallelBatch(paraDetalle, async (f) => {
      try {
        const det = await this.getDetalleFactura(axiosClient, f.codigo, f.tipoCodigo);
        if (!det) return;
        await repo.update({ empresaRut, codigo: f.codigo }, mergeDetalleFacturaToDbPatch(det));
        detallesOk++;
      } catch {
        errors++;
      }
    }, 6);

    const yaPedidos = new Set(paraDetalle.map((f) => f.codigo));
    const extraIncompletos = existentesEnDb
      .filter((r) => necesitaDetalleSet.has(r.codigo) && !yaPedidos.has(r.codigo))
      .sort((a, b) => (b.folio ?? 0) - (a.folio ?? 0))
      .slice(0, 50);

    if (extraIncompletos.length > 0) {
      console.log(
        `[SII sync] ${empresaRut} | ${rango} | Reparseo extra (no en listado actual): ${extraIncompletos.length} documentos...`
      );
      await parallelBatch(extraIncompletos, async (r) => {
        try {
          const det = await this.getDetalleFactura(axiosClient, r.codigo, r.tipoCodigo || 33);
          if (!det) return;
          await repo.update({ empresaRut, codigo: r.codigo }, mergeDetalleFacturaToDbPatch(det));
          detallesOk++;
        } catch {
          errors++;
        }
      }, 6);
    }

    console.log(
      `[SII sync] ${empresaRut} | ${rango} | ✅ Guardadas: ${nuevas.length} | Detalles OK: ${detallesOk} (listado ${paraDetalle.length} + extra ${extraIncompletos.length}) | Errores: ${errors}`
    );
    return { synced: nuevas.length, skipped, total: todasUnicas.length, errors };
  }

  // ── Borrar facturas de una empresa ───────────────────────────────────────

  static async deleteFacturasDB(empresaRut: string): Promise<number> {
    const repo = AppDataSource.getRepository(SiiFacturaEntity);
    const result = await repo.delete({ empresaRut });
    return result.affected ?? 0;
  }

  // ── Leer facturas desde DB ────────────────────────────────────────────────

  static async getFacturasDB(
    empresaRut: string,
    opts: { search?: string; tipoCodigo?: number; soloUltimaPorCliente?: boolean } = {}
  ): Promise<SiiFacturaEntity[]> {
    const repo = AppDataSource.getRepository(SiiFacturaEntity);
    const { search, tipoCodigo, soloUltimaPorCliente } = opts;

    let qb = repo.createQueryBuilder('f')
      .where('f.empresaRut = :rut', { rut: empresaRut })
      .orderBy('f.folio', 'DESC');

    if (tipoCodigo) qb = qb.andWhere('f.tipoCodigo = :tipo', { tipo: tipoCodigo });

    if (search) {
      const s = `%${search.toLowerCase()}%`;
      qb = qb.andWhere(
        '(LOWER(f.razonSocial) LIKE :s OR f.rutReceptor LIKE :s)',
        { s }
      );
    }

    const facturas = await qb.getMany();
    const decoded = facturas.map((f) => decodeFacturaEntityForApi(f));
    const deduped = dedupeSiiFacturasPorTipoYFolio(decoded);

    if (!soloUltimaPorCliente) return deduped;

    // Última por cliente (mayor folio): sin RUT usar codigo para no ocultar filas mal parseadas
    const mapa = new Map<string, SiiFacturaEntity>();
    for (const f of deduped) {
      const key = f.rutReceptor?.trim() || `__codigo:${f.codigo}`;
      const prev = mapa.get(key);
      if (!prev || (f.folio || 0) > (prev.folio || 0)) mapa.set(key, f);
    }
    return Array.from(mapa.values());
  }

  // ── Sync histórico por trimestres (generator para SSE) ───────────────────

  static async *syncHistoricoGen(
    axiosClient: AxiosInstance,
    empresaRut: string,
    tipoCodigo?: number
  ): AsyncGenerator<{
    quarter: string;
    quarterIndex: number;
    totalQuarters: number;
    synced: number;
    skipped: number;
    total: number;
    errors: number;
    acumulado: number;
  }> {
    // Calcular los últimos 8 trimestres
    const quarters = this.buildQuarters(8);
    let acumulado = 0;
    console.log(`[SII histSync] ${empresaRut} | Iniciando sync histórico: ${quarters.length} trimestres`);

    for (let i = 0; i < quarters.length; i++) {
      if (!(await this.waitForHeavySiiOpSlot(3000, 600000))) {
        console.log(`[SII histSync] ${empresaRut} | Esperando fin de emisión SII…`);
        i--;
        continue;
      }
      const q = quarters[i];
      console.log(`[SII histSync] ${empresaRut} | Trimestre ${i + 1}/${quarters.length}: ${q.label} (${q.desde} → ${q.hasta})`);
      const result = await this.syncFacturas(axiosClient, empresaRut, tipoCodigo, {
        fechaDesde: q.desde,
        fechaHasta: q.hasta,
      });
      acumulado += result.synced;
      console.log(`[SII histSync] ${empresaRut} | ${q.label}: ${result.total} encontradas, +${result.synced} nuevas, acumulado: ${acumulado}`);
      yield {
        quarter: q.label,
        quarterIndex: i + 1,
        totalQuarters: quarters.length,
        ...result,
        acumulado,
      };
    }

    // Extraer contactos automáticamente al finalizar
    await this.extractContactosFromDB(empresaRut).catch(() => {});
  }

  /** Construye N trimestres hacia atrás desde hoy */
  private static buildQuarters(n: number): Array<{ label: string; desde: string; hasta: string }> {
    const quarters: Array<{ label: string; desde: string; hasta: string }> = [];
    const today = new Date();
    let year = today.getFullYear();
    let q = Math.ceil((today.getMonth() + 1) / 3); // trimestre actual 1-4

    for (let i = 0; i < n; i++) {
      q--;
      if (q < 1) { q = 4; year--; }

      const monthStart = (q - 1) * 3 + 1;  // 1,4,7,10
      const monthEnd = q * 3;               // 3,6,9,12
      const lastDay = new Date(year, monthEnd, 0).getDate();

      const pad = (n: number) => String(n).padStart(2, '0');
      quarters.push({
        label: `Q${q} ${year}`,
        desde: `${year}-${pad(monthStart)}-01`,
        hasta: `${year}-${pad(monthEnd)}-${pad(lastDay)}`,
      });
    }
    return quarters; // del más reciente al más antiguo
  }

  // ── Extraer contactos únicos desde sii_facturas ───────────────────────────

  static async extractContactosFromDB(
    empresaRut: string
  ): Promise<{ processed: number; upserted: number }> {
    const repo = AppDataSource.getRepository(SiiContactoEntity);

    // DISTINCT ON para obtener la factura más reciente (por folio) de cada receptor
    const rows: Array<{
      rut_receptor: string;
      razon_social: string;
      giro_receptor: string;
      dir_receptor: string;
      comuna_receptor: string;
      ciudad_receptor: string;
      codigo: string;
      fecha: string;
      monto: number;
      factura_count: string;
    }> = await AppDataSource.query(
      `SELECT DISTINCT ON (rut_receptor)
         rut_receptor, razon_social, giro_receptor,
         dir_receptor, comuna_receptor, ciudad_receptor,
         codigo, fecha, monto,
         COUNT(*) OVER (PARTITION BY rut_receptor)::text AS factura_count
       FROM sii_facturas
       WHERE empresa_rut = $1
         AND rut_receptor IS NOT NULL
         AND rut_receptor <> ''
       ORDER BY rut_receptor, folio DESC NULLS LAST`,
      [empresaRut]
    );

    if (rows.length === 0) return { processed: 0, upserted: 0 };

    const contactos = rows.map(r => ({
      empresaRut,
      rutReceptor: r.rut_receptor,
      razonSocial: r.razon_social || undefined,
      giroReceptor: r.giro_receptor || undefined,
      dirReceptor: r.dir_receptor || undefined,
      comunaReceptor: r.comuna_receptor || undefined,
      ciudadReceptor: r.ciudad_receptor || undefined,
      lastFacturaCodigo: r.codigo || undefined,
      lastFacturaFecha: r.fecha || undefined,
      lastFacturaMonto: r.monto || 0,
      facturaCount: parseInt(r.factura_count, 10) || 1,
    }));

    // Upsert en batches de 100
    for (let i = 0; i < contactos.length; i += 100) {
      await repo.upsert(contactos.slice(i, i + 100), {
        conflictPaths: ['empresaRut', 'rutReceptor'],
        skipUpdateIfNoValuesChanged: false,
      });
    }

    return { processed: rows.length, upserted: contactos.length };
  }

  // ── Obtener contactos SII desde DB ────────────────────────────────────────

  static async getContactosSII(opts: {
    empresaRut?: string;
    search?: string;
  } = {}): Promise<SiiContactoEntity[]> {
    const repo = AppDataSource.getRepository(SiiContactoEntity);
    let qb = repo.createQueryBuilder('c').orderBy('c.razonSocial', 'ASC');

    if (opts.empresaRut) {
      qb = qb.where('c.empresaRut = :rut', { rut: opts.empresaRut });
    }
    if (opts.search) {
      const s = `%${opts.search.toLowerCase()}%`;
      const clause = opts.empresaRut
        ? 'andWhere'
        : 'where';
      qb = qb[clause]('(LOWER(c.razonSocial) LIKE :s OR c.rutReceptor LIKE :s)', { s });
    }
    return qb.getMany();
  }

  // ── Importar contacto SII al módulo Clientes ─────────────────────────────

  static async importContactoToClients(
    empresaRut: string,
    rutReceptor: string,
    _branchId?: number
  ): Promise<{ success: boolean; clientId: number; created: boolean }> {
    const contactoRepo = AppDataSource.getRepository(SiiContactoEntity);
    const clientRepo = AppDataSource.getRepository(WorkbenchClient);

    const contacto = await contactoRepo.findOne({ where: { empresaRut, rutReceptor } });
    if (!contacto) throw new Error('Contacto SII no encontrado');

    // Buscar si ya existe un Client con este RUT
    const existing = await clientRepo.findOne({ where: { rutWithDv: rutReceptor } });
    if (existing) {
      // Actualizar datos faltantes
      await clientRepo.update(existing.id, {
        razonSocial: existing.razonSocial || contacto.razonSocial || undefined,
        giroComercial: existing.giroComercial || contacto.giroReceptor || undefined,
        address: existing.address || contacto.dirReceptor || undefined,
        commune: existing.commune || contacto.comunaReceptor || undefined,
        city: existing.city || contacto.ciudadReceptor || undefined,
      });
      await contactoRepo.update({ empresaRut, rutReceptor }, { importedToClients: true });
      return { success: true, clientId: existing.id, created: false };
    }

    // Separar RUT y DV
    const parts = rutReceptor.split('-');
    const rutSinDv = parts[0] || rutReceptor;

    const nuevoCliente = clientRepo.create({
      type: 'empresa',
      rut: rutSinDv,
      rutWithDv: rutReceptor,
      name: contacto.razonSocial || rutReceptor,
      businessName: contacto.razonSocial || undefined,
      razonSocial: contacto.razonSocial || undefined,
      giroComercial: contacto.giroReceptor || undefined,
      address: contacto.dirReceptor || '',
      commune: contacto.comunaReceptor || undefined,
      city: contacto.ciudadReceptor || undefined,
      phone: '',
      isActive: true,
    });

    const saved = await clientRepo.save(nuevoCliente);
    await contactoRepo.update({ empresaRut, rutReceptor }, { importedToClients: true });

    return { success: true, clientId: saved.id, created: true };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private static toSiiDate(iso: string): string {
    if (!iso) return '';
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y}`; // SII usa DD/MM/YYYY con barras
  }
}

setInterval(() => {
  const now = Date.now();
  const staleIds = [...sessions.entries()]
    .filter(([, s]) => now - s.ts > 30 * 60 * 1000)
    .map(([id]) => id);
  for (const id of staleIds) {
    void SiiFacturacionService.closeSession(id);
  }
}, 5 * 60 * 1000);
