const { chromium } = require('playwright');

async function probarSIIPlaywright(rut, password) {
  let browser = null;
  
  try {
    console.log('🚀 Iniciando prueba del SII con Playwright...');
    console.log('RUT:', rut);
    console.log('Password:', password ? '***' : 'No proporcionada');
    
    // Lanzar navegador
    browser = await chromium.launch({
      headless: false,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    
    const page = await context.newPage();
    
    console.log('🌐 Navegando al SII...');
    
    // Intentar diferentes URLs
    const urls = [
      'https://www4.sii.cl/consdcvinternetui/',
      'https://www4.sii.cl/',
      'https://www.sii.cl/'
    ];
    
    let urlExitoso = null;
    for (const url of urls) {
      try {
        console.log(`📡 Probando: ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
        
        const title = await page.title();
        console.log(`📄 Título: ${title}`);
        
        if (title && title.toLowerCase().includes('sii')) {
          urlExitoso = url;
          console.log(`✅ URL exitosa: ${url}`);
          break;
        }
      } catch (error) {
        console.log(`❌ Error con ${url}: ${error.message}`);
      }
    }
    
    if (!urlExitoso) {
      throw new Error('No se pudo acceder al SII');
    }
    
    console.log('🔍 Buscando enlaces de autenticación...');
    
    // Buscar enlaces de autenticación
    const enlaces = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      return links.map(link => ({
        href: link.href,
        text: link.textContent.trim(),
        visible: link.offsetParent !== null
      })).filter(link => 
        link.text.toLowerCase().includes('autentic') ||
        link.text.toLowerCase().includes('login') ||
        link.text.toLowerCase().includes('ingresar') ||
        link.text.toLowerCase().includes('acceder') ||
        link.href.includes('autentic') ||
        link.href.includes('login') ||
        link.href.includes('consdcvinternetui')
      );
    });
    
    console.log('🔗 Enlaces de autenticación encontrados:', enlaces);
    
    // Buscar y hacer clic en enlace de autenticación
    let enlaceAutenticacion = null;
    for (const enlace of enlaces) {
      if (enlace.visible && enlace.href) {
        try {
          console.log(`🔗 Intentando enlace: ${enlace.text} -> ${enlace.href}`);
          await page.click(`a[href="${enlace.href}"]`);
          await page.waitForTimeout(3000);
          
          // Verificar si ahora hay formulario de login
          const campos = await page.evaluate(() => {
            const inputs = Array.from(document.querySelectorAll('input'));
            return inputs.map(input => ({
              id: input.id,
              name: input.name,
              type: input.type,
              placeholder: input.placeholder,
              visible: input.offsetParent !== null
            }));
          });
          
          console.log('📋 Campos después del clic:', campos);
          
          if (campos.some(campo => campo.id.includes('rut') || campo.name.includes('rut'))) {
            enlaceAutenticacion = enlace;
            console.log(`✅ Enlace exitoso: ${enlace.text}`);
            break;
          }
        } catch (error) {
          console.log(`❌ Error con enlace ${enlace.text}: ${error.message}`);
        }
      }
    }
    
    if (!enlaceAutenticacion) {
      console.log('🔍 Buscando formulario de login en página actual...');
      
      // Buscar campos de login en la página actual
      const campos = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input'));
        return inputs.map(input => ({
          id: input.id,
          name: input.name,
          type: input.type,
          placeholder: input.placeholder,
          visible: input.offsetParent !== null
        }));
      });
      
      console.log('📋 Campos encontrados:', campos);
    }
    
    // Buscar campo RUT
    let campoRut = null;
    const selectoresRut = ['#rutcntr', 'input[name*="rut"]', 'input[id*="rut"]', 'input[type="text"]'];
    
    for (const selector of selectoresRut) {
      try {
        await page.waitForSelector(selector, { timeout: 2000 });
        campoRut = selector;
        console.log(`✅ Campo RUT encontrado: ${selector}`);
        break;
      } catch (e) {
        console.log(`❌ Selector ${selector} no encontrado`);
      }
    }
    
    if (!campoRut) {
      // Screenshot para debug
      await page.screenshot({ path: 'debug-sii-form-playwright.png' });
      console.log('📸 Screenshot guardado como debug-sii-form-playwright.png');
      throw new Error('No se encontró el campo RUT');
    }
    
    console.log('✏️ Llenando formulario...');
    
    // Limpiar y llenar RUT
    await page.click(campoRut);
    await page.fill(campoRut, rut);
    console.log('✅ RUT ingresado');
    
    // Buscar campo contraseña
    const selectoresPass = ['#clave', 'input[type="password"]', 'input[name*="pass"]'];
    let campoPass = null;
    
    for (const selector of selectoresPass) {
      try {
        await page.waitForSelector(selector, { timeout: 2000 });
        campoPass = selector;
        console.log(`✅ Campo contraseña encontrado: ${selector}`);
        break;
      } catch (e) {
        console.log(`❌ Selector ${selector} no encontrado`);
      }
    }
    
    if (!campoPass) {
      throw new Error('No se encontró el campo contraseña');
    }
    
    // Llenar contraseña
    await page.click(campoPass);
    await page.fill(campoPass, password);
    console.log('✅ Contraseña ingresada');
    
    // Pausa para verificar
    console.log('⏱️ Pausa de 3 segundos para verificar...');
    await page.waitForTimeout(3000);
    
    // Buscar botón de envío
    const selectoresBtn = ['#bt_ingresar', 'input[type="submit"]', 'button[type="submit"]', 'button'];
    let botonEnvio = null;
    
    for (const selector of selectoresBtn) {
      try {
        await page.waitForSelector(selector, { timeout: 2000 });
        botonEnvio = selector;
        console.log(`✅ Botón encontrado: ${selector}`);
        break;
      } catch (e) {
        console.log(`❌ Selector ${selector} no encontrado`);
      }
    }
    
    if (!botonEnvio) {
      throw new Error('No se encontró el botón de envío');
    }
    
    console.log('🚀 Enviando formulario...');
    await page.click(botonEnvio);
    
    // Esperar respuesta
    console.log('⏳ Esperando respuesta del servidor...');
    await page.waitForTimeout(5000);
    
    // Verificar resultado
    const urlActual = page.url();
    const tituloActual = await page.title();
    
    console.log('📍 URL actual:', urlActual);
    console.log('📄 Título actual:', tituloActual);
    
    // Buscar mensajes de error
    const mensajes = await page.evaluate(() => {
      const elementos = document.querySelectorAll('.error, .mensaje, .alert, .text-danger, [class*="error"]');
      return Array.from(elementos).map(el => el.textContent.trim()).filter(text => text.length > 0);
    });
    
    if (mensajes.length > 0) {
      console.log('❌ Mensajes de error encontrados:', mensajes);
    }
    
    // Screenshot final
    await page.screenshot({ path: 'debug-sii-result-playwright.png' });
    console.log('📸 Screenshot final guardado como debug-sii-result-playwright.png');
    
    console.log('✅ Prueba completada');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    if (browser) {
      await browser.close();
    }
    throw error;
  } finally {
    if (browser) {
      console.log('🔒 Cerrando navegador...');
      await browser.close();
    }
  }
}

// Ejecutar si se llama directamente
if (require.main === module) {
  const rut = process.argv[2] || '17.311.783-3';
  const password = process.argv[3] || 'test123';
  
  probarSIIPlaywright(rut, password)
    .then(() => console.log('✅ Prueba exitosa'))
    .catch(error => console.error('❌ Error:', error.message));
}

module.exports = probarSIIPlaywright;
