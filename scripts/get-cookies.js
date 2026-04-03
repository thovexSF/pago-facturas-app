/**
 * SCRIPT DE INVESTIGACIÓN LOCAL — SII RCV
 *
 * Objetivo: entender exactamente qué cookies y requests necesita
 * el portal RCV para devolver datos, para luego implementarlo en Railway.
 *
 * Uso:
 *   node scripts/get-cookies.js
 *
 * Requiere en .env:
 *   SII_RUT=17311783-3
 *   SII_PASSWORD=tu_clave
 *   SII_EMPRESA_RUT=78015129-3
 */

require('dotenv').config();
const { chromium } = require('playwright');

const RUT      = process.env.SII_RUT;
const PASSWORD = process.env.SII_PASSWORD;
const EMPRESA  = process.env.SII_EMPRESA_RUT;

if (!RUT || !PASSWORD || !EMPRESA) {
  console.error('Faltan variables: SII_RUT, SII_PASSWORD, SII_EMPRESA_RUT en .env');
  process.exit(1);
}

function parseRut(r) {
  const clean = r.replace(/\./g, '').toUpperCase();
  const [rut, dv = ''] = clean.split('-');
  return { rut, dv };
}

async function run() {
  const browser = await chromium.launch({ headless: false, slowMo: 80 });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: { 'Accept-Language': 'es-CL,es;q=0.9' },
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();

  // ── Capturar TODOS los requests/responses de www4.sii.cl ─────────────────
  page.on('request', req => {
    const url = req.url();
    if (url.includes('www4.sii.cl')) {
      console.log(`\n→ REQUEST ${req.method()} ${url}`);
      if (req.method() === 'POST') {
        const body = req.postData();
        if (body) console.log(`  BODY: ${body.substring(0, 400)}`);
      }
    }
  });

  page.on('response', async res => {
    const url = res.url();
    if (url.includes('www4.sii.cl')) {
      const text = await res.text().catch(() => '');
      console.log(`← RESPONSE ${res.status()} ${url}`);
      console.log(`  BODY: ${text.substring(0, 400)}`);
    }
  });

  try {
    // ── Paso 1: Login ────────────────────────────────────────────────────────
    console.log('\n=== PASO 1: LOGIN ===');
    await page.goto(
      'https://zeusr.sii.cl//AUT2000/InicioAutenticacion/IngresoRutClave.html?https://misiir.sii.cl/cgi_misii/siihome.cgi',
      { waitUntil: 'domcontentloaded', timeout: 30000 }
    );
    await page.waitForSelector('#rutcntr');
    await page.fill('#rutcntr', RUT);
    await page.fill('#clave', PASSWORD);
    await Promise.all([
      page.waitForLoadState('networkidle'),
      page.click('[type=submit]'),
    ]);
    console.log(`URL post-login: ${page.url()}`);

    await logCookies(context, 'POST-LOGIN');

    // ── Paso 2: Selección empresa ─────────────────────────────────────────────
    console.log('\n=== PASO 2: SELECCIÓN EMPRESA ===');
    await page.goto('https://www1.sii.cl/cgi-bin/Portal001/mipeSelEmpresa.cgi', {
      waitUntil: 'domcontentloaded', timeout: 30000
    });

    const { rut: empRut } = parseRut(EMPRESA);
    if (await page.locator('select').count() > 0) {
      const options = await page.evaluate(() =>
        Array.from(document.querySelector('select').options).map(o => ({ value: o.value, text: o.text.trim() }))
      );
      console.log('Opciones:', JSON.stringify(options, null, 2));

      const target = options.find(o =>
        o.value === EMPRESA || o.value === empRut || o.value.includes(empRut)
      ) || options[0];

      if (target) {
        await page.selectOption('select', target.value);
        console.log(`Seleccionada: ${target.value}`);
        if (await page.locator('[type=submit]').count() > 0) {
          await Promise.all([
            page.waitForLoadState('networkidle').catch(() => {}),
            page.click('[type=submit]'),
          ]);
        }
      }
    } else {
      console.log('Sin select de empresa');
    }

    console.log(`URL post-empresa: ${page.url()}`);
    await logCookies(context, 'POST-EMPRESA');

    // ── Paso 3: Portal RCV ────────────────────────────────────────────────────
    console.log('\n=== PASO 3: PORTAL RCV www4.sii.cl ===');
    await page.goto('https://www4.sii.cl/consdcvinternetui/', {
      waitUntil: 'networkidle', timeout: 45000
    });

    console.log('Esperando que Angular inicialice (10 seg)...');
    await page.waitForTimeout(10000);

    console.log(`URL final RCV: ${page.url()}`);
    console.log(`Título: ${await page.title()}`);
    await logCookies(context, 'POST-RCV');

    // ── Mostrar HTML de www4 para inspección ──────────────────────────────────
    const bodyHtml = await page.evaluate(() => document.body.innerHTML.substring(0, 2000));
    console.log('\n=== HTML www4 (primeros 2000 chars) ===');
    console.log(bodyHtml);

    // ── Dejar browser abierto para inspección manual ──────────────────────────
    console.log('\n\n========================================');
    console.log('Browser abierto para inspección manual.');
    console.log('Navega manualmente a Documentos Recibidos');
    console.log('y observa los logs de REQUEST/RESPONSE arriba.');
    console.log('Presiona Ctrl+C cuando termines.');
    console.log('========================================\n');

    // Esperar indefinidamente hasta que el usuario cierre
    await new Promise(() => {});

  } catch (err) {
    console.error('\nError:', err.message);
    await new Promise(r => setTimeout(r, 20000));
  } finally {
    await browser.close();
  }
}

async function logCookies(context, label) {
  const cookies = await context.cookies();
  console.log(`\n--- COOKIES en ${label} (${cookies.length}) ---`);
  for (const c of cookies) {
    console.log(`  ${c.name}=${c.value.substring(0, 60)}... [domain: ${c.domain}]`);
  }
}

run().catch(console.error);
