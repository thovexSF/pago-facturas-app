const express = require('express');
const { Pool } = require('pg');
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

async function upsertFacturas(docs) {
  let insertadas = 0, actualizadas = 0;
  for (const d of docs) {
    const rut = `${d.detRutDoc}-${d.detDvDoc}`;
    const prov = await getProveedor(rut, d.detRznSoc);
    const montoTotal   = Math.round(d.detMntNeto * 1.19);
    const esContado    = prov.condicion === 'contado';
    const fechaEmision = parseDate(d.detFchDoc);
    const monto1 = esContado ? montoTotal : Math.round(montoTotal * prov.pct_1 / 100);
    const monto2 = esContado ? null       : montoTotal - monto1;

    const r = await pool.query(
      `INSERT INTO facturas_recibidas
         (codigo, rut_emisor, razon_social, folio, fecha_emision,
          monto_neto, monto_total, estado_sii,
          vcto_1, monto_1, pagado_1, pagado_1_at,
          vcto_2, monto_2, pagado_2, pagado_2_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
          $5::date,           $9,  $10, $11,
          CASE WHEN $12::boolean THEN NULL ELSE $5::date + $13::integer END,
          $14, FALSE, NULL)
       ON CONFLICT (codigo) DO UPDATE SET
         razon_social = EXCLUDED.razon_social,
         monto_neto   = EXCLUDED.monto_neto,
         monto_total  = EXCLUDED.monto_total,
         estado_sii   = EXCLUDED.estado_sii,
         pagado_1     = EXCLUDED.pagado_1,
         pagado_1_at  = EXCLUDED.pagado_1_at,
         pagado_2     = EXCLUDED.pagado_2,
         pagado_2_at  = EXCLUDED.pagado_2_at,
         vcto_1       = EXCLUDED.vcto_1,
         monto_1      = EXCLUDED.monto_1,
         vcto_2       = EXCLUDED.vcto_2,
         monto_2      = EXCLUDED.monto_2,
         updated_at   = NOW()
       RETURNING (xmax = 0) AS inserted`,
      [
        String(d.detCodigo), rut, d.detRznSoc, d.detNroDoc,
        fechaEmision, d.detMntNeto, montoTotal, d.dcvEstadoContab ?? 'REGISTRO',
        monto1, esContado, esContado ? new Date() : null,  // cuota 1
        esContado, prov.dias_2, monto2,                    // cuota 2 (null si contado)
      ]
    );
    r.rows[0].inserted ? insertadas++ : actualizadas++;
  }
  return { insertadas, actualizadas };
}

// ─── SII ──────────────────────────────────────────────────────────────────────

// Mutex: evitar múltiples browsers PDF simultáneos (SII bloquea concurrencia)
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
      // networkidle igual que abrirSesionSII (espera toda la cadena de redirects)
      await Promise.all([
        page.waitForLoadState('networkidle').catch(() => {}),
        page.keyboard.press('Enter'),
      ]);
      // Esperar a salir de zeusr.sii.cl antes de continuar
      await page.waitForURL(u => !u.includes('zeusr.sii.cl'), { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1000);
      const afterUrl = page.url();
      console.log(`[SII login] post-login URL: ${afterUrl}`);
      return; // éxito
    }

    console.warn(`[SII login] intento ${intento}: sin formulario de login`);
    if (intento < 3) await page.waitForTimeout(5000);
  }
  throw new Error('No se pudo encontrar formulario de login SII después de 3 intentos');
}

// Selecciona la empresa en el portal www1 (ignora ERR_ABORTED de redirects JS)
async function seleccionarEmpresa(page) {
  await page.goto('https://www1.sii.cl/cgi-bin/Portal001/mipeSelEmpresa.cgi',
    { waitUntil: 'load', timeout: 30000 }
  ).catch(() => {});
  await page.waitForTimeout(1000);
  if (await page.locator('select[name="RUT_EMP"]').count()) {
    await page.locator('select[name="RUT_EMP"]').selectOption(SII_EMPRESA_RUT);
    await Promise.all([
      page.waitForLoadState('load').catch(() => {}),
      page.locator('[type=submit]').first().click(),
    ]);
    await page.waitForTimeout(1000);
  }
}

async function abrirSesionSII() {
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

  await loginSII(page);
  await seleccionarEmpresa(page);

  await page.goto('https://www4.sii.cl/consdcvinternetui/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  if (!conversationId) {
    await ngSelect(page, 'select[name="rut"]', SII_EMPRESA_RUT);
    await page.waitForTimeout(2000);
  }

  if (!conversationId) throw new Error('No se pudo obtener conversationId de SII');
  return { browser, context, conversationId };
}

// Dado una página que ya muestra el detalle del DTE, hace click en el botón
// de visualización y devuelve el buffer del PDF.
async function clickYDescargarPdf(page) {
  const btnSelector = 'input[value*="VISUALIZACI"], button:has-text("VISUALIZACI"), a:has-text("VISUALIZACI"), input[value*="PDF"], a:has-text("PDF")';
  const [pdfResponse] = await Promise.all([
    page.waitForResponse(r => {
      const ct = r.headers()['content-type'] ?? '';
      return ct.includes('pdf') || r.url().toLowerCase().includes('.pdf') || ct.includes('octet-stream');
    }, { timeout: 30000 }),
    page.locator(btnSelector).first().click(),
  ]);
  return pdfResponse.body();
}

// Intenta navegar al detalle del documento de varias formas.
// Devuelve true si llegamos a una página con botón de PDF.
async function navegarADetalleDte(page, folio, rutEmisor) {
  const [rutNum, dvNum] = rutEmisor.split('-');
  const [empRut, empDv] = SII_EMPRESA_RUT.split('-');
  const folioStr = String(folio);

  // ── Intento 1: URL directa con parámetros conocidos ──────────────────────
  const urlsDirectas = [
    `https://www1.sii.cl/cgi-bin/Portal001/mipeGesDocDet.cgi?TIPO_DOC=33&FOLIO=${folioStr}&RUT_EMISOR=${rutNum}&DV_EMISOR=${dvNum}&RUT_RECEP=${empRut}&DV_RECEP=${empDv}`,
    `https://www1.sii.cl/cgi-bin/Portal001/mipeGesDocDet.cgi?TIPO_DTE=33&NUM_FOLIO=${folioStr}&RUT_EMS=${rutNum}&DV_EMS=${dvNum}`,
    `https://www1.sii.cl/cgi-bin/Portal001/mipeGesDocDet.cgi?RUT_EMISOR=${rutNum}&DV_EMISOR=${dvNum}&FOLIO=${folioStr}&TIPO=33`,
  ];

  for (const url of urlsDirectas) {
    await page.goto(url, { waitUntil: 'load', timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1000);
    const tieneBtn = await page.locator('input[value*="VISUALIZACI"], a:has-text("VISUALIZACI"), input[value*="PDF"]').count();
    if (tieneBtn) {
      console.log(`[PDF] Detalle encontrado via URL directa: ${url}`);
      return true;
    }
  }

  // ── Intento 2: buscar en la lista (sin params GET — el CGI no los acepta) ──
  await page.goto(
    'https://www1.sii.cl/cgi-bin/Portal001/mipeGesDocRcp.cgi',
    { waitUntil: 'load', timeout: 30000 }
  ).catch(e => console.warn('[PDF] goto lista error:', e.message));
  await page.waitForTimeout(2000);

  // Diagnóstico
  const diagTitle = await page.title().catch(() => '?');
  const diagRows  = await page.locator('table tr').count().catch(() => 0);
  console.log(`[PDF] Lista: "${diagTitle}" | ${diagRows} filas | ${page.url()}`);

  // Si hay form con fechas, intentar rellenarlo también
  const desde = page.locator('input[name*="DESDE"], input[name*="desde"], input[id*="desde"]').first();
  if (await desde.count()) {
    const hasta = page.locator('input[name*="HASTA"], input[name*="hasta"], input[id*="hasta"]').first();
    const d2 = new Date(); const d1 = new Date(); d1.setFullYear(d1.getFullYear()-3);
    const fmt2 = d => `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
    await desde.fill(fmt2(d1)).catch(() => {});
    if (await hasta.count()) await hasta.fill(fmt2(d2)).catch(() => {});
    const btnBuscar = page.locator('input[type=submit], button[type=submit]').first();
    if (await btnBuscar.count()) {
      await Promise.all([page.waitForLoadState('load').catch(() => {}), btnBuscar.click()]);
      await page.waitForTimeout(2000);
      const rowsAfter = await page.locator('table tr').count().catch(() => 0);
      console.log(`[PDF] Tras filtro: ${rowsAfter} filas`);
    }
  }

  // Paginar y buscar el folio
  for (let p = 0; p < 30; p++) {
    const filas = page.locator('tr').filter({ hasText: folioStr });
    const count = await filas.count();
    for (let i = 0; i < count; i++) {
      const texto = (await filas.nth(i).textContent() ?? '').replace(/\./g,'');
      if (texto.includes(rutNum)) {
        const href = await filas.nth(i).locator('a').first().getAttribute('href').catch(() => null);
        if (href) {
          const detailUrl = href.startsWith('http') ? href : `https://www1.sii.cl${href}`;
          await page.goto(detailUrl, { waitUntil: 'load', timeout: 20000 }).catch(() => {});
          await page.waitForTimeout(1000);
          const tieneBtn = await page.locator('input[value*="VISUALIZACI"], a:has-text("VISUALIZACI")').count();
          if (tieneBtn) { console.log(`[PDF] Detalle encontrado via lista pág ${p+1}`); return true; }
        }
      }
    }
    const next = page.locator('a').filter({ hasText: /^[>»]$/ }).last();
    if (!await next.count()) break;
    await Promise.all([page.waitForLoadState('load').catch(() => {}), next.click()]);
    await page.waitForTimeout(500);
  }

  return false;
}

// Descarga el PDF de UNA factura
async function descargarPdfSII(folio, rutEmisor) {
  if (pdfEnCurso) throw new Error('Ya hay una descarga de PDF en curso, intenta en unos minutos');
  pdfEnCurso = true;
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' });
  const page    = await context.newPage();

  try {
    await loginSII(page);
    await seleccionarEmpresa(page);

    const encontrado = await navegarADetalleDte(page, folio, rutEmisor);
    if (!encontrado) throw new Error(`Folio ${folio} no encontrado (ni URL directa ni lista SII)`);

    return await clickYDescargarPdf(page);

  } finally {
    pdfEnCurso = false;
    await browser.close();
  }
}

// Descarga PDFs en lote reutilizando una sola sesión SII.
// Usa navegarADetalleDte() por cada factura (URLs directas + fallback lista).
async function descargarPdfsBulkSII() {
  if (pdfEnCurso) {
    console.warn('[PDF bulk] Ya hay una sesión PDF en curso, abortando');
    return { descargadas: 0, errores: 0, total: 0 };
  }
  pdfEnCurso = true;

  const { rows: sinPdf } = await pool.query(
    `SELECT id, folio, rut_emisor FROM facturas_recibidas WHERE pdf_data IS NULL ORDER BY fecha_emision DESC`
  );
  if (!sinPdf.length) { pdfEnCurso = false; return { descargadas: 0, errores: 0, total: 0 }; }

  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  const ctx  = await browser.newContext({ ignoreHTTPSErrors: true, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' });
  const page = await ctx.newPage();
  let descargadas = 0, errores = 0;

  try {
    await loginSII(page);
    await seleccionarEmpresa(page);
    console.log(`[PDF bulk] Sesión lista. Descargando ${sinPdf.length} PDFs...`);

    for (const f of sinPdf) {
      try {
        const encontrado = await navegarADetalleDte(page, f.folio, f.rut_emisor);
        if (!encontrado) throw new Error('no encontrado en SII');

        const buf    = await clickYDescargarPdf(page);
        const nombre = `factura_${f.folio}_${f.rut_emisor}.pdf`;
        await pool.query(
          `UPDATE facturas_recibidas SET pdf_data=$1, pdf_nombre=$2, pdf_at=NOW(), updated_at=NOW() WHERE id=$3`,
          [buf, nombre, f.id]
        );
        descargadas++;
        console.log(`[PDF bulk] ✓ Folio ${f.folio} (${descargadas}/${sinPdf.length})`);
      } catch (err) {
        errores++;
        console.error(`[PDF bulk] ✗ Folio ${f.folio}: ${err.message}`);
      }
    }
  } finally {
    pdfEnCurso = false;
    await browser.close();
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
    if (pdfEnCurso) return res.json({ ok: false, mensaje: 'Ya hay una descarga de PDFs en curso', pendientes: 0 });

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
  if (pdfEnCurso) return res.status(409).json({ error: 'PDF en curso, espera' });
  const { rows } = await pool.query(
    `SELECT id, folio, rut_emisor FROM facturas_recibidas WHERE folio=$1 LIMIT 1`,
    [req.params.folio]
  );
  if (!rows.length) return res.status(404).json({ error: 'Folio no encontrado en DB' });
  const f = rows[0];
  try {
    const buf = await descargarPdfSII(f.folio, f.rut_emisor);
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
  } finally { await sesion.browser.close(); }

  res.json({ ok: true, meses: resultado });
});

app.post('/api/sync/historico', async (req, res) => {
  const actual = mesActual();
  const desde  = req.query.desde ?? req.body?.desde ?? (() => {
    const d = new Date(); d.setFullYear(d.getFullYear()-2);
    return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}`;
  })();

  const { rows } = await pool.query('SELECT mes FROM meses_sincronizados');
  const sincronizados = new Set(rows.map(r => r.mes));
  const pendientes = rangoDeMeses(desde, actual).filter(m => m === actual || !sincronizados.has(m));

  if (!pendientes.length) return res.json({ ok: true, mensaje: 'Todo ya sincronizado' });

  res.json({ ok: true, mensaje: `Sincronizando ${pendientes.length} meses en background...`, meses: pendientes });

  let sesion;
  try {
    sesion = await abrirSesionSII();
    for (const mes of pendientes) {
      const docs = await getFacturasMes(sesion.context, sesion.conversationId, mes);
      await upsertFacturas(docs);
      await pool.query(
        `INSERT INTO meses_sincronizados (mes,total) VALUES ($1,$2) ON CONFLICT (mes) DO UPDATE SET total=$2, synced_at=NOW()`,
        [mes, docs.length]
      );
      console.log(`[historico] ${mes}: ${docs.length} facturas`);
    }
    console.log('[historico] Completado');
  } catch (err) { console.error('[historico] Error:', err.message); }
  finally { sesion?.browser.close(); }
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
