const express = require('express');
const { shopifyApi, LATEST_API_VERSION } = require('@shopify/shopify-api');
const { shopifyApp } = require('@shopify/shopify-app-express');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const pdf = require('pdf-parse');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Crear directorio uploads si no existe
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

// Configuración de Shopify
const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY || 'demo_api_key',
  apiSecretKey: process.env.SHOPIFY_API_SECRET || 'demo_secret',
  scopes: process.env.SCOPES?.split(',') || ['read_products', 'write_products'],
  hostName: process.env.HOST?.replace(/https?:\/\//, '') || 'localhost:3000',
  apiVersion: LATEST_API_VERSION,
  isEmbeddedApp: true,
});

// Configurar Shopify App
const shopifyAppMiddleware = shopifyApp({
  api: shopify,
  auth: {
    path: '/api/auth',
    callbackPath: '/api/auth/callback',
  },
  webhooks: {
    path: '/api/webhooks',
  },
});

app.use(shopifyAppMiddleware);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Configuración de multer para PDFs
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({ storage: storage });

// Base de datos
const db = new sqlite3.Database('database.sqlite');

// Crear tabla si no existe
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS facturas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero_factura TEXT,
    emisor TEXT,
    monto REAL,
    monto_total REAL,
    porcentaje INTEGER,
    fecha_vencimiento TEXT,
    dias INTEGER,
    productos TEXT,
    archivo_pdf TEXT,
    fecha_emision TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    pagada_at DATETIME,
    estado TEXT DEFAULT 'pendiente'
  )`);
});

// Rutas de la app
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API para obtener facturas
app.get('/api/facturas', (req, res) => {
  db.all('SELECT * FROM facturas ORDER BY created_at DESC', (err, rows) => {
    if (err) {
      console.error('Error:', err);
      res.status(500).json({ error: 'Error obteniendo facturas' });
    } else {
      res.json(rows);
    }
  });
});

// API para subir PDF
app.post('/api/upload-pdf', upload.single('pdf'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No se subió ningún archivo' });
  }

  try {
    const dataBuffer = fs.readFileSync(req.file.path);
    const data = await pdf(dataBuffer);
    const texto = data.text;
    
    console.log('🔍 Iniciando extracción simplificada...');
    
    // Extraer número de factura
    const numeroFacturaMatch = texto.match(/Nº(\d+)/);
    const numeroFactura = numeroFacturaMatch ? numeroFacturaMatch[1] : 'Sin número';
    
    // Extraer emisor
    const emisorMatch = texto.match(/R\.U\.T\.:[\d\.-]+\s*([^\n]+)/);
    const nombreEmisor = emisorMatch ? emisorMatch[1].trim() : 'Emisor desconocido';
    
    // Extraer monto total
    const totalMatch = texto.match(/TOTAL\$([\d,\.]+)/);
    const montoTotalReal = totalMatch ? parseFloat(totalMatch[1].replace(/\./g, '')) : 0;
    
    // Extraer fecha de emisión
    let fechaEmision = null;
    const fechaEmisionMatch1 = texto.match(/(\d{2}\/\d{2}\/\d{2})/);
    if (fechaEmisionMatch1) {
      const fechaStr = fechaEmisionMatch1[1];
      const [dia, mes, año] = fechaStr.split('/');
      const añoCompleto = parseInt(año) + 2000;
      fechaEmision = `${añoCompleto}-${mes.padStart(2, '0')}-${dia.padStart(2, '0')}`;
    }
    
    // Buscar pagos
    const pagos = [];
    const lineas = texto.split('\n');
    
    for (const linea of lineas) {
      if (linea.includes('$') && linea.includes('%') && linea.includes('días')) {
        const fechaMatch = linea.match(/(\d{4}-\d{2}-\d{2})/);
        if (!fechaMatch) continue;
        const fecha = fechaMatch[1];
        
        // Extraer monto y porcentaje
        let montoMatch = linea.match(/\$\s*([\d,\.]+?)(50)%/);
        if (!montoMatch) {
          montoMatch = linea.match(/\$\s*([\d,\.]+?)(100)%/);
        }
        if (!montoMatch) continue;
        
        const montoStr = montoMatch[1];
        const porcentajeStr = montoMatch[2];
        const monto = parseFloat(montoStr.replace(/\./g, ''));
        const porcentaje = parseInt(porcentajeStr);
        
        const diasMatch = linea.match(/(\d+)\s*días/);
        const dias = diasMatch ? parseInt(diasMatch[1]) : 30;
        
        pagos.push({ fecha, monto, porcentaje, dias });
      }
    }
    
    // Guardar facturas en base de datos
    const facturas = [];
    if (pagos.length > 0) {
      for (let i = 0; i < pagos.length; i++) {
        const pago = pagos[i];
        const numeroFacturaFinal = pagos.length > 1 ? `Factura N° ${numeroFactura}-${i + 1}` : `Factura N° ${numeroFactura}`;
        
        const fechaEmisionFinal = fechaEmision || new Date().toISOString().split('T')[0];
        
        db.run(
          `INSERT INTO facturas (numero_factura, emisor, monto, monto_total, porcentaje, fecha_vencimiento, dias, productos, archivo_pdf, fecha_emision)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [numeroFacturaFinal, nombreEmisor, pago.monto, montoTotalReal, pago.porcentaje, pago.fecha, pago.dias, '[]', req.file.filename, fechaEmisionFinal],
          function(err) {
            if (err) {
              console.error('Error guardando factura:', err);
            } else {
              console.log('✅ Factura guardada:', numeroFacturaFinal, '- $' + pago.monto);
            }
          }
        );
        
        facturas.push({
          numero_factura: numeroFacturaFinal,
          emisor: nombreEmisor,
          monto: pago.monto,
          monto_total: montoTotalReal,
          porcentaje: pago.porcentaje,
          fecha_vencimiento: pago.fecha,
          dias: pago.dias
        });
      }
    }
    
    res.json({ 
      success: true, 
      message: `PDF procesado correctamente. ${facturas.length} factura(s) creada(s).`,
      facturas: facturas
    });
    
  } catch (error) {
    console.error('Error procesando PDF:', error);
    res.status(500).json({ error: 'Error procesando PDF' });
  }
});

// API para marcar como pagada
app.put('/api/facturas/:id/marcar-pagada', (req, res) => {
  const id = req.params.id;
  const fechaPago = new Date().toISOString().split('T')[0];
  
  db.run('UPDATE facturas SET estado = ?, pagada_at = ? WHERE id = ?', 
    ['pagada', fechaPago, id], 
    function(err) {
      if (err) {
        console.error('Error:', err);
        res.status(500).json({ error: 'Error marcando factura como pagada' });
      } else {
        res.json({ success: true, message: 'Factura marcada como pagada' });
      }
    }
  );
});

app.listen(PORT, () => {
  console.log(`🚀 Shopify App corriendo en puerto ${PORT}`);
  console.log(`📱 App disponible en: http://localhost:${PORT}`);
});
