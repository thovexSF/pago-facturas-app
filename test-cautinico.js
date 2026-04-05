/**
 * test-cautinico.js
 * Prueba el auth flow directo via CAutInicio.cgi (sin browser).
 * Fuente: lenguajedemaquinas.blogspot.com — reverse-engineering Portal001 SII
 *
 * Uso: node test-cautinico.js
 */

require('dotenv').config();
const axios = require('axios');

const { SII_RUT, SII_PASSWORD, SII_EMPRESA_RUT } = process.env;

if (!SII_RUT || !SII_PASSWORD || !SII_EMPRESA_RUT) {
  console.error('❌ Faltan variables de entorno: SII_RUT, SII_PASSWORD, SII_EMPRESA_RUT');
  process.exit(1);
}

const [EMPRESA_RUT] = SII_EMPRESA_RUT.split('-');
const [rutNum, dv]  = SII_RUT.replace(/\./g, '').split('-');

console.log(`\n📋 Config:`);
console.log(`   SII_RUT       = ${SII_RUT}  → rut=${rutNum} dv=${dv}`);
console.log(`   SII_EMPRESA   = ${SII_EMPRESA_RUT}  → rutcntr=${EMPRESA_RUT}`);
console.log(`   SII_PASSWORD  = ${'*'.repeat(SII_PASSWORD.length)}\n`);

// ─── PASO 1: GET directo a CAutInicio.cgi ─────────────────────────────────────

async function paso1_cautinico() {
  console.log('─── PASO 1: GET CAutInicio.cgi ──────────────────────────────────');

  const REFERENCIA = 'https://www1.sii.cl/cgi-bin/Portal001/mipeSelEmpresa.cgi';

  const qs = new URLSearchParams({
    rutcntr:   EMPRESA_RUT,
    rut:       rutNum,
    dv,
    clave:     SII_PASSWORD,
    referencia: REFERENCIA,
  }).toString();

  const url = `https://zeusr.sii.cl/cgi_AUT2000/CAutInicio.cgi?${qs}`;
  console.log(`URL: ${url.replace(SII_PASSWORD, '***')}\n`);

  let resp;
  try {
    resp = await axios.get(url, {
      maxRedirects: 0,
      validateStatus: () => true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
    });
  } catch (err) {
    if (err.response) resp = err.response;
    else { console.error('❌ Error de red:', err.message); return null; }
  }

  console.log(`Status: ${resp.status}`);
  console.log(`Location: ${resp.headers['location'] ?? '(ninguna)'}`);

  const rawCookies = [].concat(resp.headers['set-cookie'] ?? []);
  console.log(`\nSet-Cookie (${rawCookies.length} cookies):`);
  rawCookies.forEach(c => console.log(`  ${c}`));

  if (!rawCookies.length) {
    console.error('\n❌ No se recibieron cookies — credenciales incorrectas o parámetros erróneos');
    // Mostrar primeros 500 chars del body para diagnóstico
    const body = typeof resp.data === 'string' ? resp.data.slice(0, 500) : JSON.stringify(resp.data).slice(0, 500);
    console.log(`\nBody (primeros 500 chars):\n${body}`);
    return null;
  }

  // Parsear cookies
  const cookies = rawCookies.map(h => {
    const parts   = h.split(';').map(s => s.trim());
    const eqIdx   = parts[0].indexOf('=');
    const name    = parts[0].slice(0, eqIdx).trim();
    const value   = parts[0].slice(eqIdx + 1).trim();
    const domPart = parts.find(p => /^domain=/i.test(p));
    const path    = (parts.find(p => /^path=/i.test(p)) ?? '').split('=')[1]?.trim() ?? '/';
    const domain  = domPart ? domPart.split('=')[1].trim() : '.sii.cl';
    return { name, value, domain, path };
  });

  console.log(`\n✅ Cookies parseadas: ${cookies.map(c => `${c.name}=${c.value.slice(0,12)}…`).join(', ')}`);
  return cookies;
}

// ─── PASO 2: Usar las cookies para acceder a mipeSelEmpresa.cgi ───────────────

async function paso2_selEmpresa(cookies) {
  console.log('\n─── PASO 2: GET mipeSelEmpresa.cgi con cookies ──────────────────');

  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const url = 'https://www1.sii.cl/cgi-bin/Portal001/mipeSelEmpresa.cgi';

  let resp;
  try {
    resp = await axios.get(url, {
      maxRedirects: 0,
      validateStatus: () => true,
      headers: {
        'Cookie': cookieHeader,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': 'https://zeusr.sii.cl/cgi_AUT2000/CAutInicio.cgi',
      },
    });
  } catch (err) {
    console.error('❌ Error:', err.message);
    return null;
  }

  console.log(`Status: ${resp.status}`);
  console.log(`Location: ${resp.headers['location'] ?? '(ninguna)'}`);
  console.log(`Content-Type: ${resp.headers['content-type'] ?? '?'}`);

  const body = typeof resp.data === 'string' ? resp.data : '';
  const hasRutEmp = body.includes('RUT_EMP') || body.includes('name="RUT_EMP"');
  console.log(`¿Tiene select RUT_EMP?: ${hasRutEmp ? '✅ SÍ' : '❌ NO'}`);

  if (resp.status >= 300 && resp.status < 400) {
    console.log(`\n⚠️  Redirige a: ${resp.headers['location']}`);
    return { status: resp.status, redirectTo: resp.headers['location'] };
  }

  if (hasRutEmp) {
    // Extraer opciones del select
    const opts = [...body.matchAll(/value="([^"]+)"[^>]*>([^<]*)/g)]
      .filter(m => m[1].match(/^\d{7,8}-\d$/))
      .map(m => m[1]);
    console.log(`\nOpciones RUT_EMP encontradas: ${opts.join(', ')}`);

    // Verificar que SII_EMPRESA_RUT está entre las opciones
    const match = opts.find(o => o === SII_EMPRESA_RUT);
    console.log(`¿SII_EMPRESA_RUT (${SII_EMPRESA_RUT}) en opciones?: ${match ? '✅ SÍ' : '❌ NO (verificar env var)'}`);
  }

  return { status: resp.status, hasForm: hasRutEmp };
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function parseCookieHeaders(rawList) {
  return rawList.map(h => {
    const parts   = h.split(';').map(s => s.trim());
    const eqIdx   = parts[0].indexOf('=');
    const name    = parts[0].slice(0, eqIdx).trim();
    const value   = parts[0].slice(eqIdx + 1).trim();
    const domPart = parts.find(p => /^domain=/i.test(p));
    const path    = (parts.find(p => /^path=/i.test(p)) ?? '').split('=')[1]?.trim() ?? '/';
    const domain  = domPart ? domPart.split('=')[1].trim() : '.sii.cl';
    return { name, value, domain, path };
  }).filter(c => c.value && c.value !== 'DEL' && !c.name.startsWith('path='));
}

function mergeCookies(base, extra) {
  const map = new Map(base.map(c => [c.name, c]));
  for (const c of extra) map.set(c.name, c);
  return [...map.values()];
}

function cookieHeader(cookies) {
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

// ─── PASO 3: POST selección de empresa ────────────────────────────────────────

async function paso3_postEmpresa(cookies) {
  console.log('\n─── PASO 3: POST selección empresa en mipeSelEmpresa.cgi ─────────');

  // Primero GET para obtener el csrt del form action
  const ch = cookieHeader(cookies);
  const getResp = await axios.get('https://www1.sii.cl/cgi-bin/Portal001/mipeSelEmpresa.cgi', {
    maxRedirects: 5, validateStatus: () => true,
    headers: { 'Cookie': ch, 'User-Agent': 'Mozilla/5.0' },
  }).catch(e => ({ data: '' }));

  const body  = typeof getResp.data === 'string' ? getResp.data : '';
  // Probar múltiples patrones para extraer csrt
  const csrtM = body.match(/action="[^"]*[?&]csrt=([^"&\s]+)"/i)
             || body.match(/[?&]csrt=([^"&\s]+)/i)
             || body.match(/csrt['":\s=]+([a-zA-Z0-9_-]{8,})/i);
  const csrt  = csrtM ? csrtM[1] : '';
  console.log(`csrt extraído del form action: ${csrt || '(no encontrado)'}`);
  // Mostrar el form action completo para diagnóstico
  const formActionM = body.match(/action="([^"]*mipeSelEmpresa[^"]*)"/i);
  if (formActionM) console.log(`Form action encontrado: ${formActionM[1]}`);
  else {
    const anyAction = body.match(/action="([^"]+)"/i);
    console.log(`Primer form action: ${anyAction ? anyAction[1] : '(ninguno)'}`);
  }

  const postUrl = `https://www1.sii.cl/cgi-bin/Portal001/mipeSelEmpresa.cgi${csrt ? `?csrt=${csrt}` : ''}`;
  console.log(`POST → ${postUrl}`);

  let resp;
  try {
    resp = await axios.post(postUrl,
      new URLSearchParams({ RUT_EMP: SII_EMPRESA_RUT }).toString(),
      {
        maxRedirects: 0, validateStatus: () => true,
        headers: {
          'Cookie': ch,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': 'https://www1.sii.cl/cgi-bin/Portal001/mipeSelEmpresa.cgi',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      }
    );
  } catch (err) { console.error('❌', err.message); return { cookies, csrt }; }

  const postBody = typeof resp.data === 'string' ? resp.data : '';
  console.log(`Status: ${resp.status}`);
  console.log(`Location: ${resp.headers['location'] ?? '(ninguna)'}`);
  const rawNew = [].concat(resp.headers['set-cookie'] ?? []);
  const newParsed = parseCookieHeaders(rawNew);
  if (newParsed.length) console.log(`Nuevas cookies: ${newParsed.map(c => `${c.name}=${c.value.slice(0,15)}`).join(' | ')}`);

  // Meta refresh en el body?
  const metaM = postBody.match(/content=["'][^"']*url=([^"'\s]+)/i);
  if (metaM) console.log(`Meta-refresh → ${metaM[1]}`);
  console.log(`Body POST resp completo (${postBody.length} chars):\n${postBody}`);

  // Combinar cookies
  const allCookies = mergeCookies(cookies, newParsed);
  console.log(`Total cookies tras selección: ${allCookies.map(c => c.name).join(', ')}`);

  return { cookies: allCookies, csrt, location: resp.headers['location'], postBody };
}

// ─── PASO 3b: GET mipeSelEmpresa.cgi POST-selección (para capturar csrt) ──────

async function paso3b_getSelEmpresaPostSelect(cookies) {
  console.log('\n─── PASO 3b: GET mipeSelEmpresa.cgi post-selección (captura csrt) ─');

  const ch = cookieHeader(cookies);
  let resp;
  try {
    resp = await axios.get('https://www1.sii.cl/cgi-bin/Portal001/mipeSelEmpresa.cgi', {
      maxRedirects: 3, validateStatus: () => true,
      headers: { 'Cookie': ch, 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www1.sii.cl/factura_sii/factura_sii.htm' },
    });
  } catch (err) { console.error('❌', err.message); return ''; }

  const body = typeof resp.data === 'string' ? resp.data : '';
  const finalUrl = resp.request?.res?.responseUrl ?? resp.config?.url ?? '?';
  console.log(`Status: ${resp.status} | URL final: ${finalUrl}`);

  // Buscar csrt numérico en form action
  const csrtNumM = body.match(/[?&]csrt=(\d{10,})/);
  if (csrtNumM) {
    console.log(`✅ csrt NUMÉRICO encontrado: ${csrtNumM[1]}`);
    return csrtNumM[1];
  }
  // Buscar cualquier csrt
  const csrtAnyM = body.match(/[?&]csrt=([^"&\s]+)/i);
  if (csrtAnyM) {
    console.log(`✅ csrt encontrado: ${csrtAnyM[1]}`);
    return csrtAnyM[1];
  }

  // Mostrar form actions
  const actions = [...body.matchAll(/action="([^"]+)"/gi)].map(m => m[1]);
  console.log(`Form actions encontrados: ${actions.join(' | ') || '(ninguno)'}`);

  // Buscar window["_csrf_"]
  const wcsrfM = body.match(/window\["_csrf_"\]\s*=\s*"([^"]+)"/);
  if (wcsrfM) console.log(`window["_csrf_"] = ${wcsrfM[1].slice(0, 30)}…`);

  console.log('❌ No se encontró csrt numérico');
  return '';
}

// ─── PASO 4: GET mipeAdminDocsRcp.cgi con cookies completas ──────────────────

async function paso4_adminDocs(cookies, csrt = '', referer = '') {
  console.log('\n─── PASO 4: GET mipeAdminDocsRcp.cgi (cookies combinadas) ────────');

  const csrtParam = csrt ? `&csrt=${csrt}` : '';
  const url = `https://www1.sii.cl/cgi-bin/Portal001/mipeAdminDocsRcp.cgi?RUT_EMI=&FOLIO=&RZN_SOC=&FEC_DESDE=&FEC_HASTA=&TPO_DOC=33&ESTADO=&ORDEN=${csrtParam}`;
  console.log(`URL: ${url}`);
  console.log(`Cookies enviadas: ${cookies.map(c => c.name).join(', ')}`);

  let resp;
  try {
    resp = await axios.get(url, {
      maxRedirects: 0, validateStatus: () => true,
      headers: {
        'Cookie': cookieHeader(cookies),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': referer || 'https://www1.sii.cl/cgi-bin/Portal001/mipeSelEmpresa.cgi',
      },
    });
  } catch (err) { console.error('❌', err.message); return; }

  const body = typeof resp.data === 'string' ? resp.data : '';
  console.log(`Status: ${resp.status}`);
  console.log(`Location: ${resp.headers['location'] ?? '(ninguna)'}`);
  console.log(`Tamaño body: ${body.length} chars`);
  const title = (body.match(/<title>([^<]*)<\/title>/i) ?? [])[1] ?? '?';
  console.log(`Título: "${title}"`);
  const hasTable = /\<table/i.test(body);
  const hasForm  = /mipeAdminDocsRcp|RUT_EMI/i.test(body);
  console.log(`¿Tiene tabla?: ${hasTable ? '✅ SÍ' : '❌ NO'} | ¿Tiene form docs?: ${hasForm ? '✅ SÍ' : '❌ NO'}`);
  if (!hasTable) console.log(`\nBody (primeros 800 chars):\n${body.slice(0, 800)}`);
}

// ─── PASO 4b: intentar vía factura_sii.htm (landing post-selección) ──────────

async function paso4b_viaFacturaSii(cookies) {
  console.log('\n─── PASO 4b: GET factura_sii.htm → buscar link a mipeAdminDocsRcp ─');

  const url = 'https://www1.sii.cl/factura_sii/factura_sii.htm';
  let resp;
  try {
    resp = await axios.get(url, {
      maxRedirects: 3, validateStatus: () => true,
      headers: { 'Cookie': cookieHeader(cookies), 'User-Agent': 'Mozilla/5.0' },
    });
  } catch (err) { console.error('❌', err.message); return; }

  const body = typeof resp.data === 'string' ? resp.data : '';
  console.log(`Status: ${resp.status} | Tamaño: ${body.length} chars`);
  const title = (body.match(/<title>([^<]*)<\/title>/i) ?? [])[1] ?? '?';
  console.log(`Título: "${title}"`);

  // Links a mipeAdminDocsRcp
  const adminLinks = [...body.matchAll(/href="([^"]*mipeAdminDocsRcp[^"]*)"/gi)].map(m => m[1]);
  if (adminLinks.length) {
    console.log(`\n✅ Links a mipeAdminDocsRcp encontrados:`);
    adminLinks.forEach(l => console.log(`  ${l}`));
  } else {
    console.log('❌ Sin links a mipeAdminDocsRcp en factura_sii.htm');
  }

  // Todos los links CGI Portal001
  const portal001 = [...body.matchAll(/href="([^"]*Portal001[^"]*)"/gi)].map(m => m[1]).slice(0, 20);
  if (portal001.length) console.log(`\nLinks Portal001 (hasta 20):\n  ${portal001.join('\n  ')}`);

  // Buscar keywords de documentos recibidos en JS
  const recibidosMatches = [...body.matchAll(/([^\n]*[Rr]ecibid[^\n]*)/g)].map(m => m[1].trim()).slice(0, 8);
  if (recibidosMatches.length) console.log(`\nOcurrencias "recibid*":\n  ${recibidosMatches.join('\n  ')}`);

  // Buscar AdminDocs / Rcp en cualquier parte
  const rcpMatches = [...body.matchAll(/([^\n]*[Rr]cp[^\n]*)/g)].map(m => m[1].trim()).slice(0, 8);
  if (rcpMatches.length) console.log(`\nOcurrencias "Rcp":\n  ${rcpMatches.join('\n  ')}`);

  // Buscar window.open o FacturaOpenEnlace o mipeGes
  const gesMatches = [...body.matchAll(/([^\n]*mipeGes[^\n]*)/g)].map(m => m[1].trim()).slice(0, 8);
  if (gesMatches.length) console.log(`\nOcurrencias "mipeGes":\n  ${gesMatches.join('\n  ')}`);
}

// ─── PASO 5: mipeLaunchPage.cgi (entry point desde factura_sii.htm) ──────────

async function paso5_launchPage(cookies) {
  console.log('\n─── PASO 5: mipeLaunchPage.cgi?OPCION=1&TIPO=4 (ver docs recibidos) ─');

  const url = 'https://www1.sii.cl/cgi-bin/Portal001/mipeLaunchPage.cgi?OPCION=1&TIPO=4';
  console.log(`URL: ${url}`);

  let resp;
  try {
    resp = await axios.get(url, {
      maxRedirects: 5, validateStatus: () => true,
      headers: {
        'Cookie': cookieHeader(cookies),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www1.sii.cl/factura_sii/factura_sii.htm',
      },
    });
  } catch (err) { console.error('❌', err.message); return; }

  const body  = typeof resp.data === 'string' ? resp.data : '';
  const title = (body.match(/<title>([^<]*)<\/title>/i) ?? [])[1] ?? '?';
  console.log(`Status: ${resp.status} | URL final: ${resp.request?.res?.responseUrl ?? resp.config?.url ?? '?'}`);
  console.log(`Título: "${title}" | Tamaño: ${body.length} chars`);

  const hasTable   = /\<table/i.test(body);
  const hasAdmDocs = /mipeAdminDocsRcp/i.test(body);
  const hasGesDoc  = /mipeGesDocRcp/i.test(body);
  console.log(`¿Tabla?: ${hasTable ? '✅' : '❌'} | ¿ref AdminDocs?: ${hasAdmDocs ? '✅' : '❌'} | ¿ref GesDocRcp?: ${hasGesDoc ? '✅' : '❌'}`);

  if (hasTable) {
    // Buscar filas con datos
    const rows = [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].slice(0, 5);
    console.log(`Primeras ${rows.length} filas de tabla:`);
    rows.forEach((r, i) => {
      const cells = [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(c => c[1].replace(/<[^>]+>/g, '').trim()).filter(Boolean);
      if (cells.length) console.log(`  fila ${i}: ${cells.slice(0, 5).join(' | ')}`);
    });
  } else {
    console.log(`\nBody completo (${body.length} chars):\n${body}`);
  }

  // Extraer URL de FacturaOpenEnlace si existe
  const facEnlM = body.match(/FacturaOpenEnlace\("([^"]+)"/i);
  if (facEnlM) {
    console.log(`\n🔗 FacturaOpenEnlace URL: ${facEnlM[1]}`);
    return facEnlM[1]; // devolvemos la URL para usarla en PASO 6
  }

  // Links útiles en la respuesta
  const allLinks = [...body.matchAll(/href="([^"]*Portal001[^"]*)"/gi)].map(m => m[1]).slice(0, 8);
  if (allLinks.length) console.log(`\nLinks Portal001 en respuesta:\n  ${allLinks.join('\n  ')}`);
}

// ─── PASO 6: mipeAdminDocsRcp.cgi con Referer=factura_sii.htm ────────────────

async function paso6_adminDocsConReferer(cookies, csrt = '') {
  console.log('\n─── PASO 6: mipeAdminDocsRcp.cgi (URL exacta del launcher OPCION=1) ─');

  // URL exacta que usa el launcher mipeLaunchPage.cgi?OPCION=1&TIPO=4
  const url = 'https://www1.sii.cl/cgi-bin/Portal001/mipeAdminDocsRcp.cgi?RUT_EMI=&FOLIO=&RZN_SOC=&FEC_DESDE=&FEC_HASTA=&TPO_DOC=&ESTADO=&ORDEN=&NUM_PAG=1';
  console.log(`URL: ${url}`);
  let resp;
  try {
    resp = await axios.get(url, {
      maxRedirects: 3, validateStatus: () => true,
      headers: {
        'Cookie': cookieHeader(cookies),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www1.sii.cl/cgi-bin/Portal001/mipeLaunchPage.cgi?OPCION=1&TIPO=4',
      },
    });
  } catch (err) { console.error('❌', err.message); return; }

  const body  = typeof resp.data === 'string' ? resp.data : '';
  const title = (body.match(/<title>([^<]*)<\/title>/i) ?? [])[1] ?? '?';
  const hasTable = /\<table/i.test(body);
  const finalUrl = resp.request?.res?.responseUrl ?? resp.config?.url ?? '?';
  console.log(`Status: ${resp.status} | URL final: ${finalUrl}`);
  console.log(`Título: "${title}" | Tabla: ${hasTable ? '✅' : '❌'} | Size: ${body.length}`);
  if (!hasTable) {
    console.log(`Body completo:\n${body}`);
  } else {
    console.log(`\n✅ ¡TABLA ENCONTRADA! Primeras filas con links:`);
    const rows = [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].slice(0, 8);
    rows.forEach((r, i) => {
      const cells = [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(c => c[1].replace(/<[^>]+>/g, '').trim()).filter(Boolean);
      if (cells.length) console.log(`  fila ${i}: ${cells.slice(0, 6).join(' | ')}`);
      // Mostrar links de la fila
      const links = [...r[1].matchAll(/href="([^"]+)"/gi)].map(m => m[1]);
      if (links.length) console.log(`    links: ${links.join(' | ')}`);
    });
    // Buscar todos los links a mipeGesDocRcp en el body
    const gesLinks = [...body.matchAll(/href="([^"]*mipeGesDocRcp[^"]*)"/gi)].map(m => m[1]).slice(0, 5);
    if (gesLinks.length) {
      console.log(`\n✅ Links a mipeGesDocRcp:`);
      gesLinks.forEach(l => console.log(`  ${l}`));
    }
    // Primer link de acción de la tabla (generalmente ícono de ver)
    const actionLinks = [...body.matchAll(/(<a[^>]+href="([^"]*(?:mipeGes|ver|detalle|Ges)[^"]*)"|onclick="[^"]*mipeGes[^"]*")/gi)].slice(0, 5);
    if (actionLinks.length) {
      console.log(`\nLinks acción encontrados:`);
      actionLinks.forEach(l => console.log(`  ${l[0].slice(0, 120)}`));
    }
  }
}

// ─── PASO 7: Seguir la URL de FacturaOpenEnlace (desde mipeLaunchPage) ────────

async function paso7_facturaopenenlace(cookies, enlaceUrl) {
  console.log('\n─── PASO 7: GET URL de FacturaOpenEnlace (desde mipeLaunchPage) ──');
  if (!enlaceUrl) { console.log('⚠️  Sin URL de FacturaOpenEnlace — saltando'); return; }

  const url = enlaceUrl.startsWith('http') ? enlaceUrl : `https://www1.sii.cl${enlaceUrl}`;
  console.log(`URL: ${url}`);

  let resp;
  try {
    resp = await axios.get(url, {
      maxRedirects: 5, validateStatus: () => true,
      headers: {
        'Cookie': cookieHeader(cookies),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www1.sii.cl/cgi-bin/Portal001/mipeLaunchPage.cgi?OPCION=33&TIPO=4',
      },
    });
  } catch (err) { console.error('❌', err.message); return; }

  const body  = typeof resp.data === 'string' ? resp.data : '';
  const title = (body.match(/<title>([^<]*)<\/title>/i) ?? [])[1] ?? '?';
  const finalUrl = resp.request?.res?.responseUrl ?? resp.config?.url ?? '?';
  const hasTable = /\<table/i.test(body);
  const hasAdmDocs = /mipeAdminDocsRcp/i.test(body);
  console.log(`Status: ${resp.status} | URL final: ${finalUrl}`);
  console.log(`Título: "${title}" | Size: ${body.length} | Tabla: ${hasTable ? '✅' : '❌'} | AdminDocs refs: ${hasAdmDocs ? '✅' : '❌'}`);
  if (body.length < 3000) console.log(`\nBody:\n${body}`);
  else {
    console.log(`\nBody (primeros 1500 chars):\n${body.slice(0, 1500)}`);
    // Buscar filas si hay tabla
    if (hasTable) {
      const rows = [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].slice(0, 8);
      rows.forEach((r, i) => {
        const cells = [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(c => c[1].replace(/<[^>]+>/g, '').trim()).filter(Boolean);
        if (cells.length) console.log(`  fila ${i}: ${cells.slice(0, 6).join(' | ')}`);
      });
    }
  }
}

// ─── PASO 8: GET mipeGesDocRcp.cgi → buscar botón PDF ────────────────────────

async function paso8_gesDoc(cookies, codigo) {
  console.log(`\n─── PASO 8: GET mipeGesDocRcp.cgi?CODIGO=${codigo} ──────────────`);
  const url = `https://www1.sii.cl/cgi-bin/Portal001/mipeGesDocRcp.cgi?CODIGO=${codigo}&ALL_PAGE_ANT=2`;
  console.log(`URL: ${url}`);

  let resp;
  try {
    resp = await axios.get(url, {
      maxRedirects: 3, validateStatus: () => true,
      headers: {
        'Cookie': cookieHeader(cookies),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www1.sii.cl/cgi-bin/Portal001/mipeAdminDocsRcp.cgi?RUT_EMI=&FOLIO=&RZN_SOC=&FEC_DESDE=&FEC_HASTA=&TPO_DOC=&ESTADO=&ORDEN=&NUM_PAG=1',
      },
    });
  } catch (err) { console.error('❌', err.message); return null; }

  const body  = typeof resp.data === 'string' ? resp.data : '';
  const title = (body.match(/<title>([^<]*)<\/title>/i) ?? [])[1] ?? '?';
  const finalUrl = resp.request?.res?.responseUrl ?? resp.config?.url ?? '?';
  console.log(`Status: ${resp.status} | URL final: ${finalUrl}`);
  console.log(`Título: "${title}" | Size: ${body.length}`);

  // Buscar botón VISUALIZACIÓN/PDF
  const vizMatches = [...body.matchAll(/(<(?:input|button|a)[^>]*(?:VISUALIZACI|visualizaci|pdf|PDF)[^>]*>)/gi)].slice(0, 5);
  if (vizMatches.length) {
    console.log(`\n✅ Elementos VISUALIZACIÓN/PDF encontrados:`);
    vizMatches.forEach(m => console.log(`  ${m[0].slice(0, 200)}`));
  } else {
    console.log('❌ Sin botón VISUALIZACIÓN/PDF directo');
  }

  // Buscar todos los inputs y botones
  const inputs = [...body.matchAll(/<input[^>]*>/gi)].map(m => m[0]).slice(0, 10);
  if (inputs.length) console.log(`\nInputs encontrados:\n  ${inputs.join('\n  ')}`);

  const buttons = [...body.matchAll(/<button[^>]*>([^<]*)<\/button>/gi)].map(m => m[0]).slice(0, 5);
  if (buttons.length) console.log(`Buttons: ${buttons.join(' | ')}`);

  // Links con PDF o documento
  const pdfLinks = [...body.matchAll(/href="([^"]*(?:pdf|PDF|documento|visualiza)[^"]*)"/gi)].map(m => m[1]).slice(0, 8);
  if (pdfLinks.length) console.log(`\nLinks PDF/visualización:\n  ${pdfLinks.join('\n  ')}`);

  // Forms en la página
  const forms = [...body.matchAll(/<form[^>]*action="([^"]*)"[^>]*>/gi)].map(m => m[1]).slice(0, 5);
  if (forms.length) console.log(`\nForms action: ${forms.join(' | ')}`);

  // Si body pequeño, mostrar todo
  if (body.length < 3000) console.log(`\nBody completo:\n${body}`);
  else console.log(`\nBody primeros 2000 chars:\n${body.slice(0, 2000)}`);

  return body;
}

// ─── PASO 9: GET mipeShowPdf.cgi — descarga PDF directo via HTTP ───────────────

async function paso9_showPdf(cookies, codigo) {
  console.log(`\n─── PASO 9: GET mipeShowPdf.cgi?CODIGO=${codigo} (PDF directo) ──`);
  const url = `https://www1.sii.cl/cgi-bin/Portal001/mipeShowPdf.cgi?CODIGO=${codigo}`;
  console.log(`URL: ${url}`);

  let resp;
  try {
    resp = await axios.get(url, {
      maxRedirects: 3, validateStatus: () => true, responseType: 'arraybuffer',
      headers: {
        'Cookie': cookieHeader(cookies),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': `https://www1.sii.cl/cgi-bin/Portal001/mipeGesDocRcp.cgi?CODIGO=${codigo}&ALL_PAGE_ANT=2`,
      },
    });
  } catch (err) { console.error('❌', err.message); return; }

  const ct = resp.headers['content-type'] ?? '';
  const buf = Buffer.from(resp.data);
  console.log(`Status: ${resp.status} | Content-Type: ${ct} | Tamaño: ${buf.length} bytes`);

  if (ct.includes('pdf') || buf.slice(0, 5).toString() === '%PDF-') {
    console.log(`\n✅ ¡PDF RECIBIDO! ${buf.length} bytes`);
    console.log(`Primeros bytes: ${buf.slice(0, 10).toString('ascii')}`);
    // Guardar para verificar
    require('fs').writeFileSync('/tmp/test-factura.pdf', buf);
    console.log('💾 Guardado en /tmp/test-factura.pdf');
  } else {
    console.log(`❌ No es PDF. Content-Type: ${ct}`);
    const bodyStr = buf.toString('utf-8').slice(0, 500);
    console.log(`Body (500 chars):\n${bodyStr}`);
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

(async () => {
  try {
    const cookies0 = await paso1_cautinico();
    if (!cookies0) { console.log('\n⛔ Abortando: paso 1 falló'); return; }

    // Filtrar cookies inútiles (DEL, expiradas)
    const cookies = cookies0.filter(c => c.value && c.value !== 'DEL');

    await paso2_selEmpresa(cookies);
    const p3 = await paso3_postEmpresa(cookies);

    const allCookies = p3.cookies;

    // Paso 3b: GET mipeSelEmpresa.cgi con rcmp/dcmp seteados para capturar csrt
    const csrtPostSelect = await paso3b_getSelEmpresaPostSelect(allCookies);
    const csrtFinal = csrtPostSelect || p3.csrt;
    console.log(`\n📌 csrt a usar: ${csrtFinal || '(vacío)'}`);

    // Paso 4b: explorar factura_sii.htm
    await paso4b_viaFacturaSii(allCookies);

    // Paso 5: mipeLaunchPage (entry point correcto) — devuelve URL de FacturaOpenEnlace
    const enlaceUrl = await paso5_launchPage(allCookies);

    // Paso 6: mipeAdminDocsRcp con Referer y csrt (ahora usando csrtFinal)
    await paso6_adminDocsConReferer(allCookies, csrtFinal);

    // Paso 8: ver mipeGesDocRcp para un documento real (primer CODIGO de la tabla)
    // CODIGO fijo extraído del PASO 6 (Blue Express folio 3842262)
    await paso8_gesDoc(allCookies, '2710400206');

    // Paso 9: descargar PDF directamente vía HTTP
    await paso9_showPdf(allCookies, '2710400206');

    console.log('\n✅ Prueba completada. Revisar resultados arriba.');
  } catch (err) {
    console.error('\n❌ Error inesperado:', err.message);
    console.error(err.stack);
  }
})();
