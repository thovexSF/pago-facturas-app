const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const nodemailer = require('nodemailer');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Base de datos simple
const db = new sqlite3.Database('./database.sqlite');

// Inicializar tablas
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS facturas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero_factura TEXT NOT NULL,
    emisor TEXT NOT NULL,
    monto REAL NOT NULL,
    fecha_emision DATE NOT NULL,
    fecha_vencimiento DATE NOT NULL,
    estado TEXT DEFAULT 'pendiente',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    pagada_at DATETIME
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS recordatorios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    factura_id INTEGER,
    fecha_recordatorio DATE,
    enviado BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (factura_id) REFERENCES facturas (id)
  )`);
});

// Configuración de email
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER || 'test@example.com',
    pass: process.env.EMAIL_PASSWORD || 'test_password',
  },
});

// Funciones de utilidad
async function extraerFacturasSII(rut, password) {
  const { chromium } = require('playwright');
  
  try {
    console.log('Iniciando navegador para SII...');
    const browser = await chromium.launch({
      headless: false,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    
    const page = await context.newPage();
    
    // Configurar user agent para evitar detección
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    console.log('Navegando al portal del SII...');
    
    // Intentar diferentes URLs del SII
    const siiUrls = [
      'https://www4.sii.cl/consdcvinternetui/',
      'https://www4.sii.cl/consdcvinternetui',
      'https://www4.sii.cl/',
      'https://www.sii.cl/',
      'https://www4.sii.cl/consdcvinternetui/index.html'
    ];
    
    let urlExitoso = null;
    for (const url of siiUrls) {
      try {
        console.log(`Intentando URL: ${url}`);
        await page.goto(url, { 
          waitUntil: 'networkidle2',
          timeout: 15000 
        });
        
        // Verificar si la página cargó correctamente
        const title = await page.title();
        console.log(`Título de la página: ${title}`);
        
        if (title && title.toLowerCase().includes('sii')) {
          urlExitoso = url;
          console.log(`✅ URL exitosa: ${url}`);
          break;
        }
      } catch (error) {
        console.log(`❌ Error con URL ${url}: ${error.message}`);
        continue;
      }
    }
    
    if (!urlExitoso) {
      throw new Error('No se pudo acceder a ninguna URL del SII');
    }
    
    console.log(`Navegación exitosa a: ${urlExitoso}`);
    
    // Esperar a que cargue la página de login
    console.log('Esperando selector #rutcntr...');
    
    try {
      await page.waitForSelector('#rutcntr', { timeout: 10000 });
      console.log('✅ Selector #rutcntr encontrado');
    } catch (error) {
      console.log('❌ Selector #rutcntr no encontrado, buscando alternativas...');
      
      // Buscar otros selectores posibles
      const selectoresAlternativos = [
        'input[name="rut"]',
        'input[id*="rut"]',
        'input[type="text"]',
        '.rut-input',
        '#rut',
        'input[placeholder*="rut"]'
      ];
      
      let selectorEncontrado = null;
      for (const selector of selectoresAlternativos) {
        try {
          await page.waitForSelector(selector, { timeout: 2000 });
          console.log(`✅ Selector alternativo encontrado: ${selector}`);
          selectorEncontrado = selector;
          break;
        } catch (e) {
          console.log(`❌ Selector ${selector} no encontrado`);
        }
      }
      
      if (!selectorEncontrado) {
        // Capturar screenshot para debug
        await page.screenshot({ path: 'debug-sii-page.png' });
        console.log('Screenshot guardado como debug-sii-page.png');
        
        // Obtener información de la página
        const pageInfo = await page.evaluate(() => ({
          title: document.title,
          url: window.location.href,
          bodyText: document.body.textContent.substring(0, 500),
          inputs: Array.from(document.querySelectorAll('input')).map(input => ({
            id: input.id,
            name: input.name,
            type: input.type,
            placeholder: input.placeholder
          }))
        }));
        
        console.log('Información de la página:', JSON.stringify(pageInfo, null, 2));
        throw new Error('No se encontró el formulario de login del SII');
      }
    }
    
    console.log('Llenando formulario de login...');
    console.log('RUT a ingresar:', rut);
    
    // Limpiar y llenar RUT
    await page.click('#rutcntr', { clickCount: 3 });
    
    // Formatear RUT para el SII (asegurar formato correcto)
    let rutFormateado = rut.trim();
    
    // Si no tiene puntos, agregarlos
    if (!rutFormateado.includes('.')) {
      // Formato: 12345678-9 -> 12.345.678-9
      if (rutFormateado.includes('-')) {
        const [numero, dv] = rutFormateado.split('-');
        if (numero.length >= 7) {
          const parte1 = numero.slice(0, -6);
          const parte2 = numero.slice(-6, -3);
          const parte3 = numero.slice(-3);
          rutFormateado = `${parte1}.${parte2}.${parte3}-${dv}`;
        }
      }
    }
    
    console.log('RUT formateado para SII:', rutFormateado);
    await page.type('#rutcntr', rutFormateado);
    console.log('RUT ingresado');
    
    // Llenar contraseña
    await page.click('#clave', { clickCount: 3 });
    await page.type('#clave', password);
    console.log('Contraseña ingresada');
    
    // Pausa para que puedas ver el formulario
    console.log('Pausa de 3 segundos para verificar el formulario...');
    await page.waitForTimeout(3000);
    
    // Hacer clic en ingresar
    console.log('Enviando formulario...');
    await page.click('#bt_ingresar');
    
    // Esperar a que cargue la página principal o la selección de empresa
    try {
      // Verificar si hay selección de empresa
      await page.waitForSelector('.menu-principal, .empresa-selector, .selector-empresa, select[name*="empresa"], .empresas', { timeout: 15000 });
      console.log('Login exitoso, verificando si hay selección de empresa...');
      
      // Buscar selector de empresa
      const empresaSelector = await page.$('select[name*="empresa"], .empresa-selector select, .selector-empresa select');
      if (empresaSelector) {
        console.log('Seleccionando primera empresa disponible...');
        const options = await page.$$eval('select[name*="empresa"] option, .empresa-selector select option, .selector-empresa select option', 
          options => options.map(opt => ({ value: opt.value, text: opt.textContent.trim() }))
        );
        
        if (options.length > 1) {
          // Seleccionar la primera empresa (no la opción vacía)
          const primeraEmpresa = options.find(opt => opt.value && opt.value !== '');
          if (primeraEmpresa) {
            await page.select('select[name*="empresa"], .empresa-selector select, .selector-empresa select', primeraEmpresa.value);
            console.log(`Empresa seleccionada: ${primeraEmpresa.text}`);
            
            // Buscar y hacer clic en botón de continuar/aceptar
            const continuarBtn = await page.$('input[type="submit"], button[type="submit"], .btn-continuar, .btn-aceptar');
            if (continuarBtn) {
              await continuarBtn.click();
              await page.waitForTimeout(3000);
            }
          }
        }
      }
      
      // Esperar a que cargue el menú principal después de seleccionar empresa
      await page.waitForSelector('.menu-principal', { timeout: 10000 });
      console.log('Navegando a facturas...');
      
    } catch (error) {
      console.log('Error en login, verificando si hay mensaje de error...');
      
      // Capturar screenshot para debug
      await page.screenshot({ path: 'debug-login-error.png' });
      console.log('Screenshot guardado como debug-login-error.png');
      
      // Obtener el título de la página actual
      const pageTitle = await page.title();
      console.log('Título de la página actual:', pageTitle);
      
      // Obtener la URL actual
      const currentUrl = page.url();
      console.log('URL actual:', currentUrl);
      
      // Buscar mensajes de error
      const errorMessage = await page.$eval('.error, .mensaje-error, .alert, .mensaje, .text-danger', el => el.textContent).catch(() => '');
      if (errorMessage) {
        console.log('Mensaje de error encontrado:', errorMessage);
        throw new Error(`Error de autenticación: ${errorMessage}`);
      }
      
      // Buscar cualquier texto que pueda indicar el problema
      const pageContent = await page.evaluate(() => document.body.textContent);
      console.log('Contenido de la página (primeros 500 caracteres):', pageContent.substring(0, 500));
      
      throw new Error('Error de autenticación: Credenciales incorrectas o problema con selección de empresa');
    }
    
    // Navegar a la sección de facturas
    console.log('Buscando sección de facturas...');
    try {
      // Buscar diferentes enlaces relacionados con facturas
      const facturasLinks = await page.$$eval('a', links => 
        links.map(link => ({
          href: link.href,
          text: link.textContent.trim(),
          innerHTML: link.innerHTML
        })).filter(link => 
          link.text.toLowerCase().includes('factura') ||
          link.text.toLowerCase().includes('documento') ||
          link.text.toLowerCase().includes('boleta') ||
          link.text.toLowerCase().includes('pago') ||
          link.href.includes('factura') ||
          link.href.includes('documento') ||
          link.href.includes('boleta')
        )
      );
      
      console.log('Enlaces encontrados:', facturasLinks);
      
      if (facturasLinks.length > 0) {
        const facturasLink = await page.$(`a[href="${facturasLinks[0].href}"]`);
        if (facturasLink) {
          await facturasLink.click();
          await page.waitForTimeout(3000);
          console.log('Navegando a:', facturasLinks[0].text);
        }
      } else {
        console.log('No se encontraron enlaces específicos de facturas, buscando en el menú...');
        // Buscar en el menú principal
        const menuItems = await page.$$eval('.menu-principal a, .menu a, nav a', links =>
          links.map(link => link.textContent.trim())
        );
        console.log('Elementos del menú:', menuItems);
      }
    } catch (error) {
      console.log('Error navegando a facturas:', error.message);
    }
    
    // Buscar tabla de facturas
    console.log('Buscando tabla de facturas...');
    await page.waitForTimeout(2000);
    
    const facturas = await page.evaluate(() => {
      const rows = document.querySelectorAll('table tr, .tabla-facturas tr, .listado tr');
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
              !numero.includes('Subtotal')) {
            
            // Limpiar y formatear datos
            const montoLimpio = parseFloat(monto.replace(/[^\d.-]/g, '')) || 0;
            const fechaLimpia = fecha.replace(/\//g, '-');
            
            facturasEncontradas.push({
              numero: numero,
              emisor: emisor,
              monto: montoLimpio,
              fechaEmision: fechaLimpia,
              fechaVencimiento: fechaLimpia, // Asumimos que es la fecha de vencimiento
              estado: 'Pendiente'
            });
          }
        }
      });
      
      return facturasEncontradas;
    });
    
    await browser.close();
    console.log(`Extraídas ${facturas.length} facturas del SII`);
    return facturas;
    
  } catch (error) {
    console.error('Error extrayendo facturas del SII:', error);
    throw error;
  }
}

async function enviarRecordatorio(factura, email) {
  const mailOptions = {
    from: process.env.EMAIL_USER || 'test@example.com',
    to: email,
    subject: `Recordatorio: Factura ${factura.numero_factura} próxima a vencer`,
    html: `
      <h2>Recordatorio de Pago</h2>
      <p>Estimado/a,</p>
      <p>Le recordamos que tiene una factura próxima a vencer:</p>
      <ul>
        <li><strong>Número:</strong> ${factura.numero_factura}</li>
        <li><strong>Emisor:</strong> ${factura.emisor}</li>
        <li><strong>Monto:</strong> $${factura.monto.toLocaleString()}</li>
        <li><strong>Fecha de vencimiento:</strong> ${new Date(factura.fecha_vencimiento).toLocaleDateString()}</li>
      </ul>
      <p>Por favor, realice el pago antes de la fecha de vencimiento.</p>
      <p>Saludos cordiales,<br>Sistema de Gestión de Facturas</p>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    return true;
  } catch (error) {
    console.error('Error enviando email:', error);
    return false;
  }
}

// Rutas de la API
app.get('/api/facturas', (req, res) => {
  db.all('SELECT * FROM facturas ORDER BY fecha_vencimiento', (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

app.post('/api/facturas', (req, res) => {
  const { numero_factura, emisor, monto, fecha_emision, fecha_vencimiento } = req.body;
  
  db.run(
    `INSERT INTO facturas (numero_factura, emisor, monto, fecha_emision, fecha_vencimiento)
     VALUES (?, ?, ?, ?, ?)`,
    [numero_factura, emisor, monto, fecha_emision, fecha_vencimiento],
    function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ id: this.lastID, message: 'Factura agregada exitosamente' });
    }
  );
});

app.put('/api/facturas/:id/marcar-pagada', (req, res) => {
  const { id } = req.params;
  
  db.run(
    `UPDATE facturas SET estado = 'pagada', pagada_at = CURRENT_TIMESTAMP 
     WHERE id = ?`,
    [id],
    function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ message: 'Factura marcada como pagada' });
    }
  );
});

app.post('/api/sincronizar-sii', async (req, res) => {
  const { rut, password } = req.body;
  
  try {
    console.log('Iniciando sincronización real con SII...');
    
    // Extraer facturas del SII
    const facturasSII = await extraerFacturasSII(rut, password);
    
    if (facturasSII.length === 0) {
      return res.json({
        message: 'No se encontraron facturas pendientes en el SII',
        facturas_sincronizadas: 0,
        total_facturas: 0
      });
    }
    
    // Guardar facturas en la base de datos
    let sincronizadas = 0;
    for (const factura of facturasSII) {
      db.run(
        `INSERT OR IGNORE INTO facturas (numero_factura, emisor, monto, fecha_emision, fecha_vencimiento)
         VALUES (?, ?, ?, ?, ?)`,
        [factura.numero, factura.emisor, factura.monto, factura.fechaEmision, factura.fechaVencimiento],
        function(err) {
          if (!err && this.changes > 0) {
            sincronizadas++;
            console.log(`Factura sincronizada: ${factura.numero}`);
          }
        }
      );
    }
    
    res.json({
      message: 'Sincronización completada exitosamente',
      facturas_sincronizadas: sincronizadas,
      total_facturas: facturasSII.length,
      facturas: facturasSII
    });
    
  } catch (error) {
    console.error('Error en sincronización SII:', error);
    res.status(500).json({
      error: 'Error al sincronizar con SII',
      message: error.message
    });
  }
});

// Tarea programada para recordatorios (se ejecuta cada minuto para pruebas)
cron.schedule('* * * * *', async () => {
  console.log('Verificando recordatorios...');
  
  const hoy = new Date().toISOString().split('T')[0];
  const fechaLimite = new Date();
  fechaLimite.setDate(fechaLimite.getDate() + 3);
  const fechaLimiteStr = fechaLimite.toISOString().split('T')[0];
  
  db.all(
    `SELECT * FROM facturas 
     WHERE estado = 'pendiente' 
     AND fecha_vencimiento BETWEEN ? AND ?`,
    [hoy, fechaLimiteStr],
    async (err, facturas) => {
      if (err) {
        console.error('Error consultando facturas:', err);
        return;
      }
      
      for (const factura of facturas) {
        // Verificar si ya se envió recordatorio hoy
        db.get(
          'SELECT * FROM recordatorios WHERE factura_id = ? AND fecha_recordatorio = ?',
          [factura.id, hoy],
          async (err, recordatorio) => {
            if (err) {
              console.error('Error verificando recordatorio:', err);
              return;
            }
            
            if (!recordatorio) {
              console.log(`Enviando recordatorio para factura ${factura.numero_factura}`);
              
              // Registrar recordatorio
              db.run(
                'INSERT INTO recordatorios (factura_id, fecha_recordatorio, enviado) VALUES (?, ?, ?)',
                [factura.id, hoy, true]
              );
            }
          }
        );
      }
    }
  );
});

// Ruta principal
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
  console.log(`📱 App disponible en: http://localhost:${PORT}`);
  console.log(`🌐 Ngrok URL: https://1aef3bcefdaa.ngrok-free.app`);
  console.log(`📧 Recordatorios programados cada minuto para pruebas`);
});
