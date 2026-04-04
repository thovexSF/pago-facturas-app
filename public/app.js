let facturas = [];
let calendar = null;
let facturaActiva = null;

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initCalendar();
  initTabs();
  initModal();
  cargarFacturas();
  syncAuto();

  document.getElementById('btn-sync').addEventListener('click', sincronizarHistorico);
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
      const f = facturas.find(x => String(x.id) === info.event.id.split('-')[0]);
      if (f) abrirModal(f);
    },
  });
  calendar.render();
}

function cargarEventosCalendar() {
  calendar.removeAllEvents();
  const eventos = [];
  facturas.forEach(f => {
    if (f.vcto_1 && !f.pagado_1) {
      const vencida = new Date(f.vcto_1) < new Date();
      eventos.push({
        id: `${f.id}-1`,
        title: `50% ${f.razon_social || f.rut_emisor}`,
        start: f.vcto_1.split('T')[0],
        backgroundColor: vencida ? '#e53e3e' : '#3182ce',
        borderColor:     vencida ? '#c53030' : '#2b6cb0',
        extendedProps: { monto: f.monto_1, cuota: 1 },
      });
    }
    if (f.vcto_2 && !f.pagado_2) {
      const vencida = new Date(f.vcto_2) < new Date();
      eventos.push({
        id: `${f.id}-2`,
        title: `50% ${f.razon_social || f.rut_emisor}`,
        start: f.vcto_2.split('T')[0],
        backgroundColor: vencida ? '#e53e3e' : '#38a169',
        borderColor:     vencida ? '#c53030' : '#276749',
        extendedProps: { monto: f.monto_2, cuota: 2 },
      });
    }
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

  const pendC1 = facturas.filter(f => !f.pagado_1 && f.vcto_1);
  const pendC2 = facturas.filter(f => !f.pagado_2 && f.vcto_2);

  const vencidasC1 = pendC1.filter(f => new Date(f.vcto_1) < hoy);
  const vencidasC2 = pendC2.filter(f => new Date(f.vcto_2) < hoy);

  const montoPendiente = [
    ...pendC1.map(f => parseInt(f.monto_1) || 0),
    ...pendC2.map(f => parseInt(f.monto_2) || 0),
  ].reduce((s, v) => s + v, 0);

  document.getElementById('stat-total').textContent   = pendC1.length + pendC2.length;
  document.getElementById('stat-vencidas').textContent = vencidasC1.length + vencidasC2.length;
  document.getElementById('stat-monto').textContent   = '$' + formatMonto(montoPendiente);
  document.getElementById('stat-pagadas').textContent =
    facturas.filter(f => f.pagado_1 && f.pagado_2).length;
}

// ─── Tabla ────────────────────────────────────────────────────────────────────

function renderTabla() {
  const filtro = document.getElementById('filter-estado').value;
  let lista = facturas;
  if (filtro === 'pendiente') lista = facturas.filter(f => !f.pagado_1 || !f.pagado_2);
  if (filtro === 'pagada')    lista = facturas.filter(f => f.pagado_1 && f.pagado_2);

  const tbody = document.getElementById('facturas-tbody');
  const empty = document.getElementById('empty-state');

  if (!lista.length) { tbody.innerHTML = ''; empty.style.display = 'block'; return; }
  empty.style.display = 'none';

  const hoy = new Date();
  tbody.innerHTML = lista.map(f => {
    const ambaPagada = f.pagado_1 && f.pagado_2;
    const vencida = (!f.pagado_1 && f.vcto_1 && new Date(f.vcto_1) < hoy)
                 || (!f.pagado_2 && f.vcto_2 && new Date(f.vcto_2) < hoy);
    const estadoClass = ambaPagada ? 'badge-success' : vencida ? 'badge-danger' : 'badge-warning';
    const estadoLabel = ambaPagada ? 'Pagada' : vencida ? 'Vencida' : 'Pendiente';

    // Mostrar próximo vencimiento pendiente
    const proxVcto = !f.pagado_1 && f.vcto_1 ? f.vcto_1 : f.vcto_2;

    return `
      <tr class="${vencida ? 'row-vencida' : ''}" onclick="abrirModal(facturas.find(x=>x.id===${f.id}))" style="cursor:pointer">
        <td>
          <div class="emisor-nombre">${esc(f.razon_social || '—')}</div>
          <div class="emisor-rut">${esc(f.rut_emisor || '—')}</div>
        </td>
        <td>${f.folio || '—'}</td>
        <td>${formatFecha(f.fecha_emision)}</td>
        <td class="${vencida ? 'text-danger' : ''}">${formatFecha(proxVcto)}</td>
        <td class="monto">$${formatMonto(f.monto_total)}</td>
        <td><span class="badge ${estadoClass}">${estadoLabel}</span></td>
        <td>
          ${!ambaPagada ? `<button class="btn btn-sm btn-pay" onclick="event.stopPropagation();abrirModal(facturas.find(x=>x.id===${f.id}))">Pagar</button>` : ''}
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
}

function abrirModal(f) {
  if (!f) return;
  facturaActiva = f;

  document.getElementById('modal-titulo').textContent       = `Factura ${f.folio ? '#' + f.folio : ''}`;
  document.getElementById('modal-emisor').textContent       = f.razon_social || '—';
  document.getElementById('modal-rut').textContent          = f.rut_emisor || '—';
  document.getElementById('modal-folio').textContent        = f.folio || '—';
  document.getElementById('modal-fecha-emision').textContent= formatFecha(f.fecha_emision);
  document.getElementById('modal-estado-sii').textContent   = f.estado_sii || '—';
  document.getElementById('modal-monto').textContent        = '$' + formatMonto(f.monto_total);
  document.getElementById('pago-rut-copy').textContent      = f.rut_emisor || '—';
  document.getElementById('pago-monto-copy').textContent    = f.monto_total || '—';

  // Cuota 1
  const c1Pagada = !!f.pagado_1;
  document.getElementById('modal-vcto-1').textContent  = formatFecha(f.vcto_1);
  document.getElementById('modal-monto-1').textContent = '$' + formatMonto(f.monto_1);
  const btn1 = document.getElementById('btn-pagar-1');
  btn1.textContent   = c1Pagada ? '✓ Pagada' : 'Pagar 50%';
  btn1.disabled      = c1Pagada;
  btn1.className     = `btn btn-sm ${c1Pagada ? 'btn-success' : 'btn-pay'}`;
  btn1.onclick       = () => marcarCuota(1);

  // Cuota 2
  const c2Pagada = !!f.pagado_2;
  document.getElementById('modal-vcto-2').textContent  = formatFecha(f.vcto_2);
  document.getElementById('modal-monto-2').textContent = '$' + formatMonto(f.monto_2);
  const btn2 = document.getElementById('btn-pagar-2');
  btn2.textContent   = c2Pagada ? '✓ Pagada' : 'Pagar 50%';
  btn2.disabled      = c2Pagada;
  btn2.className     = `btn btn-sm ${c2Pagada ? 'btn-success' : 'btn-pay'}`;
  btn2.onclick       = () => marcarCuota(2);

  document.getElementById('modal').style.display = 'flex';
}

function cerrarModal() {
  document.getElementById('modal').style.display = 'none';
  facturaActiva = null;
}

async function marcarCuota(cuota) {
  if (!facturaActiva) return;
  try {
    const res = await fetch(`/api/facturas/${facturaActiva.id}/pagar/${cuota}`, { method: 'PUT' });
    if (!res.ok) throw new Error('Error al marcar cuota');
    mostrarToast(`Cuota ${cuota} marcada como pagada`, 'success');
    cerrarModal();
    await cargarFacturas();
  } catch (err) {
    mostrarToast(err.message, 'error');
  }
}

// ─── Sincronizar ──────────────────────────────────────────────────────────────

async function syncAuto() {
  try {
    const res  = await fetch('/api/sync/auto', { method: 'POST' });
    const data = await res.json();
    if (data.meses?.length) {
      const total = data.meses.reduce((s, m) => s + m.insertadas, 0);
      if (total > 0) {
        mostrarToast(`Auto-sync: ${total} facturas nuevas`, 'success');
        await cargarFacturas();
      }
    }
  } catch (_) { /* silencioso */ }
}

async function sincronizarHistorico() {
  const btn = document.getElementById('btn-sync');
  btn.disabled = true;
  btn.textContent = '↻ Sincronizando...';
  try {
    const res  = await fetch('/api/sync/historico', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error sincronizando');
    mostrarToast(data.mensaje ?? 'Sincronización histórica iniciada', 'success');
    setTimeout(cargarFacturas, 5000);
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
    const solo = fecha.split('T')[0]; // "2026-04-01T00:00:00Z" → "2026-04-01"
    return new Date(solo + 'T12:00:00').toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch { return fecha; }
}

function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function mostrarToast(msg, tipo = 'info') {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = `toast toast-${tipo} show`;
  setTimeout(() => { toast.className = 'toast'; }, 3500);
}
