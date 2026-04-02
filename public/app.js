let facturas = [];
let calendar = null;
let facturaActiva = null;

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initCalendar();
  initTabs();
  initModal();
  cargarFacturas();

  document.getElementById('btn-sync').addEventListener('click', sincronizar);
  document.getElementById('filter-estado').addEventListener('change', renderTabla);
});

// ─── Calendar ─────────────────────────────────────────────────────────────────

function initCalendar() {
  const el = document.getElementById('calendar');
  calendar = new FullCalendar.Calendar(el, {
    initialView: 'dayGridMonth',
    locale: 'es',
    height: 'auto',
    headerToolbar: {
      left: 'prev,next today',
      center: 'title',
      right: 'dayGridMonth,listMonth',
    },
    eventClick: (info) => {
      const f = facturas.find(x => String(x.id) === info.event.id);
      if (f) abrirModal(f);
    },
    eventDidMount: (info) => {
      info.el.title = `${info.event.title} — $${formatMonto(info.event.extendedProps.monto)}`;
    },
  });
  calendar.render();
}

function cargarEventosCalendar() {
  calendar.removeAllEvents();
  const pendientes = facturas.filter(f => f.estado_pago === 'pendiente' && f.fecha_vencimiento);
  const eventos = pendientes.map(f => {
    const vencida = new Date(f.fecha_vencimiento) < new Date();
    return {
      id: String(f.id),
      title: f.razon_social || f.rut_emisor || 'Factura',
      start: f.fecha_vencimiento,
      backgroundColor: vencida ? '#e53e3e' : '#3182ce',
      borderColor: vencida ? '#c53030' : '#2b6cb0',
      extendedProps: { monto: f.monto },
    };
  });
  calendar.addEventSource(eventos);
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────

function initTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
      if (tab.dataset.tab === 'calendario') calendar.updateSize();
    });
  });
}

// ─── Cargar facturas ──────────────────────────────────────────────────────────

async function cargarFacturas() {
  try {
    const res = await fetch('/api/facturas');
    facturas = await res.json();
    renderStats();
    renderTabla();
    cargarEventosCalendar();
  } catch (err) {
    mostrarToast('Error cargando facturas: ' + err.message, 'error');
  }
}

// ─── Stats ────────────────────────────────────────────────────────────────────

function renderStats() {
  const hoy = new Date();
  const inicioMes = new Date(hoy.getFullYear(), hoy.getMonth(), 1);

  const pendientes = facturas.filter(f => f.estado_pago === 'pendiente');
  const vencidas = pendientes.filter(f => f.fecha_vencimiento && new Date(f.fecha_vencimiento) < hoy);
  const montoPendiente = pendientes.reduce((s, f) => s + (parseInt(f.monto) || 0), 0);
  const pagadasMes = facturas.filter(f => f.estado_pago === 'pagada' && f.pagada_at && new Date(f.pagada_at) >= inicioMes);

  document.getElementById('stat-total').textContent = pendientes.length;
  document.getElementById('stat-vencidas').textContent = vencidas.length;
  document.getElementById('stat-monto').textContent = '$' + formatMonto(montoPendiente);
  document.getElementById('stat-pagadas').textContent = pagadasMes.length;
}

// ─── Tabla ────────────────────────────────────────────────────────────────────

function renderTabla() {
  const filtro = document.getElementById('filter-estado').value;
  const lista = filtro ? facturas.filter(f => f.estado_pago === filtro) : facturas;
  const tbody = document.getElementById('facturas-tbody');
  const empty = document.getElementById('empty-state');

  if (lista.length === 0) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  const hoy = new Date();
  tbody.innerHTML = lista.map(f => {
    const vencida = f.fecha_vencimiento && new Date(f.fecha_vencimiento) < hoy && f.estado_pago === 'pendiente';
    const estadoClass = f.estado_pago === 'pagada' ? 'badge-success' : vencida ? 'badge-danger' : 'badge-warning';
    const estadoLabel = f.estado_pago === 'pagada' ? 'Pagada' : vencida ? 'Vencida' : 'Pendiente';
    return `
      <tr class="${vencida ? 'row-vencida' : ''}" onclick="abrirModal(facturas.find(x=>x.id===${f.id}))" style="cursor:pointer">
        <td>
          <div class="emisor-nombre">${esc(f.razon_social || '—')}</div>
          <div class="emisor-rut">${esc(f.rut_emisor || '—')}</div>
        </td>
        <td>${f.folio || '—'}</td>
        <td>${formatFecha(f.fecha_emision)}</td>
        <td class="${vencida ? 'text-danger' : ''}">${formatFecha(f.fecha_vencimiento)}</td>
        <td class="monto">$${formatMonto(f.monto)}</td>
        <td><span class="badge ${estadoClass}">${estadoLabel}</span></td>
        <td>
          ${f.estado_pago === 'pendiente' ? `<button class="btn btn-sm btn-pay" onclick="event.stopPropagation();abrirModal(facturas.find(x=>x.id===${f.id}))">Pagar</button>` : ''}
        </td>
      </tr>
    `;
  }).join('');
}

// ─── Modal ────────────────────────────────────────────────────────────────────

function initModal() {
  document.getElementById('modal-close').addEventListener('click', cerrarModal);
  document.getElementById('modal-cancel').addEventListener('click', cerrarModal);
  document.getElementById('modal').addEventListener('click', e => {
    if (e.target === document.getElementById('modal')) cerrarModal();
  });
  document.getElementById('btn-pagar').addEventListener('click', marcarPagada);
}

function abrirModal(f) {
  if (!f) return;
  facturaActiva = f;
  const hoy = new Date();
  const vencida = f.fecha_vencimiento && new Date(f.fecha_vencimiento) < hoy;

  document.getElementById('modal-titulo').textContent = `Factura ${f.folio ? '#' + f.folio : ''}`;
  document.getElementById('modal-emisor').textContent = f.razon_social || '—';
  document.getElementById('modal-rut').textContent = f.rut_emisor || '—';
  document.getElementById('modal-folio').textContent = f.folio || '—';
  document.getElementById('modal-fecha-emision').textContent = formatFecha(f.fecha_emision);
  document.getElementById('modal-vencimiento').textContent = formatFecha(f.fecha_vencimiento) + (vencida ? ' ⚠️ Vencida' : '');
  document.getElementById('modal-monto').textContent = '$' + formatMonto(f.monto);
  document.getElementById('modal-estado-sii').textContent = f.estado_sii || '—';

  document.getElementById('pago-rut-copy').textContent = f.rut_emisor || '—';
  document.getElementById('pago-monto-copy').textContent = f.monto || '—';

  const btnPagar = document.getElementById('btn-pagar');
  btnPagar.style.display = f.estado_pago === 'pagada' ? 'none' : '';

  document.getElementById('modal').style.display = 'flex';
}

function cerrarModal() {
  document.getElementById('modal').style.display = 'none';
  facturaActiva = null;
}

async function marcarPagada() {
  if (!facturaActiva) return;
  try {
    const res = await fetch(`/api/facturas/${facturaActiva.id}/pagar`, { method: 'PUT' });
    if (!res.ok) throw new Error('Error al marcar como pagada');
    mostrarToast('Factura marcada como pagada', 'success');
    cerrarModal();
    await cargarFacturas();
  } catch (err) {
    mostrarToast(err.message, 'error');
  }
}

// ─── Sincronizar ──────────────────────────────────────────────────────────────

async function sincronizar() {
  const btn = document.getElementById('btn-sync');
  btn.disabled = true;
  btn.textContent = '↻ Sincronizando...';
  try {
    const res = await fetch('/api/sync', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error sincronizando');
    mostrarToast(`Sincronización completa: ${data.nuevas} nuevas, ${data.actualizadas} actualizadas`, 'success');
    await cargarFacturas();
  } catch (err) {
    mostrarToast('Error: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span class="sync-icon">↻</span> Sincronizar SII';
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatMonto(monto) {
  return Number(monto || 0).toLocaleString('es-CL');
}

function formatFecha(fecha) {
  if (!fecha) return '—';
  try {
    return new Date(fecha + 'T12:00:00').toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch { return fecha; }
}

function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function copiarTexto(elementId) {
  const texto = document.getElementById(elementId)?.textContent || '';
  navigator.clipboard.writeText(texto).then(() => mostrarToast('Copiado', 'success'));
}

function mostrarToast(msg, tipo = 'info') {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = `toast toast-${tipo} show`;
  setTimeout(() => { toast.className = 'toast'; }, 3500);
}
