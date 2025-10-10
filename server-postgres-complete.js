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
app.use('/uploads', express.static('uploads'));

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

// Función para extraer datos del PDF
async function extraerDatosPDF(buffer) {
  console.log('🔍 Iniciando extracción de datos del PDF...');
  
  try {
    const data = await pdf(buffer);
    const texto = data.text;
    console.log('📄 Texto extraído del PDF:', texto.substring(0, 200) + '...');
    
    // Extraer número de factura
    const numeroFacturaMatch = texto.match(/N°\s*(\d+)/);
    const numeroFactura = numeroFacturaMatch ? numeroFacturaMatch[1] : 'No encontrado';
    console.log('🔢 Número de factura:', numeroFactura);
    
    // Extraer emisor
    const emisorMatch = texto.match(/RUT:\s*(\d+[-\dKk])\s*([^\n]+)/);
    const nombreEmisor = emisorMatch ? emisorMatch[2].trim() : 'No encontrado';
    console.log('🏢 Emisor:', nombreEmisor);
    
    // Extraer fecha de emisión
    let fechaEmision = new Date().toISOString().split('T')[0]; // Fecha actual por defecto
    const fechaEmisionMatch = texto.match(/Fecha Emision:\s*(\d{2}\/\d{2}\/\d{2})/);
    if (fechaEmisionMatch) {
      const fechaStr = fechaEmisionMatch[1];
      const [dia, mes, año] = fechaStr.split('/');
      const añoCompleto = parseInt(año) + 2000;
      fechaEmision = `${añoCompleto}-${mes.padStart(2, '0')}-${dia.padStart(2, '0')}`;
      console.log('📅 Fecha de emisión:', fechaEmision);
    }
    
    // Extraer pagos
    const pagos = [];
    const lineas = texto.split('\n');
    
    for (const linea of lineas) {
      if (linea.includes('$') && linea.includes('%')) {
        console.log('🔍 Procesando línea de pago:', linea);
        
        // Buscar monto y porcentaje
        let montoMatch = linea.match(/\$\s*([\d,\.]+?)(50)%/);
        let porcentaje = 50;
        
        if (!montoMatch) {
          montoMatch = linea.match(/\$\s*([\d,\.]+?)(100)%/);
          porcentaje = 100;
        }
        
        if (montoMatch) {
          const montoStr = montoMatch[1];
          const monto = parseFloat(montoStr.replace(/\./g, ''));
          const porcentajeFinal = parseInt(montoMatch[2]);
          
          // Buscar fecha de vencimiento - buscar diferentes formatos
          let fechaVencimiento = '01/01/2025'; // Fecha por defecto
          
          // Buscar formato DD/MM/YYYY
          const fechaMatch1 = linea.match(/(\d{2}\/\d{2}\/\d{4})/);
          if (fechaMatch1) {
            fechaVencimiento = fechaMatch1[1];
          } else {
            // Buscar formato DD/MM/YY
            const fechaMatch2 = linea.match(/(\d{2}\/\d{2}\/\d{2})/);
            if (fechaMatch2) {
              const fechaStr = fechaMatch2[1];
              const [dia, mes, año] = fechaStr.split('/');
              const añoCompleto = parseInt(año) + 2000;
              fechaVencimiento = `${dia}/${mes}/${añoCompleto}`;
            }
          }
          
          // Calcular días
          let dias = 0;
          if (fechaVencimiento) {
            const [dia, mes, año] = fechaVencimiento.split('/');
            const fechaVenc = new Date(año, mes - 1, dia);
            const hoy = new Date();
            dias = Math.ceil((fechaVenc - hoy) / (1000 * 60 * 60 * 24));
          }
          
          pagos.push({
            monto: monto,
            porcentaje: porcentajeFinal,
            fecha: fechaVencimiento,
            dias: dias
          });
          
          console.log('💰 Pago encontrado:', { monto, porcentaje: porcentajeFinal, fecha: fechaVencimiento, dias });
        }
      }
    }
    
    // Extraer productos
    const productos = [];
    const productosMatch = texto.match(/Productos:([\s\S]*?)(?=Total|$)/);
    if (productosMatch) {
      const productosTexto = productosMatch[1];
      const lineasProductos = productosTexto.split('\n');
      
      for (const linea of lineasProductos) {
        if (linea.trim() && !linea.includes('Total')) {
          productos.push(linea.trim());
        }
      }
    }
    
    // Calcular monto total
    const montoTotal = pagos.reduce((sum, pago) => sum + pago.monto, 0);
    
    console.log('📋 Datos extraídos:', {
      numeroFactura,
      nombreEmisor,
      fechaEmision,
      pagos: pagos.length,
      montoTotal,
      productos: productos.length
    });
    
    return {
      numeroFactura,
      emisor: nombreEmisor,
      fechaEmision,
      pagos,
      productos,
      montoTotal
    };
    
  } catch (error) {
    console.error('❌ Error extrayendo datos del PDF:', error);
    throw error;
  }
}

// Ruta para subir PDF
app.post('/api/subir-pdf', upload.single('pdf'), async (req, res) => {
  try {
    console.log('📤 Archivo recibido:', req.file.originalname);
    
    if (!req.file) {
      return res.status(400).json({ error: 'No se recibió archivo PDF' });
    }
    
    const buffer = fs.readFileSync(req.file.path);
    const datos = await extraerDatosPDF(buffer);
    
    // Guardar en PostgreSQL
    const facturas = [];
    
    for (let i = 0; i < datos.pagos.length; i++) {
      const pago = datos.pagos[i];
      const numeroFacturaFinal = datos.pagos.length > 1 ? 
        `Factura N° ${datos.numeroFactura}-${i + 1}` : 
        `Factura N° ${datos.numeroFactura}`;
      
      const client = await pool.connect();
      
      try {
        await client.query(`
          INSERT INTO facturas (numero_factura, emisor, monto, monto_total, porcentaje, fecha_vencimiento, dias, productos, archivo_pdf, fecha_emision)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `, [
          numeroFacturaFinal,
          datos.emisor,
          pago.monto,
          datos.montoTotal,
          pago.porcentaje,
          pago.fecha,
          pago.dias,
          JSON.stringify(datos.productos),
          req.file.filename,
          datos.fechaEmision
        ]);
        
        facturas.push({
          numero_factura: numeroFacturaFinal,
          emisor: datos.emisor,
          monto: pago.monto,
          monto_total: datos.montoTotal,
          porcentaje: pago.porcentaje,
          fecha_vencimiento: pago.fecha,
          dias: pago.dias,
          productos: datos.productos,
          archivo_pdf: req.file.filename,
          fecha_emision: datos.fechaEmision
        });
        
      } finally {
        client.release();
      }
    }
    
    console.log('✅ Facturas guardadas en PostgreSQL:', facturas.length);
    res.json({ success: true, facturas: facturas });
    
  } catch (error) {
    console.error('❌ Error procesando PDF:', error);
    res.status(500).json({ error: 'Error al procesar el PDF: ' + error.message });
  }
});

// Ruta para obtener facturas
app.get('/api/facturas', async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT * FROM facturas ORDER BY created_at DESC');
    client.release();
    
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Error obteniendo facturas:', error);
    res.status(500).json({ error: 'Error obteniendo facturas' });
  }
});

// Ruta para marcar factura como pagada
app.put('/api/facturas/:id/marcar-pagada', async (req, res) => {
  try {
    const id = req.params.id;
    const fechaPago = new Date().toISOString().split('T')[0];
    
    const client = await pool.connect();
    await client.query('UPDATE facturas SET estado = $1, pagada_at = $2 WHERE id = $3', ['pagada', fechaPago, id]);
    client.release();
    
    console.log('✅ Factura marcada como pagada:', id);
    res.json({ success: true, mensaje: 'Factura marcada como pagada correctamente' });
  } catch (error) {
    console.error('❌ Error marcando factura como pagada:', error);
    res.status(500).json({ error: 'Error marcando factura como pagada' });
  }
});

// Ruta principal
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Iniciar servidor
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
  console.log(`📱 App disponible en: http://localhost:${PORT}`);
  console.log(`🗄️ Base de datos: PostgreSQL`);
});

// Manejo de errores
process.on('uncaughtException', (err) => {
  console.error('❌ Error no capturado:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('❌ Promise rechazada:', err);
});
