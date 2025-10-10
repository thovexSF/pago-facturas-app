const { chromium } = require('playwright');

async function extraerFacturasSIICompleto(rut, password) {
  let browser = null;
  
  try {
    console.log('🚀 Iniciando extracción completa del SII...');
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
    
    // Navegar directamente a la URL de autenticación
    await page.goto('https://www4.sii.cl/consdcvinternetui/', { 
      waitUntil: 'domcontentloaded', 
      timeout: 15000 
    });
    
    console.log('📄 Título de la página:', await page.title());
    
    // Buscar formulario de login
    console.log('🔍 Buscando formulario de login...');
    
    // Buscar todos los campos de input visibles
    const campos = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input'));
      return inputs.map(input => ({
        id: input.id,
        name: input.name,
        type: input.type,
        placeholder: input.placeholder,
        visible: input.offsetParent !== null,
        value: input.value
      }));
    });
    
    console.log('📋 Todos los campos encontrados:', campos);
    
    // Buscar campo RUT visible
    let campoRut = null;
    const selectoresRut = ['#rutcntr', 'input[name*="rut"]:not([type="hidden"])', 'input[id*="rut"]:not([type="hidden"])', 'input[type="text"]'];
    
    for (const selector of selectoresRut) {
      try {
        await page.waitForSelector(selector, { timeout: 2000 });
        const elemento = await page.$(selector);
        const esVisible = await elemento.isVisible();
        if (esVisible) {
          campoRut = selector;
          console.log(`✅ Campo RUT visible encontrado: ${selector}`);
          break;
        }
      } catch (e) {
        console.log(`❌ Selector ${selector} no encontrado o no visible`);
      }
    }
    
    if (!campoRut) {
      throw new Error('No se encontró el campo RUT');
    }
    
    console.log('✏️ Llenando formulario...');
    
    // Limpiar y llenar RUT
    await page.click(campoRut);
    await page.fill(campoRut, rut);
    console.log('✅ RUT ingresado');
    
    // Buscar campo contraseña
    const selectoresPass = ['#clave', 'input[type="password"]'];
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
    const selectoresBtn = ['#bt_ingresar', 'input[type="submit"]', 'button[type="submit"]'];
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
    
    // Esperar respuesta del login
    console.log('⏳ Esperando respuesta del login...');
    await page.waitForTimeout(5000);
    
    // Verificar si el login fue exitoso
    const urlActual = page.url();
    const tituloActual = await page.title();
    
    console.log('📍 URL después del login:', urlActual);
    console.log('📄 Título después del login:', tituloActual);
    
    // Buscar mensajes de error
    const mensajes = await page.evaluate(() => {
      const elementos = document.querySelectorAll('.error, .mensaje, .alert, .text-danger, [class*="error"]');
      return Array.from(elementos).map(el => el.textContent.trim()).filter(text => text.length > 0);
    });
    
    if (mensajes.length > 0) {
      console.log('❌ Mensajes de error encontrados:', mensajes);
      throw new Error(`Error de login: ${mensajes.join(', ')}`);
    }
    
    // Verificar si hay página de selección de modo de ingreso
    console.log('🔍 Verificando página de selección...');
    
    const tituloSeleccion = await page.$('text=ESCOJA COMO DESEA INGRESAR');
    if (tituloSeleccion) {
      console.log('📋 Página de selección detectada, buscando botón Continuar...');
      
      // Buscar botón "Continuar"
      const botones = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"]'));
        return buttons.map(btn => ({
          text: btn.textContent.trim(),
          value: btn.value,
          type: btn.type,
          visible: btn.offsetParent !== null
        }));
      });
      
      console.log('🔘 Botones encontrados:', botones);
      
      // Buscar botón "Continuar" de manera más robusta
      try {
        // Esperar a que la página se estabilice
        await page.waitForTimeout(2000);
        
        // Buscar todos los elementos clickeables que contengan "Continuar"
        const continuarElements = await page.$$eval('*', elements => {
          return elements
            .filter(el => el.textContent && el.textContent.trim().toLowerCase().includes('continuar'))
            .map(el => ({
              tagName: el.tagName,
              text: el.textContent.trim(),
              className: el.className,
              id: el.id,
              visible: el.offsetParent !== null
            }));
        });
        
        console.log('🔍 Elementos con "Continuar" encontrados:', continuarElements);
        
        // Buscar el botón más apropiado
        let continuarBtn = null;
        for (const element of continuarElements) {
          if (element.visible && (element.tagName === 'BUTTON' || element.tagName === 'INPUT' || element.tagName === 'A')) {
            continuarBtn = element;
            break;
          }
        }
        
        if (continuarBtn) {
          console.log('✅ Botón Continuar encontrado:', continuarBtn);
          
          // Hacer clic usando JavaScript
          await page.evaluate(() => {
            const elements = Array.from(document.querySelectorAll('*'));
            const continuarElement = elements.find(el => 
              el.textContent && 
              el.textContent.trim().toLowerCase().includes('continuar') &&
              el.offsetParent !== null &&
              (el.tagName === 'BUTTON' || el.tagName === 'INPUT' || el.tagName === 'A')
            );
            if (continuarElement) {
              continuarElement.click();
            }
          });
          
          await page.waitForTimeout(3000);
          console.log('✅ Clic en Continuar realizado');
        } else {
          console.log('❌ No se encontró botón Continuar visible');
        }
      } catch (error) {
        console.log('❌ Error buscando botón Continuar:', error.message);
      }
    }
    
    // Verificar si hay selección de empresa
    console.log('🔍 Verificando si hay selección de empresa...');
    
    const empresaSelect = await page.$('select[name*="empresa"], .empresa-selector select, .selector-empresa select');
    if (empresaSelect) {
      console.log('🏢 Seleccionando primera empresa...');
      
      const opciones = await page.$$eval('select[name*="empresa"] option, .empresa-selector select option, .selector-empresa select option', 
        options => options.map(opt => ({ value: opt.value, text: opt.textContent.trim() }))
      );
      
      if (opciones.length > 1) {
        const primeraEmpresa = opciones.find(opt => opt.value && opt.value !== '');
        if (primeraEmpresa) {
          await page.select('select[name*="empresa"], .empresa-selector select, .selector-empresa select', primeraEmpresa.value);
          console.log(`✅ Empresa seleccionada: ${primeraEmpresa.text}`);
          
          // Buscar botón de continuar
          const continuarBtn = await page.$('input[type="submit"], button[type="submit"], .btn-continuar, .btn-aceptar');
          if (continuarBtn) {
            await continuarBtn.click();
            await page.waitForTimeout(3000);
          }
        }
      }
    }
    
    // Verificar si estamos en la página de registro de compras y ventas
    console.log('🔍 Verificando página actual...');
    const tituloRegistro = await page.title();
    console.log('📄 Título actual:', tituloRegistro);
    
    if (tituloRegistro.includes('REGISTRO DE COMPRAS Y VENTAS') || tituloRegistro.includes('Registro')) {
      console.log('✅ Estamos en la página de registro de compras y ventas');
      
      // Buscar dropdown de empresa
      console.log('🏢 Buscando selector de empresa...');
      const empresaSelect = await page.$('select, .dropdown, [class*="select"]');
      
      if (empresaSelect) {
        console.log('✅ Selector de empresa encontrado');
        
        // Obtener opciones disponibles
        const opciones = await page.$$eval('select option, .dropdown option', options => 
          options.map(opt => ({
            value: opt.value,
            text: opt.textContent.trim(),
            selected: opt.selected
          }))
        );
        
        console.log('📋 Opciones de empresa disponibles:', opciones);
        
        // Filtrar solo las empresas (RUTs válidos)
        const empresasValidas = opciones.filter(opt => 
          opt.value && 
          opt.value !== '' && 
          opt.text !== 'Empresa' && 
          opt.text !== 'Mes' && 
          opt.text !== 'Año' &&
          opt.text !== 'Enero' &&
          opt.text !== 'Febrero' &&
          opt.text !== 'Marzo' &&
          opt.text !== 'Abril' &&
          opt.text !== 'Mayo' &&
          opt.text !== 'Junio' &&
          opt.text !== 'Julio' &&
          opt.text !== 'Agosto' &&
          opt.text !== 'Septiembre' &&
          opt.text !== 'Octubre' &&
          opt.text !== 'Noviembre' &&
          opt.text !== 'Diciembre' &&
          !opt.text.match(/^\d{4}$/) // No años (2025, 2024, etc.)
        );
        
        console.log('🏢 Empresas válidas encontradas:', empresasValidas);
        
        if (empresasValidas.length > 0) {
          const ultimaEmpresa = empresasValidas[empresasValidas.length - 1];
          console.log(`🏢 Seleccionando última empresa: ${ultimaEmpresa.text} (${ultimaEmpresa.value})`);
          
          // Usar selectOption con el selector específico del RUT
          await page.selectOption('select[name="rut"]', ultimaEmpresa.value);
          await page.waitForTimeout(2000);
          
          // Buscar y hacer clic en botón "Consultar"
          const consultarBtn = await page.$('button:has-text("Consultar"), input[value*="Consultar"], .btn:has-text("Consultar")');
          if (consultarBtn) {
            console.log('🔍 Haciendo clic en Consultar...');
            await consultarBtn.click();
            await page.waitForTimeout(5000);
            console.log('✅ Consulta realizada');
          } else {
            console.log('❌ No se encontró botón Consultar');
          }
        } else {
          console.log('❌ No se encontraron empresas válidas');
        }
      } else {
        console.log('❌ No se encontró selector de empresa');
      }
    } else {
      console.log('🔍 Buscando sección de facturas...');
      
      // Buscar enlaces relacionados con facturas
      const enlacesFacturas = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a'));
        return links.map(link => ({
          href: link.href,
          text: link.textContent.trim(),
          visible: link.offsetParent !== null
        })).filter(link => 
          link.text.toLowerCase().includes('factura') ||
          link.text.toLowerCase().includes('documento') ||
          link.text.toLowerCase().includes('boleta') ||
          link.text.toLowerCase().includes('pago') ||
          link.href.includes('factura') ||
          link.href.includes('documento') ||
          link.href.includes('boleta')
        );
      });
      
      console.log('🔗 Enlaces de facturas encontrados:', enlacesFacturas);
      
      // Intentar navegar a facturas
      if (enlacesFacturas.length > 0) {
        const enlaceFacturas = enlacesFacturas[0];
        console.log(`🔗 Navegando a: ${enlaceFacturas.text}`);
        await page.click(`a[href="${enlaceFacturas.href}"]`);
        await page.waitForTimeout(3000);
      }
    }
    
    // Buscar tabla de facturas
    console.log('🔍 Buscando tabla de facturas...');
    
    const facturas = await page.evaluate(() => {
      const rows = document.querySelectorAll('table tr, .tabla-facturas tr, .listado tr, tbody tr');
      const facturasEncontradas = [];
      
      rows.forEach((row, index) => {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 4) {
          const numero = cells[0]?.textContent?.trim();
          const emisor = cells[1]?.textContent?.trim();
          const monto = cells[2]?.textContent?.trim();
          const fecha = cells[3]?.textContent?.trim();
          
          if (numero && emisor && monto && fecha && 
              numero !== 'Número' && 
              !numero.includes('Total') &&
              !numero.includes('Subtotal') &&
              numero.length > 0) {
            
            // Limpiar y formatear datos
            const montoLimpio = parseFloat(monto.replace(/[^\d.-]/g, '')) || 0;
            const fechaLimpia = fecha.replace(/\//g, '-');
            
            facturasEncontradas.push({
              numero: numero,
              emisor: emisor,
              monto: montoLimpio,
              fechaEmision: fechaLimpia,
              fechaVencimiento: fechaLimpia,
              estado: 'Pendiente'
            });
          }
        }
      });
      
      return facturasEncontradas;
    });
    
    console.log(`📄 Facturas extraídas: ${facturas.length}`);
    
    if (facturas.length > 0) {
      console.log('📋 Facturas encontradas:');
      facturas.forEach((factura, index) => {
        console.log(`  ${index + 1}. ${factura.numero} - ${factura.emisor} - $${factura.monto}`);
      });
    } else {
      console.log('ℹ️ No se encontraron facturas pendientes');
    }
    
    // Screenshot final
    await page.screenshot({ path: 'debug-sii-facturas.png' });
    console.log('📸 Screenshot final guardado como debug-sii-facturas.png');
    
    return facturas;
    
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
  
  extraerFacturasSIICompleto(rut, password)
    .then((facturas) => {
      console.log('✅ Extracción completada');
      console.log(`📊 Total de facturas: ${facturas.length}`);
    })
    .catch(error => console.error('❌ Error:', error.message));
}

module.exports = extraerFacturasSIICompleto;
