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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sii_session (
      id INTEGER PRIMARY KEY DEFAULT 1,
      cookies_json TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('[DB] Tablas listas');
}

// ─── Sesión SII (cookies guardadas desde script local) ───────────────────────

async function getStoredCookies() {
  const r = await pool.query('SELECT cookies_json, updated_at FROM sii_session WHERE id = 1');
  if (!r.rows[0]?.cookies_json) return null;
  const age = Date.now() - new Date(r.rows[0].updated_at).getTime();
  if (age > 8 * 60 * 60 * 1000) return null; // expira en 8 horas
  return r.rows[0].cookies_json;
}

async function saveStoredCookies(cookiesJson) {
  await pool.query(`
    INSERT INTO sii_session (id, cookies_json, updated_at)
    VALUES (1, $1, NOW())
    ON CONFLICT (id) DO UPDATE SET cookies_json = $1, updated_at = NOW()
  `, [cookiesJson]);
}

// ─── RCV Fetcher (usa cookies guardadas) ─────────────────────────────────────

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

function calcularVencimiento(fechaEmision, dias) {
  try {
    const d = new Date(fechaEmision);
    d.setDate(d.getDate() + dias);
    return d.toISOString().split('T')[0];
  } catch { return null; }
}

async function fetchFacturasFromRCV(cookieStr, mesesAtras = 6) {
  const facturas = [];
  const http = makeSiiAxios();

  const hoy = new Date();
  const periodos = [];
  for (let i = 0; i < mesesAtras; i++) {
    const d = new Date(hoy.getFullYear(), hoy.getMonth() - i, 1);
    periodos.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`);
  }

  const TIPOS_DOC = [
    { codigo: '33', nombre: 'Factura Electrónica Afecta' },
    { codigo: '34', nombre: 'Factura Electrónica Exenta' },
    { codigo: '46', nombre: 'Liquidación Factura Electrónica' },
  ];

  for (const periodo of periodos) {
    for (const tipo of TIPOS_DOC) {
      console.log(`[RCV] Consultando ${periodo}/${tipo.codigo}...`);
      try {
        const body = {
          metaData: {
            namespace: 'cl.sii.sdi.lob.diii.consdcv.data.api.interfaces.FacadeService/getDetalleCompra',
            conversationId: `C${Date.now()}`,
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
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
              'Content-Type': 'application/json; charset=utf-8',
              'Accept': '*/*',
              'Accept-Language': 'es-CL,es;q=0.9',
              Cookie: cookieStr,
              Referer: 'https://www4.sii.cl/consdcvinternetui/',
              Origin: 'https://www4.sii.cl',
            },
            responseType: 'arraybuffer',
          }
        );

        const rawText = decodeSiiHtml(res.data);
        console.log(`[RCV] ${periodo}/${tipo.codigo} → ${res.status} | ${rawText.substring(0, 200)}`);

        let parsed;
        try { parsed = JSON.parse(rawText); }
        catch { console.warn(`[RCV] No JSON: ${rawText.substring(0, 150)}`); continue; }

        const errors = parsed?.metaData?.errors || [];
        if (errors.length) console.log(`[RCV] Errores: ${errors.map(e => e.descripcion).join(', ')}`);

        if (parsed?.respEstado?.codRespuesta === 2) {
          console.log(`[RCV] Sin datos ${periodo}/${tipo.codigo}: ${parsed?.respEstado?.codError}`);
          continue;
        }

        const lista = parsed?.data?.listaDetalle || parsed?.data || [];
        if (!Array.isArray(lista) || lista.length === 0) {
          console.log(`[RCV] Lista vacía ${periodo}/${tipo.codigo}`);
          continue;
        }

        console.log(`[RCV] ✓ ${lista.length} documentos en ${periodo}/${tipo.codigo}`);

        for (const item of lista) {
          const rutEmisor = item.rutDoc ? `${item.rutDoc}-${item.dvDoc || ''}` :
                            item.rutEmisor ? `${item.rutEmisor}-${item.dvEmisor || ''}` : null;
          const fecha = (item.fchDoc || item.fechaDoc || '').substring(0, 10) || null;
          facturas.push({
            codigo: `${periodo}-${tipo.codigo}-${rutEmisor}-${parseInt(item.folio || '0', 10)}`,
            rutEmisor,
            razonSocial: item.razonSocial || item.rznSoc || '',
            tipoDocumento: tipo.nombre,
            tipoCodigo: parseInt(tipo.codigo, 10),
            folio: parseInt(item.folio || '0', 10),
            fechaEmision: fecha,
            fechaVencimiento: fecha ? calcularVencimiento(fecha, 30) : null,
            monto: parseInt(item.mntTotal || item.montoTotal || '0', 10),
            estadoSii: item.estadoContab || 'REGISTRO',
          });
        }
      } catch (err) {
        console.warn(`[RCV] Error ${periodo}/${tipo.codigo}:`, err.message);
      }
      await new Promise(r => setTimeout(r, 400));
    }
  }
  return facturas;
}

// ─── API Routes ───────────────────────────────────────────────────────────────

// GET /api/facturas
app.get('/api/facturas', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM facturas_recibidas ORDER BY fecha_vencimiento ASC NULLS LAST
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/session-status — estado de la sesión SII guardada
app.get('/api/session-status', async (req, res) => {
  try {
    const r = await pool.query('SELECT updated_at FROM sii_session WHERE id = 1');
    if (!r.rows[0]) return res.json({ active: false, message: 'Sin sesión guardada' });
    const age = Date.now() - new Date(r.rows[0].updated_at).getTime();
    const minutes = Math.floor(age / 60000);
    const active = age < 8 * 60 * 60 * 1000;
    res.json({
      active,
      updatedAt: r.rows[0].updated_at,
      ageMinutes: minutes,
      message: active ? `Sesión activa (hace ${minutes} min)` : 'Sesión expirada — ejecutar script local',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/set-cookies — recibe cookies del script local Playwright
app.post('/api/set-cookies', async (req, res) => {
  try {
    const { cookies, secret } = req.body;
    // Verificar secret para evitar uso no autorizado
    if (secret !== (process.env.SYNC_SECRET || 'bioma-sync-2024')) {
      return res.status(401).json({ error: 'Secret incorrecto' });
    }
    if (!cookies || typeof cookies !== 'string') {
      return res.status(400).json({ error: 'cookies requerido (string)' });
    }
    await saveStoredCookies(cookies);
    console.log(`[SESSION] Cookies actualizadas (${cookies.length} chars)`);
    res.json({ ok: true, message: 'Sesión SII guardada. Puedes sincronizar desde la app.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sync — sincroniza usando cookies guardadas
app.post('/api/sync', async (req, res) => {
  try {
    const cookieStr = await getStoredCookies();
    if (!cookieStr) {
      return res.status(401).json({
        error: 'Sin sesión SII activa. Ejecuta el script local: npm run sync',
        needsLogin: true,
      });
    }

    console.log('[SYNC] Iniciando sincronización con cookies guardadas...');
    const facturas = await fetchFacturasFromRCV(cookieStr, 6);
    console.log(`[SYNC] ${facturas.length} facturas obtenidas`);

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

    res.json({ ok: true, total: facturas.length, nuevas, actualizadas: facturas.length - nuevas });
  } catch (err) {
    console.error('[SYNC] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/facturas/:id/pagar
app.put('/api/facturas/:id/pagar', async (req, res) => {
  try {
    await pool.query(`
      UPDATE facturas_recibidas
      SET estado_pago = 'pagada', pagada_at = NOW(), updated_at = NOW()
      WHERE id = $1
    `, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /health
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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
