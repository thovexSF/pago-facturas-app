const express = require('express');
const { Pool } = require('pg');
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

// Configuración de PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/facturas',
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

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

// Ruta principal
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Pago Facturas - Railway + PostgreSQL</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            body { font-family: Arial, sans-serif; margin: 40px; }
            .container { max-width: 800px; margin: 0 auto; }
            .success { color: #28a745; }
            .info { background: #f8f9fa; padding: 20px; border-radius: 5px; }
            .btn { background: #007bff; color: white; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1 class="success">✅ App funcionando en Railway + PostgreSQL!</h1>
            <div class="info">
                <h2>🚀 Servidor activo</h2>
                <p><strong>Puerto:</strong> ${PORT}</p>
                <p><strong>Entorno:</strong> ${process.env.NODE_ENV || 'development'}</p>
                <p><strong>Base de datos:</strong> PostgreSQL</p>
                <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
            </div>
            <h2>📋 Funcionalidades:</h2>
            <ul>
                <li>✅ Deploy exitoso en Railway</li>
                <li>✅ Servidor respondiendo</li>
                <li>✅ PostgreSQL configurado</li>
                <li>🔄 Gestión de facturas</li>
                <li>🔄 Integración con Shopify</li>
            </ul>
            <button class="btn" onclick="window.location.href='/test-db'">Probar Base de Datos</button>
        </div>
    </body>
    </html>
  `);
});

// Ruta de healthcheck
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    port: PORT,
    database: 'postgresql'
  });
});

// Ruta para probar la base de datos
app.get('/test-db', async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW() as current_time, version() as postgres_version');
    client.release();
    
    res.json({
      status: 'success',
      message: 'Conexión a PostgreSQL exitosa',
      data: result.rows[0],
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('❌ Error conectando a PostgreSQL:', err);
    res.status(500).json({
      status: 'error',
      message: 'Error conectando a PostgreSQL',
      error: err.message
    });
  }
});

// Ruta para crear tabla de facturas
app.get('/setup-db', async (req, res) => {
  try {
    const client = await pool.connect();
    
    // Crear tabla de facturas
    await client.query(`
      CREATE TABLE IF NOT EXISTS facturas (
        id SERIAL PRIMARY KEY,
        numero_factura VARCHAR(255) NOT NULL,
        emisor VARCHAR(255) NOT NULL,
        monto DECIMAL(10,2) NOT NULL,
        monto_total DECIMAL(10,2) NOT NULL,
        porcentaje INTEGER NOT NULL,
        fecha_vencimiento DATE NOT NULL,
        dias INTEGER NOT NULL,
        productos TEXT,
        archivo_pdf VARCHAR(255),
        fecha_emision DATE,
        estado VARCHAR(50) DEFAULT 'pendiente',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        pagada_at TIMESTAMP
      )
    `);
    
    client.release();
    
    res.json({
      status: 'success',
      message: 'Tabla de facturas creada exitosamente',
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('❌ Error creando tabla:', err);
    res.status(500).json({
      status: 'error',
      message: 'Error creando tabla',
      error: err.message
    });
  }
});

// Iniciar servidor
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
  console.log(`📱 App disponible en: http://localhost:${PORT}`);
  console.log(`🔍 Healthcheck en: http://localhost:${PORT}/health`);
  console.log(`🗄️ Base de datos: PostgreSQL`);
});

// Manejo de errores
process.on('uncaughtException', (err) => {
  console.error('❌ Error no capturado:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('❌ Promise rechazada:', err);
});
