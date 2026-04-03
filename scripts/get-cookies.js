/**
 * Script local: captura sesión SII con Playwright y la sube a Railway.
 *
 * Uso:
 *   npm run sync
 *   — o —
 *   RAILWAY_URL=https://tu-app.railway.app node scripts/get-cookies.js
 *
 * Variables de entorno necesarias (en .env local o en el sistema):
 *   SII_RUT          — RUT personal, ej: 17311783-3
 *   SII_PASSWORD     — Clave SII
 *   SII_EMPRESA_RUT  — RUT empresa, ej: 78015129-3
 *   RAILWAY_URL      — URL de tu app en Railway
 *   SYNC_SECRET      — (opcional) mismo valor que en Railway, default: bioma-sync-2024
 */

require('dotenv').config();
const { chromium } = require('playwright');
const https = require('https');

const RUT        = process.env.SII_RUT;
const PASSWORD   = process.env.SII_PASSWORD;
const EMPRESA    = process.env.SII_EMPRESA_RUT;
const RAILWAY_URL = process.env.RAILWAY_URL || 'https://pago-facturas-app-production.up.railway.app';
const SECRET     = process.env.SYNC_SECRET || 'bioma-sync-2024';

if (!RUT || !PASSWORD || !EMPRESA) {
  console.error('❌ Faltan variables de entorno: SII_RUT, SII_PASSWORD, SII_EMPRESA_RUT');
  process.exit(1);
}

function parseRut(r) {
  const clean = r.replace(/\./g, '').replace(/\s/g, '').toUpperCase();
  const parts = clean.split('-');
  return { rut: parts[0], dv: parts[1] || '' };
}

async function run() {
  console.log('🚀 Iniciando Playwright...');
  const browser = await chromium.launch({
    headless: false, // visible para que puedas ver qué pasa
    slowMo: 100,
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: { 'Accept-Language': 'es-CL,es;q=0.9' },
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();

  // Loguear todas las llamadas al RCV para diagnóstico
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('consdcvinternetui/services') || url.includes('facadeService')) {
      const text = await response.text().catch(() => '');
      console.log(`  📡 ${url.split('/').pop()} [${response.status()}]: ${text.substring(0, 200)}`);
    }
  });

  try {
    // ── Paso 1: Login ─────────────────────────────────────────────────────────
    console.log('\n📋 Paso 1: Login SII...');
    await page.goto(
      'https://zeusr.sii.cl//AUT2000/InicioAutenticacion/IngresoRutClave.html?https://misiir.sii.cl/cgi_misii/siihome.cgi',
      { waitUntil: 'domcontentloaded', timeout: 30000 }
    );

    await page.waitForSelector('#rutcntr', { timeout: 15000 });
    await page.fill('#rutcntr', RUT);
    await page.fill('#clave', PASSWORD);

    await Promise.all([
      page.waitForLoadState('networkidle'),
      page.click('[type=submit]'),
    ]);

    const loginUrl = page.url();
    console.log(`   URL post-login: ${loginUrl}`);
    if (loginUrl.includes('IngresoRut') || loginUrl.includes('rutcntr')) {
      throw new Error('Login SII fallido: credenciales incorrectas');
    }
    console.log('   ✅ Login exitoso');

    // ── Paso 2: Selección empresa ──────────────────────────────────────────────
    console.log('\n🏢 Paso 2: Selección empresa...');
    await page.goto(
      'https://www1.sii.cl/cgi-bin/Portal001/mipeSelEmpresa.cgi',
      { waitUntil: 'domcontentloaded', timeout: 30000 }
    );

    const { rut: empRut } = parseRut(EMPRESA);
    const selectCount = await page.locator('select').count();

    if (selectCount > 0) {
      const options = await page.evaluate(() =>
        Array.from(document.querySelector('select')?.options || [])
          .map(o => ({ value: o.value, text: o.text.trim() }))
      );
      console.log(`   Opciones: ${JSON.stringify(options)}`);

      const target = options.find(o =>
        o.value === EMPRESA || o.value === empRut ||
        o.value.includes(empRut) || o.text.includes(empRut)
      ) || options[0];

      if (target) {
        await page.selectOption('select', target.value);
        console.log(`   Empresa seleccionada: ${target.value} — ${target.text}`);
        const btnCount = await page.locator('[type=submit]').count();
        if (btnCount > 0) {
          await Promise.all([
            page.waitForLoadState('networkidle').catch(() => {}),
            page.click('[type=submit]'),
          ]);
        }
      }
    } else {
      console.log('   Sin select (empresa única o auto-seleccionada)');
    }
    console.log(`   URL post-empresa: ${page.url()}`);

    // ── Paso 3: Portal RCV ─────────────────────────────────────────────────────
    console.log('\n📊 Paso 3: Navegando a portal RCV (www4.sii.cl)...');
    await page.goto(
      'https://www4.sii.cl/consdcvinternetui/',
      { waitUntil: 'networkidle', timeout: 45000 }
    );

    // Esperar que el AngularJS app inicialice completamente
    console.log('   Esperando que Angular inicialice (8 seg)...');
    await page.waitForTimeout(8000);

    const title = await page.title();
    const url = page.url();
    console.log(`   Título: ${title}`);
    console.log(`   URL: ${url}`);

    // Verificar si hay selección de empresa/representado en www4
    const selectsInWww4 = await page.locator('select').count();
    if (selectsInWww4 > 0) {
      const opts = await page.evaluate(() =>
        Array.from(document.querySelector('select')?.options || [])
          .map(o => ({ v: o.value, t: o.text.trim() }))
      );
      console.log(`   Select en www4: ${JSON.stringify(opts)}`);
      const tgt = opts.find(o => o.v.includes(empRut) || o.t.includes(empRut));
      if (tgt) {
        await page.evaluate((v) => {
          const sel = document.querySelector('select');
          sel.value = v;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }, tgt.v);
        console.log(`   ✅ Empresa en www4: ${tgt.v}`);
        await page.waitForTimeout(3000);
      }
    }

    // ── Paso 4: Capturar y enviar cookies ─────────────────────────────────────
    const allCookies = await context.cookies();
    console.log(`\n🍪 Cookies capturadas (${allCookies.length}):`);
    allCookies.forEach(c => console.log(`   ${c.name} [${c.domain}]`));

    const cookieStr = allCookies.map(c => `${c.name}=${c.value}`).join('; ');

    console.log(`\n📤 Enviando cookies a Railway (${RAILWAY_URL})...`);
    const payload = JSON.stringify({ cookies: cookieStr, secret: SECRET });

    const response = await fetch(`${RAILWAY_URL}/api/set-cookies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });

    const result = await response.json();
    if (response.ok) {
      console.log(`✅ ${result.message}`);
      console.log('\n🎉 Listo. Ahora puedes clicar "Sincronizar SII" en la app.');
    } else {
      console.error(`❌ Error de Railway: ${result.error}`);
    }

  } catch (err) {
    console.error('\n❌ Error:', err.message);
    // Si falló, dejar el browser abierto para diagnóstico
    console.log('Browser abierto para diagnóstico. Ciérralo manualmente cuando termines.');
    await new Promise(r => setTimeout(r, 30000));
  } finally {
    await browser.close();
  }
}

run().catch(console.error);
