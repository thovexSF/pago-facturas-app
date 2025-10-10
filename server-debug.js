const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Ruta principal
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Pago Facturas - Debug</title>
        <meta charset="utf-8">
        <style>
            body { font-family: Arial, sans-serif; margin: 40px; }
            .container { max-width: 800px; margin: 0 auto; }
            .info { background: #f8f9fa; padding: 20px; border-radius: 5px; margin: 20px 0; }
            .error { background: #f8d7da; color: #721c24; padding: 20px; border-radius: 5px; margin: 20px 0; }
            .success { background: #d4edda; color: #155724; padding: 20px; border-radius: 5px; margin: 20px 0; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🔍 Pago Facturas - Debug</h1>
            
            <div class="info">
                <h2>📊 Variables de Entorno</h2>
                <p><strong>NODE_ENV:</strong> ${process.env.NODE_ENV || 'no definido'}</p>
                <p><strong>PORT:</strong> ${PORT}</p>
                <p><strong>DATABASE_URL:</strong> ${process.env.DATABASE_URL ? '✅ Configurada' : '❌ No configurada'}</p>
            </div>
            
            <div class="info">
                <h2>🔗 URLs de Prueba</h2>
                <ul>
                    <li><a href="/test-db">/test-db - Probar conexión PostgreSQL</a></li>
                    <li><a href="/setup-db">/setup-db - Crear tabla facturas</a></li>
                    <li><a href="/env">/env - Ver todas las variables</a></li>
                </ul>
            </div>
        </div>
    </body>
    </html>
  `);
});

// Ruta para ver variables de entorno
app.get('/env', (req, res) => {
  res.json({
    NODE_ENV: process.env.NODE_ENV,
    PORT: PORT,
    DATABASE_URL: process.env.DATABASE_URL ? 'Configurada' : 'No configurada',
    timestamp: new Date().toISOString()
  });
});

// Ruta para probar PostgreSQL
app.get('/test-db', async (req, res) => {
  try {
    if (!process.env.DATABASE_URL) {
      return res.json({
        status: 'error',
        message: 'DATABASE_URL no está configurada',
        timestamp: new Date().toISOString()
      });
    }

    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    });

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
    res.json({
      status: 'error',
      message: 'Error conectando a PostgreSQL',
      error: err.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Ruta para crear tabla
app.get('/setup-db', async (req, res) => {
  try {
    if (!process.env.DATABASE_URL) {
      return res.json({
        status: 'error',
        message: 'DATABASE_URL no está configurada',
        timestamp: new Date().toISOString()
      });
    }

    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    });

    const client = await pool.connect();
    
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
    res.json({
      status: 'error',
      message: 'Error creando tabla',
      error: err.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Iniciar servidor
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor debug corriendo en puerto ${PORT}`);
  console.log(`📱 App disponible en: http://localhost:${PORT}`);
});

// Manejo de errores
process.on('uncaughtException', (err) => {
  console.error('❌ Error no capturado:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('❌ Promise rechazada:', err);
});
