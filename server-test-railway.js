const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const pdf = require('pdf-parse');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Crear directorio uploads si no existe
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Ruta principal
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Pago Facturas - Railway</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            body { font-family: Arial, sans-serif; margin: 40px; }
            .container { max-width: 800px; margin: 0 auto; }
            .success { color: #28a745; }
            .info { background: #f8f9fa; padding: 20px; border-radius: 5px; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1 class="success">✅ App funcionando en Railway!</h1>
            <div class="info">
                <h2>🚀 Servidor activo</h2>
                <p><strong>Puerto:</strong> ${PORT}</p>
                <p><strong>Entorno:</strong> ${process.env.NODE_ENV || 'development'}</p>
                <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
            </div>
            <h2>📋 Próximos pasos:</h2>
            <ul>
                <li>✅ Deploy exitoso en Railway</li>
                <li>✅ Servidor respondiendo</li>
                <li>🔄 Configurar Shopify integration</li>
                <li>🔄 Agregar funcionalidades de facturas</li>
            </ul>
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
    port: PORT 
  });
});

// Iniciar servidor
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
  console.log(`📱 App disponible en: http://localhost:${PORT}`);
  console.log(`🔍 Healthcheck en: http://localhost:${PORT}/health`);
});

// Manejo de errores
process.on('uncaughtException', (err) => {
  console.error('❌ Error no capturado:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('❌ Promise rechazada:', err);
});
