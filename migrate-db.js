const { Pool } = require('pg');
require('dotenv').config();

async function migrate() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
  });

  try {
    console.log('🔗 Conectando a PostgreSQL...');
    const client = await pool.connect();
    
    console.log('📋 Creando tabla facturas...');
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
    
    console.log('✅ Tabla facturas creada exitosamente');
    
    // Verificar que la tabla existe
    const result = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name = 'facturas'
    `);
    
    if (result.rows.length > 0) {
      console.log('✅ Tabla facturas verificada');
    } else {
      console.log('❌ Tabla facturas no encontrada');
    }
    
    client.release();
    console.log('🎉 Migración completada');
    
  } catch (err) {
    console.error('❌ Error en migración:', err);
  } finally {
    await pool.end();
  }
}

migrate();
