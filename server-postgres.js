const express      = require('express');
const { Pool }     = require('pg');
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
      mes        VARCHAR(6) PRIMARY KEY,
      total      INTEGER,
      synced_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Migración columnas faltantes
  for (const [col, type] of [
    ['monto_neto','BIGINT'],['monto_total','BIGINT'],['estado_sii','VARCHAR(50)'],
    ['vcto_1','DATE'],['monto_1','BIGINT'],['pagado_1','BOOLEAN DEFAULT FALSE'],['pagado_1_at','TIMESTAMP'],
    ['vcto_2','DATE'],['monto_2','BIGINT'],['pagado_2','BOOLEAN DEFAULT FALSE'],['pagado_2_at','TIMESTAMP'],
  ]) {
    await pool.query(
      `ALTER TABLE facturas_recibidas ADD COLUMN IF NOT EXISTS ${col} ${type}`
    ).catch(() => {});
  }
  console.log('[DB] Tablas listas');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseDate(str) {
  if (!str) return null;
  const [d, m, y] = str.split('/');
  return `${y}-${m}-${d}`;
}

// Genera lista de meses YYYYMM entre desde y hasta (inclusive)
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

async function upsertFacturas(docs) {
  let insertadas = 0, actualizadas = 0;
  for (const d of docs) {
    const montoTotal = Math.round(d.detMntNeto * 1.19);
    const mitad      = Math.round(montoTotal / 2);
    const r = await pool.query(
      `INSERT INTO facturas_recibidas
         (codigo, rut_emisor, razon_social, folio, fecha_emision,
          monto_neto, monto_total, estado_sii,
          vcto_1, monto_1, vcto_2, monto_2)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, $5::date+30,$9, $5::date+40,$10)
       ON CONFLICT (codigo) DO UPDATE SET
         razon_social = EXCLUDED.razon_social,
         monto_neto   = EXCLUDED.monto_neto,
         monto_total  = EXCLUDED.monto_total,
         estado_sii   = EXCLUDED.estado_sii,
         updated_at   = NOW()
       RETURNING (xmax = 0) AS inserted`,
      [
        String(d.detCodigo), `${d.detRutDoc}-${d.detDvDoc}`, d.detRznSoc, d.detNroDoc,
        parseDate(d.detFchDoc), d.detMntNeto, montoTotal,
        d.dcvEstadoContab ?? 'REGISTRO', mitad, montoTotal - mitad,
      ]
    );
    r.rows[0].inserted ? insertadas++ : actualizadas++;
  }
  return { insertadas, actualizadas };
}

// ─── SII — sesión reutilizable ────────────────────────────────────────────────

async function ngSelect(page, selector, value) {
  await page.evaluate(({ sel, val }) => {
    const el = document.querySelector(sel);
    el.value = val;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, { sel: selector, val: value });
}

async function abrirSesionSII() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
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

  await page.goto('https://zeusr.sii.cl//AUT2000/InicioAutenticacion/IngresoRutClave.html?https://misiir.sii.cl/cgi_misii/siihome.cgi');
  await page.fill('#rutcntr', SII_RUT);
  await page.fill('#clave',   SII_PASSWORD);
  await Promise.all([page.waitForLoadState('networkidle'), page.keyboard.press('Enter')]);

  await page.goto('https://www1.sii.cl/cgi-bin/Portal001/mipeSelEmpresa.cgi');
  if (await page.locator('select[name="RUT_EMP"]').count()) {
    await page.locator('select[name="RUT_EMP"]').selectOption(SII_EMPRESA_RUT);
    await Promise.all([
      page.waitForLoadState('networkidle').catch(() => {}),
      page.locator('[type=submit]').first().click(),
    ]);
  }

  await page.goto('https://www4.sii.cl/consdcvinternetui/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  if (!conversationId) {
    await ngSelect(page, 'select[name="rut"]', SII_EMPRESA_RUT);
    await page.waitForTimeout(2000);
  }

  if (!conversationId) throw new Error('No se pudo obtener conversationId de SII');

  return { browser, context, conversationId };
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

// POST /api/sync/auto — sincroniza meses recientes que no estén en DB
// Abre sesión una sola vez. Siempre re-sincroniza el mes actual.
app.post('/api/sync/auto', async (req, res) => {
  const actual = mesActual();

  // Meses ya sincronizados
  const { rows } = await pool.query('SELECT mes FROM meses_sincronizados');
  const sincronizados = new Set(rows.map(r => r.mes));

  // Últimos 3 meses + siempre el actual
  const ultimos3 = rangoDeMeses(
    (() => { const d = new Date(); d.setMonth(d.getMonth() - 2); return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}`; })(),
    actual
  );
  const pendientes = ultimos3.filter(m => m === actual || !sincronizados.has(m));

  if (!pendientes.length) {
    return res.json({ ok: true, mensaje: 'Todo al día', meses: [] });
  }

  console.log(`[auto] Meses pendientes: ${pendientes.join(', ')}`);
  let sesion;
  try {
    sesion = await abrirSesionSII();
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }

  const resultado = [];
  try {
    for (const mes of pendientes) {
      const docs = await getFacturasMes(sesion.context, sesion.conversationId, mes);
      const { insertadas, actualizadas } = await upsertFacturas(docs);
      await pool.query(
        `INSERT INTO meses_sincronizados (mes, total) VALUES ($1,$2)
         ON CONFLICT (mes) DO UPDATE SET total=$2, synced_at=NOW()`,
        [mes, docs.length]
      );
      resultado.push({ mes, total: docs.length, insertadas, actualizadas });
      console.log(`[auto] ${mes}: ${docs.length} facturas`);
    }
  } finally {
    await sesion.browser.close();
  }

  res.json({ ok: true, meses: resultado });
});

// POST /api/sync/historico?desde=202401 — trae todo desde una fecha
// Omite meses ya sincronizados (excepto el actual)
app.post('/api/sync/historico', async (req, res) => {
  const actual = mesActual();
  const desde  = req.query.desde ?? req.body?.desde ?? (() => {
    const d = new Date(); d.setFullYear(d.getFullYear() - 2);
    return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}`;
  })();

  const { rows } = await pool.query('SELECT mes FROM meses_sincronizados');
  const sincronizados = new Set(rows.map(r => r.mes));

  const todos      = rangoDeMeses(desde, actual);
  const pendientes = todos.filter(m => m === actual || !sincronizados.has(m));

  console.log(`[historico] ${pendientes.length} meses por sincronizar (desde ${desde})`);
  if (!pendientes.length) return res.json({ ok: true, mensaje: 'Todo ya sincronizado' });

  // Responde de inmediato y procesa en background
  res.json({ ok: true, mensaje: `Sincronizando ${pendientes.length} meses en background...`, meses: pendientes });

  let sesion;
  try {
    sesion = await abrirSesionSII();
    for (const mes of pendientes) {
      const docs = await getFacturasMes(sesion.context, sesion.conversationId, mes);
      await upsertFacturas(docs);
      await pool.query(
        `INSERT INTO meses_sincronizados (mes, total) VALUES ($1,$2)
         ON CONFLICT (mes) DO UPDATE SET total=$2, synced_at=NOW()`,
        [mes, docs.length]
      );
      console.log(`[historico] ${mes}: ${docs.length} facturas`);
    }
    console.log('[historico] Completado');
  } catch (err) {
    console.error('[historico] Error:', err.message);
  } finally {
    sesion?.browser.close();
  }
});

// PUT /api/facturas/:id/vencimientos
app.put('/api/facturas/:id/vencimientos', async (req, res) => {
  const { vcto_1, monto_1, vcto_2, monto_2 } = req.body;
  try {
    await pool.query(
      `UPDATE facturas_recibidas SET
         vcto_1=COALESCE($2,vcto_1), monto_1=COALESCE($3,monto_1),
         vcto_2=COALESCE($4,vcto_2), monto_2=COALESCE($5,monto_2),
         updated_at=NOW()
       WHERE id=$1`,
      [req.params.id, vcto_1??null, monto_1??null, vcto_2??null, monto_2??null]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/facturas/:id/pagar/:cuota
app.put('/api/facturas/:id/pagar/:cuota', async (req, res) => {
  const { cuota } = req.params;
  if (!['1','2'].includes(cuota)) return res.status(400).json({ error: 'cuota debe ser 1 o 2' });
  try {
    await pool.query(
      `UPDATE facturas_recibidas SET
         pagado_${cuota}=TRUE, pagado_${cuota}_at=NOW(), updated_at=NOW()
       WHERE id=$1`,
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
