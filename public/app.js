let facturas    = [];
let proveedores = [];
let calendar    = null;
let facturaActiva = null;
let modalLista    = [];   // lista filtrada visible al abrir el modal
let modalIndex    = -1;   // índice de facturaActiva en modalLista
let listaActual         = [];   // última lista renderizada en la tabla (para navegación)
let filtroInicializado  = false;

// Chips: set de rut_emisor visibles en calendario (persistido en localStorage)
let chipsFiltro = new Set(JSON.parse(localStorage.getItem('chipsFiltro') ?? 'null') ?? []);

// Filtro del gráfico: Set de razon_social seleccionados (vacío antes de inicializar)
let graficoProvsFiltro = new Set();
let graficoFiltroIniciado = false;

// Filtro tipo Excel de la columna Emisor: null = todos, Set = seleccionados
let filtroEmisores = null;

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initCalendar();
  initTabs();
  initModal();
  cargarTodo();
  syncAuto();
  cargarBannerVencimientos();

  document.getElementById('btn-sync').addEventListener('click', sincronizarHistorico);
  document.getElementById('btn-pdf-sync').addEventListener('click', descargarPdfsPendientes);
  document.getElementById('filter-estado').addEventListener('change', renderTabla);
  document.getElementById('grafico-tipo').addEventListener('change', renderGrafico);

  // Cerrar dropdowns al hacer click fuera
  document.addEventListener('click', e => {
    const dd = document.getElementById('prov-dropdown');
    if (dd && !dd.contains(e.target))
      document.getElementById('prov-dropdown-panel')?.classList.remove('open');

    const thEmisor = document.getElementById('th-emisor');
    if (thEmisor && !thEmisor.contains(e.target))
      cerrarFiltroEmisor();
  });
});

let graficoChart = null;

async function cargarTodo() {
  await Promise.all([cargarFacturas(), cargarProveedores()]);
}

// ─── Calendar ─────────────────────────────────────────────────────────────────

function initCalendar() {
  calendar = new FullCalendar.Calendar(document.getElementById('calendar'), {
    initialView: 'dayGridMonth',
    locale: 'es',
    height: 'auto',
    headerToolbar: { left: 'prev,next today', center: 'title', right: 'dayGridMonth,listMonth' },
    eventClick: (info) => {
      const id = parseInt(info.event.id.split('-')[0]);
      const f  = facturas.find(x => x.id === id);
      if (f) abrirModal(f);
    },
  });
  calendar.render();
}

function cargarEventosCalendar() {
  calendar.removeAllEvents();
  // Si no hay chips seleccionados, mostrar todos los que tengan en_agenda=true
  const agendaRuts = new Set(proveedores.filter(p => p.en_agenda).map(p => p.rut_emisor));
  const filtrados  = chipsFiltro.size > 0 ? chipsFiltro : agendaRuts;

  facturas.forEach(f => {
    if (!filtrados.has(f.rut_emisor)) return;
    if (f.vcto_1) {
      const vencida = !f.pagado_1 && new Date(f.vcto_1) < new Date();
      calendar.addEvent({
        id: `${f.id}-1`,
        title: `C1 Factura N° ${f.folio} $${formatMonto(f.monto_1)}`,
        start: f.vcto_1.split('T')[0],
        backgroundColor: f.pagado_1 ? '#276749' : vencida ? '#e53e3e' : (f.vcto_2 ? '#38a169' : '#3182ce'),
        borderColor:     f.pagado_1 ? '#1a4731' : vencida ? '#c53030' : (f.vcto_2 ? '#276749' : '#2b6cb0'),
        textColor:       '#fff',
      });
    }
    if (f.vcto_2) {
      const vencida = !f.pagado_2 && new Date(f.vcto_2) < new Date();
      calendar.addEvent({
        id: `${f.id}-2`,
        title: `C2 Factura N° ${f.folio} $${formatMonto(f.monto_2)}`,
        start: f.vcto_2.split('T')[0],
        backgroundColor: f.pagado_2 ? '#2b6cb0' : vencida ? '#e53e3e' : '#3182ce',
        borderColor:     f.pagado_2 ? '#1a4480' : vencida ? '#c53030' : '#2563eb',
        textColor:       '#fff',
      });
    }
  });
}

// ─── Chips ────────────────────────────────────────────────────────────────────

function renderChips() {
  const container = document.getElementById('chips-container');
  // Mostrar solo proveedores a crédito (los únicos relevantes para el calendario)
  const credito = proveedores.filter(p => p.condicion === 'credito');
  if (!credito.length) { container.innerHTML = ''; return; }

  container.innerHTML = credito.map(p => {
    const activo = chipsFiltro.size === 0
      ? p.en_agenda
      : chipsFiltro.has(p.rut_emisor);
    return `<button class="chip ${activo ? 'chip-active' : ''}"
              onclick="toggleChip('${p.rut_emisor}')">${esc(p.razon_social || p.rut_emisor)}</button>`;
  }).join('');
}

function toggleChip(rut) {
  if (chipsFiltro.has(rut)) {
    chipsFiltro.delete(rut);
  } else {
    chipsFiltro.add(rut);
  }
  localStorage.setItem('chipsFiltro', JSON.stringify([...chipsFiltro]));
  renderChips();
  cargarEventosCalendar();
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
      if (tab.dataset.tab === 'grafico') renderGrafico();
    });
  });
}

// ─── Cargar datos ─────────────────────────────────────────────────────────────

async function cargarFacturas() {
  const res = await fetch('/api/facturas');
  facturas  = await res.json();

  // Filtro por defecto: solo Arabica Spa (solo en la primera carga)
  if (!filtroInicializado && facturas.length) {
    filtroInicializado = true;
    const arabica = facturas.find(f => /arabica/i.test(f.razon_social));
    if (arabica) {
      filtroEmisores = new Set([arabica.rut_emisor]);
      const chk = document.getElementById('chk-emisor-todos');
      if (chk) chk.checked = false;
    }
  }

  renderStats();
  renderTabla();
  cargarEventosCalendar();
  renderGrafico();
}

async function cargarProveedores() {
  const res   = await fetch('/api/proveedores');
  proveedores = await res.json();
  renderProveedores();
  renderChips();
  cargarEventosCalendar();
}

// ─── Stats ────────────────────────────────────────────────────────────────────

function renderStats() {
  const hoy = new Date();
  const pendC1 = facturas.filter(f => !f.pagado_1 && f.vcto_1);
  const pendC2 = facturas.filter(f => !f.pagado_2 && f.vcto_2);
  const vencidas = [
    ...pendC1.filter(f => new Date(f.vcto_1) < hoy),
    ...pendC2.filter(f => new Date(f.vcto_2) < hoy),
  ].length;
  const montoPendiente = [
    ...pendC1.map(f => parseInt(f.monto_1)||0),
    ...pendC2.map(f => parseInt(f.monto_2)||0),
  ].reduce((s,v) => s+v, 0);

  document.getElementById('stat-total').textContent    = pendC1.length + pendC2.length;
  document.getElementById('stat-vencidas').textContent  = vencidas;
  document.getElementById('stat-monto').textContent    = '$' + formatMonto(montoPendiente);
  document.getElementById('stat-pagadas').textContent  = facturas.filter(f => f.pagado_1 && (!f.vcto_2 || f.pagado_2)).length;
}

// ─── Tabla ────────────────────────────────────────────────────────────────────

function renderTabla() {
  const filtro = document.getElementById('filter-estado').value;
  let lista = facturas;
  if (filtro === 'pendiente') lista = lista.filter(f => !f.pagado_1 || (f.vcto_2 && !f.pagado_2));
  if (filtro === 'pagada')    lista = lista.filter(f => f.pagado_1 && (!f.vcto_2 || f.pagado_2));
  if (filtroEmisores !== null) lista = lista.filter(f => filtroEmisores.has(f.rut_emisor));
  actualizarBtnFiltroEmisor();

  const tbody = document.getElementById('facturas-tbody');
  const empty = document.getElementById('empty-state');
  if (!lista.length) { tbody.innerHTML = ''; empty.style.display = 'block'; return; }
  empty.style.display = 'none';
  listaActual = lista;  // exponer para onclick inline

  const hoy = new Date();
  tbody.innerHTML = lista.map(f => {
    const ambaPagada = f.pagado_1 && (!f.vcto_2 || f.pagado_2);
    const vencida = (!f.pagado_1 && f.vcto_1 && new Date(f.vcto_1) < hoy)
                 || (!f.pagado_2 && f.vcto_2 && new Date(f.vcto_2) < hoy);
    const estadoClass = ambaPagada ? 'badge-success' : vencida ? 'badge-danger' : 'badge-warning';
    const estadoLabel = ambaPagada ? 'Pagada' : vencida ? 'Vencida' : 'Pendiente';
    const proxVcto    = !f.pagado_1 && f.vcto_1 ? f.vcto_1 : f.vcto_2;
    return `
      <tr class="${vencida?'row-vencida':''}" onclick="abrirModal(facturas.find(x=>x.id===${f.id}),listaActual)" style="cursor:pointer">
        <td>
          <div class="emisor-nombre">${esc(f.razon_social||'—')}</div>
          <div class="emisor-rut">${esc(f.rut_emisor||'—')}</div>
        </td>
        <td>${f.folio||'—'}</td>
        <td>${formatFecha(f.fecha_emision)}</td>
        <td class="${vencida?'text-danger':''}">${formatFecha(proxVcto)}</td>
        <td class="monto">$${formatMonto(f.monto_total)}</td>
        <td class="fechas-pago">
          ${f.pagado_1 && f.pagado_1_at ? `<div class="pago-fecha">C1 · ${formatFecha(f.pagado_1_at)}</div>` : ''}
          ${f.pagado_2 && f.pagado_2_at ? `<div class="pago-fecha">C2 · ${formatFecha(f.pagado_2_at)}</div>` : ''}
          ${!f.pagado_1 && !f.pagado_2 ? '<span class="text-muted">—</span>' : ''}
        </td>
        <td><span class="badge ${estadoClass}">${estadoLabel}</span></td>
        <td onclick="event.stopPropagation()">
          ${f.has_pdf
            ? `<a class="btn btn-sm btn-success" href="/api/facturas/${f.id}/pdf" target="_blank" rel="noopener">📄 Ver</a>`
            : `<button class="btn btn-sm btn-secondary" onclick="descargarPdfFactura(${f.id})">⬇ PDF</button>`}
        </td>
        <td>${!ambaPagada?`<button class="btn btn-sm btn-pay" onclick="event.stopPropagation();abrirModal(facturas.find(x=>x.id===${f.id}))">Pagar</button>`:''}</td>
      </tr>`;
  }).join('');
}

// ─── Proveedores ──────────────────────────────────────────────────────────────

function renderProveedores() {
  const el = document.getElementById('proveedores-lista');
  if (!proveedores.length) {
    el.innerHTML = '<p class="empty-prov">Sincroniza primero para ver los proveedores.</p>';
    return;
  }
  el.innerHTML = `
    <table class="facturas-table">
      <thead><tr>
        <th>Proveedor</th>
        <th>Categoría</th>
        <th>Condición</th>
        <th>Cuota 1</th>
        <th>Cuota 2</th>
        <th>En agenda</th>
      </tr></thead>
      <tbody>
        ${proveedores.map(p => `
          <tr>
            <td>
              <div class="emisor-nombre">${esc(p.razon_social||'—')}</div>
              <div class="emisor-rut">${esc(p.rut_emisor)}</div>
            </td>
            <td>
              <input class="prov-input prov-input-cat" type="text"
                placeholder="Sin categoría"
                value="${esc(p.categoria||'')}"
                onchange="actualizarProveedor('${p.rut_emisor}','categoria',this.value||null)">
            </td>
            <td>
              <select class="prov-select" onchange="actualizarProveedor('${p.rut_emisor}','condicion',this.value)">
                <option value="contado" ${p.condicion==='contado'?'selected':''}>Contado</option>
                <option value="credito" ${p.condicion==='credito'?'selected':''}>Crédito</option>
              </select>
            </td>
            <td class="${p.condicion==='contado'?'prov-disabled':''}">
              <input class="prov-input" type="number" value="${p.dias_1}" min="1" max="365"
                ${p.condicion==='contado'?'disabled':''}
                onchange="actualizarProveedor('${p.rut_emisor}','dias_1',parseInt(this.value))"> días ·
              <input class="prov-input prov-input-sm" type="number" value="${p.pct_1}" min="1" max="100"
                ${p.condicion==='contado'?'disabled':''}
                onchange="actualizarProveedor('${p.rut_emisor}','pct_1',parseInt(this.value))">%
            </td>
            <td class="${p.condicion==='contado'?'prov-disabled':''}">
              <input class="prov-input" type="number" value="${p.dias_2}" min="1" max="365"
                ${p.condicion==='contado'?'disabled':''}
                onchange="actualizarProveedor('${p.rut_emisor}','dias_2',parseInt(this.value))"> días ·
              <input class="prov-input prov-input-sm" type="number" value="${p.pct_2}" min="1" max="100"
                ${p.condicion==='contado'?'disabled':''}
                onchange="actualizarProveedor('${p.rut_emisor}','pct_2',parseInt(this.value))">%
            </td>
            <td>
              <input type="checkbox" ${p.en_agenda?'checked':''}
                onchange="actualizarProveedor('${p.rut_emisor}','en_agenda',this.checked)">
            </td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

async function actualizarProveedor(rut, campo, valor) {
  await fetch(`/api/proveedores/${encodeURIComponent(rut)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [campo]: valor }),
  });
  await cargarProveedores();
}

// ─── Modal ────────────────────────────────────────────────────────────────────

function initModal() {
  document.getElementById('modal-close').addEventListener('click', cerrarModal);
  document.getElementById('modal-cancel').addEventListener('click', cerrarModal);
  document.getElementById('modal').addEventListener('click', e => {
    if (e.target === document.getElementById('modal')) cerrarModal();
  });
  // btn-modal-pdf onclick se asigna dinámicamente en abrirModal
}

function abrirModal(f, lista) {
  if (!f) return;
  facturaActiva = f;
  // Si se pasa una lista (desde la tabla), actualizarla; si no, reusar la actual
  if (lista) modalLista = lista;
  modalIndex = modalLista.findIndex(x => x.id === f.id);

  // Flechas
  const prev = document.getElementById('btn-modal-prev');
  const next = document.getElementById('btn-modal-next');
  if (prev) prev.disabled = modalIndex <= 0;
  if (next) next.disabled = modalIndex >= modalLista.length - 1;
  const prov = proveedores.find(p => p.rut_emisor === f.rut_emisor);

  document.getElementById('modal-titulo').textContent        = `Factura ${f.folio?'#'+f.folio:''}`;
  document.getElementById('modal-emisor').textContent        = f.razon_social||'—';
  document.getElementById('modal-rut').textContent           = f.rut_emisor||'—';
  document.getElementById('modal-folio').textContent         = f.folio||'—';
  document.getElementById('modal-fecha-emision').textContent = formatFecha(f.fecha_emision);
  document.getElementById('modal-estado-sii').textContent    = f.estado_sii||'—';
  document.getElementById('modal-monto').textContent         = '$'+formatMonto(f.monto_total);
  document.getElementById('pago-rut-copy').textContent       = f.rut_emisor||'—';
  document.getElementById('pago-monto-copy').textContent     = f.monto_total||'—';

  // Labels dinámicos según condición del proveedor
  const esContado = !prov || prov.condicion === 'contado';
  document.getElementById('modal-label-1').textContent = esContado ? 'contado' : `día ${prov?.dias_1??30}`;
  document.getElementById('modal-label-2').textContent = esContado ? 'contado' : `día ${prov?.dias_2??40}`;

  document.getElementById('modal-vcto-1').value = f.vcto_1 ? f.vcto_1.split('T')[0] : '';
  document.getElementById('modal-monto-1').textContent = '$'+formatMonto(f.monto_1);
  document.getElementById('modal-vcto-2').value = f.vcto_2 ? f.vcto_2.split('T')[0] : '';
  document.getElementById('modal-monto-2').textContent = '$'+formatMonto(f.monto_2);

  // Botón extraer PDF solo si tiene PDF descargado
  const btnExtraer = document.getElementById('btn-extraer-pdf');
  if (btnExtraer) btnExtraer.style.display = f.has_pdf ? '' : 'none';

  const btn1 = document.getElementById('btn-pagar-1');
  btn1.textContent = f.pagado_1 ? '✓ Cuota 1 pagada' : 'Pagar cuota 1';
  btn1.disabled    = !!f.pagado_1;
  btn1.className   = `btn btn-sm ${f.pagado_1?'btn-secondary':'btn-pay'}`;
  btn1.onclick     = () => marcarCuota(1);

  const btn2 = document.getElementById('btn-pagar-2');
  btn2.textContent = f.pagado_2 ? '✓ Cuota 2 pagada' : 'Pagar cuota 2';
  btn2.disabled    = !!f.pagado_2;
  btn2.className   = `btn btn-sm ${f.pagado_2?'btn-secondary':'btn-pay'}`;
  btn2.onclick     = () => marcarCuota(2);

  // Ocultar cuotas si es contado (ya está pagado)
  document.querySelectorAll('.cuota-row').forEach(r => {
    r.style.display = esContado ? 'none' : '';
  });

  // Panel PDF: iframe si tiene PDF, placeholder si no
  const iframe      = document.getElementById('modal-pdf-iframe');
  const placeholder = document.getElementById('modal-pdf-placeholder');
  const btnPdf      = document.getElementById('btn-modal-pdf');

  if (f.has_pdf) {
    iframe.src = `/api/facturas/${f.id}/pdf`;
    iframe.style.display = 'block';
    placeholder.style.display = 'none';
  } else {
    iframe.src = '';
    iframe.style.display = 'none';
    placeholder.style.display = 'flex';
    btnPdf.textContent = '⬇ Descargar PDF';
    btnPdf.disabled = false;
    btnPdf.onclick = async () => {
      btnPdf.disabled = true;
      btnPdf.textContent = '⏳ Descargando…';
      await descargarPdfFactura(f.id);
      await cargarFacturas();
      const updated = facturas.find(x => x.id === f.id);
      if (updated) abrirModal(updated);
    };
  }

  document.getElementById('modal').style.display = 'flex';
}

function navegarModal(dir) {
  const nuevo = modalIndex + dir;
  if (nuevo < 0 || nuevo >= modalLista.length) return;
  abrirModal(modalLista[nuevo]);
}

function cerrarModal() {
  document.getElementById('modal-pdf-iframe').src = '';
  document.getElementById('modal').style.display = 'none';
  facturaActiva = null;
  modalLista = [];
  modalIndex = -1;
}

async function marcarCuota(cuota) {
  if (!facturaActiva) return;
  try {
    const res = await fetch(`/api/facturas/${facturaActiva.id}/pagar/${cuota}`, { method: 'PUT' });
    if (!res.ok) throw new Error('Error al marcar cuota');
    mostrarToast(`Cuota ${cuota} pagada`, 'success');
    cerrarModal();
    await cargarFacturas();
  } catch (err) { mostrarToast(err.message, 'error'); }
}

// ─── PDF ──────────────────────────────────────────────────────────────────────

async function descargarPdfFactura(id) {
  try {
    const res = await fetch(`/api/facturas/${id}/pdf`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al descargar PDF');
    mostrarToast(`PDF guardado (${Math.round(data.bytes/1024)} KB)`, 'success');
    await cargarFacturas();
  } catch (err) { mostrarToast('Error PDF: '+err.message, 'error'); }
}

async function descargarPdfsPendientes() {
  const btn = document.getElementById('btn-pdf-sync');
  btn.disabled = true; btn.textContent = '⏳ Iniciando…';
  try {
    const res  = await fetch('/api/pdf/sync', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error');
    mostrarToast(data.mensaje, data.pendientes > 0 ? 'info' : 'success');
    if (data.pendientes > 0) {
      // Recargar facturas cada 15 s mientras hay PDFs descargándose
      let intentos = 0;
      const poll = setInterval(async () => {
        intentos++;
        const st = await fetch('/api/pdf/status').then(r => r.json()).catch(() => null);
        if (st) {
          btn.textContent = `📄 ${st.con_pdf}/${st.total} PDFs`;
          if (st.con_pdf >= st.total || intentos >= 60) {
            clearInterval(poll);
            btn.disabled = false; btn.textContent = '📄 Descargar PDFs';
            await cargarFacturas();
            mostrarToast(`PDFs disponibles: ${st.con_pdf}/${st.total}`, 'success');
          }
        }
      }, 15000);
    }
  } catch (err) { mostrarToast('Error: '+err.message, 'error'); }
  finally {
    if (document.getElementById('btn-pdf-sync').textContent === '⏳ Iniciando…') {
      btn.disabled = false; btn.textContent = '📄 Descargar PDFs';
    }
  }
}

// ─── Sync ─────────────────────────────────────────────────────────────────────

async function syncAuto() {
  try {
    const res  = await fetch('/api/sync/auto', { method: 'POST' });
    const data = await res.json();
    if (data.meses?.length) {
      const total = data.meses.reduce((s,m) => s+m.insertadas, 0);
      if (total > 0) {
        mostrarToast(`Auto-sync: ${total} facturas nuevas`, 'success');
        await cargarTodo();
      }
    }
  } catch (_) {}
}

async function sincronizarHistorico() {
  const btn = document.getElementById('btn-sync');
  btn.disabled = true; btn.textContent = '↻ Sincronizando...';
  try {
    const res  = await fetch('/api/sync/historico', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error');
    mostrarToast(data.mensaje ?? 'Sincronización iniciada', 'success');
    setTimeout(cargarTodo, 5000);
  } catch (err) { mostrarToast('Error: '+err.message, 'error'); }
  finally {
    btn.disabled = false;
    btn.innerHTML = '<span class="sync-icon">↻</span> Sincronizar SII';
  }
}

// ─── Gráfico ──────────────────────────────────────────────────────────────────

const COLORES = [
  '#3182ce','#38a169','#e53e3e','#d69e2e','#805ad5',
  '#dd6b20','#319795','#d53f8c','#2b6cb0','#276749',
];

function renderGraficoDropdown(proveedoresOrdenados) {
  const list = document.getElementById('prov-check-list');
  if (!list) return;

  // "Todos" activo = ningún filtro individual activo
  const todosActivo = graficoProvsFiltro.size === 0;
  const todosBtn = document.getElementById('prov-check-all');
  if (todosBtn) todosBtn.classList.toggle('todos-activo', todosActivo);

  list.innerHTML = proveedoresOrdenados.map(prov => `
    <label class="prov-check-row">
      <input type="checkbox" ${graficoProvsFiltro.has(prov) ? 'checked' : ''}
        onchange="toggleGraficoProveedor(${JSON.stringify(prov)}, this.checked)">
      ${esc(prov)}
    </label>`).join('');

  // Label del botón desplegable
  const label = document.getElementById('prov-dropdown-label');
  if (label) {
    label.textContent = todosActivo
      ? '· Todos'
      : `· ${graficoProvsFiltro.size} seleccionado${graficoProvsFiltro.size > 1 ? 's' : ''}`;
  }
}

function toggleProvDropdown() {
  document.getElementById('prov-dropdown-panel').classList.toggle('open');
}

// "Todos" = limpiar filtro individual → mostrar todos los proveedores
function toggleGraficoTodos() {
  graficoProvsFiltro.clear();
  renderGrafico();
}

function toggleGraficoProveedor(prov, checked) {
  if (checked) {
    graficoProvsFiltro.add(prov);
  } else {
    graficoProvsFiltro.delete(prov);
  }
  renderGrafico();
}

function renderGrafico() {
  if (!facturas.length) return;

  // Agrupar por mes y proveedor → suma monto_total
  const porMesProv = {};
  facturas.forEach(f => {
    if (!f.fecha_emision) return;
    const mes  = f.fecha_emision.slice(0, 7); // "2026-03"
    const prov = f.razon_social || f.rut_emisor;
    if (!porMesProv[mes]) porMesProv[mes] = {};
    porMesProv[mes][prov] = (porMesProv[mes][prov] || 0) + (parseInt(f.monto_total) || 0);
  });

  const meses  = Object.keys(porMesProv).sort();
  const labels = meses.map(m => {
    const [y, mo] = m.split('-');
    return new Date(y, mo - 1).toLocaleDateString('es-CL', { month: 'short', year: '2-digit' });
  });

  // Proveedores únicos ordenados por total histórico desc
  const totProv = {};
  Object.values(porMesProv).forEach(mp => Object.entries(mp).forEach(([p, v]) => {
    totProv[p] = (totProv[p] || 0) + v;
  }));
  const proveedoresOrdenados = Object.keys(totProv).sort((a, b) => totProv[b] - totProv[a]);

  // Primera carga: pre-seleccionar Arabica por defecto
  if (!graficoFiltroIniciado && proveedoresOrdenados.length > 0) {
    graficoFiltroIniciado = true;
    const arabica = proveedoresOrdenados.find(p => p.toLowerCase().includes('arabica'));
    graficoProvsFiltro = new Set(arabica ? [arabica] : []);
  }

  // Renderizar dropdown (con la lista ordenada)
  renderGraficoDropdown(proveedoresOrdenados);

  // Filtrar por chips seleccionados
  const visibles = graficoProvsFiltro.size > 0
    ? proveedoresOrdenados.filter(p => graficoProvsFiltro.has(p))
    : proveedoresOrdenados;

  const tipo = document.getElementById('grafico-tipo')?.value ?? 'bar';

  const datasets = visibles.map((prov, i) => {
    const colorIdx = proveedoresOrdenados.indexOf(prov); // mantener colores fijos por proveedor
    return {
      label: prov,
      data:  meses.map(m => Math.round((porMesProv[m]?.[prov] || 0) / 1000)),
      backgroundColor: COLORES[colorIdx % COLORES.length] + (tipo === 'bar' ? 'cc' : '22'),
      borderColor:     COLORES[colorIdx % COLORES.length],
      borderWidth: tipo === 'line' ? 2 : 0,
      fill: false,
      tension: 0.3,
      pointRadius: tipo === 'line' ? 3 : 0,
    };
  });

  if (graficoChart) graficoChart.destroy();

  graficoChart = new Chart(document.getElementById('grafico-canvas'), {
    type: tipo === 'line' ? 'line' : 'bar',
    data: { labels, datasets },
    options: {
      responsive: true,
      plugins: {
        legend: { position: 'bottom', labels: { font: { size: 11 }, boxWidth: 12 } },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.dataset.label}: $${ctx.parsed.y.toLocaleString('es-CL')}k`,
          },
        },
      },
      scales: {
        x: { stacked: tipo === 'bar', grid: { display: false } },
        y: {
          stacked: tipo === 'bar',
          ticks: { callback: v => `$${v}k` },
          grid:  { color: '#f0f4f8' },
        },
      },
    },
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatMonto(v) { return Number(v||0).toLocaleString('es-CL'); }

function formatFecha(fecha) {
  if (!fecha) return '—';
  try {
    return new Date(fecha.split('T')[0]+'T12:00:00').toLocaleDateString('es-CL', { day:'2-digit', month:'2-digit', year:'numeric' });
  } catch { return fecha; }
}

function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function guardarVencimientos() {
  if (!facturaActiva) return;
  const vcto_1 = document.getElementById('modal-vcto-1').value || null;
  const vcto_2 = document.getElementById('modal-vcto-2').value || null;
  const btn = document.getElementById('btn-guardar-vcto');
  btn.disabled = true; btn.textContent = 'Guardando…';
  try {
    const r = await fetch(`/api/facturas/${facturaActiva.id}/vencimientos`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vcto_1, vcto_2 }),
    });
    if (!r.ok) throw new Error(await r.text());
    mostrarToast('Fechas guardadas', 'success');
    await cargarFacturas();
    // Actualizar la factura activa con los nuevos datos
    facturaActiva = facturas.find(f => f.id === facturaActiva.id) ?? facturaActiva;
  } catch (e) {
    mostrarToast('Error: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Guardar fechas';
  }
}

async function extraerFechasPdf() {
  if (!facturaActiva) return;
  const btn = document.getElementById('btn-extraer-pdf');
  btn.disabled = true; btn.textContent = '⏳ Extrayendo…';
  try {
    const r = await fetch(`/api/facturas/${facturaActiva.id}/extraer-fechas`, { method: 'POST' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error ?? 'Error');
    if (data.vcto_1) {
      document.getElementById('modal-vcto-1').value = data.vcto_1;
      mostrarToast(`Vencimiento encontrado: ${data.vcto_1}`, 'success');
    } else {
      mostrarToast('No se encontró fecha de vencimiento en el PDF', 'info');
    }
    if (data.vcto_2) document.getElementById('modal-vcto-2').value = data.vcto_2;
  } catch (e) {
    mostrarToast('Error: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '🔍 Extraer del PDF';
  }
}

function copiarTexto(id) {
  navigator.clipboard.writeText(document.getElementById(id)?.textContent||'')
    .then(() => mostrarToast('Copiado','success'));
}

// ─── Filtro tipo Excel — columna Emisor ───────────────────────────────────────

function toggleFiltroEmisor(e) {
  e.stopPropagation();
  const panel = document.getElementById('filter-emisor-panel');
  const btn   = document.getElementById('btn-filter-emisor');
  const abierto = panel.classList.contains('open');
  if (abierto) { cerrarFiltroEmisor(); return; }

  // Construir items con los emisores únicos de facturas
  const emisores = [...new Map(
    facturas.map(f => [f.rut_emisor, f.razon_social || f.rut_emisor])
  ).entries()].sort((a, b) => a[1].localeCompare(b[1]));

  const items = document.getElementById('filter-emisor-items');
  items.innerHTML = emisores.map(([rut, nombre]) => {
    const checked = filtroEmisores === null || filtroEmisores.has(rut);
    return `<label class="th-filter-item" data-rut="${rut}" data-nombre="${nombre.toLowerCase()}">
      <input type="checkbox" ${checked ? 'checked' : ''} onchange="toggleEmisor('${rut}',this.checked)" onclick="event.stopPropagation()">
      <span>${esc(nombre)}</span>
    </label>`;
  }).join('');

  // Sincronizar checkbox TODOS
  const chkTodos = document.getElementById('chk-emisor-todos');
  if (chkTodos) chkTodos.checked = filtroEmisores === null;

  // Limpiar búsqueda previa
  const searchInput = panel.querySelector('.th-filter-search input');
  if (searchInput) searchInput.value = '';

  // Posicionar el panel usando fixed (evita clipping por overflow del table-wrapper)
  const rect = btn.getBoundingClientRect();
  panel.style.top  = (rect.bottom + 4) + 'px';
  panel.style.left = rect.left + 'px';

  panel.classList.add('open');
  btn.classList.add('active');
}

function cerrarFiltroEmisor() {
  document.getElementById('filter-emisor-panel')?.classList.remove('open');
  document.getElementById('btn-filter-emisor')?.classList.remove('active');
  actualizarBtnFiltroEmisor();
}

function toggleEmisor(rut, checked) {
  if (filtroEmisores === null) {
    filtroEmisores = new Set(facturas.map(f => f.rut_emisor));
  }
  if (checked) filtroEmisores.add(rut);
  else         filtroEmisores.delete(rut);

  // Si todos seleccionados → volver a null (sin filtro)
  const total = new Set(facturas.map(f => f.rut_emisor)).size;
  if (filtroEmisores.size === total) filtroEmisores = null;

  // Sincronizar checkbox TODOS
  const chkTodos = document.getElementById('chk-emisor-todos');
  if (chkTodos) chkTodos.checked = filtroEmisores === null;

  renderTabla();
}

function toggleFiltroEmisorTodos(checked) {
  if (checked) {
    filtroEmisores = null;
    document.querySelectorAll('#filter-emisor-items input[type=checkbox]')
      .forEach(cb => cb.checked = true);
  } else {
    filtroEmisores = new Set();
    document.querySelectorAll('#filter-emisor-items input[type=checkbox]')
      .forEach(cb => cb.checked = false);
  }
  renderTabla();
}

function filtrarItemsEmisor(q) {
  const texto = q.toLowerCase();
  document.querySelectorAll('#filter-emisor-items .th-filter-item').forEach(el => {
    el.classList.toggle('hidden', texto && !el.dataset.nombre.includes(texto));
  });
}

function actualizarBtnFiltroEmisor() {
  const btn = document.getElementById('btn-filter-emisor');
  if (!btn) return;
  btn.classList.toggle('active', filtroEmisores !== null);
}

function mostrarToast(msg, tipo='info') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast toast-${tipo} show`;
  setTimeout(() => { t.className = 'toast'; }, 3500);
}

// ─── Banner de vencimientos próximos ─────────────────────────────────────────

async function cargarBannerVencimientos() {
  const DIAS = 5;
  const STORAGE_KEY = 'banner_vcto_dismissed';
  const hoy = new Date().toISOString().split('T')[0];

  // No mostrar si ya fue cerrado hoy
  if (localStorage.getItem(STORAGE_KEY) === hoy) return;

  try {
    const cuotas = await fetch(`/api/notificaciones/proximos?dias=${DIAS}`).then(r => r.json());
    if (!cuotas.length) return;

    const fmt = (d) => d ? new Date(d + 'T00:00:00').toLocaleDateString('es-CL') : '—';
    const fmtMonto = (n) => n ? new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP' }).format(n) : '';

    const items = cuotas.map(c => {
      const partes = [];
      if (!c.pagado_1 && c.vcto_1) partes.push(`C1 <strong>${fmt(c.vcto_1)}</strong> ${fmtMonto(c.monto_1)}`);
      if (!c.pagado_2 && c.vcto_2) partes.push(`C2 <strong>${fmt(c.vcto_2)}</strong> ${fmtMonto(c.monto_2)}`);
      return `<span class="banner-vcto-item"><span class="banner-vcto-nombre">${c.nombre_emisor} #${c.folio}</span> — ${partes.join(' · ')}</span>`;
    }).join('');

    const banner = document.createElement('div');
    banner.id = 'banner-vencimientos';
    banner.className = 'banner-vencimientos';
    banner.innerHTML = `
      <span class="banner-vcto-icon">⚠️</span>
      <div class="banner-vcto-content">
        <strong>${cuotas.length} cuota${cuotas.length > 1 ? 's' : ''} vence${cuotas.length > 1 ? 'n' : ''} en los próximos ${DIAS} días</strong>
        <div class="banner-vcto-items">${items}</div>
      </div>
      <button class="banner-vcto-close" onclick="cerrarBannerVencimientos()" title="Cerrar">✕</button>
    `;

    document.querySelector('.app').prepend(banner);
  } catch (_) { /* silencioso */ }
}

function cerrarBannerVencimientos() {
  const hoy = new Date().toISOString().split('T')[0];
  localStorage.setItem('banner_vcto_dismissed', hoy);
  document.getElementById('banner-vencimientos')?.remove();
}
