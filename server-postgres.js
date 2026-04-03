const express    = require('express');
const { Pool }   = require('pg');
const { chromium } = require('playwright');
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
    CREATE TABLE IF NOT EXISTS facturas_recibidas (
      id            SERIAL PRIMARY KEY,
      codigo        VARCHAR(50) UNIQUE,
      rut_emisor    VARCHAR(20),
      razon_social  VARCHAR(255),
      folio         INTEGER,
      fecha_emision DATE,
      monto_neto    BIGINT,
      estado_sii    VARCHAR(50),
      estado_pago   VARCHAR(20) DEFAULT 'pendiente',
      pagada_at     TIMESTAMP,
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('[DB] Tabla lista');
}

// ─── SII Scraper ──────────────────────────────────────────────────────────────

async function ngSelect(page, selector, value) {
  await page.evaluate(({ sel, val }) => {
    const el = document.querySelector(sel);
    el.value = val;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, { sel: selector, val: value });
}

async function scrapeSII(ptributario) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page    = await context.newPage();

  try {
    // Capturar conversationId del init de Angular
    let conversationId = null;
    page.on('response', async res => {
      if (res.url().includes('consdcvinternetui/services')) {
        const json = await res.json().catch(() => null);
        const cid  = json?.metaData?.conversationId;
        if (cid && String(cid).length > 5 && !conversationId)
          conversationId = String(cid);
      }
    });

    // Login
    await page.goto('https://zeusr.sii.cl//AUT2000/InicioAutenticacion/IngresoRutClave.html?https://misiir.sii.cl/cgi_misii/siihome.cgi');
    await page.fill('#rutcntr', SII_RUT);
    await page.fill('#clave',   SII_PASSWORD);
    await Promise.all([page.waitForLoadState('networkidle'), page.keyboard.press('Enter')]);

    // Seleccionar empresa
    await page.goto('https://www1.sii.cl/cgi-bin/Portal001/mipeSelEmpresa.cgi');
    if (await page.locator('select[name="RUT_EMP"]').count()) {
      await page.locator('select[name="RUT_EMP"]').selectOption(SII_EMPRESA_RUT);
      await Promise.all([
        page.waitForLoadState('networkidle').catch(() => {}),
        page.locator('[type=submit]').first().click(),
      ]);
    }

    // RCV — esperar que Angular inicialice y emita conversationId
    await page.goto('https://www4.sii.cl/consdcvinternetui/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);

    if (!conversationId) {
      await ngSelect(page, 'select[name="rut"]', SII_EMPRESA_RUT);
      await page.waitForTimeout(2000);
    }

    if (!conversationId) throw new Error('No se pudo obtener conversationId de SII');

    // Llamada directa a getDetalleCompra
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
            rutEmisor:       EMPRESA_RUT,
            dvEmisor:        EMPRESA_DV,
            ptributario,
            codTipoDoc:      '33',
            operacion:       'COMPRA',
            estadoContab:    'REGISTRO',
            accionRecaptcha: 'RCV_DETC',
            tokenRecaptcha:  't-o-k-e-n-web',
          },
        },
      }
    );

    const json = await res.json();
    return Array.isArray(json?.data) ? json.data : [];

  } finally {
    await browser.close();
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseDate(str) {
  if (!str) return null;
  const [d, m, y] = str.split('/');
  return `${y}-${m}-${d}`;
}

// ─── API ──────────────────────────────────────────────────────────────────────

app.get('/api/facturas', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM facturas_recibidas ORDER BY fecha_emision DESC'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sync?mes=202603
app.post('/api/sync', async (req, res) => {
  const mes = req.query.mes ?? req.body.mes;
  if (!mes) return res.status(400).json({ error: 'Falta parámetro mes (ej: 202603)' });

  console.log(`[sync] Iniciando para ${mes}...`);
  let docs;
  try {
    docs = await scrapeSII(mes);
  } catch (err) {
    console.error('[sync] Error SII:', err.message);
    return res.status(502).json({ error: err.message });
  }

  console.log(`[sync] ${docs.length} facturas obtenidas`);
  let insertadas = 0, actualizadas = 0;

  for (const d of docs) {
    const r = await pool.query(
      `INSERT INTO facturas_recibidas
         (codigo, rut_emisor, razon_social, folio, fecha_emision, monto_neto, estado_sii)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (codigo) DO UPDATE SET
         razon_social = EXCLUDED.razon_social,
         monto_neto   = EXCLUDED.monto_neto,
         estado_sii   = EXCLUDED.estado_sii,
         updated_at   = NOW()
       RETURNING (xmax = 0) AS inserted`,
      [
        String(d.detCodigo),
        `${d.detRutDoc}-${d.detDvDoc}`,
        d.detRznSoc,
        d.detNroDoc,
        parseDate(d.detFchDoc),
        d.detMntNeto,
        d.dcvEstadoContab ?? 'REGISTRO',
      ]
    );
    r.rows[0].inserted ? insertadas++ : actualizadas++;
  }

  res.json({ ok: true, mes, insertadas, actualizadas, total: docs.length });
});

app.put('/api/facturas/:id/pagar', async (req, res) => {
  try {
    await pool.query(
      `UPDATE facturas_recibidas
       SET estado_pago = 'pagada', pagada_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ─── Startup ──────────────────────────────────────────────────────────────────

async function start() {
  await setupDb();
  app.listen(PORT, '0.0.0.0', () => console.log(`Puerto ${PORT}`));
}

start().catch(err => { console.error(err); process.exit(1); });
