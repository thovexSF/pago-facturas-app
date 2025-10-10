// Configuración de Shopify App Bridge
const { createApp } = window['app-bridge'];
const { getSessionToken } = window['app-bridge-utils'];

// Inicializar App Bridge (modo demo sin autenticación)
const app = createApp({
  apiKey: 'demo_api_key',
  shop: 'demo-shop.myshopify.com',
  forceRedirect: false
});

// Variables globales
let facturas = [];

// Inicialización
document.addEventListener('DOMContentLoaded', function() {
    initializeApp();
    loadFacturas();
    loadStats();
    
    // Event listeners
    document.getElementById('pdf-upload-form').addEventListener('submit', handlePdfUpload);
    document.getElementById('config-form').addEventListener('submit', handleConfigSave);
});

function initializeApp() {
    console.log('🚀 Aplicación inicializada');
}

// Función para formatear números con puntos como separadores de miles
function formatearNumero(numero) {
    return numero.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

// Funciones para mostrar/ocultar secciones
function showUploadForm() {
    document.getElementById('upload-section').style.display = 'block';
    document.getElementById('config-section').style.display = 'none';
}

function hideUploadForm() {
    document.getElementById('upload-section').style.display = 'none';
}

function showConfig() {
    document.getElementById('config-section').style.display = 'block';
    document.getElementById('upload-section').style.display = 'none';
}

function hideConfig() {
    document.getElementById('config-section').style.display = 'none';
}

// Cargar estadísticas
async function loadStats() {
    try {
        const response = await fetch('/api/facturas');
        const data = await response.json();
        
        const total = data.length;
        const pendientes = data.filter(f => f.estado === 'pendiente').length;
        const vencidas = data.filter(f => {
            const hoy = new Date();
            const vencimiento = new Date(f.fecha_vencimiento);
            return vencimiento < hoy && f.estado === 'pendiente';
        }).length;
        const montoTotal = data
            .filter(f => f.estado === 'pendiente')
            .reduce((sum, f) => sum + parseFloat(f.monto), 0);
        
        document.getElementById('total-facturas').textContent = total;
        document.getElementById('facturas-pendientes').textContent = pendientes;
        document.getElementById('facturas-vencidas').textContent = vencidas;
        document.getElementById('monto-total').textContent = `$${montoTotal.toLocaleString()}`;
        
        console.log('📊 Stats actualizadas:', { total, pendientes, vencidas, montoTotal });
        
    } catch (error) {
        console.error('Error cargando estadísticas:', error);
    }
}

// Cargar facturas
async function loadFacturas() {
    try {
        const response = await fetch('/api/facturas');
        const data = await response.json();
        facturas = data;
        
        const facturasList = document.getElementById('facturas-list');
        if (data.length === 0) {
            facturasList.innerHTML = `
                <div class="empty-state">
                    <h4>📄 No hay facturas registradas</h4>
                    <p>Arrastra un PDF aquí o sube tu primer archivo para comenzar</p>
                    <button class="btn btn-primary" onclick="showUploadForm()">Subir PDF</button>
                </div>
            `;
        } else {
            facturasList.innerHTML = data.map(factura => createFacturaHTML(factura)).join('');
        }
        
    } catch (error) {
        console.error('Error cargando facturas:', error);
        showNotification('Error cargando facturas', 'error');
    }
}

// Crear HTML para factura
function createFacturaHTML(factura) {
    // Crear fecha de vencimiento sin problemas de zona horaria
    const fechaVencimiento = new Date(factura.fecha_vencimiento + 'T00:00:00');
    const hoy = new Date();
    const diasRestantes = Math.ceil((fechaVencimiento - hoy) / (1000 * 60 * 60 * 24));
    
    // Debug: mostrar datos de la factura
    console.log('🔍 Datos de factura:', {
        numero: factura.numero_factura,
        monto: factura.monto,
        monto_total: factura.monto_total,
        porcentaje: factura.porcentaje,
        dias: factura.dias
    });
    
    // Debug: verificar si el porcentaje existe
    console.log('🔍 Porcentaje existe?', factura.porcentaje, typeof factura.porcentaje);
    
    let estadoClass = 'estado-pendiente';
    let estadoText = 'Pendiente';
    
    if (factura.estado === 'pagada') {
        estadoClass = 'estado-pagada';
        estadoText = 'Pagada';
    } else if (diasRestantes < 0) {
        estadoClass = 'estado-vencida';
        estadoText = 'Vencida';
    } else if (diasRestantes <= 3) {
        estadoClass = 'estado-proxima';
        estadoText = 'Próxima';
    }
    
    return `
        <div class="factura-item">
            <div class="factura-info">
        <div class="factura-numero">
            ${factura.numero_factura}
        </div>
                    <div class="factura-details">
                        <strong>${factura.emisor}</strong><br>
                        Monto: $${formatearNumero(parseFloat(factura.monto))}${factura.porcentaje ? ` (${factura.porcentaje}%)` : ''}<br>
                        <small style="color: #666;">Monto Factura Total: $${formatearNumero(parseFloat(factura.monto_total || factura.monto))}</small><br>
                        <strong>Vence: ${fechaVencimiento.toLocaleDateString()}</strong>
                        ${diasRestantes >= 0 ? `(${diasRestantes} días)` : `(Vencida hace ${Math.abs(diasRestantes)} días)`}
                    </div>
            </div>
                    <div class="factura-productos">
                        ${factura.productos ? `<div class="productos-detail">${factura.productos}</div>` : ''}
                    </div>
            <div class="factura-actions">
                <div class="factura-header-actions">
                    ${factura.archivo_pdf ? 
                        `<button class="btn btn-info" onclick="verPDF('${factura.archivo_pdf}')" title="Ver PDF">Ver factura</button>` : 
                        ''
                    }
                    <span class="estado-badge ${estadoClass}">${estadoText}</span>
                </div>
                <div class="factura-buttons">
                    ${factura.estado === 'pendiente' ? 
                        `<button class="btn btn-primary" onclick="pagarFactura(${factura.id})">Pagar</button>
                         <button class="btn btn-success" onclick="marcarPagada(${factura.id})">Marcar Pagada</button>` : 
                        ''
                    }
                    <button class="btn btn-danger btn-square" onclick="eliminarFactura(${factura.id})" title="Eliminar">✕</button>
                </div>
            </div>
        </div>
    `;
}

// Pagar factura (proceso de pago)
async function pagarFactura(id) {
    try {
        // Aquí se integraría con Mercado Pago
        showNotification('💳 Redirigiendo a Mercado Pago...', 'info');
        
        // Por ahora, simular el proceso de pago
        setTimeout(async () => {
            const response = await fetch(`/api/facturas/${id}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ estado: 'pagada' })
            });
            
            if (response.ok) {
                showNotification('✅ Pago procesado exitosamente', 'success');
                loadFacturas();
                loadStats();
            } else {
                showNotification('❌ Error al procesar el pago', 'error');
            }
        }, 2000);
        
    } catch (error) {
        console.error('Error:', error);
        showNotification('❌ Error al procesar el pago', 'error');
    }
}

// Marcar factura como pagada
async function marcarPagada(id) {
    try {
        const response = await fetch(`/api/facturas/${id}/marcar-pagada`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        if (response.ok) {
            showNotification('Factura marcada como pagada', 'success');
            loadFacturas();
            loadStats();
        } else {
            showNotification('Error al marcar factura como pagada', 'error');
        }
    } catch (error) {
        console.error('Error:', error);
        showNotification('Error al marcar factura como pagada', 'error');
    }
}

// Eliminar factura
async function eliminarFactura(id) {
    try {
        const response = await fetch(`/api/facturas/${id}`, {
            method: 'DELETE'
        });
        
        if (response.ok) {
            showNotification('Factura eliminada', 'success');
            loadFacturas();
            loadStats();
        } else {
            showNotification('Error al eliminar factura', 'error');
        }
    } catch (error) {
        console.error('Error:', error);
        showNotification('Error al eliminar factura', 'error');
    }
}

// Ver PDF en modal
function verPDF(archivoPdf) {
    console.log('🔍 Archivo PDF a mostrar:', archivoPdf);
    console.log('🔍 URL completa:', `/uploads/${archivoPdf}`);
    
    // Crear modal para mostrar PDF
    const modal = document.createElement('div');
    modal.className = 'modal pdf-modal-overlay';
    modal.style.display = 'flex';
    modal.innerHTML = `
        <div class="modal-content pdf-modal">
            <span class="close" onclick="this.parentElement.parentElement.remove()">&times;</span>
            <h3>📄 Factura PDF</h3>
            <div class="pdf-container">
                <iframe src="/uploads/${encodeURIComponent(archivoPdf)}" width="100%" height="80vh" frameborder="0"></iframe>
            </div>
            <div class="pdf-actions">
                <button class="btn btn-primary" onclick="window.open('/uploads/${encodeURIComponent(archivoPdf)}', '_blank')">Abrir en Nueva Pestaña</button>
                <button class="btn btn-secondary" onclick="this.closest('.modal').remove()">Cerrar</button>
            </div>
        </div>
    `;
    
    // Agregar funcionalidad para cerrar al hacer clic fuera del modal
    modal.addEventListener('click', function(e) {
        // Si el clic es en el overlay (no en el contenido del modal)
        if (e.target === modal) {
            modal.remove();
        }
    });
    
    // Prevenir que el clic en el contenido del modal lo cierre
    const modalContent = modal.querySelector('.modal-content');
    modalContent.addEventListener('click', function(e) {
        e.stopPropagation();
    });
    
    document.body.appendChild(modal);
}

// Manejar subida de PDF
async function handlePdfUpload(e) {
    e.preventDefault();
    
    const formData = new FormData(e.target);
    const fileInput = document.getElementById('pdf-file');
    
    if (!fileInput.files[0]) {
        showNotification('Por favor selecciona un archivo PDF', 'error');
        return;
    }
    
    const uploadStatus = document.getElementById('upload-status');
    uploadStatus.style.display = 'block';
    uploadStatus.innerHTML = '<div class="upload-status">📄 Procesando PDF...</div>';
    
    try {
        const response = await fetch('/api/subir-pdf', {
            method: 'POST',
            body: formData
        });
        
        const result = await response.json();
        
        if (response.ok) {
            uploadStatus.innerHTML = `
                <div class="upload-status success">
                    ✅ ${result.message}
                    <br>
                    📊 Facturas extraídas: ${result.facturas}
                    <br>
                    💾 Facturas guardadas: ${result.guardadas}
                </div>
            `;
            
            // Recargar facturas y estadísticas
            loadFacturas();
            loadStats();
            
            // Limpiar formulario
            e.target.reset();
            
        } else {
            uploadStatus.innerHTML = `
                <div class="upload-status error">
                    ❌ Error: ${result.error}
                </div>
            `;
        }
        
    } catch (error) {
        console.error('Error subiendo PDF:', error);
        uploadStatus.innerHTML = `
            <div class="upload-status error">
                ❌ Error al procesar el PDF: ${error.message}
            </div>
        `;
    }
}

// Manejar sincronización SII
async function handleSiiSync() {
    const rut = prompt('Ingresa tu RUT (formato: 12.345.678-9):');
    const password = prompt('Ingresa tu clave del SII:');
    
    if (!rut || !password) {
        showNotification('Se requieren RUT y clave del SII', 'error');
        return;
    }
    
    showNotification('🔄 Sincronizando con SII...', 'info');
    
    try {
        const response = await fetch('/api/sincronizar-sii', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ rut, password })
        });
        
        const result = await response.json();
        
        if (response.ok) {
            showNotification(`✅ ${result.message}`, 'success');
            loadFacturas();
            loadStats();
        } else {
            showNotification(`❌ Error: ${result.error}`, 'error');
        }
        
    } catch (error) {
        console.error('Error sincronizando SII:', error);
        showNotification('Error al sincronizar con SII', 'error');
    }
}

// Manejar configuración
async function handleConfigSave(e) {
    e.preventDefault();
    
    const formData = new FormData(e.target);
    const config = Object.fromEntries(formData.entries());
    
    try {
        const response = await fetch('/api/config', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(config)
        });
        
        if (response.ok) {
            showNotification('Configuración guardada', 'success');
            hideConfig();
        } else {
            showNotification('Error al guardar configuración', 'error');
        }
        
    } catch (error) {
        console.error('Error guardando configuración:', error);
        showNotification('Error al guardar configuración', 'error');
    }
}

// Mostrar notificaciones
function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.textContent = message;
    
    document.body.appendChild(notification);
    
    setTimeout(() => {
        notification.remove();
    }, 3000);
}

// Funciones de Drag & Drop
function handleDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
}

function handleDragEnter(e) {
    e.preventDefault();
    e.target.classList.add('drag-over');
}

function handleDragLeave(e) {
    e.preventDefault();
    e.target.classList.remove('drag-over');
}

function handleDrop(e) {
    e.preventDefault();
    e.target.classList.remove('drag-over');
    
    const files = e.dataTransfer.files;
    if (files.length > 0) {
        const file = files[0];
        if (file.type === 'application/pdf') {
            uploadPDFFile(file);
        } else {
            showNotification('Solo se permiten archivos PDF', 'error');
        }
    }
}

// Función para subir PDF arrastrado
async function uploadPDFFile(file) {
    const formData = new FormData();
    formData.append('pdf', file);
    
    showNotification('📄 Procesando PDF...', 'info');
    
    try {
        const response = await fetch('/api/subir-pdf', {
            method: 'POST',
            body: formData
        });
        
        const result = await response.json();
        
        if (response.ok) {
            showNotification(`✅ ${result.message || 'PDF procesado correctamente'}`, 'success');
            loadFacturas();
            loadStats();
        } else {
            const errorMessage = result.error || result.message || 'Error desconocido';
            showNotification(`❌ Error: ${errorMessage}`, 'error');
        }
        
    } catch (error) {
        console.error('Error subiendo PDF:', error);
        showNotification('❌ Error al procesar el PDF', 'error');
    }
}

// Función para ordenar facturas
function sortFacturas(campo, direccion) {
    console.log(`🔍 Ordenando facturas por ${campo} ${direccion}`);
    
    // Crear una copia del array para no modificar el original
    const facturasOrdenadas = [...facturas];
    
    facturasOrdenadas.sort((a, b) => {
        let valorA, valorB;
        
        switch (campo) {
            case 'fecha':
                valorA = new Date(a.fecha_vencimiento);
                valorB = new Date(b.fecha_vencimiento);
                break;
            case 'monto':
                valorA = a.monto;
                valorB = b.monto;
                break;
            case 'emisor':
                valorA = a.emisor.toLowerCase();
                valorB = b.emisor.toLowerCase();
                break;
            default:
                return 0;
        }
        
        if (direccion === 'asc') {
            return valorA > valorB ? 1 : -1;
        } else {
            return valorA < valorB ? 1 : -1;
        }
    });
    
    // Renderizar las facturas ordenadas
    const facturasList = document.getElementById('facturas-list');
    facturasList.innerHTML = facturasOrdenadas.map(factura => createFacturaHTML(factura)).join('');
    
    // Mostrar notificación
    const direccionText = direccion === 'asc' ? 'ascendente' : 'descendente';
    showNotification(`📅 Facturas ordenadas por fecha ${direccionText}`, 'success');
}