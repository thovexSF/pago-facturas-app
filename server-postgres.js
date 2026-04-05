const express = require('express');
const { Pool }  = require('pg');
const axios     = require('axios');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3000;

const { SII_RUT, SII_PASSWORD, SII_EMPRESA_RUT } = process.env;
const [EMPRESA_RUT, EMPRESA_DV] = (SII_EMPRESA_RUT ?? '-').split('-');

app.use(express.json());
app.use(express.static('public'));

// ─── PostgreSQL ───────────────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function setupDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS proveedores (
      rut_emisor   VARCHAR(20) PRIMARY KEY,
      razon_social VARCHAR(255),
        condicion    VARCHAR(10) DEFAULT 'contado',  -- 'contado' | 'credito'
      categoria    VARCHAR(100),
      dias_1       INTEGER DEFAULT 30,
      pct_1        INTEGER DEFAULT 50,
      dias_2       INTEGER DEFAULT 40,
      pct_2        INTEGER DEFAULT 50,
      en_agenda    BOOLEAN DEFAULT FALSE,
      updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS facturas_recibidas (
      id            SERIAL PRIMARY KEY,
      codigo        VARCHAR(50) UNIQUE,
      rut_emisor    VARCHAR(20),
      razon_social  VARCHAR(255),
      folio         INTEGER,
      fecha_emision DATE,
      monto_neto    BIGINT,
      monto_total   BIGINT,
      estado_sii    VARCHAR(50),
      vcto_1        DATE,
      monto_1       BIGINT,
      pagado_1      BOOLEAN DEFAULT FALSE,
      pagado_1_at   TIMESTAMP,
      vcto_2        DATE,
      monto_2       BIGINT,
      pagado_2      BOOLEAN DEFAULT FALSE,
      pagado_2_at   TIMESTAMP,
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS meses_sincronizados (
      mes       VARCHAR(6) PRIMARY KEY,
      total     INTEGER,
      synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Migraciones
  await pool.query(`ALTER TABLE proveedores ADD COLUMN IF NOT EXISTS categoria VARCHAR(100)`).catch(() => {});
  for (const [col, type] of [
    ['monto_neto','BIGINT'],['monto_total','BIGINT'],['estado_sii','VARCHAR(50)'],
    ['vcto_1','DATE'],['monto_1','BIGINT'],['pagado_1','BOOLEAN DEFAULT FALSE'],['pagado_1_at','TIMESTAMP'],
    ['vcto_2','DATE'],['monto_2','BIGINT'],['pagado_2','BOOLEAN DEFAULT FALSE'],['pagado_2_at','TIMESTAMP'],
    ['pdf_data','BYTEA'],['pdf_nombre','VARCHAR(100)'],['pdf_at','TIMESTAMP'],
  ]) {
    await pool.query(`ALTER TABLE facturas_recibidas ADD COLUMN IF NOT EXISTS ${col} ${type}`).catch(() => {});
  }
  // Crear proveedores desde facturas existentes que no tengan proveedor aún
  await pool.query(`
    INSERT INTO proveedores (rut_emisor, razon_social, condicion)
    SELECT DISTINCT rut_emisor, razon_social, 'contado'
    FROM facturas_recibidas
    ON CONFLICT (rut_emisor) DO NOTHING
  `);
  // Rellenar monto_total si es NULL (registros viejos sin IVA calculado)
  await pool.query(`
    UPDATE facturas_recibidas SET
      monto_total = ROUND(monto_neto * 1.19)
    WHERE monto_total IS NULL AND monto_neto IS NOT NULL
  `);
  // Corregir facturas contado: una sola cuota por el total, vcto = fecha emisión
  await pool.query(`
    UPDATE facturas_recibidas f SET
      vcto_1      = f.fecha_emision,
      monto_1     = COALESCE(f.monto_total, ROUND(f.monto_neto * 1.19)),
      pagado_1    = TRUE,
      pagado_1_at = COALESCE(f.pagado_1_at, f.created_at),
      vcto_2      = NULL,
      monto_2     = NULL,
      pagado_2    = FALSE,
      pagado_2_at = NULL,
      updated_at  = NOW()
    FROM proveedores p
    WHERE f.rut_emisor = p.rut_emisor
      AND p.condicion = 'contado'
  `);
  // Marcar como pagadas todas las cuotas cuyo vencimiento ya pasó
  await pool.query(`
    UPDATE facturas_recibidas SET
      pagado_1 = TRUE, pagado_1_at = COALESCE(pagado_1_at, vcto_1), updated_at = NOW()
    WHERE pagado_1 = FALSE AND vcto_1 < CURRENT_DATE
  `);
  await pool.query(`
    UPDATE facturas_recibidas SET
      pagado_2 = TRUE, pagado_2_at = COALESCE(pagado_2_at, vcto_2), updated_at = NOW()
    WHERE pagado_2 = FALSE AND vcto_2 IS NOT NULL AND vcto_2 < CURRENT_DATE
  `);
  console.log('[DB] Tablas listas');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseDate(str) {
  if (!str) return null;
  const [d, m, y] = str.split('/');
  return `${y}-${m}-${d}`;
}

function rangoDeMeses(desde, hasta) {
  const meses = [];
  let [y, m] = [parseInt(desde.slice(0, 4)), parseInt(desde.slice(4))];
  const [hy, hm] = [parseInt(hasta.slice(0, 4)), parseInt(hasta.slice(4))];
  while (y < hy || (y === hy && m <= hm)) {
    meses.push(`${y}${String(m).padStart(2, '0')}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return meses;
}

function mesActual() {
  const n = new Date();
  return `${n.getFullYear()}${String(n.getMonth() + 1).padStart(2, '0')}`;
}

// Obtiene o crea proveedor. Si es nuevo, lo registra como 'contado'.
async function getProveedor(rut, razonSocial) {
  const { rows } = await pool.query('SELECT * FROM proveedores WHERE rut_emisor=$1', [rut]);
  if (rows.length) return rows[0];
  await pool.query(
    `INSERT INTO proveedores (rut_emisor, razon_social, condicion)
     VALUES ($1, $2, 'contado') ON CONFLICT DO NOTHING`,
    [rut, razonSocial]
  );
  return { rut_emisor: rut, razon_social: razonSocial, condicion: 'contado',
           dias_1: 30, pct_1: 50, dias_2: 40, pct_2: 50 };
}

// forzar=true → re-escribe vcto_1/vcto_2 en registros existentes (sync histórico)
// forzar=false → preserva edits manuales del usuario (sync regular)
async function upsertFacturas(docs, forzar = false) {
  let insertadas = 0, actualizadas = 0;
  if (docs.length > 0) console.log('[SII sync] Campos disponibles en doc:', Object.keys(docs[0]).join(', '));
  for (const d of docs) {
    const rut = `${d.detRutDoc}-${d.detDvDoc}`;
    const prov = await getProveedor(rut, d.detRznSoc);
    const montoTotal   = Math.round(d.detMntNeto * 1.19);
    const esContado    = prov.condicion === 'contado';
    const esCredito    = !esContado;
    const fechaEmision = parseDate(d.detFchDoc);
    const vctoSII      = d.detFchVcto ? parseDate(d.detFchVcto) : null;

    // vcto_1: SII > cálculo crédito > fecha emisión (contado) > null
    // vcto_2: solo si es crédito Y no hay vctoSII
    const monto1 = esContado ? montoTotal : Math.round(montoTotal * prov.pct_1 / 100);
    const monto2 = esContado || vctoSII   ? null : esCredito ? montoTotal - monto1 : null;

    if (vctoSII) console.log(`[SII sync] Folio ${d.detNroDoc} → vcto SII: ${vctoSII}`);

    const r = await pool.query(
      `INSERT INTO facturas_recibidas
         (codigo, rut_emisor, razon_social, folio, fecha_emision,
          monto_neto, monto_total, estado_sii,
          vcto_1, monto_1, pagado_1, pagado_1_at,
          vcto_2, monto_2, pagado_2, pagado_2_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
          -- vcto_1 INSERT: SII > crédito calculado > contado (fecha emisión)
          CASE WHEN $9::date IS NOT NULL THEN $9::date
               WHEN $10::boolean         THEN $5::date
               ELSE $5::date + $11::integer END,
          $12, $10, CASE WHEN $10 THEN NOW() ELSE NULL END,
          -- vcto_2 INSERT: solo crédito sin vctoSII
          CASE WHEN $9::date IS NOT NULL OR NOT $13::boolean THEN NULL
               ELSE $5::date + $14::integer END,
          $15, FALSE, NULL)
       ON CONFLICT (codigo) DO UPDATE SET
         razon_social = EXCLUDED.razon_social,
         monto_neto   = EXCLUDED.monto_neto,
         monto_total  = EXCLUDED.monto_total,
         estado_sii   = EXCLUDED.estado_sii,
         pagado_1     = EXCLUDED.pagado_1,
         pagado_1_at  = EXCLUDED.pagado_1_at,
         pagado_2     = EXCLUDED.pagado_2,
         pagado_2_at  = EXCLUDED.pagado_2_at,
         monto_1      = EXCLUDED.monto_1,
         monto_2      = EXCLUDED.monto_2,
         -- vcto: actualizar si SII trae fecha O si es sync forzado
         vcto_1 = CASE WHEN $9::date IS NOT NULL OR $16::boolean
                        THEN EXCLUDED.vcto_1
                        ELSE facturas_recibidas.vcto_1 END,
         vcto_2 = CASE WHEN $9::date IS NOT NULL OR $16::boolean
                        THEN EXCLUDED.vcto_2
                        ELSE facturas_recibidas.vcto_2 END,
         updated_at   = NOW()
       RETURNING (xmax = 0) AS inserted`,
      [
        String(d.detCodigo), rut, d.detRznSoc, d.detNroDoc,
        fechaEmision, d.detMntNeto, montoTotal, d.dcvEstadoContab ?? 'REGISTRO',
        vctoSII,       // $9  — fecha SII o null
        esContado,     // $10
        prov.dias_1,   // $11 — fallback cuota 1 (crédito)
        monto1,        // $12
        esCredito,     // $13 — es crédito → puede tener vcto_2
        prov.dias_2,   // $14 — fallback cuota 2
        monto2,        // $15
        forzar,        // $16 — forzar re-escritura de vcto en ON CONFLICT
      ]
    );
    r.rows[0].inserted ? insertadas++ : actualizadas++;
  }
  return { insertadas, actualizadas };
}

// ─── SII — HTTP directo (sin Playwright) ─────────────────────────────────────

// ── Helpers cookies HTTP ──────────────────────────────────────────────────────

function parseSiiCookies(rawList) {
  return [].concat(rawList ?? []).map(h => {
    const parts  = h.split(';').map(s => s.trim());
    const eqIdx  = parts[0].indexOf('=');
    const name   = parts[0].slice(0, eqIdx).trim();
    const value  = parts[0].slice(eqIdx + 1).trim();
    const domPt  = parts.find(p => /^domain=/i.test(p));
    const pathPt = parts.find(p => /^path=/i.test(p));
    const domain = domPt  ? domPt.split('=')[1].trim()  : '.sii.cl';
    const path   = pathPt ? pathPt.split('=')[1].trim() : '/';
    return { name, value, domain, path };
  }).filter(c => c.name && c.value && c.value !== 'DEL' && !c.name.startsWith('path='));
}

function mergeSiiCookies(base, extra) {
  const map = new Map(base.map(c => [c.name, c]));
  for (const c of extra) map.set(c.name, c);
  return [...map.values()];
}

function siiCookieHeader(cookies) {
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

const SII_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Autenticación directa vía CAutInicio.cgi (HTTP, sin browser) ──────────────
// Rápida pero puede fallar desde IPs de nube (Railway). Devuelve cookies o null.
async function autenticarHTTP() {
  const [rutNum, dv] = SII_RUT.replace(/\./g, '').split('-');
  const [empresaRut] = SII_EMPRESA_RUT.split('-');
  const REFERENCIA   = 'https://www1.sii.cl/cgi-bin/Portal001/mipeSelEmpresa.cgi';

  const qs = new URLSearchParams({ rutcntr: empresaRut, rut: rutNum, dv, clave: SII_PASSWORD, referencia: REFERENCIA }).toString();
  const r1 = await axios.get(`https://zeusr.sii.cl/cgi_AUT2000/CAutInicio.cgi?${qs}`, {
    maxRedirects: 0, validateStatus: () => true,
    headers: {
      'User-Agent':      SII_UA,
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'es-CL,es;q=0.9',
    },
  });
  const cookies = parseSiiCookies(r1.headers['set-cookie']);
  console.log(`[SII auth] CAutInicio status=${r1.status} cookies=[${cookies.map(c=>c.name).join(',')||'ninguna'}]`);
  if (!cookies.some(c => c.name === 'TOKEN')) return null;
  return cookies;
}

// ── POST mipeSelEmpresa.cgi con cookies de sesión ────────────────────────────
async function seleccionarEmpresaHTTP(cookies) {
  const r = await axios.post(
    'https://www1.sii.cl/cgi-bin/Portal001/mipeSelEmpresa.cgi',
    new URLSearchParams({ RUT_EMP: SII_EMPRESA_RUT }).toString(),
    {
      maxRedirects: 0, validateStatus: () => true,
      headers: {
        'Cookie':       siiCookieHeader(cookies),
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer':      'https://www1.sii.cl/cgi-bin/Portal001/mipeSelEmpresa.cgi',
        'User-Agent':   SII_UA,
      },
    }
  );
  const all = mergeSiiCookies(cookies, parseSiiCookies(r.headers['set-cookie']));
  if (!all.some(c => c.name === 'NETSCAPE_LIVEWIRE.rcmp'))
    throw new Error('mipeSelEmpresa no estableció rcmp (empresa no seleccionada)');
  console.log(`[SII auth] Empresa rcmp=${all.find(c=>c.name==='NETSCAPE_LIVEWIRE.rcmp')?.value}`);
  return all;
}

// ── Autenticación vía formulario browser (Playwright) ────────────────────────
// Fallback cuando CAutInicio HTTP está bloqueado (ej: IPs de Railway).
// Hace login con browser, extrae cookies y selecciona empresa vía HTTP.
async function autenticarViaBrowser() {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  const ctx     = await browser.newContext({ ignoreHTTPSErrors: true, userAgent: SII_UA });
  const page    = await ctx.newPage();
  try {
    await loginSII(page);   // form browser → zeusr session

    // Extraer todas las cookies del contexto del browser
    const rawCookies = await ctx.cookies();
    const cookies = rawCookies.map(c => ({
      name: c.name, value: c.value,
      domain: c.domain.startsWith('.') ? c.domain : `.${c.domain}`,
      path: c.path ?? '/',
    })).filter(c => c.value && c.value !== 'DEL');

    if (!cookies.some(c => c.name === 'TOKEN'))
      throw new Error('Browser login no devolvió TOKEN');
    console.log(`[SII auth] Cookies extraídas del browser: ${cookies.map(c=>c.name).join(',')}`);

    // Seleccionar empresa vía HTTP con estas cookies (más fiable que navegar en Playwright)
    return await seleccionarEmpresaHTTP(cookies);
  } finally {
    await browser.close().catch(() => {});
  }
}

// ── Punto de entrada: intenta HTTP, cae a browser si falla ────────────────────
async function autenticarSIIdirecto() {
  // Intento 1: HTTP directo (rápido, funciona desde IPs no bloqueadas)
  try {
    const cookies = await autenticarHTTP();
    if (cookies) return await seleccionarEmpresaHTTP(cookies);
    console.warn('[SII auth] CAutInicio HTTP sin TOKEN, usando browser...');
  } catch (err) {
    console.warn(`[SII auth] CAutInicio HTTP error (${err.message}), usando browser...`);
  }
  // Intento 2: formulario browser → extraer cookies → HTTP Portal001
  return autenticarViaBrowser();
}

// ── Buscar CODIGO de un documento en mipeAdminDocsRcp ────────────────────────
// Devuelve el CODIGO interno del SII para ese folio+emisor (null si no existe).
async function buscarCodigoPdf(cookies, folio, rutEmisor) {
  const [rutNum] = rutEmisor.replace(/\./g, '').split('-');
  const folioStr = String(folio);
  const url = `https://www1.sii.cl/cgi-bin/Portal001/mipeAdminDocsRcp.cgi?RUT_EMI=${rutNum}&FOLIO=${folioStr}&RZN_SOC=&FEC_DESDE=&FEC_HASTA=&TPO_DOC=&ESTADO=&ORDEN=&NUM_PAG=1`;

  // Hasta 4 intentos con backoff: 2s, 4s, 8s entre reintentos por 503
  for (let intento = 1; intento <= 4; intento++) {
    const resp = await axios.get(url, {
      maxRedirects: 3, validateStatus: () => true,
      headers: {
        'Cookie': siiCookieHeader(cookies),
        'Referer': 'https://www1.sii.cl/cgi-bin/Portal001/mipeLaunchPage.cgi?OPCION=1&TIPO=4',
        'User-Agent': SII_UA,
      },
    });

    const body = typeof resp.data === 'string' ? resp.data : '';

    // SII sobrecargado — reintentar con backoff
    if (resp.status === 503 || body.includes('503 Service Temporarily')) {
      const espera = intento * 2000;
      console.warn(`[SII pdf] Folio ${folio} → 503, reintento ${intento}/4 en ${espera/1000}s...`);
      await sleep(espera);
      continue;
    }

    const m = body.match(/\/cgi-bin\/Portal001\/mipeGesDocRcp\.cgi\?CODIGO=(\d+)/);
    if (!m) {
      const titulo = (body.match(/<title>([^<]*)<\/title>/i) ?? [])[1] ?? '?';
      console.warn(`[SII pdf] Folio ${folio} no encontrado. Título: "${titulo}" | body: ${body.slice(0, 200)}`);
      return null;
    }
    return m[1];
  }

  console.warn(`[SII pdf] Folio ${folio} → 503 persistente tras 4 intentos`);
  return null;
}

// ── Descargar PDF de un documento dado su CODIGO interno ─────────────────────
async function descargarPdfPorCodigo(cookies, codigo) {
  const url  = `https://www1.sii.cl/cgi-bin/Portal001/mipeShowPdf.cgi?CODIGO=${codigo}`;
  const resp = await axios.get(url, {
    maxRedirects: 3, validateStatus: () => true, responseType: 'arraybuffer',
    headers: {
      'Cookie': siiCookieHeader(cookies),
      'Referer': `https://www1.sii.cl/cgi-bin/Portal001/mipeGesDocRcp.cgi?CODIGO=${codigo}&ALL_PAGE_ANT=2`,
      'User-Agent': SII_UA,
    },
  });
  const buf = Buffer.from(resp.data);
  if (!buf.slice(0, 5).toString().startsWith('%PDF'))
    throw new Error(`mipeShowPdf no devolvió PDF (ct=${resp.headers['content-type']}, size=${buf.length})`);
  return buf;
}

// Mutex global: SII bloquea sesiones concurrentes del mismo RUT
let siiEnCurso = false;
// Alias para compatibilidad con rutas que chequeaban pdfEnCurso
let pdfEnCurso = false;

async function ngSelect(page, selector, value) {
  await page.evaluate(({ sel, val }) => {
    const el = document.querySelector(sel);
    el.value = val;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, { sel: selector, val: value });
}

// Login compartido — robusto: múltiples selectores, URL alternativa, diagnóstico
async function loginSII(page) {
  // Posibles selectores del campo RUT (SII los ha cambiado en el pasado)
  const rutSels  = ['#rutcntr', 'input[name="rutcntr"]', 'input[name="rut"]', '#rut', 'input[autocomplete="username"]'];
  const claveSels = ['#clave', 'input[name="clave"]', 'input[type="password"]'];

  const loginUrls = [
    'https://zeusr.sii.cl//AUT2000/InicioAutenticacion/IngresoRutClave.html?https://misiir.sii.cl/cgi_misii/siihome.cgi',
    'https://zeusr.sii.cl/AUT2000/InicioAutenticacion/IngresoRutClave.html',
    'https://herculesr.sii.cl/cgi_AUT/CAutInicio.html?https://misiir.sii.cl/cgi_misii/siihome.cgi',
  ];

  for (let intento = 1; intento <= 3; intento++) {
    const url = loginUrls[Math.min(intento - 1, loginUrls.length - 1)];
    // Sin .catch: necesitamos ver el error real si falla
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (gotoErr) {
      console.warn(`[SII login] intento ${intento} goto error: ${gotoErr.message}`);
    }
    await page.waitForTimeout(3000);

    const diagUrl   = page.url();
    const diagTitle = await page.title().catch(() => '?');
    // Loguear primeras 300 chars del body para entender qué página es
    const bodySnip  = await page.evaluate(() =>
      (document.body?.innerText ?? '').replace(/\s+/g,' ').trim().slice(0,300)
    ).catch(() => '');
    console.log(`[SII login] intento ${intento} | URL: ${diagUrl} | título: "${diagTitle}"`);
    console.log(`[SII login] texto página: "${bodySnip}"`);

    // Buscar campo RUT con cualquier selector conocido
    let rutSel = null;
    for (const s of rutSels) {
      if (await page.locator(s).count()) { rutSel = s; break; }
    }
    let claveSel = null;
    for (const s of claveSels) {
      if (await page.locator(s).count()) { claveSel = s; break; }
    }

    if (rutSel && claveSel) {
      console.log(`[SII login] campos encontrados: rut="${rutSel}" clave="${claveSel}"`);
      await page.fill(rutSel,   SII_RUT);
      await page.fill(claveSel, SII_PASSWORD);

      // Submit: esperar 60s que CAutInicio.cgi redirija a misiir automáticamente (SSO chain)
      await page.keyboard.press('Enter');
      try {
        await page.waitForURL(u => u.includes('misiir.sii.cl'), { timeout: 60000 });
      } catch { /* timeout — loguear HTML de CAutInicio para diagnóstico */ }

      await page.waitForTimeout(2000);
      const postUrl = page.url();
      console.log(`[SII login] post-login URL: ${postUrl}`);

      // Log del HTML y links si quedamos en CAutInicio (entender qué bloquea el redirect)
      if (postUrl.includes('CAutInicio') || (postUrl.includes('zeusr') && !postUrl.includes('IngresoRutClave'))) {
        const htmlSnip = await page.evaluate(() =>
          (document.body?.innerHTML ?? '').replace(/\s+/g,' ').trim().slice(0, 1200)
        ).catch(() => '');
        console.log(`[SII login] CAutInicio HTML: ${htmlSnip}`);
        // Log todos los links a dominios SII (útil para ver qué paths tienen tokens)
        const links = await page.evaluate(() =>
          Array.from(document.querySelectorAll('a[href*="sii.cl"]'))
            .map(a => `"${a.textContent.trim().slice(0,30)}" → ${a.href.slice(0,120)}`)
            .slice(0, 15)
        ).catch(() => []);
        if (links.length) console.log(`[SII login] Links SII en CAutInicio:\n  ${links.join('\n  ')}`);
      }

      // Rechazo: volvió al formulario de login
      if (postUrl.includes('IngresoRutClave')) {
        console.warn(`[SII login] intento ${intento}: credenciales rechazadas → ${postUrl}`);
        if (intento < 3) await page.waitForTimeout(3000);
        continue;
      }

      console.log(`[SII login] ✓ Sesión establecida | URL: ${postUrl}`);
      return;
    }

    console.warn(`[SII login] intento ${intento}: sin formulario de login`);
    if (intento < 3) await page.waitForTimeout(5000);
  }
  throw new Error('No se pudo encontrar formulario de login SII después de 3 intentos');
}

// Selecciona la empresa en el portal www1.
// www1/Portal001 requiere autenticación vía CAutInicio con www1 como return URL.
// Si la primera navegación a www1 redirige a zeusr, volvemos a autenticar
// con la URL de retorno apuntando a www1 para que CAutInicio redirija allí.
async function seleccionarEmpresa(page) {
  const TARGET = 'https://www1.sii.cl/cgi-bin/Portal001/mipeSelEmpresa.cgi';

  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000);
  let url = page.url();
  console.log(`[SII empresa] URL inicial: ${url}`);

  // Si www1 redirigió a zeusr login → autenticar con www1 como return URL
  if (url.includes('zeusr.sii.cl') && url.includes('IngresoRutClave')) {
    console.log('[SII empresa] www1 pidió auth en zeusr, re-autenticando...');

    // Buscar campos de login (misma lógica que loginSII)
    const rutSels   = ['#rutcntr', 'input[name="rutcntr"]', 'input[name="rut"]'];
    const claveSels = ['#clave', 'input[name="clave"]', 'input[type="password"]'];
    let rutSel = null, claveSel = null;
    for (const s of rutSels)   { if (await page.locator(s).count()) { rutSel   = s; break; } }
    for (const s of claveSels) { if (await page.locator(s).count()) { claveSel = s; break; } }

    if (rutSel && claveSel) {
      await page.fill(rutSel,   SII_RUT);
      await page.fill(claveSel, SII_PASSWORD);
      await page.keyboard.press('Enter');
      // Login puede ir primero a CAutInicio antes de llegar a www1
      try {
        await page.waitForURL(u => u.includes('www1.sii.cl') || u.includes('CAutInicio'), { timeout: 30000 });
      } catch { /* timeout */ }
      await page.waitForTimeout(2000);
      url = page.url();
      console.log(`[SII empresa] Post-auth URL: ${url}`);

      // Si aterrizamos en CAutInicio (no en www1), buscar un link a Portal001 desde ahí
      if (!url.includes('www1.sii.cl')) {
        console.log('[SII empresa] CAutInicio — buscando links Portal001...');
        const linksWww1 = await page.locator('a[href*="www1.sii.cl"]').all();
        console.log(`[SII empresa] Links www1 en CAutInicio: ${linksWww1.length}`);
        for (let i = 0; i < Math.min(linksWww1.length, 8); i++) {
          const h = await linksWww1[i].getAttribute('href').catch(() => '');
          const t = (await linksWww1[i].textContent().catch(() => '')).trim().slice(0, 40);
          console.log(`[SII empresa]   [${i}] "${t}" → ${(h ?? '').slice(0, 120)}`);
        }

        const linkPortal = page.locator('a[href*="www1.sii.cl/cgi-bin/Portal001"]').first();
        if (await linkPortal.count()) {
          const href = await linkPortal.getAttribute('href');
          console.log(`[SII empresa] Navegando Portal001 desde CAutInicio: ${href?.slice(0, 80)}`);
          await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
          await page.waitForTimeout(2000);
          url = page.url();
          console.log(`[SII empresa] Post-Portal001 URL: ${url}`);
        } else {
          // Fallback: ir a homer.sii.cl (enlace "Inicio" en CAutInicio) y buscar Portal001 ahí
          console.log('[SII empresa] Sin links Portal001 en CAutInicio, probando homer.sii.cl...');
          await page.goto('http://homer.sii.cl/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
          await page.waitForTimeout(2000);
          url = page.url();
          console.log(`[SII empresa] Post-homer URL: ${url}`);

          const linkHomer = page.locator('a[href*="www1.sii.cl/cgi-bin/Portal001"]').first();
          if (await linkHomer.count()) {
            const href = await linkHomer.getAttribute('href');
            console.log(`[SII empresa] Navegando Portal001 desde homer: ${href?.slice(0, 80)}`);
            await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await page.waitForTimeout(2000);
            url = page.url();
            console.log(`[SII empresa] Post-Portal001-homer URL: ${url}`);
          } else {
            // Último recurso: TARGET directo con la sesión recién renovada
            console.log('[SII empresa] Sin links Portal001 en homer, reintentando TARGET directo...');
            await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await page.waitForTimeout(2000);
            url = page.url();
            console.log(`[SII empresa] Post-TARGET-retry URL: ${url}`);
          }
        }
      }
    } else {
      console.warn('[SII empresa] Sin campos de login en zeusr');
    }
  }

  // Log diagnóstico de la página actual (formularios, selects, botones)
  const diagPage = await page.evaluate(() => {
    const sel = document.querySelector('select[name="RUT_EMP"]');
    const form = sel?.closest('form');
    return {
      tieneRutEmp:  !!sel,
      formAction:   form?.action ?? '(sin form)',
      optsCount:    sel?.options?.length ?? 0,
      optsValues:   Array.from(sel?.options ?? []).map(o => o.value).slice(0, 8),
      allSubmits:   Array.from(document.querySelectorAll('[type=submit]'))
                      .map(b => ({ val: b.value?.slice(0, 30), formAction: b.form?.action?.split('/').pop() ?? '?' }))
                      .slice(0, 6),
    };
  }).catch(() => null);
  if (diagPage) console.log(`[SII empresa] Diag página: ${JSON.stringify(diagPage)}`);

  if (await page.locator('select[name="RUT_EMP"]').count()) {
    await page.locator('select[name="RUT_EMP"]').selectOption(SII_EMPRESA_RUT);
    // Clicar el submit que está DENTRO del mismo form que select[name="RUT_EMP"]
    // (la página puede tener otros forms con sus propios submit que llevan a factura_sii.htm)
    const submitEnForm = page.locator('form:has(select[name="RUT_EMP"]) [type=submit]');
    const submitBtn = await submitEnForm.count()
      ? submitEnForm.first()
      : page.locator('[type=submit]').first();
    await Promise.all([
      page.waitForLoadState('load').catch(() => {}),
      submitBtn.click(),
    ]);
    await page.waitForTimeout(1000);
    console.log(`[SII empresa] Post-selección URL: ${page.url()}`);
  } else {
    console.warn(`[SII empresa] Sin selector empresa en: ${page.url()}`);
  }
}

// Inyecta cookies HTTP en un contexto Playwright
async function inyectarCookiesEnContexto(context, cookies) {
  await context.addCookies(cookies.map(c => ({
    name: c.name, value: c.value,
    domain: c.domain.startsWith('.') ? c.domain : `.${c.domain}`,
    path: c.path ?? '/',
    secure: true, sameSite: 'None',
  })));
}

async function abrirSesionSII() {
  if (siiEnCurso) throw new Error('Ya hay una operación SII en curso, espera unos minutos');
  siiEnCurso = true;

  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' });
  const page    = await context.newPage();

  let conversationId = null;
  page.on('response', async res => {
    if (res.url().includes('consdcvinternetui/services')) {
      const json = await res.json().catch(() => null);
      const cid  = json?.metaData?.conversationId;
      if (cid && String(cid).length > 5 && !conversationId)
        conversationId = String(cid);
    }
  });

  try {
    // Intentar auth HTTP directo primero (más rápido)
    let authViaBrowser = false;
    try {
      const httpCookies = await autenticarSIIdirecto();
      await inyectarCookiesEnContexto(context, httpCookies);
      console.log('[SII www4] Cookies HTTP inyectadas en Playwright');
    } catch (httpErr) {
      console.warn(`[SII www4] Auth HTTP falló (${httpErr.message}), usando formulario browser...`);
      await loginSII(page);
      await seleccionarEmpresa(page);
      authViaBrowser = true;
      console.log('[SII www4] Auth browser completado');
    }

    await page.goto('https://www4.sii.cl/consdcvinternetui/', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);

    if (!conversationId) {
      await ngSelect(page, 'select[name="rut"]', SII_EMPRESA_RUT);
      await page.waitForTimeout(2000);
    }

    if (!conversationId) throw new Error('No se pudo obtener conversationId de SII');
    // siiEnCurso permanece true — el LLAMADOR debe liberarlo al cerrar browser
    return { browser, context, conversationId };
  } catch (err) {
    siiEnCurso = false;
    await browser.close().catch(() => {});
    throw err;
  }
}


// Descarga el PDF de UNA factura (HTTP directo, sin Playwright)
async function descargarPdfSII(folio, rutEmisor, codigoBd = null) {
  if (pdfEnCurso || siiEnCurso) throw new Error('Ya hay una operación SII en curso, intenta en unos minutos');
  pdfEnCurso = true;
  try {
    const cookies = await autenticarSIIdirecto();
    const codigo  = codigoBd || await buscarCodigoPdf(cookies, folio, rutEmisor);
    if (!codigo) throw new Error(`Folio ${folio} no encontrado en SII`);
    console.log(`[SII pdf] Folio ${folio} → CODIGO ${codigo}`);
    return await descargarPdfPorCodigo(cookies, codigo);
  } finally {
    pdfEnCurso = false;
  }
}

// Descarga PDFs en lote reutilizando una sola sesión HTTP.
async function descargarPdfsBulkSII() {
  if (pdfEnCurso || siiEnCurso) {
    console.warn('[PDF bulk] Ya hay una operación SII en curso, abortando');
    return { descargadas: 0, errores: 0, total: 0 };
  }
  pdfEnCurso = true;

  const { rows: sinPdf } = await pool.query(
    `SELECT id, folio, rut_emisor, codigo FROM facturas_recibidas WHERE pdf_data IS NULL ORDER BY fecha_emision DESC`
  );
  if (!sinPdf.length) { pdfEnCurso = false; return { descargadas: 0, errores: 0, total: 0 }; }

  let descargadas = 0, errores = 0;
  try {
    const cookies = await autenticarSIIdirecto();
    console.log(`[PDF bulk] Sesión lista. Descargando ${sinPdf.length} PDFs...`);

    let sesionErrores = 0;
    for (const f of sinPdf) {
      // Pausa cortés entre documentos para no saturar SII
      await sleep(400);
      try {
        // Usar CODIGO guardado en BD directamente (viene de detCodigo al sincronizar)
        // Fallback: buscar en mipeAdminDocsRcp si no está en BD (documentos antiguos)
        let codigo = f.codigo;
        if (!codigo) {
          codigo = await buscarCodigoPdf(cookies, f.folio, f.rut_emisor);
        }
        if (!codigo) {
          errores++;
          console.warn(`[PDF bulk] ✗ Folio ${f.folio}: sin CODIGO en BD ni en SII`);
          continue;
        }

        const buf    = await descargarPdfPorCodigo(cookies, codigo);
        const nombre = `factura_${f.folio}_${f.rut_emisor}.pdf`;
        await pool.query(
          `UPDATE facturas_recibidas SET pdf_data=$1, pdf_nombre=$2, pdf_at=NOW(), updated_at=NOW() WHERE id=$3`,
          [buf, nombre, f.id]
        );
        descargadas++;
        sesionErrores = 0;
        console.log(`[PDF bulk] ✓ Folio ${f.folio} CODIGO ${codigo} (${descargadas}/${sinPdf.length})`);
      } catch (err) {
        sesionErrores++;
        errores++;
        console.error(`[PDF bulk] ✗ Folio ${f.folio}: ${err.message}`);
        // Si 3 errores seguidos, la sesión probablemente expiró → re-autenticar
        if (sesionErrores >= 3) {
          console.warn('[PDF bulk] 3 errores seguidos → re-autenticando sesión SII...');
          try {
            cookies = await autenticarSIIdirecto();
            sesionErrores = 0;
            console.log('[PDF bulk] Re-autenticación OK');
          } catch (e) {
            console.error(`[PDF bulk] Re-auth fallida: ${e.message}`);
          }
          await sleep(2000);
        }
      }
    }
  } finally {
    pdfEnCurso = false;
  }

  console.log(`[PDF bulk] Completado: ${descargadas} OK, ${errores} errores`);
  return { descargadas, errores, total: sinPdf.length };
}

async function getFacturasMes(context, conversationId, ptributario) {
  const res = await context.request.post(
    'https://www4.sii.cl/consdcvinternetui/services/data/facadeService/getDetalleCompra',
    {
      headers: { 'Content-Type': 'application/json' },
      data: {
        metaData: {
          namespace: 'cl.sii.sdi.lob.diii.consdcv.data.api.interfaces.FacadeService/getDetalleCompra',
          conversationId,
          transactionId: Math.random().toString(36).slice(2),
          page: null,
        },
        data: {
          rutEmisor: EMPRESA_RUT, dvEmisor: EMPRESA_DV, ptributario,
          codTipoDoc: '33', operacion: 'COMPRA', estadoContab: 'REGISTRO',
          accionRecaptcha: 'RCV_DETC', tokenRecaptcha: 't-o-k-e-n-web',
        },
      },
    }
  );
  const json = await res.json();
  return Array.isArray(json?.data) ? json.data : [];
}

// ─── API — Proveedores ────────────────────────────────────────────────────────

app.get('/api/proveedores', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM proveedores ORDER BY razon_social');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/proveedores/:rut', async (req, res) => {
  const { condicion, categoria, dias_1, pct_1, dias_2, pct_2, en_agenda } = req.body;
  try {
    await pool.query(
      `UPDATE proveedores SET
         condicion  = COALESCE($2, condicion),
         categoria  = CASE WHEN $3::boolean THEN $4 ELSE categoria END,
         dias_1     = COALESCE($5, dias_1),
         pct_1      = COALESCE($6, pct_1),
         dias_2     = COALESCE($7, dias_2),
         pct_2      = COALESCE($8, pct_2),
         en_agenda  = COALESCE($9, en_agenda),
         updated_at = NOW()
       WHERE rut_emisor = $1`,
      [req.params.rut, condicion??null,
       categoria !== undefined, categoria ?? null,
       dias_1??null, pct_1??null, dias_2??null, pct_2??null, en_agenda??null]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── API — Facturas ───────────────────────────────────────────────────────────

app.get('/api/facturas', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, codigo, rut_emisor, razon_social, folio, fecha_emision,
             monto_neto, monto_total, estado_sii,
             vcto_1, monto_1, pagado_1, pagado_1_at,
             vcto_2, monto_2, pagado_2, pagado_2_at,
             pdf_nombre, pdf_at, (pdf_data IS NOT NULL) AS has_pdf,
             created_at, updated_at
      FROM facturas_recibidas ORDER BY fecha_emision DESC
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/facturas/:id/pdf — descarga el PDF desde SII y lo guarda en DB
app.post('/api/facturas/:id/pdf', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM facturas_recibidas WHERE id=$1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Factura no encontrada' });
  const f = rows[0];

  let pdfBuffer;
  try {
    pdfBuffer = await descargarPdfSII(f.folio, f.rut_emisor);
  } catch (err) {
    console.error('[PDF]', err.message);
    return res.status(502).json({ error: err.message });
  }

  const nombre = `factura_${f.folio}_${f.rut_emisor}.pdf`;
  await pool.query(
    `UPDATE facturas_recibidas SET pdf_data=$1, pdf_nombre=$2, pdf_at=NOW(), updated_at=NOW() WHERE id=$3`,
    [pdfBuffer, nombre, req.params.id]
  );
  res.json({ ok: true, nombre, bytes: pdfBuffer.length });
});

// GET /api/facturas/:id/pdf — sirve el PDF guardado
app.get('/api/facturas/:id/pdf', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT pdf_data, pdf_nombre FROM facturas_recibidas WHERE id=$1', [req.params.id]
  );
  if (!rows.length || !rows[0].pdf_data)
    return res.status(404).json({ error: 'PDF no disponible' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${rows[0].pdf_nombre}"`);
  res.send(rows[0].pdf_data);
});

// POST /api/pdf/sync — descarga en background todos los PDFs faltantes
app.post('/api/pdf/sync', async (req, res) => {
  try {
    if (pdfEnCurso || siiEnCurso) return res.json({ ok: false, mensaje: 'Ya hay una operación SII en curso, espera unos minutos', pendientes: 0 });

    const { rows } = await pool.query(
      `SELECT COUNT(*) FROM facturas_recibidas WHERE pdf_data IS NULL`
    );
    const pendientes = parseInt(rows[0].count);
    if (!pendientes) return res.json({ ok: true, mensaje: 'Todos los PDFs ya están disponibles', pendientes: 0 });

    res.json({ ok: true, mensaje: `Descargando ${pendientes} PDFs en background…`, pendientes });

    descargarPdfsBulkSII()
      .then(r => console.log(`[PDF sync] ${r.descargadas}/${r.total} OK, ${r.errores} errores`))
      .catch(err => console.error('[PDF sync]', err.message));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/pdf/test/:folio — prueba de descarga con UNA factura (debug)
app.get('/api/pdf/test/:folio', async (req, res) => {
  if (pdfEnCurso || siiEnCurso) return res.status(409).json({ error: 'Operación SII en curso, espera' });
  const { rows } = await pool.query(
    `SELECT id, folio, rut_emisor, codigo FROM facturas_recibidas WHERE folio=$1 LIMIT 1`,
    [req.params.folio]
  );
  if (!rows.length) return res.status(404).json({ error: 'Folio no encontrado en DB' });
  const f = rows[0];
  try {
    const buf = await descargarPdfSII(f.folio, f.rut_emisor, f.codigo);
    const nombre = `factura_${f.folio}_${f.rut_emisor}.pdf`;
    await pool.query(
      `UPDATE facturas_recibidas SET pdf_data=$1, pdf_nombre=$2, pdf_at=NOW(), updated_at=NOW() WHERE id=$3`,
      [buf, nombre, f.id]
    );
    res.json({ ok: true, folio: f.folio, bytes: buf.length, nombre });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// GET /api/pdf/status — cuántos PDFs están disponibles vs total
app.get('/api/pdf/status', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*) AS total, COUNT(pdf_data) AS con_pdf FROM facturas_recibidas`
    );
    res.json({ total: parseInt(rows[0].total), con_pdf: parseInt(rows[0].con_pdf) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/facturas/:id/extraer-fechas — extrae fechas de vencimiento del PDF guardado
app.post('/api/facturas/:id/extraer-fechas', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT pdf_data, fecha_emision FROM facturas_recibidas WHERE id=$1', [req.params.id]
    );
    if (!rows.length)        return res.status(404).json({ error: 'Factura no encontrada' });
    if (!rows[0].pdf_data)   return res.status(404).json({ error: 'Sin PDF descargado' });

    const pdfParse = require('pdf-parse');
    const data = await pdfParse(rows[0].pdf_data);
    const texto = data.text;

    const fechaEmision = new Date(rows[0].fecha_emision);
    const resultado = { texto_raw: texto.slice(0, 1000), vcto_1: null, vcto_2: null };

    // 1) Fecha explícita DD/MM/YYYY o DD-MM-YYYY cerca de palabras clave
    const patronFecha = /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/g;
    const keywordsVcto = /vencim|fecha\s+pago|fecha\s+de\s+pago|f\.?\s*pago|plazo|condici/i;

    // Buscar líneas con palabras clave de vencimiento
    const lineas = texto.split(/\r?\n/);
    const fechasEncontradas = [];
    for (const linea of lineas) {
      if (!keywordsVcto.test(linea)) continue;
      let m;
      while ((m = patronFecha.exec(linea)) !== null) {
        const [, d, mo, y] = m;
        const fecha = new Date(`${y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}`);
        if (!isNaN(fecha) && fecha > fechaEmision) {
          fechasEncontradas.push(fecha.toISOString().split('T')[0]);
        }
      }
      patronFecha.lastIndex = 0;
    }

    // 2) Si no encontró fechas explícitas, buscar plazo en días
    if (!fechasEncontradas.length) {
      const mPlazo = texto.match(/(?:plazo|condici[oó]n[^:]*|net)\D{0,5}(\d{1,3})\s*d[ií]as?/i)
                  ?? texto.match(/(\d{1,3})\s*d[ií]as?\s*(?:de\s+)?(?:plazo|cr[eé]dito)/i);
      if (mPlazo) {
        const dias = parseInt(mPlazo[1]);
        if (dias > 0 && dias <= 365) {
          const vcto = new Date(fechaEmision);
          vcto.setDate(vcto.getDate() + dias);
          fechasEncontradas.push(vcto.toISOString().split('T')[0]);
        }
      }
    }

    if (fechasEncontradas.length >= 1) resultado.vcto_1 = fechasEncontradas[0];
    if (fechasEncontradas.length >= 2) resultado.vcto_2 = fechasEncontradas[1];

    res.json(resultado);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/facturas/:id/vencimientos', async (req, res) => {
  const { vcto_1, monto_1, vcto_2, monto_2 } = req.body;
  try {
    await pool.query(
      `UPDATE facturas_recibidas SET
         vcto_1=COALESCE($2,vcto_1), monto_1=COALESCE($3,monto_1),
         vcto_2=COALESCE($4,vcto_2), monto_2=COALESCE($5,monto_2), updated_at=NOW()
       WHERE id=$1`,
      [req.params.id, vcto_1??null, monto_1??null, vcto_2??null, monto_2??null]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/facturas/:id/pagar/:cuota', async (req, res) => {
  const { cuota } = req.params;
  if (!['1','2'].includes(cuota)) return res.status(400).json({ error: 'cuota debe ser 1 o 2' });
  try {
    await pool.query(
      `UPDATE facturas_recibidas SET pagado_${cuota}=TRUE, pagado_${cuota}_at=NOW(), updated_at=NOW() WHERE id=$1`,
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── API — Sync ───────────────────────────────────────────────────────────────

app.post('/api/sync/auto', async (req, res) => {
  const actual = mesActual();
  const { rows } = await pool.query('SELECT mes FROM meses_sincronizados');
  const sincronizados = new Set(rows.map(r => r.mes));

  const desde3 = (() => { const d = new Date(); d.setMonth(d.getMonth()-2); return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}`; })();
  const pendientes = rangoDeMeses(desde3, actual).filter(m => m === actual || !sincronizados.has(m));

  if (!pendientes.length) return res.json({ ok: true, mensaje: 'Todo al día', meses: [] });

  let sesion;
  try { sesion = await abrirSesionSII(); }
  catch (err) { return res.status(502).json({ error: err.message }); }

  const resultado = [];
  try {
    for (const mes of pendientes) {
      const docs = await getFacturasMes(sesion.context, sesion.conversationId, mes);
      const { insertadas, actualizadas } = await upsertFacturas(docs);
      await pool.query(
        `INSERT INTO meses_sincronizados (mes,total) VALUES ($1,$2) ON CONFLICT (mes) DO UPDATE SET total=$2, synced_at=NOW()`,
        [mes, docs.length]
      );
      resultado.push({ mes, total: docs.length, insertadas, actualizadas });
    }
  } finally { siiEnCurso = false; await sesion.browser.close(); }

  res.json({ ok: true, meses: resultado });
});

// POST /api/sync/historico
// ?forzar=true → re-procesa TODOS los meses (aunque ya sincronizados) para actualizar vcto
app.post('/api/sync/historico', async (req, res) => {
  const actual  = mesActual();
  const forzar  = req.query.forzar === 'true' || req.body?.forzar === true;
  const desde   = req.query.desde ?? req.body?.desde ?? (() => {
    const d = new Date(); d.setFullYear(d.getFullYear()-2);
    return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}`;
  })();

  const { rows } = await pool.query('SELECT mes FROM meses_sincronizados');
  const sincronizados = new Set(rows.map(r => r.mes));
  const todos = rangoDeMeses(desde, actual);
  const pendientes = forzar ? todos : todos.filter(m => m === actual || !sincronizados.has(m));

  if (!pendientes.length) return res.json({ ok: true, mensaje: 'Todo ya sincronizado' });

  res.json({ ok: true, mensaje: `Sincronizando ${pendientes.length} meses en background${forzar?' (forzado)':''}...`, meses: pendientes });

  let sesion;
  try {
    sesion = await abrirSesionSII();
    for (const mes of pendientes) {
      const docs = await getFacturasMes(sesion.context, sesion.conversationId, mes);
      await upsertFacturas(docs, forzar);
      await pool.query(
        `INSERT INTO meses_sincronizados (mes,total) VALUES ($1,$2) ON CONFLICT (mes) DO UPDATE SET total=$2, synced_at=NOW()`,
        [mes, docs.length]
      );
      console.log(`[historico] ${mes}: ${docs.length} facturas${forzar?' (forzado)':''}`);
    }
    console.log('[historico] Completado');
  } catch (err) { console.error('[historico] Error:', err.message); }
  finally { siiEnCurso = false; sesion?.browser?.close(); }
});

let dbReady = false;
app.get('/health', (req, res) => res.json({ status: 'ok', db: dbReady }));

// ─── Startup ──────────────────────────────────────────────────────────────────

process.on('uncaughtException',  err => console.error('[CRASH] uncaughtException:', err));
process.on('unhandledRejection', err => console.error('[CRASH] unhandledRejection:', err));

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Puerto ${PORT} — servidor listo`);
  setupDb()
    .then(() => { dbReady = true; console.log('[DB] lista'); })
    .catch(err => console.error('[DB] Error setup:', err.message));
});

server.on('error', err => console.error('[SERVER] Error:', err));
