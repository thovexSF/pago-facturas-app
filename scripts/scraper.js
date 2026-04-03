require('dotenv').config();
const { chromium } = require('playwright');
const axios = require('axios');

const { SII_RUT, SII_PASSWORD, SII_EMPRESA_RUT, RAILWAY_URL } = process.env;
const [EMPRESA_RUT, EMPRESA_DV] = SII_EMPRESA_RUT.split('-');

async function ngSelect(page, selector, value) {
  await page.evaluate(({ sel, val }) => {
    const el = document.querySelector(sel);
    el.value = val;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, { sel: selector, val: value });
}

async function getFacturas(context, conversationId, ptributario) {
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
  return res.json();
}

async function scrape() {
  const mes = process.argv[2] ?? '202603'; // ej: node scraper.js 202604

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page    = await context.newPage();

  // Capturar conversationId real (string largo, no número pequeño)
  let conversationId = null;
  page.on('response', async res => {
    if (res.url().includes('consdcvinternetui/services')) {
      const json = await res.json().catch(() => null);
      const cid  = json?.metaData?.conversationId;
      if (cid && String(cid).length > 5 && !conversationId) {
        conversationId = String(cid);
        console.log('conversationId:', conversationId);
      }
    }
  });

  // ── Login ──────────────────────────────────────────────────────────────
  await page.goto('https://zeusr.sii.cl//AUT2000/InicioAutenticacion/IngresoRutClave.html?https://misiir.sii.cl/cgi_misii/siihome.cgi');
  await page.fill('#rutcntr', SII_RUT);
  await page.fill('#clave',   SII_PASSWORD);
  await Promise.all([page.waitForLoadState('networkidle'), page.keyboard.press('Enter')]);

  // ── Seleccionar empresa ────────────────────────────────────────────────
  await page.goto('https://www1.sii.cl/cgi-bin/Portal001/mipeSelEmpresa.cgi');
  if (await page.locator('select[name="RUT_EMP"]').count()) {
    await page.locator('select[name="RUT_EMP"]').selectOption(SII_EMPRESA_RUT);
    await Promise.all([
      page.waitForLoadState('networkidle').catch(() => {}),
      page.locator('[type=submit]').first().click(),
    ]);
  }

  // ── RCV — esperar que Angular inicialice ───────────────────────────────
  await page.goto('https://www4.sii.cl/consdcvinternetui/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  if (!conversationId) {
    await ngSelect(page, 'select[name="rut"]', SII_EMPRESA_RUT);
    await page.waitForTimeout(2000);
  }

  if (!conversationId) {
    console.error('ERROR: No se pudo obtener conversationId');
    await browser.close();
    return;
  }

  // ── Obtener facturas ───────────────────────────────────────────────────
  console.log(`\nConsultando ${mes.slice(4)}/${mes.slice(0, 4)}...`);
  const result = await getFacturas(context, conversationId, mes);
  const docs   = Array.isArray(result?.data) ? result.data : [];
  console.log(`${docs.length} facturas encontradas`);

  await browser.close();

  if (!docs.length) {
    console.log('Nada que sincronizar.');
    return;
  }

  // ── Enviar a Railway ───────────────────────────────────────────────────
  const url = (RAILWAY_URL ?? 'http://localhost:3000').replace(/\/$/, '');
  console.log(`\nSincronizando con ${url}...`);
  const { data } = await axios.post(`${url}/api/sync`, { facturas: docs });
  console.log(`✓ ${data.insertadas} nuevas, ${data.actualizadas} actualizadas`);
}

scrape().catch(console.error);
