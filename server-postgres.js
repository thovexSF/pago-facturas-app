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
  // Capturar el resultado final del POST de empresa para obtener la URL del home MIPYME
  const { res: empPostFinal, finalUrl: empPostFinalUrl } = await followRedirects(http, cookieStore, empPostRaw, formAction);
  const empPostHtml = decodeSiiHtml(empPostFinal.data);
  console.log(`[SII] Post-empresa URL final: ${empPostFinalUrl}`);

  console.log('[SII] Login MIPYME completo');

  // Paso 6: Establecer sesión en portal RCV (www4.sii.cl) desde el portal MIPYME
  console.log('[SII] Estableciendo sesión RCV desde portal MIPYME...');
  try {
    // Buscar link al RCV directamente en la página del portal MIPYME (www1.sii.cl)
    // El portal MIPYME tiene links con el contexto de empresa ya seleccionada
    let rcvLink = null;

    // 1. Buscar en la página post-empresa
    const rcvM1 = empPostHtml.match(/href="(https?:\/\/www4\.sii\.cl\/consdcvinternetui\/[^"]+)"/i);
    if (rcvM1) rcvLink = rcvM1[1];

    // 2. Si no está ahí, buscar en el home MIPYME
    if (!rcvLink) {
      const mipymeHomeUrls = [
        'https://www1.sii.cl/cgi-bin/Portal001/mipeHome.cgi',
        'https://www1.sii.cl/cgi-bin/Portal001/mipeMenus.cgi',
        empPostFinalUrl,
      ];
      for (const homeUrl of mipymeHomeUrls) {
        if (!homeUrl || !homeUrl.includes('www1.sii.cl')) continue;
        const homeRes = await http.get(homeUrl, {
          headers: { ...BASE_HEADERS, Cookie: getCookieHeader(cookieStore), Referer: empPostFinalUrl },
        });
        mergeCookies(cookieStore, homeRes.headers['set-cookie']);
        const homeHtml = decodeSiiHtml(homeRes.data);
        const rcvM = homeHtml.match(/href="(https?:\/\/www4\.sii\.cl\/consdcvinternetui\/[^"]+)"/i);
        if (rcvM) { rcvLink = rcvM[1]; break; }
        console.log(`[SII] Sin link RCV en ${homeUrl.substring(0, 80)}, status: ${homeRes.status}`);
      }
    }

    // 3. Fallback: URL directa con RUT empresa como parámetro
    if (!rcvLink) {
      const { rut: empRut, dv: empDv } = parseRut(empresaRut);
      rcvLink = `https://www4.sii.cl/consdcvinternetui/?rut=${empRut}&dv=${empDv}`;
      console.log(`[SII] Fallback RCV URL: ${rcvLink}`);
    } else {
      console.log(`[SII] Link RCV encontrado: ${rcvLink}`);
    }

    // Navegar al portal RCV para establecer sesión
    const rcvRes = await http.get(rcvLink, {
      headers: { ...BASE_HEADERS, Cookie: getCookieHeader(cookieStore), Referer: empPostFinalUrl || formAction },
    });
    mergeCookies(cookieStore, rcvRes.headers['set-cookie']);
    console.log(`[SII] RCV inicial status: ${rcvRes.status}, new cookies: ${JSON.stringify(rcvRes.headers['set-cookie'])?.substring(0, 200)}`);

    const { res: rcvFinal, finalUrl: rcvFinalUrl } = await followRedirects(http, cookieStore, rcvRes, rcvLink);
    console.log(`[SII] RCV URL final: ${rcvFinalUrl}, status: ${rcvFinal.status}`);
    console.log(`[SII] Todas las cookies: ${getCookieHeader(cookieStore).substring(0, 400)}`);
  } catch (err) {
    console.warn('[SII] Error accediendo RCV:', err.message);
  }

  const cookies = getCookieHeader(cookieStore);
  console.log(`[SII] Login completo. Cookies (200 chars): ${cookies.substring(0, 200)}`);
  return { http, cookies, cookieStore };
}

// Extrae TOKEN de las cookies del SII
function extractToken(cookies) {
  const m = cookies.match(/(?:^|;\s*)TOKEN=([^;]+)/i);
  return m ? m[1] : null;
}

// Extrae RUT y DV de las cookies del SII
function extractRutDvFromCookies(cookies) {
  const rutM = cookies.match(/(?:^|;\s*)RUT_NS=([^;]+)/i);
  const dvM  = cookies.match(/(?:^|;\s*)DV_NS=([^;]+)/i);
  return { rut: rutM?.[1] || null, dv: dvM?.[1] || null };
}

async function fetchFacturasRecibidas(http, cookies, opts = {}) {
  const { mesesAtras = 6 } = opts;
  const facturas = [];

  // El RCV trabaja por período tributario (YYYYMM)
  const hoy = new Date();
  const periodos = [];
  for (let i = 0; i < mesesAtras; i++) {
    const d = new Date(hoy.getFullYear(), hoy.getMonth() - i, 1);
    periodos.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`);
  }

  const cookieHeader = cookies;

  // Tipos de documento a consultar: 33=Factura Afecta, 34=Factura Exenta, 46=Liquidación
  const TIPOS_DOC = [
    { codigo: '33', nombre: 'Factura Electrónica Afecta' },
    { codigo: '34', nombre: 'Factura Electrónica Exenta' },
    { codigo: '46', nombre: 'Liquidación Factura Electrónica' },
  ];

  for (const periodo of periodos) {
    for (const tipo of TIPOS_DOC) {
      console.log(`[SII RCV] Consultando período ${periodo} tipo ${tipo.codigo}...`);
      try {
        // Generar conversationId único para esta solicitud
        const convId = `APP${Date.now()}${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

        const body = {
          metaData: {
            namespace: 'cl.sii.sdi.lob.diii.consdcv.data.api.interfaces.FacadeService/getDetalleCompra',
            conversationId: convId,
            transactionId: '0',
            page: null,
          },
          data: {
            ptributario: periodo,
            operacion: 'COMPRA',
            estadoContab: 'REGISTRO',
            codTipoDoc: tipo.codigo,
            accionRecaptcha: 'RCV_DETC',
            tokenRecaptcha: 'c3',
          },
        };

        const res = await http.post(
          'https://www4.sii.cl/consdcvinternetui/services/data/facadeService/getDetalleCompra',
          JSON.stringify(body),
          {
            headers: {
              ...BASE_HEADERS,
              'Content-Type': 'application/json; charset=utf-8',
              'Accept': '*/*',
              Cookie: cookieHeader,
              Referer: 'https://www4.sii.cl/consdcvinternetui/',
              Origin: 'https://www4.sii.cl',
            },
            responseType: 'arraybuffer',
          }
        );

        const rawText = decodeSiiHtml(res.data);
        console.log(`[SII RCV] ${periodo}/${tipo.codigo} status: ${res.status}, snippet: ${rawText.substring(0, 250)}`);

        let parsed;
        try { parsed = JSON.parse(rawText); } catch {
          console.warn(`[SII RCV] No JSON ${periodo}/${tipo.codigo}:`, rawText.substring(0, 200));
          continue;
        }

        // Verificar errores de la API
        const errors = parsed?.metaData?.errors || [];
        if (errors.length > 0) {
          console.log(`[SII RCV] Errores ${periodo}/${tipo.codigo}:`, errors.map(e => e.descripcion).join(', '));
        }
        if (parsed?.respEstado?.codRespuesta === 2) {
          console.log(`[SII RCV] Sin datos ${periodo}/${tipo.codigo}: ${parsed?.respEstado?.codError}`);
          continue;
        }

        // La respuesta viene en data.listaDetalle
        const lista = parsed?.data?.listaDetalle || parsed?.data || [];
        if (!Array.isArray(lista) || lista.length === 0) {
          console.log(`[SII RCV] Lista vacía ${periodo}/${tipo.codigo}`);
          continue;
        }

        console.log(`[SII RCV] ${lista.length} documentos en ${periodo}/${tipo.codigo}`);

        for (const item of lista) {
          const rutEmisor = item.rutDoc ? `${item.rutDoc}-${item.dvDoc || ''}` :
                            item.rutEmisor ? `${item.rutEmisor}-${item.dvEmisor || ''}` : null;
          const fecha = (item.fchDoc || item.fechaDoc || item.fecha || '').substring(0, 10) || null;
          const monto = parseInt(item.mntTotal || item.montoTotal || item.monto || '0', 10);
          const folio = parseInt(item.folio || item.nroDoc || '0', 10);
          const codigo = `${periodo}-${tipo.codigo}-${rutEmisor}-${folio}`;

          facturas.push({
            codigo,
            rutEmisor,
            razonSocial: item.razonSocial || item.rznSoc || item.nombreEmisor || '',
            tipoDocumento: tipo.nombre,
            tipoCodigo: parseInt(tipo.codigo, 10),
            folio,
            fechaEmision: fecha,
            fechaVencimiento: fecha ? calcularVencimiento(fecha, 30) : null,
            monto,
            estadoSii: item.estadoContab || item.estado || 'REGISTRO',
          });
        }
      } catch (err) {
        console.warn(`[SII RCV] Error ${periodo}/${tipo.codigo}:`, err.message);
      }

      await new Promise(r => setTimeout(r, 300));
    }
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

    const facturas = await fetchFacturasRecibidas(http, cookies, { fechaDesde, fechaHasta, empresaRut });
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
    const hoy = new Date();
    const periodo = req.query.periodo || `${hoy.getFullYear()}${String(hoy.getMonth() + 1).padStart(2, '0')}`;
    const token = extractToken(cookies);
    console.log(`[DEBUG] Cookies: ${cookies.substring(0, 200)}`);
    console.log(`[DEBUG] TOKEN: ${token}`);

    // Separar RUT/DV empresa
    const empParts = (empresaRut || '').replace(/\./g, '').split('-');
    const rutEmp = empParts[0] || '';
    const dvEmp = empParts[1] || '';

    const codTipoDoc = req.query.tipo || '33';
    const convId = `DBG${Date.now()}`;
    const body = {
      metaData: {
        namespace: 'cl.sii.sdi.lob.diii.consdcv.data.api.interfaces.FacadeService/getDetalleCompra',
        conversationId: convId,
        transactionId: '0',
        page: null,
      },
      data: {
        ptributario: periodo,
        operacion: 'COMPRA',
        estadoContab: 'REGISTRO',
        codTipoDoc,
        accionRecaptcha: 'RCV_DETC',
        tokenRecaptcha: 'c3',
      },
    };
    const rawRes = await http.post(
      'https://www4.sii.cl/consdcvinternetui/services/data/facadeService/getDetalleCompra',
      JSON.stringify(body),
      {
        headers: {
          ...BASE_HEADERS,
          'Content-Type': 'application/json; charset=utf-8',
          Accept: '*/*',
          Cookie: cookies,
          Referer: 'https://www4.sii.cl/consdcvinternetui/',
          Origin: 'https://www4.sii.cl',
        },
        responseType: 'arraybuffer',
      }
    );
    const rawText = decodeSiiHtml(rawRes.data);
    res.json({ status: rawRes.status, cookies: cookies.substring(0, 300), periodo, rutEmpresa: rutEmp, dvEmpresa: dvEmp, requestBody: body, raw: rawText });
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
