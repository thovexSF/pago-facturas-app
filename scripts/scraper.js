/**
 * Scraper SII — Facturas Recibidas
 *
 * Uso: node scripts/scraper.js
 * Requiere en .env: SII_RUT, SII_PASSWORD, SII_EMPRESA_RUT
 */

require('dotenv').config();
const { chromium } = require('playwright');
const axios = require('axios');

const { SII_RUT, SII_PASSWORD, SII_EMPRESA_RUT } = process.env;
const [EMPRESA_NUM, EMPRESA_DV] = SII_EMPRESA_RUT.replace(/\./g, '').split('-');

async function scrape() {
  // ── 1. Obtener sesión www4 via Playwright ────────────────────────────────
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page    = await context.newPage();

  // Login
  await page.goto('https://zeusr.sii.cl//AUT2000/InicioAutenticacion/IngresoRutClave.html?https://misiir.sii.cl/cgi_misii/siihome.cgi');
  await page.fill('#rutcntr', SII_RUT);
  await page.fill('#clave',   SII_PASSWORD);
  await Promise.all([page.waitForLoadState('networkidle'), page.click('[type=submit]')]);

  // Seleccionar empresa
  await page.goto('https://www1.sii.cl/cgi-bin/Portal001/mipeSelEmpresa.cgi');
  if (await page.locator('select').count()) {
    await page.selectOption('select', EMPRESA_NUM);
    await Promise.all([page.waitForLoadState('networkidle').catch(() => {}), page.click('[type=submit]')]);
  }

  // Navegar al RCV para establecer sesión Angular
  await page.goto('https://www4.sii.cl/consdcvinternetui/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(5000);

  const cookies = (await context.cookies()).map(c => `${c.name}=${c.value}`).join('; ');
  await browser.close();

  // ── 2. Consultar API RCV con las cookies capturadas ──────────────────────
  const facturas = [];
  const hoy = new Date();

  for (let mes = 0; mes < 3; mes++) {
    const d = new Date(hoy.getFullYear(), hoy.getMonth() - mes, 1);
    const periodo = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;

    for (const tipo of ['33', '34']) {
      const { data } = await axios.post(
        'https://www4.sii.cl/consdcvinternetui/services/data/facadeService/getDetalleCompra',
        {
          metaData: { namespace: 'cl.sii.sdi.lob.diii.consdcv.data.api.interfaces.FacadeService/getDetalleCompra', conversationId: 'scraper', transactionId: '0', page: null },
          data:     { ptributario: periodo, operacion: 'COMPRA', estadoContab: 'REGISTRO', codTipoDoc: tipo, accionRecaptcha: 'RCV_DETC', tokenRecaptcha: 'c3' },
        },
        { headers: { Cookie: cookies, 'Content-Type': 'application/json', Accept: '*/*', Referer: 'https://www4.sii.cl/consdcvinternetui/', Origin: 'https://www4.sii.cl' } }
      );

      const lista = data?.data?.listaDetalle ?? [];
      console.log(`${periodo}/${tipo}: ${lista.length} docs | ${JSON.stringify(data?.respEstado ?? data?.metaData?.errors)}`);
      facturas.push(...lista);
    }
  }

  console.log(`\nTotal: ${facturas.length} facturas`);
  if (facturas.length) console.log('Ejemplo:', JSON.stringify(facturas[0], null, 2));
  return facturas;
}

scrape().catch(console.error);
