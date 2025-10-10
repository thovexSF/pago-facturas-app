const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware básico
app.use(cors());
app.use(express.json());

// Ruta principal
app.get('/', (req, res) => {
  res.json({
    status: 'success',
    message: 'Pago Facturas App funcionando en Railway!',
    timestamp: new Date().toISOString(),
    port: PORT,
    environment: process.env.NODE_ENV || 'development'
  });
});

// Ruta de healthcheck
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    port: PORT 
  });
});

// Ruta de prueba
app.get('/test', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Pago Facturas - Test</title>
        <meta charset="utf-8">
        <style>
            body { font-family: Arial, sans-serif; margin: 40px; }
            .success { color: #28a745; font-size: 24px; }
            .info { background: #f8f9fa; padding: 20px; border-radius: 5px; margin: 20px 0; }
        </style>
    </head>
    <body>
        <h1 class="success">✅ App funcionando en Railway!</h1>
        <div class="info">
            <h2>🚀 Servidor activo</h2>
            <p><strong>Puerto:</strong> ${PORT}</p>
            <p><strong>Entorno:</strong> ${process.env.NODE_ENV || 'development'}</p>
            <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
        </div>
        <h2>📋 Rutas disponibles:</h2>
        <ul>
            <li><a href="/">/ - Página principal (JSON)</a></li>
            <li><a href="/health">/health - Healthcheck</a></li>
            <li><a href="/test">/test - Página de prueba (HTML)</a></li>
        </ul>
    </body>
    </html>
  `);
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
