const express = require('express');
const { shopifyApi, LATEST_API_VERSION } = require('@shopify/shopify-api');
const { shopifyApp } = require('@shopify/shopify-app-express');
const { SQLiteSessionStorage } = require('@shopify/shopify-app-session-storage-sqlite');
const axios = require('axios');
const puppeteer = require('puppeteer');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const mercadopago = require('mercadopago');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Configuración de Shopify
const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: ['read_products', 'write_products', 'read_orders', 'write_orders'],
  hostName: process.env.SHOPIFY_APP_URL?.replace('https://', '').replace('http://', ''),
  apiVersion: LATEST_API_VERSION,
  isEmbeddedApp: true,
});

// Configuración de la app de Shopify
const shopifyAppExpress = shopifyApp({
  api: shopify,
  scopes: ['read_products', 'write_products', 'read_orders', 'write_orders'],
  sessionStorage: new SQLiteSessionStorage('./database.sqlite'),
  auth: {
    path: '/api/auth',
    callbackPath: '/api/auth/callback',
  },
  webhooks: {
    path: '/api/webhooks',
  },
});

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Aplicar middleware de Shopify
app.use(shopifyAppExpress);

// Configuración de email
const transporter = nodemailer.createTransporter({
  host: process.env.EMAIL_HOST || 'smtp.gmail.com',
  port: process.env.EMAIL_PORT || 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD,
  },
});

// Configuración de Mercado Pago
mercadopago.configure({
  access_token: process.env.MERCADOPAGO_ACCESS_TOKEN,
});

// Base de datos simple (en producción usar PostgreSQL)
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./database.sqlite');

// Inicializar tablas
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS facturas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_domain TEXT NOT NULL,
    numero_factura TEXT NOT NULL,
    emisor TEXT NOT NULL,
    monto REAL NOT NULL,
    fecha_emision DATE NOT NULL,
    fecha_vencimiento DATE NOT NULL,
    estado TEXT DEFAULT 'pendiente',
    sii_data TEXT,
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

  db.run(`CREATE TABLE IF NOT EXISTS configuraciones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_domain TEXT UNIQUE NOT NULL,
    sii_rut TEXT,
    sii_password TEXT,
    mercado_pago_token TEXT,
    email_notificaciones TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// Funciones de utilidad
async function extraerFacturasSII(rut, password) {
  try {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    
    // Navegar al portal del SII
    await page.goto('https://www4.sii.cl/consdcvinternetui/');
    
    // Llenar formulario de login
    await page.type('#rutcntr', rut);
    await page.type('#clave', password);
    await page.click('#bt_ingresar');
    
    // Esperar a que cargue la página
    await page.waitForSelector('.menu-principal', { timeout: 10000 });
    
    // Navegar a la sección de facturas
    await page.click('a[href*="facturas"]');
    await page.waitForSelector('.tabla-facturas', { timeout: 10000 });
    
    // Extraer datos de facturas
    const facturas = await page.evaluate(() => {
      const rows = document.querySelectorAll('.tabla-facturas tbody tr');
      return Array.from(rows).map(row => {
        const cells = row.querySelectorAll('td');
        return {
          numero: cells[0]?.textContent?.trim(),
          emisor: cells[1]?.textContent?.trim(),
          monto: parseFloat(cells[2]?.textContent?.replace(/[^\d.-]/g, '')),
          fechaEmision: cells[3]?.textContent?.trim(),
          fechaVencimiento: cells[4]?.textContent?.trim(),
          estado: cells[5]?.textContent?.trim()
        };
      }).filter(factura => factura.numero && factura.estado === 'Pendiente');
    });
    
    await browser.close();
    return facturas;
  } catch (error) {
    console.error('Error extrayendo facturas del SII:', error);
    return [];
  }
}

async function enviarRecordatorio(factura, email) {
  const mailOptions = {
    from: process.env.EMAIL_USER,
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
app.get('/api/facturas', async (req, res) => {
  try {
    const { session } = res.locals.shopify;
    const shopDomain = session.shop;
    
    db.all(
      'SELECT * FROM facturas WHERE shop_domain = ? ORDER BY fecha_vencimiento',
      [shopDomain],
      (err, rows) => {
        if (err) {
          return res.status(500).json({ error: err.message });
        }
        res.json(rows);
      }
    );
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/facturas', async (req, res) => {
  try {
    const { session } = res.locals.shopify;
    const { numero_factura, emisor, monto, fecha_emision, fecha_vencimiento } = req.body;
    
    db.run(
      `INSERT INTO facturas (shop_domain, numero_factura, emisor, monto, fecha_emision, fecha_vencimiento)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [session.shop, numero_factura, emisor, monto, fecha_emision, fecha_vencimiento],
      function(err) {
        if (err) {
          return res.status(500).json({ error: err.message });
        }
        res.json({ id: this.lastID, message: 'Factura agregada exitosamente' });
      }
    );
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/sincronizar-sii', async (req, res) => {
  try {
    const { session } = res.locals.shopify;
    const { rut, password } = req.body;
    
    // Guardar configuración
    db.run(
      `INSERT OR REPLACE INTO configuraciones (shop_domain, sii_rut, sii_password)
       VALUES (?, ?, ?)`,
      [session.shop, rut, password]
    );
    
    // Extraer facturas del SII
    const facturasSII = await extraerFacturasSII(rut, password);
    
    // Guardar facturas en la base de datos
    let sincronizadas = 0;
    for (const factura of facturasSII) {
      db.run(
        `INSERT OR IGNORE INTO facturas (shop_domain, numero_factura, emisor, monto, fecha_emision, fecha_vencimiento, sii_data)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          session.shop,
          factura.numero,
          factura.emisor,
          factura.monto,
          factura.fechaEmision,
          factura.fechaVencimiento,
          JSON.stringify(factura)
        ],
        function(err) {
          if (!err && this.changes > 0) sincronizadas++;
        }
      );
    }
    
    res.json({ 
      message: 'Sincronización completada',
      facturas_sincronizadas: sincronizadas,
      total_facturas: facturasSII.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/facturas/:id/marcar-pagada', async (req, res) => {
  try {
    const { id } = req.params;
    const { session } = res.locals.shopify;
    
    db.run(
      `UPDATE facturas SET estado = 'pagada', pagada_at = CURRENT_TIMESTAMP 
       WHERE id = ? AND shop_domain = ?`,
      [id, session.shop],
      function(err) {
        if (err) {
          return res.status(500).json({ error: err.message });
        }
        res.json({ message: 'Factura marcada como pagada' });
      }
    );
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Tarea programada para recordatorios (se ejecuta diariamente a las 9:00 AM)
cron.schedule('0 9 * * *', async () => {
  console.log('Ejecutando verificación de recordatorios...');
  
  const hoy = new Date().toISOString().split('T')[0];
  const fechaLimite = new Date();
  fechaLimite.setDate(fechaLimite.getDate() + 3);
  const fechaLimiteStr = fechaLimite.toISOString().split('T')[0];
  
  db.all(
    `SELECT f.*, c.email_notificaciones 
     FROM facturas f 
     LEFT JOIN configuraciones c ON f.shop_domain = c.shop_domain 
     WHERE f.estado = 'pendiente' 
     AND f.fecha_vencimiento BETWEEN ? AND ?`,
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
            
            if (!recordatorio && factura.email_notificaciones) {
              // Enviar recordatorio
              const enviado = await enviarRecordatorio(factura, factura.email_notificaciones);
              
              if (enviado) {
                // Registrar recordatorio enviado
                db.run(
                  'INSERT INTO recordatorios (factura_id, fecha_recordatorio, enviado) VALUES (?, ?, ?)',
                  [factura.id, hoy, true]
                );
                console.log(`Recordatorio enviado para factura ${factura.numero_factura}`);
              }
            }
          }
        );
      }
    }
  );
});

// Ruta principal de la app
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
  console.log(`App disponible en: ${process.env.SHOPIFY_APP_URL}`);
});
