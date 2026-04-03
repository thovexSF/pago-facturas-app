const express = require('express');
const { Pool } = require('pg');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

// ─── PostgreSQL ──────────────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function setupDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS facturas_recibidas (
      id SERIAL PRIMARY KEY,
      codigo VARCHAR(50) UNIQUE,
      rut_emisor VARCHAR(20),
      razon_social VARCHAR(255),
      tipo_documento VARCHAR(100),
      tipo_codigo INTEGER,
      folio INTEGER,
      fecha_emision DATE,
      fecha_vencimiento DATE,
      monto BIGINT,
      estado_sii VARCHAR(50),
      estado_pago VARCHAR(20) DEFAULT 'pendiente',
      pagada_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('[DB] Tabla facturas_recibidas lista');
}

// ─── API Routes ───────────────────────────────────────────────────────────────

// GET /api/facturas
app.get('/api/facturas', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM facturas_recibidas ORDER BY fecha_vencimiento ASC NULLS LAST'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sync — por ahora retorna instrucción de cómo sincronizar
app.post('/api/sync', async (req, res) => {
  res.status(503).json({
    error: 'Sincronización SII en desarrollo. Próximamente disponible.',
    needsLogin: true,
  });
});

// PUT /api/facturas/:id/pagar
app.put('/api/facturas/:id/pagar', async (req, res) => {
  try {
    await pool.query(
      `UPDATE facturas_recibidas
       SET estado_pago = 'pagada', pagada_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /health
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Startup ──────────────────────────────────────────────────────────────────

async function start() {
  await setupDb();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor corriendo en puerto ${PORT}`);
  });
}

start().catch(err => {
  console.error('Error iniciando servidor:', err);
  process.exit(1);
});
