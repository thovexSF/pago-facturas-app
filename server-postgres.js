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
    ['tipo_doc','VARCHAR(10) DEFAULT \'33\''],['ref_tipo_doc','VARCHAR(10)'],['ref_folio','INTEGER'],
    ['anulada','BOOLEAN DEFAULT FALSE'],['anulada_por_folio','INTEGER'],
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

function extraerReferenciasDesdeDocSii(d) {
  const ownFo = parseInt(String(d.detNroDoc ?? '').replace(/\D/g, ''), 10);
  const found = [];
  const pares = [
    ['detTipoDocRef', 'detFolioDocRef'],
    ['detTpoDocRef', 'detNroDocRef'],
    ['dcvTpoDocRef', 'dcvNroDocRef'],
    ['detCodTipoDocRef', 'detNroDocRef'],
    ['codTipoDocReferencia', 'folioReferencia'],
    ['codDocReferencia', 'folioDocReferencia'],
  ];
  for (const [kt, kf] of pares) {
    if (d[kt] == null || d[kf] == null) continue;
    const ti = parseInt(String(d[kt]).replace(/\D/g, ''), 10);
    const fo = parseInt(String(d[kf]).replace(/\D/g, ''), 10);
    if (ti && fo && !(ti === 61 && fo === ownFo)) found.push({ tipo: ti, folio: fo });
  }
  if (Array.isArray(d.detallesRefDoc)) {
    for (const x of d.detallesRefDoc) {
      const fo = x?.folio ?? x?.nroFolio ?? x?.detNroDoc;
      const ti = x?.tpoDoc ?? x?.codTipoDoc ?? x?.tipoDte;
      if (fo != null && ti != null) {
        const t = parseInt(String(ti).replace(/\D/g, ''), 10);
        const f = parseInt(String(fo).replace(/\D/g, ''), 10);
        if (t && f && !(t === 61 && f === ownFo)) found.push({ tipo: t, folio: f });
      }
    }
  }
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const folio = node.folio ?? node.detFolio ?? node.nroFolio ?? node.numFolio ?? node.detNroDocRef;
    const tipo = node.tipoDoc ?? node.codTipoDoc ?? node.dcvTipoDoc ?? node.tipoDte ?? node.detTipoDoc;
    if (folio != null && tipo != null) {
      const ti = parseInt(String(tipo).replace(/\D/g, ''), 10);
      const fo = parseInt(String(folio).replace(/\D/g, ''), 10);
      if (ti && fo && !(ti === 61 && fo === ownFo))
        found.push({ tipo: ti, folio: fo });
    }
    for (const v of Object.values(node)) visit(v);
  };
  visit(d);
  const seen = new Set();
  const uniq = found.filter(r => {
    const k = `${r.tipo}-${r.folio}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const pref = uniq.filter(r => r.tipo === 33 || r.tipo === 34 || r.tipo === 46);
  return pref.length ? pref : uniq;
}

function parseReferenciasGesHtml(html) {
  if (!html || typeof html !== 'string') return [];
  const refs = [];
  const seen = new Set();
  const add = (tipo, folio) => {
    const t = parseInt(String(tipo).replace(/\D/g, ''), 10);
    const f = parseInt(String(folio).replace(/\D/g, ''), 10);
    if (!t || !f) return;
    const k = `${t}-${f}`;
    if (seen.has(k)) return;
    seen.add(k);
    refs.push({ tipo: t, folio: f });
  };
  let m;
  const r1 = /[?&]FOLIO=(\d+)[^"'&\s]*[?&]T(?:IPO_)?DOC(?:UMENTO)?=(\d+)/gi;
  while ((m = r1.exec(html)) !== null) add(m[2], m[1]);
  const r2 = /[?&]T(?:IPO_)?DOC(?:UMENTO)?=(\d+)[^"'&\s]*[?&]FOLIO=(\d+)/gi;
  while ((m = r2.exec(html)) !== null) add(m[1], m[2]);
  const r3 = /Folio[^0-9]{0,8}(\d{1,9})[^0-9]{0,40}Tipo[^0-9]{0,12}(\d{2})/gi;
  while ((m = r3.exec(html)) !== null) add(m[2], m[1]);
  const r4 = /Tipo\s+DTE[^0-9]{0,24}(\d{2,3})[^0-9]{0,120}?Folio[^0-9]{0,12}(\d{4,9})/gi;
  while ((m = r4.exec(html)) !== null) add(m[1], m[2]);
  const r5 = /Folio[:\s]+(\d{1,9})[\s\S]{0,160}?Tipo\s+(?:de\s+)?(?:DTE|documento)[^0-9]{0,20}(\d{2,3})/gi;
  while ((m = r5.exec(html)) !== null) add(m[2], m[1]);
  const pref = refs.filter(r => r.tipo === 33 || r.tipo === 34 || r.tipo === 46);
  return pref.length ? pref : refs;
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
    const tipoDoc = String(d._codTipoDoc || d.detTipoDoc || d.detCodTipoDoc || '33');
    const esNC = tipoDoc === '61';
    const montoNetoVal = Math.abs(Number(d.detMntNeto) || 0);
    const montoTotal = Math.round(montoNetoVal * 1.19);
    const esContado = prov.condicion === 'contado';
    const esCredito = !esContado;
    const fechaEmision = parseDate(d.detFchDoc);
    const vctoSII = d.detFchVcto ? parseDate(d.detFchVcto) : null;

    if (esNC) {
      const refs = extraerReferenciasDesdeDocSii(d);
      const prim = refs.find(x => x.tipo === 33 || x.tipo === 34) ?? refs[0];
      const refTipo = prim ? String(prim.tipo) : null;
      const refFolio = prim ? prim.folio : null;
      const r = await pool.query(
        `INSERT INTO facturas_recibidas
           (codigo, rut_emisor, razon_social, folio, fecha_emision,
            monto_neto, monto_total, estado_sii, tipo_doc, ref_tipo_doc, ref_folio,
            vcto_1, monto_1, pagado_1, pagado_1_at, vcto_2, monto_2, pagado_2, pagado_2_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'61',$9,$10,
            $5, $7, TRUE, NOW(), NULL, NULL, FALSE, NULL)
         ON CONFLICT (codigo) DO UPDATE SET
           razon_social = EXCLUDED.razon_social,
           monto_neto = EXCLUDED.monto_neto,
           monto_total = EXCLUDED.monto_total,
           estado_sii = EXCLUDED.estado_sii,
           tipo_doc = EXCLUDED.tipo_doc,
           ref_tipo_doc = COALESCE(EXCLUDED.ref_tipo_doc, facturas_recibidas.ref_tipo_doc),
           ref_folio = COALESCE(EXCLUDED.ref_folio, facturas_recibidas.ref_folio),
           updated_at = NOW()
         RETURNING (xmax = 0) AS inserted`,
        [
          String(d.detCodigo), rut, d.detRznSoc, d.detNroDoc,
          fechaEmision, montoNetoVal, montoTotal, d.dcvEstadoContab ?? 'REGISTRO',
          refTipo, refFolio,
        ]
      );
      r.rows[0].inserted ? insertadas++ : actualizadas++;
      continue;
    }

    const monto1 = esContado ? montoTotal : Math.round(montoTotal * prov.pct_1 / 100);
    const monto2 = esContado || vctoSII ? null : esCredito ? montoTotal - monto1 : null;

    if (vctoSII) console.log(`[SII sync] Folio ${d.detNroDoc} → vcto SII: ${vctoSII}`);

    const r = await pool.query(
      `INSERT INTO facturas_recibidas
         (codigo, rut_emisor, razon_social, folio, fecha_emision,
          monto_neto, monto_total, estado_sii, tipo_doc,
          vcto_1, monto_1, pagado_1, pagado_1_at,
          vcto_2, monto_2, pagado_2, pagado_2_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'33',
          CASE WHEN $9::date IS NOT NULL THEN $9::date
               WHEN $10::boolean         THEN $5::date
               ELSE $5::date + $11::integer END,
          $12, $10, CASE WHEN $10 THEN NOW() ELSE NULL END,
          CASE WHEN $9::date IS NOT NULL OR NOT $13::boolean THEN NULL
               ELSE $5::date + $14::integer END,
          $15, FALSE, NULL)
       ON CONFLICT (codigo) DO UPDATE SET
         razon_social = EXCLUDED.razon_social,
         monto_neto   = EXCLUDED.monto_neto,
         monto_total  = EXCLUDED.monto_total,
         estado_sii   = EXCLUDED.estado_sii,
         tipo_doc     = EXCLUDED.tipo_doc,
         pagado_1     = EXCLUDED.pagado_1,
         pagado_1_at  = EXCLUDED.pagado_1_at,
         pagado_2     = EXCLUDED.pagado_2,
         pagado_2_at  = EXCLUDED.pagado_2_at,
         monto_1      = EXCLUDED.monto_1,
         monto_2      = EXCLUDED.monto_2,
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
        fechaEmision, montoNetoVal, montoTotal, d.dcvEstadoContab ?? 'REGISTRO',
        vctoSII,
        esContado,
        prov.dias_1,
        monto1,
        esCredito,
        prov.dias_2,
        monto2,
        forzar,
      ]
    );
    r.rows[0].inserted ? insertadas++ : actualizadas++;
  }
  await aplicarAnulacionesPorReferencias();
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

async function obtenerReferenciasGesDoc(cookies, codigo) {
  const launchUrl = 'https://www1.sii.cl/cgi-bin/Portal001/mipeLaunchPage.cgi?OPCION=1&TIPO=4';
  const gesUrl = `https://www1.sii.cl/cgi-bin/Portal001/mipeGesDocRcp.cgi?CODIGO=${codigo}&ALL_PAGE_ANT=2`;
  const hdr = (ref) => ({ 'Cookie': siiCookieHeader(cookies), 'Referer': ref, 'User-Agent': SII_UA });
  await axios.get(launchUrl, { validateStatus: () => true, headers: hdr('https://www1.sii.cl/') }).catch(() => null);
  await sleep(200);
  const chunks = [];
  const r2 = await axios.get(gesUrl, { validateStatus: () => true, headers: hdr(launchUrl) }).catch(() => null);
  chunks.push(Buffer.from(r2?.data ?? '').toString('latin1'));
  const extras = [
    `https://www1.sii.cl/cgi-bin/Portal001/mipeLstDocReferenciaRcp.cgi?CODIGO=${encodeURIComponent(codigo)}`,
    `https://www1.sii.cl/cgi-bin/Portal001/mipeLstReferenciaRcp.cgi?CODIGO=${encodeURIComponent(codigo)}`,
  ];
  for (const u of extras) {
    await sleep(150);
    const rx = await axios.get(u, { validateStatus: () => true, headers: hdr(gesUrl) }).catch(() => null);
    if (rx && rx.status === 200 && rx.data) chunks.push(Buffer.from(rx.data).toString('latin1'));
  }
  return parseReferenciasGesHtml(chunks.join('\n'));
}

async function aplicarAnulacionesPorReferencias() {
  const r = await pool.query(`
    UPDATE facturas_recibidas f
    SET anulada = TRUE,
        anulada_por_folio = nc.folio,
        updated_at = NOW()
    FROM facturas_recibidas nc
    WHERE nc.tipo_doc = '61'
      AND nc.ref_folio IS NOT NULL
      AND nc.ref_tipo_doc IS NOT NULL
      AND f.rut_emisor = nc.rut_emisor
      AND f.folio = nc.ref_folio
      AND f.tipo_doc IS DISTINCT FROM '61'
      AND COALESCE(f.anulada, FALSE) = FALSE
  `);
  if (r.rowCount) console.log(`[NC anulación] ${r.rowCount} factura(s) marcadas anulada por NC`);
}

async function resolverReferenciasNotasCredito(cookies) {
  const { rows } = await pool.query(`
    SELECT id, codigo, folio FROM facturas_recibidas
    WHERE tipo_doc = '61'
      AND codigo IS NOT NULL
      AND (ref_folio IS NULL OR ref_tipo_doc IS NULL)
  `);
  for (const r of rows) {
    let refs = [];
    try {
      refs = await obtenerReferenciasGesDoc(cookies, r.codigo);
    } catch (e) {
      console.warn(`[NC ref] id ${r.id} codigo ${r.codigo}: ${e.message}`);
    }
    if (!refs.length) continue;
    const p = refs.find(x => x.tipo === 33 || x.tipo === 34) ?? refs[0];
    await pool.query(
      `UPDATE facturas_recibidas SET ref_tipo_doc = $1, ref_folio = $2, updated_at = NOW() WHERE id = $3`,
      [String(p.tipo), p.folio, r.id]
    );
    console.log(`[NC ref] NC folio ${r.folio} → ref ${p.tipo}/${p.folio}`);
  }
  await aplicarAnulacionesPorReferencias();
}

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
// tipoDte: '33' FE, '61' NC, etc. Si se omite, lista sin filtrar (puede equivocarse entre tipos).
async function buscarCodigoPdf(cookies, folio, rutEmisor, tipoDte = null) {
  const [rutNum] = rutEmisor.replace(/\./g, '').split('-');
  const folioStr = String(folio);
  const intentosTpo = tipoDte ? [String(tipoDte), null] : [null];

  for (const td of intentosTpo) {
    const tpo = td ? `&TPO_DOC=${encodeURIComponent(td)}` : '&TPO_DOC=';
    const url = `https://www1.sii.cl/cgi-bin/Portal001/mipeAdminDocsRcp.cgi?RUT_EMI=${rutNum}&FOLIO=${folioStr}&RZN_SOC=&FEC_DESDE=&FEC_HASTA=${tpo}&ESTADO=&ORDEN=&NUM_PAG=1`;

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

      if (resp.status === 503 || body.includes('503 Service Temporarily')) {
        const espera = intento * 2000;
        console.warn(`[SII pdf] Folio ${folio} TPO=${td ?? '∅'} → 503, reintento ${intento}/4 en ${espera / 1000}s...`);
        await sleep(espera);
        continue;
      }

      const m = body.match(/\/cgi-bin\/Portal001\/mipeGesDocRcp\.cgi\?CODIGO=(\d+)/);
      if (!m) {
        const titulo = (body.match(/<title>([^<]*)<\/title>/i) ?? [])[1] ?? '?';
        console.warn(`[SII pdf] Folio ${folio} TPO=${td ?? '∅'} no encontrado. Título: "${titulo}"`);
        break;
      }
      console.log(`[SII pdf] Folio ${folio} → CODIGO ${m[1]} (TPO_DOC=${td ?? '∅'})`);
      return m[1];
    }
  }

  console.warn(`[SII pdf] Folio ${folio} → sin CODIGO tras intentos`);
  return null;
}

// ── Descargar PDF de un documento dado su CODIGO interno ─────────────────────
async function descargarPdfPorCodigo(cookies, codigo) {
  const launchUrl = 'https://www1.sii.cl/cgi-bin/Portal001/mipeLaunchPage.cgi?OPCION=1&TIPO=4';
  const gesUrl    = `https://www1.sii.cl/cgi-bin/Portal001/mipeGesDocRcp.cgi?CODIGO=${codigo}&ALL_PAGE_ANT=2`;
  const defaultPdfUrl = `https://www1.sii.cl/cgi-bin/Portal001/mipeShowPdf.cgi?CODIGO=${codigo}`;

  // Fusiona Set-Cookie headers en el array [{name,value}] que usa siiCookieHeader
  const mergeCookies = (existing, setCookieHeader) => {
    const map = new Map(existing.map(c => [c.name, c]));
    const raw = Array.isArray(setCookieHeader) ? setCookieHeader : (setCookieHeader ? [setCookieHeader] : []);
    for (const c of raw) {
      const pair = c.split(';')[0].trim();
      const eqIdx = pair.indexOf('=');
      if (eqIdx > 0) map.set(pair.slice(0, eqIdx).trim(), { name: pair.slice(0, eqIdx).trim(), value: pair.slice(eqIdx + 1).trim() });
    }
    return [...map.values()];
  };

  let ck = [...cookies];
  const hdr = (ref) => ({ 'Cookie': siiCookieHeader(ck), 'Referer': ref, 'User-Agent': SII_UA });
  const absUrl = (u) => (u.startsWith('http') ? u : `https://www1.sii.cl${u.startsWith('/') ? '' : '/'}${u}`);
  const extraerPdfUrlDesdeGes = (html) => {
    if (!html) return null;
    const m1 = html.match(/\/cgi-bin\/Portal001\/mipeShowPdf[^"'\s>]*\?CODIGO=\d+/i);
    if (m1) return absUrl(m1[0]);
    const m2 = html.match(/href="([^"]*mipeShowPdf[^"]*\?CODIGO=\d+[^"]*)"/i);
    if (m2) return absUrl(m2[1]);
    const m3 = html.match(/action="([^"]*mipeShowPdf[^"]*)"/i);
    if (m3) {
      const u = m3[1].includes('CODIGO=') ? m3[1] : `${m3[1]}${m3[1].includes('?') ? '&' : '?'}CODIGO=${encodeURIComponent(String(codigo))}`;
      return absUrl(u);
    }
    return null;
  };

  // Paso 1: landing page
  const r1 = await axios.get(launchUrl, { validateStatus: () => true, headers: hdr('https://www1.sii.cl/') }).catch(() => null);
  if (r1) ck = mergeCookies(ck, r1.headers['set-cookie']);
  await sleep(300);

  // Paso 2: página de gestión — capturamos cookies y diagnosticamos
  const r2 = await axios.get(gesUrl, { validateStatus: () => true, headers: hdr(launchUrl) }).catch(() => null);
  let body2 = '';
  if (r2) {
    ck = mergeCookies(ck, r2.headers['set-cookie']);
    body2 = Buffer.from(r2.data ?? '').toString('latin1');
    const title2 = (body2.match(/<title>([^<]*)<\/title>/i) ?? [])[1] ?? '?';
    console.log(`[PDF] mipeGesDocRcp status=${r2.status} title="${title2}"`);
    if (title2.toLowerCase().includes('error')) {
      // El CODIGO no es accesible — probablemente documento en estado Pendiente sin PDF disponible
      throw new Error(`Documento no disponible en SII (${title2}). Puede estar en estado Pendiente.`);
    }
  }
  await sleep(300);

  // Paso 3: PDF (primero endpoint clásico; fallback URL encontrada en HTML)
  const tryGetPdf = async (pdfUrl) => {
    const resp = await axios.get(pdfUrl, {
      maxRedirects: 3, validateStatus: () => true, responseType: 'arraybuffer',
      headers: { ...hdr(gesUrl), Accept: 'application/pdf,*/*;q=0.8' },
    });
    const buf = Buffer.from(resp.data);
    if (buf.slice(0, 4).toString() === '%PDF') return buf;
    return null;
  };

  let buf = await tryGetPdf(defaultPdfUrl);
  if (buf) return buf;

  const altPdfUrl = extraerPdfUrlDesdeGes(body2);
  if (altPdfUrl && altPdfUrl !== defaultPdfUrl) {
    buf = await tryGetPdf(altPdfUrl);
    if (buf) return buf;
  }

  const failPreview = Buffer.from(buf ?? '').toString('latin1').slice(0, 300).replace(/\s+/g, ' ');
  console.error(`[PDF] CODIGO ${codigo} no devolvió PDF:`, failPreview);
  throw new Error(`SII no devolvió PDF para este documento`);
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


// Descarga el PDF de UNA factura — intenta HTTP, cae a Playwright si falla
// tipoDte: '33' | '61' | null — necesario para buscar CODIGO en mipeAdmin cuando no hay código en BD.
async function descargarPdfSII(folio, rutEmisor, codigoBd = null, tipoDte = null) {
  if (pdfEnCurso || siiEnCurso) throw new Error('Ya hay una operación SII en curso, intenta en unos minutos');
  pdfEnCurso = true;
  try {
    // Intento 1: HTTP directo (rápido)
    let cookies = null;
    try {
      cookies = await autenticarHTTP();
      if (cookies) cookies = await seleccionarEmpresaHTTP(cookies);
    } catch (_) { cookies = null; }

    if (cookies) {
      const codigo = codigoBd || await buscarCodigoPdf(cookies, folio, rutEmisor, tipoDte);
      if (codigo) {
        console.log(`[SII pdf] Folio ${folio} → CODIGO ${codigo} (HTTP)`);
        try {
          return await descargarPdfPorCodigo(cookies, codigo);
        } catch (httpErr) {
          console.warn(`[SII pdf] HTTP falló (${httpErr.message}), intentando vía browser...`);
        }
      }
    }

    // Intento 2: Auth via browser → descarga HTTP Portal001 (más estable que pedir PDF dentro del browser)
    try {
      const ck = await autenticarSIIdirecto();
      const codigo = codigoBd || await buscarCodigoPdf(ck, folio, rutEmisor, tipoDte);
      if (codigo) {
        console.log(`[SII pdf] Folio ${folio} → CODIGO ${codigo} (directo)`);
        return await descargarPdfPorCodigo(ck, codigo);
      }
    } catch (e) {
      console.warn(`[SII pdf] directo falló (${e.message}), intentando vía browser Playwright...`);
    }

    // Intento 3: Playwright navega directamente al PDF en el browser autenticado
    console.log(`[SII pdf] Folio ${folio} → descargando vía browser Playwright`);
    return await descargarPdfViaBrowser(folio, rutEmisor, codigoBd, tipoDte);
  } finally {
    pdfEnCurso = false;
  }
}

// Descarga PDF usando Playwright directamente (sin extraer cookies)
async function descargarPdfViaBrowser(folio, rutEmisor, codigoBd = null, tipoDte = null) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx  = browser.newContext({ userAgent: SII_UA });
    const page = (await ctx).newPage();
    await loginSII(await page);

    // Seleccionar empresa
    await (await page).goto('https://www1.sii.cl/cgi-bin/Portal001/mipeSelEmpresa.cgi', { waitUntil: 'domcontentloaded', timeout: 30000 });
    try {
      await (await page).selectOption('select[name="RUT_EMP"]', SII_EMPRESA_RUT.replace('-', ''), { timeout: 5000 });
      await (await page).click('input[type="submit"]', { timeout: 5000 });
    } catch (_) {}
    await sleep(1000);

    // Obtener CODIGO si no lo tenemos
    let codigo = codigoBd;
    if (!codigo) {
      const [rutNum] = rutEmisor.replace(/\./g, '').split('-');
      const intentos = tipoDte ? [String(tipoDte), ''] : [''];
      for (const td of intentos) {
        const tpo = td === '' ? '&TPO_DOC=' : `&TPO_DOC=${encodeURIComponent(td)}`;
        const searchUrl = `https://www1.sii.cl/cgi-bin/Portal001/mipeAdminDocsRcp.cgi?RUT_EMI=${rutNum}&FOLIO=${folio}&RZN_SOC=&FEC_DESDE=&FEC_HASTA=${tpo}&ESTADO=&ORDEN=&NUM_PAG=1`;
        await (await page).goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const content = await (await page).content();
        const m = content.match(/CODIGO=(\d+)/);
        if (m) {
          codigo = m[1];
          break;
        }
      }
      if (!codigo) throw new Error(`Folio ${folio} no encontrado en SII (browser)`);
    }

    console.log(`[SII pdf] Folio ${folio} → CODIGO ${codigo} (browser)`);

    // Con CODIGO detectado en browser, descargar vía helper HTTP (más robusto)
    const ck = await autenticarSIIdirecto();
    return await descargarPdfPorCodigo(ck, codigo);
  } finally {
    await browser.close().catch(() => {});
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
    `SELECT id, folio, rut_emisor, codigo, tipo_doc FROM facturas_recibidas WHERE pdf_data IS NULL ORDER BY fecha_emision DESC`
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
          codigo = await buscarCodigoPdf(cookies, f.folio, f.rut_emisor, f.tipo_doc || null);
        }
        if (!codigo) {
          errores++;
          console.warn(`[PDF bulk] ✗ Folio ${f.folio}: sin CODIGO en BD ni en SII`);
          continue;
        }

        const buf    = await descargarPdfPorCodigo(cookies, codigo);
        const nombre = f.tipo_doc === '61'
          ? `nc_${f.folio}_${f.rut_emisor}.pdf`
          : `factura_${f.folio}_${f.rut_emisor}.pdf`;
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

async function getFacturasMesEstado(context, conversationId, ptributario, estadoContab, codTipoDoc = '33') {
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
          codTipoDoc, operacion: 'COMPRA', estadoContab,
          accionRecaptcha: 'RCV_DETC', tokenRecaptcha: 't-o-k-e-n-web',
        },
      },
    }
  );
  const json = await res.json();
  return Array.isArray(json?.data) ? json.data : [];
}

function mergeRegistroPendiente(registro, pendientes) {
  const vistos = new Set(registro.map(d => `${d.detRutDoc}-${d.detNroDoc}`));
  const soloNuevos = pendientes.filter(d => !vistos.has(`${d.detRutDoc}-${d.detNroDoc}`));
  return [...registro, ...soloNuevos];
}

async function getFacturasMes(context, conversationId, ptributario) {
  const [r33, p33, r61, p61] = await Promise.all([
    getFacturasMesEstado(context, conversationId, ptributario, 'REGISTRO', '33'),
    getFacturasMesEstado(context, conversationId, ptributario, 'PENDIENTE', '33'),
    getFacturasMesEstado(context, conversationId, ptributario, 'REGISTRO', '61'),
    getFacturasMesEstado(context, conversationId, ptributario, 'PENDIENTE', '61'),
  ]);
  const m33 = mergeRegistroPendiente(r33, p33);
  const m61 = mergeRegistroPendiente(r61, p61);
  const v33 = new Set(r33.map(x => `${x.detRutDoc}-${x.detNroDoc}`));
  const pendExtra = p33.filter(d => !v33.has(`${d.detRutDoc}-${d.detNroDoc}`));
  if (pendExtra.length) console.log(`[SII sync] ${ptributario}: +${pendExtra.length} pendientes (FE)`);
  const v61 = new Set(r61.map(x => `${x.detRutDoc}-${x.detNroDoc}`));
  const pendExtra61 = p61.filter(d => !v61.has(`${d.detRutDoc}-${d.detNroDoc}`));
  if (pendExtra61.length) console.log(`[SII sync] ${ptributario}: +${pendExtra61.length} pendientes (NC)`);
  return [...m33.map(d => ({ ...d, _codTipoDoc: '33' })), ...m61.map(d => ({ ...d, _codTipoDoc: '61' }))];
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
    const incluirAnuladas = req.query.incluir_anuladas === '1' || req.query.incluir_anuladas === 'true';
    const { rows } = await pool.query(
      `SELECT id, codigo, rut_emisor, razon_social, folio, fecha_emision,
              monto_neto, monto_total, estado_sii,
              vcto_1, monto_1, pagado_1, pagado_1_at,
              vcto_2, monto_2, pagado_2, pagado_2_at,
              pdf_nombre, pdf_at, (pdf_data IS NOT NULL) AS has_pdf,
              tipo_doc, ref_tipo_doc, ref_folio, anulada, anulada_por_folio,
              created_at, updated_at
       FROM facturas_recibidas
       WHERE ($1::boolean OR COALESCE(anulada, FALSE) = FALSE)
       ORDER BY fecha_emision DESC`,
      [incluirAnuladas]
    );
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
    pdfBuffer = await descargarPdfSII(f.folio, f.rut_emisor, f.codigo, f.tipo_doc || null);
  } catch (err) {
    console.error('[PDF]', err.message);
    return res.status(502).json({ error: err.message });
  }

  const nombre = f.tipo_doc === '61'
    ? `nc_${f.folio}_${f.rut_emisor}.pdf`
    : `factura_${f.folio}_${f.rut_emisor}.pdf`;
  await pool.query(
    `UPDATE facturas_recibidas SET pdf_data=$1, pdf_nombre=$2, pdf_at=NOW(), updated_at=NOW() WHERE id=$3`,
    [pdfBuffer, nombre, req.params.id]
  );
  res.json({ ok: true, nombre, bytes: pdfBuffer.length });
});

// POST /api/facturas/:id/resolver-ref-nc — ref desde HTML SII solo si aún falta en BD (el RCV ya trae detTipoDocRef)
app.post('/api/facturas/:id/resolver-ref-nc', async (req, res) => {
  if (pdfEnCurso || siiEnCurso) return res.status(409).json({ error: 'Operación SII en curso, espera' });
  try {
    const { rows } = await pool.query('SELECT * FROM facturas_recibidas WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'No encontrado' });
    const row = rows[0];
    if (String(row.tipo_doc) !== '61') return res.status(400).json({ error: 'Solo aplica a notas de crédito' });
    if (row.ref_folio != null && row.ref_tipo_doc != null) {
      await aplicarAnulacionesPorReferencias();
      return res.json({
        ok: true,
        desde: 'bd',
        ref_tipo_doc: String(row.ref_tipo_doc),
        ref_folio: row.ref_folio,
        mensaje: 'Referencia ya estaba en base de datos; anulaciones aplicadas',
      });
    }
    if (!row.codigo) return res.status(400).json({ error: 'Sin código SII en base de datos; sincroniza de nuevo' });
    const cookies = await autenticarSIIdirecto();
    const refs = await obtenerReferenciasGesDoc(cookies, String(row.codigo));
    const prim = refs.find(x => x.tipo === 33 || x.tipo === 34) ?? refs[0];
    if (!prim) return res.json({ ok: false, mensaje: 'No se encontró documento referenciado en el HTML del SII' });
    await pool.query(
      `UPDATE facturas_recibidas SET ref_tipo_doc=$1, ref_folio=$2, updated_at=NOW() WHERE id=$3`,
      [String(prim.tipo), prim.folio, row.id]
    );
    await aplicarAnulacionesPorReferencias();
    res.json({ ok: true, desde: 'sii', ref_tipo_doc: String(prim.tipo), ref_folio: prim.folio });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// POST /api/facturas/:id/ocultar-factura-referenciada — NC: marca anulada la FE (mismo emisor, folio ref.)
app.post('/api/facturas/:id/ocultar-factura-referenciada', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM facturas_recibidas WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'No encontrado' });
    const nc = rows[0];
    if (String(nc.tipo_doc) !== '61') return res.status(400).json({ error: 'Solo desde una nota de crédito' });
    if (nc.ref_folio == null || nc.ref_tipo_doc == null) {
      return res.status(400).json({ error: 'La NC no tiene folio de referencia; sincroniza con el SII' });
    }
    const r = await pool.query(
      `UPDATE facturas_recibidas f
       SET anulada = TRUE, anulada_por_folio = $3, updated_at = NOW()
       WHERE f.rut_emisor = $1 AND f.folio = $2
         AND f.tipo_doc IS DISTINCT FROM '61'
         AND COALESCE(f.anulada, FALSE) = FALSE
       RETURNING f.id, f.folio`,
      [nc.rut_emisor, nc.ref_folio, nc.folio]
    );
    if (!r.rowCount) {
      return res.json({
        ok: true,
        ya_estaba: true,
        mensaje: 'No había factura activa con ese folio o ya estaba oculta',
      });
    }
    res.json({ ok: true, ocultadas: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/facturas/:id/eliminar-referenciada-permanente — NC: borra la fila de la FE referenciada (irreversible)
app.post('/api/facturas/:id/eliminar-referenciada-permanente', async (req, res) => {
  try {
    if (req.body?.confirmar !== 'ELIMINAR') {
      return res.status(400).json({ error: 'Enviar JSON { "confirmar": "ELIMINAR" }' });
    }
    const { rows } = await pool.query('SELECT * FROM facturas_recibidas WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'No encontrado' });
    const nc = rows[0];
    if (String(nc.tipo_doc) !== '61') return res.status(400).json({ error: 'Solo desde una nota de crédito' });
    if (nc.ref_folio == null) return res.status(400).json({ error: 'NC sin folio de referencia' });
    const r = await pool.query(
      `DELETE FROM facturas_recibidas f
       WHERE f.rut_emisor = $1 AND f.folio = $2 AND f.tipo_doc IS DISTINCT FROM '61'
       RETURNING f.id, f.folio`,
      [nc.rut_emisor, nc.ref_folio]
    );
    res.json({ ok: true, eliminadas: r.rowCount, filas: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
    `SELECT id, folio, rut_emisor, codigo, tipo_doc FROM facturas_recibidas WHERE folio=$1 LIMIT 1`,
    [req.params.folio]
  );
  if (!rows.length) return res.status(404).json({ error: 'Folio no encontrado en DB' });
  const f = rows[0];
  try {
    const buf = await descargarPdfSII(f.folio, f.rut_emisor, f.codigo, f.tipo_doc || null);
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

    // 1) Fecha explícita cerca de palabras clave (DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD)
    const patronFechaDMY  = /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/g;
    const patronFechaISO  = /(\d{4})-(\d{2})-(\d{2})/g;
    const keywordsVcto = /vencim|fecha\s+pago|fecha\s+de\s+pago|f\.?\s*pago|plazo|condici|pagos/i;

    const extraerDeFecha = (linea) => {
      const out = [];
      let m;
      patronFechaDMY.lastIndex = 0;
      while ((m = patronFechaDMY.exec(linea)) !== null) {
        const [, d, mo, y] = m;
        const f = new Date(`${y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}`);
        if (!isNaN(f) && f > fechaEmision) out.push(f.toISOString().split('T')[0]);
      }
      patronFechaISO.lastIndex = 0;
      while ((m = patronFechaISO.exec(linea)) !== null) {
        const [, y, mo, d] = m;
        const f = new Date(`${y}-${mo}-${d}`);
        if (!isNaN(f) && f > fechaEmision) out.push(f.toISOString().split('T')[0]);
      }
      return out;
    };

    // Buscar líneas con palabras clave; también inspeccionar las 5 líneas siguientes
    // (para cubrir casos como "Pagos:\n2026-04-22 ...")
    const lineas = texto.split(/\r?\n/);
    const fechasEncontradas = [];
    const vistas = new Set();
    for (let i = 0; i < lineas.length; i++) {
      if (!keywordsVcto.test(lineas[i])) continue;
      const ventana = lineas.slice(i, Math.min(i + 6, lineas.length));
      for (const l of ventana) {
        for (const f of extraerDeFecha(l)) {
          if (!vistas.has(f)) { vistas.add(f); fechasEncontradas.push(f); }
        }
      }
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

app.post('/api/sync', async (req, res) => {
  try {
    const docs = req.body.facturas || [];
    const r = await upsertFacturas(docs);
    try {
      const ck = await autenticarSIIdirecto();
      await resolverReferenciasNotasCredito(ck);
    } catch (e) { console.warn('[NC ref] /api/sync:', e.message); }
    res.json(r);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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

  try {
    const ck = await autenticarSIIdirecto();
    await resolverReferenciasNotasCredito(ck);
  } catch (e) { console.warn('[NC ref] post-sync:', e.message); }

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
    try {
      const ck = await autenticarSIIdirecto();
      await resolverReferenciasNotasCredito(ck);
    } catch (e) { console.warn('[NC ref] post-sync:', e.message); }
    console.log('[historico] Completado');
  } catch (err) { console.error('[historico] Error:', err.message); }
  finally { siiEnCurso = false; sesion?.browser?.close(); }
});

// ─── Notificaciones de vencimiento ───────────────────────────────────────────

const nodemailer = require('nodemailer');
const cron       = require('node-cron');

const NOTIF_EMAIL_TO   = process.env.NOTIF_EMAIL_TO;
const NOTIF_EMAIL_FROM = process.env.NOTIF_EMAIL_FROM;
const NOTIF_EMAIL_PASS = process.env.NOTIF_EMAIL_PASS;
const NOTIF_DIAS       = parseInt(process.env.NOTIF_DIAS_AVISO ?? '5');

async function getCuotasProximas(dias = NOTIF_DIAS) {
  const { rows } = await pool.query(`
    SELECT f.id, f.folio, f.rut_emisor, f.monto_total,
           p.razon_social AS nombre_emisor,
           f.vcto_1, f.monto_1, f.pagado_1,
           f.vcto_2, f.monto_2, f.pagado_2
    FROM facturas_recibidas f
    JOIN proveedores p ON f.rut_emisor = p.rut_emisor
    WHERE COALESCE(f.anulada, FALSE) = FALSE
      AND COALESCE(f.tipo_doc, '33') <> '61'
      AND (
      (f.vcto_1 IS NOT NULL AND f.pagado_1 = FALSE
         AND f.vcto_1 BETWEEN CURRENT_DATE AND CURRENT_DATE + $1)
      OR
      (f.vcto_2 IS NOT NULL AND f.pagado_2 = FALSE
         AND f.vcto_2 BETWEEN CURRENT_DATE AND CURRENT_DATE + $1)
    )
    ORDER BY LEAST(
      CASE WHEN f.pagado_1 = FALSE THEN f.vcto_1 ELSE NULL END,
      CASE WHEN f.pagado_2 = FALSE THEN f.vcto_2 ELSE NULL END
    )
  `, [dias]);
  return rows;
}

// GET /api/notificaciones/proximos — para el banner del browser
app.get('/api/notificaciones/proximos', async (req, res) => {
  try {
    const dias = parseInt(req.query.dias ?? NOTIF_DIAS);
    const rows = await getCuotasProximas(dias);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/notificaciones/enviar — disparo manual o vía cron
app.post('/api/notificaciones/enviar', async (req, res) => {
  try {
    if (!NOTIF_EMAIL_TO || !NOTIF_EMAIL_FROM || !NOTIF_EMAIL_PASS) {
      return res.status(400).json({ error: 'Variables NOTIF_EMAIL_TO/FROM/PASS no configuradas' });
    }
    const cuotas = await getCuotasProximas();
    if (!cuotas.length) return res.json({ enviado: false, motivo: 'Sin vencimientos próximos' });

    const fmt = (n) => n ? new Intl.NumberFormat('es-CL',{style:'currency',currency:'CLP'}).format(n) : '—';
    const fmtDate = (d) => d ? new Date(d).toLocaleDateString('es-CL') : '—';

    const filas = cuotas.map(c => {
      const partes = [];
      if (!c.pagado_1 && c.vcto_1) partes.push(`C1 ${fmtDate(c.vcto_1)} ${fmt(c.monto_1)}`);
      if (!c.pagado_2 && c.vcto_2) partes.push(`C2 ${fmtDate(c.vcto_2)} ${fmt(c.monto_2)}`);
      return `<tr>
        <td style="padding:6px 12px;border-bottom:1px solid #e2e8f0">${c.nombre_emisor}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #e2e8f0">${c.folio}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #e2e8f0">${partes.join(' · ')}</td>
      </tr>`;
    }).join('');

    const html = `
      <h2 style="font-family:sans-serif;color:#1e293b">Facturas con vencimiento próximo</h2>
      <p style="font-family:sans-serif;color:#64748b">Vencen en los próximos ${NOTIF_DIAS} días:</p>
      <table style="border-collapse:collapse;font-family:sans-serif;font-size:14px">
        <thead><tr style="background:#f8fafc">
          <th style="padding:6px 12px;text-align:left">Proveedor</th>
          <th style="padding:6px 12px;text-align:left">Folio</th>
          <th style="padding:6px 12px;text-align:left">Cuotas</th>
        </tr></thead>
        <tbody>${filas}</tbody>
      </table>
    `;

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: NOTIF_EMAIL_FROM, pass: NOTIF_EMAIL_PASS }
    });

    await transporter.sendMail({
      from: `Facturas Bioma <${NOTIF_EMAIL_FROM}>`,
      to: NOTIF_EMAIL_TO,
      subject: `⚠️ ${cuotas.length} factura(s) vencen en los próximos ${NOTIF_DIAS} días`,
      html
    });

    res.json({ enviado: true, total: cuotas.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Cron: lunes a viernes a las 8:00 AM (hora servidor / Railway usa UTC — ajustar si es necesario)
cron.schedule('0 8 * * 1-5', async () => {
  if (!NOTIF_EMAIL_TO) return;
  try {
    const r = await fetch(`http://localhost:${PORT}/api/notificaciones/enviar`, { method: 'POST' });
    const j = await r.json();
    console.log('[CRON notif]', j);
  } catch (err) { console.error('[CRON notif] Error:', err.message); }
});

// Libera el mutex si quedó trabado por un error previo
app.post('/api/sii/reset-mutex', (req, res) => {
  siiEnCurso = false;
  pdfEnCurso = false;
  res.json({ ok: true });
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
