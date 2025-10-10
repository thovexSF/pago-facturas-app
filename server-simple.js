const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;

// Configurar multer para subir archivos
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({ storage: storage });

// Configurar base de datos
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
    fecha_creacion DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// Middleware
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Función simplificada para extraer datos del PDF
async function extraerDatosPDF(buffer) {
  console.log('🔍 Iniciando extracción simplificada...');
  
  const data = await pdfParse(buffer);
  const texto = data.text;
  
  // 1. Datos básicos
  const numeroFactura = texto.match(/Nº(\d+)/)?.[1] || `PDF-${Date.now()}`;
  const totalMatch = texto.match(/TOTAL\$([\d,\.]+)/);
  const montoTotalReal = totalMatch ? parseFloat(totalMatch[1].replace(/\./g, '')) : null;
  const nombreEmisor = texto.match(/^([A-Za-z\s\.]+SPA?)/m)?.[1] || 'Proveedor PDF';
  
  // Extraer fecha de emisión del PDF - buscar en la parte superior del documento
  let fechaEmision = null;
  
  // Dividir el texto en líneas para buscar la fecha de emisión en la parte superior
  const lineasTexto = texto.split('\n');
  const lineasSuperiores = lineasTexto.slice(0, 20); // Buscar en las primeras 20 líneas
  const textoSuperior = lineasSuperiores.join('\n');
  
  console.log('🔍 Líneas que podrían contener fecha de emisión:', lineasSuperiores.filter(linea => 
    linea.includes('/') || linea.includes('-') || linea.match(/\d{2,4}/)
  ));
  
  // Buscar formato "Fecha Emision:DD de Mes del YYYY" en la parte superior
  const fechaEmisionMatch1 = textoSuperior.match(/Fecha Emision:(\d{1,2}) de (\w+) del (\d{4})/);
  if (fechaEmisionMatch1) {
    const [, dia, mesNombre, año] = fechaEmisionMatch1;
    const meses = {
      'Enero': '01', 'Febrero': '02', 'Marzo': '03', 'Abril': '04',
      'Mayo': '05', 'Junio': '06', 'Julio': '07', 'Agosto': '08',
      'Septiembre': '09', 'Octubre': '10', 'Noviembre': '11', 'Diciembre': '12'
    };
    const mesNumero = meses[mesNombre] || '01';
    fechaEmision = `${año}-${mesNumero}-${dia.padStart(2, '0')}`;
    console.log('🔍 Fecha de emisión extraída del PDF (DD de Mes del YYYY):', `${dia} de ${mesNombre} del ${año}`, '->', fechaEmision);
  }
  
  // Si no se encontró, buscar formato "Fecha Emision:DD de Mes del YY" (año cortado)
  if (!fechaEmision) {
    const fechaEmisionMatch1b = textoSuperior.match(/Fecha Emision:(\d{1,2}) de (\w+) del (\d{1,2})/);
    if (fechaEmisionMatch1b) {
      const [, dia, mesNombre, añoCorto] = fechaEmisionMatch1b;
      const meses = {
        'Enero': '01', 'Febrero': '02', 'Marzo': '03', 'Abril': '04',
        'Mayo': '05', 'Junio': '06', 'Julio': '07', 'Agosto': '08',
        'Septiembre': '09', 'Octubre': '10', 'Noviembre': '11', 'Diciembre': '12'
      };
      const mesNumero = meses[mesNombre] || '01';
      // Si el año es muy corto (1-2 dígitos), asumir que es 2025
      const añoCompleto = parseInt(añoCorto) < 10 ? 2025 : parseInt(añoCorto) + 2000;
      fechaEmision = `${añoCompleto}-${mesNumero}-${dia.padStart(2, '0')}`;
      console.log('🔍 Fecha de emisión extraída del PDF (DD de Mes del YY):', `${dia} de ${mesNombre} del ${añoCorto}`, '->', fechaEmision);
    }
  }
  
  // Si no se encontró, buscar formato DD/MM/YY en la parte superior
  if (!fechaEmision) {
    const fechaEmisionMatch2 = textoSuperior.match(/(\d{2}\/\d{2}\/\d{2})/);
    if (fechaEmisionMatch2) {
      const fechaStr = fechaEmisionMatch2[1]; // formato: 23/06/25
      const [dia, mes, año] = fechaStr.split('/');
      const añoCompleto = parseInt(año) + 2000; // 25 -> 2025
      fechaEmision = `${añoCompleto}-${mes.padStart(2, '0')}-${dia.padStart(2, '0')}`;
      console.log('🔍 Fecha de emisión extraída del PDF (DD/MM/YY):', fechaStr, '->', fechaEmision);
    }
  }
  
  // Si no se encontró, buscar formato DD/MM/YYYY en la parte superior
  if (!fechaEmision) {
    const fechaEmisionMatch3 = textoSuperior.match(/(\d{2}\/\d{2}\/\d{4})/);
    if (fechaEmisionMatch3) {
      const fechaStr = fechaEmisionMatch3[1]; // formato: 23/06/2025
      const [dia, mes, año] = fechaStr.split('/');
      fechaEmision = `${año}-${mes.padStart(2, '0')}-${dia.padStart(2, '0')}`;
      console.log('🔍 Fecha de emisión extraída del PDF (DD/MM/YYYY):', fechaStr, '->', fechaEmision);
    }
  }
  
  // Si aún no se encontró, buscar formato DD-MM-YYYY en la parte superior
  if (!fechaEmision) {
    const fechaEmisionMatch4 = textoSuperior.match(/(\d{2}-\d{2}-\d{4})/);
    if (fechaEmisionMatch4) {
      const fechaStr = fechaEmisionMatch4[1]; // formato: 23-06-2025
      const [dia, mes, año] = fechaStr.split('-');
      fechaEmision = `${año}-${mes}-${dia}`;
      console.log('🔍 Fecha de emisión extraída del PDF (DD-MM-YYYY):', fechaStr, '->', fechaEmision);
    }
  }
  
  console.log('📋 Datos básicos:', { numeroFactura, montoTotalReal, nombreEmisor, fechaEmision });
  
  // Debug: mostrar líneas que contienen fechas
  const lineasConFechas = texto.split('\n').filter(linea => 
    linea.includes('/') || linea.includes('-') || linea.includes('emisión') || linea.includes('Emisión')
  );
  console.log('🔍 Líneas que podrían contener fecha de emisión:', lineasConFechas.slice(0, 10));
  
  // 2. Buscar productos (LÓGICA COMPLETA CON DEBUG)
  const productos = [];
  const productosConPrecios = [];
  const productosUnicos = new Set(); // Para evitar duplicados
  
  console.log('🔍 Buscando productos en el texto...');
  
  // Debug: mostrar líneas que contienen productos
  const lineasConProductos = texto.split('\n').filter(linea => 
    linea.includes('-') && linea.includes('kg') && linea.includes('30')
  );
  console.log('🔍 Líneas con productos encontradas:', lineasConProductos);
  
  // Patrón para productos con kg: -Café Verde kaypacha30kg9.600288.000
  const productosRegex = /-([A-Za-z\sáéíóúñ]+?)(\d+)kg([\d,\.]+)/g;
  let productoMatch;
  let matchCount = 0;
  
  while ((productoMatch = productosRegex.exec(texto)) !== null) {
    matchCount++;
    console.log(`🔍 Match ${matchCount}:`, productoMatch[0]);
    
    const producto = productoMatch[1].trim();
    const cantidad = productoMatch[2];
    const precioStr = productoMatch[3];
    
    console.log(`🔍 Producto: "${producto}", Cantidad: ${cantidad}, PrecioStr: ${precioStr}`);
    
    // Extraer el precio correcto (formato: 9.600288.000 -> 9600)
    const precioMatch = precioStr.match(/(\d+\.\d{3})/);
    const cleanPrecioStr = precioMatch ? precioMatch[1].replace(/\./g, '') : '0';
    const precio = parseInt(cleanPrecioStr);
    const precioPorKg = cantidad > 0 ? (precio / parseInt(cantidad)).toFixed(0) : '0';
    
    console.log(`🔍 Precio extraído: ${precio}, PrecioPorKg: ${precioPorKg}`);
    
    const productoKey = `${producto}-${cantidad}`;
    if (producto && producto.length > 3 && !productosUnicos.has(productoKey)) {
      productosUnicos.add(productoKey);
      productos.push(producto);
      productosConPrecios.push({
        nombre: producto,
        cantidad: cantidad,
        precio: precio,
        precioPorKg: precioPorKg,
        porcentaje: 50 // Porcentaje por defecto
      });
      console.log(`✅ Producto agregado: ${producto}`);
    } else {
      console.log(`❌ Producto omitido: ${producto} (duplicado o muy corto)`);
    }
  }
  
  console.log(`🔍 Total matches encontrados: ${matchCount}`);
  
  // Buscar despacho: -despacho camino farellone1  ida14.00014.000
  const despachoRegex = /-despacho\s+([^0-9]+)\s*(\d+)\s+ida\s*([\d,\.]+)/g;
  let despachoMatch;
  
  while ((despachoMatch = despachoRegex.exec(texto)) !== null) {
    const nombre = `Despacho ${despachoMatch[1].trim()}`;
    const cantidad = despachoMatch[2];
    const precioStr = despachoMatch[3];
    
    // Extraer solo el precio correcto (formato: 14.00014.000 -> 14000)
    const precioMatch = precioStr.match(/(\d+\.\d{3})/);
    const cleanPrecioStr = precioMatch ? precioMatch[1].replace(/\./g, '') : '0';
    const precio = parseInt(cleanPrecioStr);
    
    const productoKey = `${nombre}-${cantidad}`;
    if (!productosUnicos.has(productoKey)) {
      productosUnicos.add(productoKey);
      productosConPrecios.push({
        nombre: nombre,
        cantidad: cantidad,
        precio: precio,
        precioPorKg: precio.toString(),
        porcentaje: 50, // Porcentaje por defecto
        esDespacho: true // Marcar como despacho
      });
    }
  }
  
  console.log('🛍️ Productos encontrados:', productos);

  // 3. Buscar pagos
  const pagos = [];
  const pagosUnicos = new Set();
  
  console.log('🔍 Buscando pagos en el texto...');
  const lineas = texto.split('\n');
  
  // Debug: mostrar líneas que contienen $ y %
  const lineasConDolar = lineas.filter(linea => linea.includes('$'));
  console.log('🔍 Líneas con $:', lineasConDolar);
  
  const lineasConPorcentaje = lineas.filter(linea => linea.includes('%'));
  console.log('🔍 Líneas con %:', lineasConPorcentaje);
  
  for (const linea of lineas) {
    if (linea.includes('$') && linea.includes('%') && linea.includes('días')) {
      console.log('🔍 Línea de pago:', linea);
      
      // Extraer fecha
      const fechaMatch = linea.match(/(\d{4}-\d{2}-\d{2})/);
      if (!fechaMatch) continue;
      const fecha = fechaMatch[1];
      console.log('🔍 Fecha extraída del PDF:', fecha);
      
      // Extraer monto y porcentaje - formato: 865.130100% o 387.94050%
      // Buscar el patrón: $ monto.xxxporcentaje%
      // Usar regex específico para cada caso
      let montoMatch = linea.match(/\$\s*([\d,\.]+?)(50)%/); // Para 50%
      let porcentaje = 50;
      
      if (!montoMatch) {
        montoMatch = linea.match(/\$\s*([\d,\.]+?)(100)%/); // Para 100%
        porcentaje = 100;
      }
      
      if (!montoMatch) continue;
      
      const montoStr = montoMatch[1]; // "865.130" o "387.940"
      const porcentajeStr = montoMatch[2]; // "100" o "50"
      
      // En formato chileno, el punto es separador de miles
      const monto = parseFloat(montoStr.replace(/\./g, ''));
      const porcentajeFinal = parseInt(porcentajeStr);
      
      // Extraer días
      const diasMatch = linea.match(/(\d+)\s*días/);
      const dias = diasMatch ? parseInt(diasMatch[1]) : 30;
      
      const pagoKey = `${fecha}-${monto}-${porcentajeFinal}`;
      if (!pagosUnicos.has(pagoKey)) {
        pagosUnicos.add(pagoKey);
        pagos.push({ fecha, monto, porcentaje: porcentajeFinal, dias });
        console.log('✅ Pago agregado:', { fecha, monto, porcentaje: porcentajeFinal, dias });
      }
    }
  }
  
  console.log('📅 Pagos encontrados:', pagos);
  console.log('📊 Total de pagos encontrados:', pagos.length);
  
  // 4. Crear facturas
  const facturas = [];
  if (pagos.length > 0) {
    pagos.forEach((pago, index) => {
      const montoTotalFactura = montoTotalReal || (pago.porcentaje > 0 ? (pago.monto / (pago.porcentaje / 100)) : pago.monto);
      
      // Crear tabla de productos (LÓGICA ORIGINAL PERFECTA)
        const productosDetalle = `
          <table style="width: 120%; border-collapse: separate; border-spacing: 0; font-size: 11px; background-color: white; position: relative; left: -120px; border: 1px solid #ccc; border-radius: 8px; overflow: hidden; line-height: 1.3;">
            <tbody>
              ${productosConPrecios.map(p => `
                <tr>
                  <td style="padding: 5px 8px; text-align: left; background-color: white; width: 85%;">${p.nombre}</td>
                  <td style="padding: 5px 8px; text-align: right; background-color: white; width: 15%;">$${p.precio.toLocaleString('es-CL')}${p.esDespacho ? '' : '/kg'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `;
      
      // Solo agregar guión si hay múltiples pagos
      const numeroFacturaFinal = pagos.length > 1 ? `Factura N° ${numeroFactura}-${index + 1}` : `Factura N° ${numeroFactura}`;
      
      facturas.push({
        numero_factura: numeroFacturaFinal,
        emisor: nombreEmisor,
        monto: pago.monto,
        monto_total: montoTotalFactura,
        porcentaje: pago.porcentaje,
        fecha_vencimiento: pago.fecha,
        dias: pago.dias,
        productos: productosDetalle,
        fecha_emision: fechaEmision
      });
    });
  } else {
    console.log('⚠️ No se encontraron pagos, creando factura por defecto');
    console.log('🔍 Texto completo del PDF (primeros 500 caracteres):', texto.substring(0, 500));
    
    // Crear factura por defecto cuando no se encuentran pagos
    const montoTotalFactura = montoTotalReal || 0;
    const productosDetalle = productosConPrecios.length > 0 ? `
      <table style="width: 120%; border-collapse: separate; border-spacing: 0; font-size: 11px; background-color: white; position: relative; left: -120px; border: 1px solid #ccc; border-radius: 8px; overflow: hidden; line-height: 1.3;">
        <tbody>
          ${productosConPrecios.map(p => `
            <tr>
              <td style="padding: 5px 8px; text-align: left; background-color: white; width: 85%;">${p.nombre}</td>
              <td style="padding: 5px 8px; text-align: right; background-color: white; width: 15%;">$${p.precio.toLocaleString('es-CL')}${p.esDespacho ? '' : '/kg'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    ` : '';
    
    facturas.push({
      numero_factura: `Factura N° ${numeroFactura}`,
      emisor: nombreEmisor,
      monto: montoTotalFactura,
      monto_total: montoTotalFactura,
      porcentaje: 50,
      fecha_vencimiento: new Date().toISOString().split('T')[0],
      dias: 30,
      productos: productosDetalle,
      fecha_emision: fechaEmision
    });
  }
  
  return facturas;
}

// Ruta para subir PDF
app.post('/api/subir-pdf', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No se subió ningún archivo' });
    }

    console.log('📄 Procesando PDF:', req.file.filename);
    
    const buffer = fs.readFileSync(req.file.path);
    const facturas = await extraerDatosPDF(buffer);
    
    // Guardar en base de datos con validación de duplicados
    let facturasGuardadas = 0;
    let facturasDuplicadas = 0;
    let operacionesCompletadas = 0;
    
    if (facturas.length === 0) {
      return res.json({ 
        success: true, 
        facturas: 0,
        guardadas: 0,
        duplicadas: 0,
        message: 'No se encontraron facturas en el PDF'
      });
    }
    
    for (const factura of facturas) {
      // Verificar si ya existe una factura con el mismo número y emisor
      db.get(
        `SELECT id FROM facturas WHERE numero_factura = ? AND emisor = ?`,
        [factura.numero_factura, factura.emisor],
        function(err, row) {
          operacionesCompletadas++;
          
          if (err) {
            console.error('❌ Error verificando duplicado:', err);
            if (operacionesCompletadas === facturas.length) {
              res.json({ 
                success: false, 
                error: 'Error verificando duplicados'
              });
            }
            return;
          }
          
          if (row) {
            console.log('⚠️ Factura duplicada encontrada:', factura.numero_factura, '-', factura.emisor);
            facturasDuplicadas++;
          } else {
            // No existe, proceder a insertar
            const fechaEmision = factura.fecha_emision || new Date().toISOString().split('T')[0];
            console.log('🔍 Fecha de vencimiento a guardar:', factura.fecha_vencimiento);
            console.log('🔍 Fecha de emisión a guardar:', fechaEmision);
            
            db.run(
              `INSERT INTO facturas (numero_factura, emisor, monto, monto_total, porcentaje, fecha_vencimiento, dias, productos, archivo_pdf, fecha_emision) 
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [factura.numero_factura, factura.emisor, factura.monto, factura.monto_total, 
               factura.porcentaje, factura.fecha_vencimiento, factura.dias, factura.productos, req.file.filename, fechaEmision],
              function(err) {
                if (err) {
                  console.error('❌ Error guardando factura:', err);
                } else {
                  console.log('✅ Factura guardada:', factura.numero_factura, '- $' + factura.monto);
                  facturasGuardadas++;
                }
              }
            );
          }
          
          // Verificar si todas las operaciones están completas
          if (operacionesCompletadas === facturas.length) {
            res.json({ 
              success: true, 
              facturas: facturas.length,
              guardadas: facturasGuardadas,
              duplicadas: facturasDuplicadas,
              message: facturasDuplicadas > 0 
                ? `Se procesaron ${facturas.length} facturas. ${facturasGuardadas} nuevas, ${facturasDuplicadas} duplicadas omitidas.`
                : `Se procesaron ${facturas.length} facturas correctamente`
            });
          }
        }
      );
    }
    
  } catch (error) {
    console.error('❌ Error procesando PDF:', error);
    res.status(500).json({ error: 'Error procesando el PDF' });
  }
});

// Ruta para obtener facturas
app.get('/api/facturas', (req, res) => {
  db.all('SELECT * FROM facturas ORDER BY id DESC', (err, rows) => {
    if (err) {
      console.error('❌ Error obteniendo facturas:', err);
      res.status(500).json({ error: 'Error obteniendo facturas' });
    } else {
      res.json(rows);
    }
  });
});

// Ruta para eliminar factura
app.delete('/api/facturas/:id', (req, res) => {
  const id = req.params.id;
  db.run('DELETE FROM facturas WHERE id = ?', [id], function(err) {
    if (err) {
      console.error('❌ Error eliminando factura:', err);
      res.status(500).json({ error: 'Error eliminando factura' });
    } else {
      res.json({ success: true, mensaje: 'Factura eliminada correctamente' });
    }
  });
});

// Ruta para marcar factura como pagada
app.put('/api/facturas/:id/marcar-pagada', (req, res) => {
  const id = req.params.id;
  const fechaPago = new Date().toISOString().split('T')[0]; // Fecha actual en formato YYYY-MM-DD
  
  db.run('UPDATE facturas SET estado = ?, pagada_at = ? WHERE id = ?', ['pagada', fechaPago, id], function(err) {
    if (err) {
      console.error('❌ Error marcando factura como pagada:', err);
      res.status(500).json({ error: 'Error marcando factura como pagada' });
    } else {
      console.log('✅ Factura marcada como pagada:', id);
      res.json({ success: true, mensaje: 'Factura marcada como pagada correctamente' });
    }
  });
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
  console.log(`📱 App disponible en: http://localhost:${PORT}`);
});
