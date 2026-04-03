const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
const iconv = require('iconv-lite');
const https = require('https');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

// ─── PostgreSQL ──────────────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function setupDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS facturas_recibidas (
      id SERIAL PRIMARY KEY,
      codigo VARCHAR(50) UNIQUE,
      rut_emisor VARCHAR(20),
      razon_social VARCHAR(255),
      tipo_documento VARCHAR(100),
      tipo_codigo INTEGER,
      folio INTEGER,
      fecha_emision DATE,
      fecha_vencimiento DATE,
      monto BIGINT,
      estado_sii VARCHAR(50),
      estado_pago VARCHAR(20) DEFAULT 'pendiente',
      pagada_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('[DB] Tabla facturas_recibidas lista');
}

// ─── SII Service ─────────────────────────────────────────────────────────────

const SII_URLS = {
  login: 'https://zeusr.sii.cl//AUT2000/InicioAutenticacion/IngresoRutClave.html?https://misiir.sii.cl/cgi_misii/siihome.cgi',
  siiHome: 'https://misiir.sii.cl/cgi_misii/siihome.cgi',
  selEmpresa: 'https://www1.sii.cl/cgi-bin/Portal001/mipeSelEmpresa.cgi',
  listadoEmitidos: 'https://www1.sii.cl/cgi-bin/Portal001/mipeAdminDocsEmi.cgi',
  listadoRecibidos: 'https://www1.sii.cl/cgi-bin/Portal001/mipeAdminDocsRec.cgi',
};

const BASE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-CL,es;q=0.9,en;q=0.8',
};

function makeSiiAxios() {
  return axios.create({
    maxRedirects: 0,
    validateStatus: () => true,
    responseType: 'arraybuffer',
    timeout: 30000,
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  });
}

function decodeSiiHtml(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  try { return iconv.decode(buf, 'windows-1252'); } catch { return buf.toString('utf8'); }
}

function parseRut(username) {
  const clean = username.replace(/\./g, '').replace(/\s/g, '').toUpperCase();
  const parts = clean.split('-');
  const rut = parts[0];
  const dv = parts[1] || '';
  return { rutcntr: `${rut}-${dv}`, rut, dv };
}

function mergeCookies(cookieStore, setCookieHeader) {
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

function getCookieHeader(cookieStore) {
  return [...cookieStore.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function followRedirects(http, cookieStore, initialRes, initialUrl) {
  let res = initialRes;
  let currentUrl = initialUrl;
  let count = 0;
  while ([301, 302, 303, 307, 308].includes(res.status) && count < 12) {
    mergeCookies(cookieStore, res.headers['set-cookie']);
    const location = res.headers['location'];
    if (!location) break;
    const nextUrl = location.startsWith('http') ? location : new URL(location, currentUrl).href;
    console.log(`[SII] redirect ${res.status} → ${nextUrl.substring(0, 80)}`);
    res = await http.get(nextUrl, { headers: { ...BASE_HEADERS, Cookie: getCookieHeader(cookieStore) } });
    currentUrl = nextUrl;
    count++;
  }
  mergeCookies(cookieStore, res.headers['set-cookie']);
  return { res, finalUrl: currentUrl };
}

function extractLoginFormFields(html) {
  const fields = new Map();
  const lower = html.toLowerCase();
  let idx = 0;
  while (idx < html.length) {
    const formStart = lower.indexOf('<form', idx);
    if (formStart < 0) break;
    const formEnd = lower.indexOf('</form>', formStart);
    if (formEnd < 0) break;
    const slice = html.slice(formStart, formEnd);
    if (!/\brutcntr\b/i.test(slice)) { idx = formEnd + 7; continue; }
    const inputRe = /<input\b([^>]+)>/gi;
    let m;
    while ((m = inputRe.exec(slice)) !== null) {
      const tag = m[1];
      const nameM = tag.match(/\bname\s*=\s*"([^"]*)"/i) || tag.match(/\bname\s*=\s*'([^']*)'/i);
      const name = nameM?.[1]?.trim();
      if (!name) continue;
      const typeM = tag.match(/\btype\s*=\s*"([^"]*)"/i);
      const type = (typeM?.[1] || 'text').toLowerCase();
      if (['submit', 'button', 'image'].includes(type)) continue;
      const valueM = tag.match(/\bvalue\s*=\s*"([^"]*)"/i) || tag.match(/\bvalue\s*=\s*'([^']*)'/i);
      fields.set(name, valueM?.[1] ?? '');
    }
    break;
  }
  return fields;
}

function buildLoginPostBody(scrapedFields, referencia, codeFieldName, creds) {
  const params = new URLSearchParams();
  if (scrapedFields.size > 0) {
    for (const [k, v] of scrapedFields) params.set(k, v);
  }
  params.set('rutcntr', creds.rutcntr);
  params.set('rut', creds.rut);
  params.set('dv', creds.dv);
  params.set('clave', creds.clave);
  params.set('referencia', referencia);
  if (!scrapedFields.has(codeFieldName)) params.set(codeFieldName, '');
  return params.toString();
}

function parseTableRows(html) {
  const rows = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let trM;
  while ((trM = trRe.exec(html)) !== null) {
    const rowHtml = trM[1];
    const cells = [];
    const links = [];
    const tdRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let tdM;
    while ((tdM = tdRe.exec(rowHtml)) !== null) {
      const cell = tdM[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
      cells.push(cell);
      const hrefRe = /href="([^"]+)"/gi;
      let hM;
      while ((hM = hrefRe.exec(tdM[1])) !== null) links.push(hM[1]);
    }
    if (cells.length > 0) rows.push({ cells, links });
  }
  return rows;
}

async function siiLogin(rut, password, empresaRut) {
  const cookieStore = new Map();
  const http = makeSiiAxios();
  const { rutcntr, rut: rutNum, dv } = parseRut(rut);

  // Paso 1: GET login page
  console.log('[SII] GET login page...');
  const step1Raw = await http.get(SII_URLS.login, { headers: BASE_HEADERS });
  mergeCookies(cookieStore, step1Raw.headers['set-cookie']);
  const html1 = decodeSiiHtml(step1Raw.data);

  const loginUrlParts = SII_URLS.login.split('?');
  const referencia = loginUrlParts.length > 1 ? loginUrlParts.slice(1).join('?') : SII_URLS.siiHome;

  const codeMatch = html1.match(/<input[^>]*id="code"[^>]*name="(\d+)"/i) ||
                    html1.match(/<input[^>]*name="(\d+)"[^>]*id="code"/i);
  const codeFieldName = codeMatch?.[1] ?? '411';

  const scrapedFields = extractLoginFormFields(html1);
  const postPayload = buildLoginPostBody(scrapedFields, referencia, codeFieldName, {
    rutcntr, rut: rutNum, dv, clave: password,
  });

  // Paso 2: POST credenciales
  console.log('[SII] POST credenciales...');
  const postRes = await http.post('https://zeusr.sii.cl/cgi_AUT2000/CAutInicio.cgi', postPayload, {
    headers: {
      ...BASE_HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: SII_URLS.login,
      Origin: 'https://zeusr.sii.cl',
      Cookie: getCookieHeader(cookieStore),
    },
  });
  const { res: loginRes, finalUrl: loginUrl } = await followRedirects(http, cookieStore, postRes, 'https://zeusr.sii.cl/cgi_AUT2000/CAutInicio.cgi');
  const loginHtml = decodeSiiHtml(loginRes.data);
  console.log(`[SII] Login final URL: ${loginUrl}, status: ${loginRes.status}`);

  if (loginHtml.includes('id="rutcntr"') || loginHtml.includes("id='rutcntr'")) {
    throw new Error('Login SII fallido: RUT o clave incorrectos');
  }

  // Paso 3: GET misiir home (enlazar sesión con portal MIPYME)
  console.log('[SII] GET misiir home...');
  const homeRaw = await http.get(SII_URLS.siiHome, {
    headers: { ...BASE_HEADERS, Cookie: getCookieHeader(cookieStore), Referer: loginUrl },
  });
  await followRedirects(http, cookieStore, homeRaw, SII_URLS.siiHome);

  // Paso 4: GET selEmpresa
  console.log('[SII] GET selEmpresa...');
  const empGetRaw = await http.get(SII_URLS.selEmpresa, {
    headers: { ...BASE_HEADERS, Cookie: getCookieHeader(cookieStore), Referer: SII_URLS.siiHome },
  });
  const { res: empGet } = await followRedirects(http, cookieStore, empGetRaw, SII_URLS.selEmpresa);
  const htmlEmp = decodeSiiHtml(empGet.data);

  // Paso 5: POST selección empresa
  const formActionM = htmlEmp.match(/<form[^>]*action="([^"]+)"/i);
  const rawAction = formActionM?.[1] ?? SII_URLS.selEmpresa;
  const formAction = rawAction.startsWith('http') ? rawAction : `https://www1.sii.cl${rawAction.startsWith('/') ? '' : '/'}${rawAction}`;
  const selectNameM = htmlEmp.match(/<select[^>]*name="([^"]+)"/i);
  const selectName = selectNameM?.[1] ?? 'RUT_EMP';

  const empBody = new URLSearchParams();
  empBody.set(selectName, empresaRut);
  const inputRe = /<input([^>]*)>/gi;
  let im;
  while ((im = inputRe.exec(htmlEmp)) !== null) {
    const nameM = im[1].match(/name="([^"]+)"/i);
    const valueM = im[1].match(/value="([^"]+)"/i);
    const typeM = im[1].match(/type="([^"]+)"/i);
    if (nameM && typeM?.[1]?.toLowerCase() !== 'submit') {
      empBody.set(nameM[1], valueM?.[1] ?? '');
    }
  }

  console.log(`[SII] POST empresa ${empresaRut} → ${formAction}`);
  const empPostRaw = await http.post(formAction, empBody.toString(), {
    headers: {
      ...BASE_HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: SII_URLS.selEmpresa,
      Origin: 'https://www1.sii.cl',
      Cookie: getCookieHeader(cookieStore),
    },
  });
  await followRedirects(http, cookieStore, empPostRaw, formAction);

  const cookies = getCookieHeader(cookieStore);
  console.log('[SII] Login completo');
  return { http, cookies, cookieStore };
}

async function fetchFacturasRecibidas(http, cookies, opts = {}) {
  const { fechaDesde, fechaHasta, maxPaginas = 20 } = opts;
  const facturas = [];
  let pagina = 1;

  while (pagina <= maxPaginas) {
    const params = new URLSearchParams({
      RUT_EMIT: '',
      FOLIO: '',
      RZN_SOC: '',
      FEC_DESDE: fechaDesde || '',
      FEC_HASTA: fechaHasta || '',
      TPO_DOC: '33', // Facturas electrónicas
      ESTADO: '',
      ORDEN: '',
      NUM_PAG: String(pagina),
    });

    console.log(`[SII] GET facturas recibidas pág ${pagina}...`);
    const res = await http.get(`${SII_URLS.listadoRecibidos}?${params}`, {
      headers: { ...BASE_HEADERS, Cookie: cookies },
    });
    const html = decodeSiiHtml(res.data);

    // Detectar si no hay datos
    const codigos = [...html.matchAll(/CODIGO=(\d+)/g)].map(m => m[1]);
    if (codigos.length === 0) {
      console.log(`[SII] Sin más facturas recibidas en pág ${pagina}`);
      break;
    }

    const rows = parseTableRows(html);
    const filasDatos = rows.filter(r =>
      r.cells.length >= 4 &&
      (r.links.some(l => l.includes('CODIGO=')) || r.cells.join(' ').includes('CODIGO='))
    );

    for (const row of filasDatos) {
      const linkCodigo = row.links.find(l => l.includes('CODIGO=')) || row.cells.find(c => c.includes('CODIGO='));
      if (!linkCodigo) continue;
      const codigoM = linkCodigo.match(/CODIGO=(\d+)/);
      if (!codigoM) continue;
      const codigo = codigoM[1];

      // Para recibidas: [rut_emisor | razon_social | tipo_doc | folio | fecha | monto | estado]
      const dataCells = row.cells.filter((c, i) => i > 0 || c.length > 5);
      const [col0, col1, col2, col3, col4, col5, col6] = dataCells;

      const isDate = s => /^\d{4}-\d{2}-\d{2}/.test((s || '').trim());
      const isTipoDoc = s => /(factura|electronica|electrónica|exenta|gu[ií]a|nota|despacho|cr[eé]dito|d[eé]bito|boleta)/i.test(s || '');

      let rutEmisor, razonSocial, tipoDoc, folio, fecha, montoStr, estado;

      if (isTipoDoc(col1)) {
        const rutM = (col0 || '').match(/^(\d{7,8}-[\dKk])\s*(.*)/);
        rutEmisor = rutM ? rutM[1] : (col0 || '').trim();
        razonSocial = rutM?.[2]?.trim() || '';
        tipoDoc = (col1 || '').trim();
        folio = parseInt(col2 || '0', 10) || 0;
        fecha = (col3 || '').trim();
        montoStr = col4 || '0';
        estado = (col5 || '').trim();
      } else {
        rutEmisor = (col0 || '').trim();
        razonSocial = (col1 || '').trim();
        tipoDoc = (col2 || '').trim();
        if (isDate(col3)) {
          folio = 0;
          fecha = (col3 || '').trim();
          montoStr = col4 || '0';
          estado = (col5 || '').trim();
        } else {
          folio = parseInt(col3 || '0', 10) || 0;
          fecha = (col4 || '').trim();
          montoStr = col5 || '0';
          estado = (col6 || '').trim();
        }
      }

      const monto = parseInt(montoStr.replace(/[^\d]/g, '') || '0', 10);
      // Fecha de vencimiento: 30 días desde emisión (estándar facturas Chile)
      const fechaVencimiento = fecha ? calcularVencimiento(fecha, 30) : null;

      facturas.push({
        codigo,
        rutEmisor,
        razonSocial,
        tipoDocumento: tipoDoc,
        tipoCodigo: 33,
        folio,
        fechaEmision: fecha || null,
        fechaVencimiento,
        monto,
        estadoSii: estado,
      });
    }

    pagina++;
    await new Promise(r => setTimeout(r, 300)); // pausa entre páginas
  }

  return facturas;
}

function calcularVencimiento(fechaEmision, dias) {
  try {
    const d = new Date(fechaEmision);
    d.setDate(d.getDate() + dias);
    return d.toISOString().split('T')[0];
  } catch {
    return null;
  }
}

// ─── API Routes ───────────────────────────────────────────────────────────────

// GET /api/facturas - listar facturas desde DB
app.get('/api/facturas', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM facturas_recibidas
      ORDER BY fecha_vencimiento ASC NULLS LAST
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('[API] GET /api/facturas:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sync - sincronizar facturas desde SII
app.post('/api/sync', async (req, res) => {
  const rut = process.env.SII_RUT;
  const password = process.env.SII_PASSWORD;
  const empresaRut = process.env.SII_EMPRESA_RUT;

  if (!rut || !password || !empresaRut) {
    return res.status(400).json({ error: 'Credenciales SII no configuradas (SII_RUT, SII_PASSWORD, SII_EMPRESA_RUT)' });
  }

  try {
    console.log('[SYNC] Iniciando sincronización SII...');
    const { http, cookies } = await siiLogin(rut, password, empresaRut);

    // Últimos 90 días
    const hoy = new Date();
    const hace90 = new Date(hoy);
    hace90.setDate(hoy.getDate() - 90);
    const fechaDesde = hace90.toISOString().split('T')[0];
    const fechaHasta = hoy.toISOString().split('T')[0];

    const facturas = await fetchFacturasRecibidas(http, cookies, { fechaDesde, fechaHasta });
    console.log(`[SYNC] Obtenidas ${facturas.length} facturas del SII`);

    let nuevas = 0;
    for (const f of facturas) {
      const result = await pool.query(`
        INSERT INTO facturas_recibidas
          (codigo, rut_emisor, razon_social, tipo_documento, tipo_codigo, folio,
           fecha_emision, fecha_vencimiento, monto, estado_sii)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (codigo) DO UPDATE SET
          razon_social = EXCLUDED.razon_social,
          monto = EXCLUDED.monto,
          estado_sii = EXCLUDED.estado_sii,
          updated_at = NOW()
        RETURNING (xmax = 0) AS inserted
      `, [
        f.codigo, f.rutEmisor, f.razonSocial, f.tipoDocumento, f.tipoCodigo,
        f.folio, f.fechaEmision, f.fechaVencimiento, f.monto, f.estadoSii,
      ]);
      if (result.rows[0]?.inserted) nuevas++;
    }

    res.json({
      ok: true,
      total: facturas.length,
      nuevas,
      actualizadas: facturas.length - nuevas,
    });
  } catch (err) {
    console.error('[SYNC] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/facturas/:id/pagar - marcar como pagada
app.put('/api/facturas/:id/pagar', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(`
      UPDATE facturas_recibidas
      SET estado_pago = 'pagada', pagada_at = NOW(), updated_at = NOW()
      WHERE id = $1
    `, [id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Health ───────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Debug: ver HTML crudo que retorna el SII ─────────────────────────────────

app.get('/debug/sii-recibidas', async (req, res) => {
  const rut = process.env.SII_RUT;
  const password = process.env.SII_PASSWORD;
  const empresaRut = process.env.SII_EMPRESA_RUT;
  try {
    const { http, cookies } = await siiLogin(rut, password, empresaRut);
    const params = new URLSearchParams({
      RUT_EMIT: '', FOLIO: '', RZN_SOC: '',
      FEC_DESDE: '', FEC_HASTA: '', TPO_DOC: '', ESTADO: '', ORDEN: '', NUM_PAG: '1',
    });
    const rawRes = await http.get(`${SII_URLS.listadoRecibidos}?${params}`, {
      headers: { ...BASE_HEADERS, Cookie: cookies },
    });
    const html = decodeSiiHtml(rawRes.data);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Startup ──────────────────────────────────────────────────────────────────

async function start() {
  await setupDb();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor corriendo en puerto ${PORT}`);
  });
}

start().catch(err => {
  console.error('Error iniciando servidor:', err);
  process.exit(1);
});
