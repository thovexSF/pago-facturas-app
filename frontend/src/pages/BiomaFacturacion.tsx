import { useCallback, useEffect, useState } from 'react';
import {
  Box, Typography, Paper, Button, Alert, CircularProgress, Table, TableBody,
  TableCell, TableContainer, TableHead, TableRow, Chip, Snackbar,
  Stack, LinearProgress, Accordion, AccordionSummary, AccordionDetails,
  Grid, Divider, Tabs, Tab,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/esm/ExpandMore.js';
import RefreshIcon from '@mui/icons-material/esm/Refresh.js';
import { API_CONFIG } from '../config/api';
import { formatRut, validateRut } from '../utils/rutUtils';
import StatCard from '../components/StatCard';

const BIOMA_API = `${API_CONFIG.BASE_URL}/api/bioma`;
const SII_API = `${API_CONFIG.BASE_URL}/api/sii-facturacion`;


interface ShopifyOrderForBioma {
  id: string;
  name: string;
  processedAt: string;
  total: number;
  customAttributes: Array<{ key: string; value: string }>;
  customer: { firstName: string | null; lastName: string | null } | null;
  shippingAddress: { name: string | null } | null;
}

interface BiomaEmision {
  status: 'pending' | 'drafting' | 'emitting' | 'emitted' | 'error';
  lastError: string | null;
  siiFolio: number | null;
  siiCodigo?: string | null;
}

interface PendingRow {
  shopify: ShopifyOrderForBioma;
  emision: BiomaEmision | null;
}

interface PayloadData {
  rutReceptor: string | null;
  razonSocial: string | null;
  giroReceptor: string | null;
  tipoCodigo?: number;
  items: Array<{ numero: number; descripcion: string; cantidad: number; precioUnitario: number; subtotal: number }>;
  template: {
    codigo: string | null;
    folio?: number | null;
    templateCliente?: string | null;
    source?: 'env' | 'cliente_emision' | 'cliente_sii' | 'nueva';
  };
}

interface EmisionDbRow {
  shopifyOrderId: string;
  shopifyOrderName: string;
  customerName: string | null;
  rutReceptor: string | null;
  razonSocial: string | null;
  tipoCodigo: number;
  status: BiomaEmision['status'];
  siiFolio: number | null;
  siiCodigo: string | null;
  emittedAt: string | null;
  createdAt?: string | null;
  lastError: string | null;
}

type ModuleTab = 'pendientes' | 'boletas' | 'realizadas';

function dteLabel(tipo: number): string {
  if (tipo === 39) return 'Boleta';
  if (tipo === 41) return 'Boleta exenta';
  if (tipo === 34) return 'Factura exenta';
  return 'Factura';
}

function templateLabel(t: PayloadData['template'] | null | undefined): string {
  if (!t) return '—';
  if (t.source === 'nueva') return 'Factura nueva (sin historial para este RUT)';
  if (t.source === 'cliente_emision') {
    return `Copiar última Bioma → ${t.templateCliente || 'cliente'} (folio ${t.folio ?? '?'})`;
  }
  if (t.source === 'cliente_sii') {
    return `Copiar última SII → ${t.templateCliente || 'cliente'} (folio ${t.folio ?? '?'})`;
  }
  if (t.source === 'env') return `Plantilla fija .env (${t.codigo})`;
  if (t.codigo) return `Copiar documento ${t.codigo} (folio ${t.folio ?? '?'})`;
  return 'Factura nueva';
}

function templateReady(t: PayloadData['template'] | null | undefined): boolean {
  return !!t && (t.source === 'nueva' || !!t.codigo);
}

const fmt = (n: number) => `$${(n || 0).toLocaleString('es-CL')}`;

function statusChip(status?: BiomaEmision['status']) {
  if (!status || status === 'pending') return <Chip size="small" label="Pendiente" color="warning" variant="outlined" />;
  if (status === 'drafting') return <Chip size="small" label="Borrador" color="info" />;
  if (status === 'emitting') return <Chip size="small" label="Emitiendo" color="info" />;
  if (status === 'emitted') return <Chip size="small" label="Emitida" color="success" />;
  if (status === 'error') return <Chip size="small" label="Error" color="error" />;
  return <Chip size="small" label={String(status)} />;
}

export default function BiomaFacturacion() {
  const [moduleTab, setModuleTab] = useState<ModuleTab>('pendientes');
  const [empresaRut, setEmpresaRut] = useState('');
  const [autoEmitFactura, setAutoEmitFactura] = useState(false);
  const [autoEmitBoleta, setAutoEmitBoleta] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(() => localStorage.getItem('biomaSiiSessionId'));
  const [configOpen, setConfigOpen] = useState(() => !localStorage.getItem('biomaSiiSessionId'));

  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<PendingRow[]>([]);
  const [boletasRows, setBoletasRows] = useState<EmisionDbRow[]>([]);
  const [realizadasRows, setRealizadasRows] = useState<EmisionDbRow[]>([]);
  const [realizadasTotal, setRealizadasTotal] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [payload, setPayload] = useState<PayloadData | null>(null);
  const [payloadLoading, setPayloadLoading] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [snack, setSnack] = useState<string | null>(null);
  const [lastAviso, setLastAviso] = useState<string | null>(null);
  const [busyOrderId, setBusyOrderId] = useState<string | null>(null);
  const [creatingSession, setCreatingSession] = useState(false);
  const [siiBlocked, setSiiBlocked] = useState<{
    blocked: boolean;
    reason?: string;
    retryAfterMinutes?: number;
    blockedUntil?: number;
    blockedSince?: number;
  }>({ blocked: false });
  const [blockCountdown, setBlockCountdown] = useState('');

  const loadBlockStatus = useCallback(async () => {
    try {
      const res = await fetch(`${SII_API}/block-status`);
      const data = await res.json();
      setSiiBlocked({
        blocked: !!data.blocked,
        reason: data.reason,
        retryAfterMinutes: data.retryAfterMinutes,
        blockedUntil: data.blockedUntil,
        blockedSince: data.blockedSince,
      });
    } catch {
      setSiiBlocked({ blocked: false });
    }
  }, []);

  // Contador en vivo hasta blockedUntil (sin esperar al poll de 60s)
  useEffect(() => {
    const until = siiBlocked.blockedUntil;
    if (!siiBlocked.blocked || !until) {
      setBlockCountdown('');
      return;
    }
    const tick = () => {
      const ms = until - Date.now();
      if (ms <= 0) {
        setBlockCountdown('');
        setSiiBlocked({ blocked: false });
        void loadBlockStatus();
        return;
      }
      const h = Math.floor(ms / 3_600_000);
      const m = Math.floor((ms % 3_600_000) / 60_000);
      const s = Math.floor((ms % 60_000) / 1000);
      if (h > 0) setBlockCountdown(`${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`);
      else setBlockCountdown(`${m}:${String(s).padStart(2, '0')}`);
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [siiBlocked.blocked, siiBlocked.blockedUntil, loadBlockStatus]);

  useEffect(() => {
    loadBlockStatus();
    const t = window.setInterval(loadBlockStatus, 60_000);
    return () => clearInterval(t);
  }, [loadBlockStatus]);

  const loadPending = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${BIOMA_API}/pedidos-pendientes?pageSize=50`);
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      setRows(data.rows || []);
    } catch (e: any) {
      setError(`Pedidos Shopify: ${e?.message || e}`);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadBoletas = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${BIOMA_API}/boletas-pendientes?pageSize=50`);
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      setBoletasRows(data.rows || []);
    } catch (e: any) {
      setError(`Boletas: ${e?.message || e}`);
      setBoletasRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadRealizadas = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${BIOMA_API}/facturas-realizadas?pageSize=50`);
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      setRealizadasRows(data.rows || []);
      setRealizadasTotal(data.total ?? data.rows?.length ?? 0);
    } catch (e: any) {
      setError(`Realizadas: ${e?.message || e}`);
      setRealizadasRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshCurrentTab = useCallback(() => {
    if (moduleTab === 'pendientes') return loadPending();
    if (moduleTab === 'boletas') return loadBoletas();
    return loadRealizadas();
  }, [moduleTab, loadPending, loadBoletas, loadRealizadas]);

  const loadPayload = useCallback(async (orderId: string) => {
    setPayloadLoading(true);
    try {
      const res = await fetch(`${BIOMA_API}/payload/${encodeURIComponent(orderId)}`);
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      setPayload(data.payload);
    } catch (e: any) {
      setError(`Datos del pedido: ${e?.message || e}`);
      setPayload(null);
    } finally {
      setPayloadLoading(false);
    }
  }, []);

  useEffect(() => { loadPending(); loadBoletas(); loadRealizadas(); }, [loadPending, loadBoletas, loadRealizadas]);

  useEffect(() => {
    fetch(`${BIOMA_API}/config`)
      .then((r) => r.json())
      .then((d) => {
        if (d.empresaRut) setEmpresaRut(d.empresaRut);
        setAutoEmitFactura(!!d.autoEmitFactura);
        setAutoEmitBoleta(!!d.autoEmitBoleta);
      })
      .catch(() => {
        fetch(`${BIOMA_API}/template-codigo`)
          .then((r) => r.json())
          .then((d) => { if (d.empresaRut) setEmpresaRut(d.empresaRut); })
          .catch(() => {});
      });
  }, []);

  const selectOrder = useCallback((row: PendingRow) => {
    const id = row.shopify.id;
    setSelectedId((prev) => (prev === id ? null : id));
    setPayload(null);
    if (id) loadPayload(id);
  }, [loadPayload]);

  const selectBoleta = useCallback((row: EmisionDbRow) => {
    const id = row.shopifyOrderId;
    setSelectedId((prev) => (prev === id ? null : id));
    setPayload(null);
    if (id) loadPayload(id);
  }, [loadPayload]);

  const createSession = useCallback(async () => {
    if (siiBlocked.blocked) {
      setError(`SII en pausa (~${siiBlocked.retryAfterMinutes} min). Entra manual en sii.cl primero.`);
      return;
    }
    if (!empresaRut) {
      setError('RUT emisor no configurado en el servidor (BIOMA_EMPRESA_RUT)');
      return;
    }
    setCreatingSession(true);
    setError(null);
    try {
      const res = await fetch(`${SII_API}/session/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ empresaRut, deferPlaywright: true }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      setSessionId(data.sessionId);
      localStorage.setItem('biomaSiiSessionId', data.sessionId);
      setConfigOpen(false);
      setSnack('Sesión SII lista (HTTP). Playwright se abre al usar el scraper.');
    } catch (e: any) {
      setError(`Sesión SII: ${e?.message || e}`);
    } finally {
      setCreatingSession(false);
    }
  }, [empresaRut, siiBlocked]);

  const closeSession = useCallback(async () => {
    if (!sessionId) return;
    try {
      await fetch(`${SII_API}/session/${sessionId}`, { method: 'DELETE' });
    } finally {
      setSessionId(null);
      localStorage.removeItem('biomaSiiSessionId');
      setConfigOpen(true);
    }
  }, [sessionId]);

  const sessionReady = !!sessionId;

  const stopAllSii = useCallback(async () => {
    try {
      await fetch(`${SII_API}/session/close-all`, { method: 'POST' });
      setSessionId(null);
      localStorage.removeItem('biomaSiiSessionId');
      setSnack('Sesiones workbench cerradas — no toques el SII por un rato');
      await loadBlockStatus();
    } catch {
      setError('No se pudieron cerrar las sesiones');
    }
  }, [loadBlockStatus]);

  const clearSiiBlock = useCallback(async () => {
    try {
      const res = await fetch(`${SII_API}/block-status/clear`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setSiiBlocked({ blocked: false });
      setSnack('Bloqueo workbench limpiado — solo continúa si ya entraste manual al SII');
      await loadBlockStatus();
    } catch (e: any) {
      setError(`Limpiar bloqueo: ${e?.message || e}`);
    }
  }, [loadBlockStatus]);

  const emitirDte = useCallback(async (orderId: string, opts?: { isBoleta?: boolean }) => {
    if (siiBlocked.blocked) {
      setError(`SII en pausa ~${siiBlocked.retryAfterMinutes} min.`);
      return;
    }
    if (!sessionReady) {
      setError('Abre sesión SII antes de emitir');
      setConfigOpen(true);
      return;
    }
    const isBoleta = opts?.isBoleta ?? payload?.tipoCodigo === 39;
    if (!isBoleta && !templateReady(payload?.template)) {
      setError('No se pudo resolver plantilla SII.');
      return;
    }
    const ok = window.confirm(
      isBoleta
        ? '¿Emitir boleta electrónica en el SII?\n\nTarda ~1 minuto.'
        : '¿Emitir factura en el SII?\n\nTarda ~1 minuto. Si algo falla, corrígelo manual en sii.cl.',
    );
    if (!ok) return;

    setBusyOrderId(orderId);
    setError(null);
    try {
      const res = await fetch(`${BIOMA_API}/emitir/${encodeURIComponent(orderId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || data.result?.error || `HTTP ${res.status}`);
      }
      const folio = data.row?.siiFolio || data.result?.folio;
      const tipo = data.row?.tipoCodigo ?? (isBoleta ? 39 : 33);
      setSnack(folio ? `${dteLabel(tipo)} emitida — folio ${folio}` : `${dteLabel(tipo)} emitida en el SII`);
      await loadPending();
      await loadBoletas();
      await loadRealizadas();
      if (selectedId === orderId) await loadPayload(orderId);
    } catch (e: any) {
      setError(`Emitir: ${e?.message || e}`);
      await loadBlockStatus();
    } finally {
      setBusyOrderId(null);
    }
  }, [sessionReady, sessionId, payload, loadPending, loadBoletas, loadRealizadas, loadPayload, selectedId, siiBlocked, loadBlockStatus]);

  const descargarPdf = useCallback(async (orderId: string) => {
    if (!sessionReady) {
      setError('Abre sesión SII para descargar el PDF');
      return;
    }
    setBusyOrderId(orderId);
    setError(null);
    try {
      const res = await fetch(`${BIOMA_API}/pdf/${encodeURIComponent(orderId)}/fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      window.open(`${BIOMA_API}/pdf/${encodeURIComponent(orderId)}`, '_blank');
    } catch (e: any) {
      setError(`PDF: ${e?.message || e}`);
    } finally {
      setBusyOrderId(null);
    }
  }, [sessionReady, sessionId]);

  const pendingRows = rows.filter((r) => r.emision?.status !== 'emitted');
  const pendingCount = pendingRows.length;
  const boletasCount = boletasRows.length;
  const pendingMonto = pendingRows.reduce((sum, r) => sum + (r.shopify.total || 0), 0);
  const selectedRow = rows.find((r) => r.shopify.id === selectedId) ?? null;
  const selectedBoleta = boletasRows.find((r) => r.shopifyOrderId === selectedId) ?? null;
  const isBusy = busyOrderId === selectedId;

  return (
    <Box>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'repeat(2, 1fr)', md: 'repeat(4, 1fr)' },
          gap: 2,
          mb: 2.5,
        }}
      >
        <StatCard value={pendingCount} label="Facturas pendientes" variant={pendingCount ? 'warning' : 'default'} />
        <StatCard value={boletasCount} label="Boletas pendientes" variant={boletasCount ? 'warning' : 'default'} />
        <StatCard value={realizadasTotal} label="Realizadas" variant="success" />
        <StatCard value={fmt(pendingMonto)} label="Monto por facturar" variant="amount" />
      </Box>

      {(autoEmitFactura || autoEmitBoleta) && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Auto-emisión activa:
          {autoEmitFactura && ' facturas (toggle checkout)'}
          {autoEmitFactura && autoEmitBoleta && ' ·'}
          {autoEmitBoleta && ' boletas (sin toggle)'}
          {' '}— vía webhook <code>orders/paid</code> y cola en servidor.
        </Alert>
      )}

      <Tabs
        value={moduleTab}
        onChange={(_, v: ModuleTab) => { setModuleTab(v); setSelectedId(null); setPayload(null); }}
        sx={{ mb: 2, borderBottom: '2px solid #e2e8f0' }}
      >
        <Tab value="pendientes" label={`Facturas pendientes (${pendingCount})`} />
        <Tab value="boletas" label={`Boletas pendientes (${boletasCount})`} />
        <Tab value="realizadas" label={`Realizadas (${realizadasTotal})`} />
      </Tabs>

      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 2,
          mb: 2,
          flexWrap: 'wrap',
        }}
      >
        <Typography variant="body2" color="text.secondary">
          {moduleTab === 'pendientes' && (
            <>Pedidos con tag <strong>factura</strong> (toggle checkout) — emisión DTE tipo 33.</>
          )}
          {moduleTab === 'boletas' && (
            <>Pedidos B2C sin toggle factura — boleta electrónica tipo 39.</>
          )}
          {moduleTab === 'realizadas' && (
            <>Documentos emitidos desde este módulo (facturas y boletas).</>
          )}
        </Typography>
        <Button
          variant="contained"
          startIcon={<RefreshIcon />}
          onClick={refreshCurrentTab}
          disabled={loading}
          sx={{ flexShrink: 0 }}
        >
          Refrescar
        </Button>
      </Box>

      {siiBlocked.blocked && (
        <Alert severity="error" sx={{ mb: 2 }}>
          <strong>El SII te bloqueó temporalmente</strong> ({siiBlocked.reason || 'demasiados intentos'}).
          <Box sx={{ mt: 1, mb: 1, fontFamily: 'monospace', fontSize: '1.5rem', fontWeight: 700 }}>
            {blockCountdown || 'calculando…'}
          </Box>
          <Typography variant="body2">
            Tiempo restante antes de que el workbench permita reintentar el scraper.
            {siiBlocked.blockedSince && (
              <> Bloqueo activo desde {new Date(siiBlocked.blockedSince).toLocaleTimeString('es-CL')}.</>
            )}
          </Typography>
          <Typography variant="body2" sx={{ mt: 1 }}>
            No uses el scraper hasta que el contador llegue a 0. Luego prueba entrar manual en{' '}
            <a href="https://www.sii.cl" target="_blank" rel="noreferrer">sii.cl</a> antes de volver aquí.
          </Typography>
          <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
            <Button size="small" color="inherit" variant="outlined" onClick={stopAllSii}>
              Cerrar sesiones workbench
            </Button>
            <Button size="small" color="warning" variant="outlined" onClick={clearSiiBlock}>
              Ya entré manual al SII
            </Button>
          </Stack>
        </Alert>
      )}

      <Accordion
        expanded={configOpen}
        onChange={(_, exp) => setConfigOpen(exp)}
        sx={{
          mb: 2,
          bgcolor: '#fff',
          border: '1px solid #e2e8f0',
          borderRadius: '10px !important',
          '&:before': { display: 'none' },
          boxShadow: 'none',
        }}
      >
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Typography fontWeight={500}>
            Configuración SII {sessionReady ? '· sesión activa' : '· requerida para emitir'}
          </Typography>
        </AccordionSummary>
        <AccordionDetails>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }}>
            <Box>
              <Typography variant="caption" color="text.secondary" display="block">
                Emisor (fijo)
              </Typography>
              <Typography fontWeight={600}>
                {empresaRut ? formatRut(empresaRut) : 'Cargando…'}
              </Typography>
            </Box>
            {sessionReady ? (
              <>
                <Chip label="Sesión OK" color="success" size="small" />
                <Button size="small" color="warning" onClick={closeSession}>Cerrar sesión</Button>
              </>
            ) : (
              <Button
                variant="contained"
                size="small"
                onClick={createSession}
                disabled={creatingSession || !empresaRut || siiBlocked.blocked}
              >
                {creatingSession ? 'Conectando…' : 'Abrir sesión SII'}
              </Button>
            )}
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
            En Railway el scraper corre headless (sin ventana Chrome). La firma usa{' '}
            <code>SII_FIRMA_CLAVE</code> en las variables del servidor.
          </Typography>
        </AccordionDetails>
      </Accordion>

      {lastAviso && !error && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setLastAviso(null)}>
          {lastAviso}
        </Alert>
      )}

      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}
      {loading && <LinearProgress sx={{ mb: 2, borderRadius: 1 }} />}

      {moduleTab === 'realizadas' && (
        <TableContainer component={Paper} variant="outlined" sx={{ bgcolor: '#fff' }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 600, bgcolor: '#f7fafc' }}>Pedido</TableCell>
                <TableCell sx={{ fontWeight: 600, bgcolor: '#f7fafc' }}>Tipo</TableCell>
                <TableCell sx={{ fontWeight: 600, bgcolor: '#f7fafc' }}>Cliente</TableCell>
                <TableCell sx={{ fontWeight: 600, bgcolor: '#f7fafc' }}>Folio</TableCell>
                <TableCell sx={{ fontWeight: 600, bgcolor: '#f7fafc' }}>Emitida</TableCell>
                <TableCell sx={{ fontWeight: 600, bgcolor: '#f7fafc' }}>PDF</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {realizadasRows.length === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={6} align="center" sx={{ py: 6, color: 'text.secondary' }}>
                    Aún no hay documentos emitidos desde este módulo.
                  </TableCell>
                </TableRow>
              )}
              {realizadasRows.map((row) => (
                <TableRow key={row.shopifyOrderId} hover>
                  <TableCell><Typography fontWeight={600} fontSize={13}>{row.shopifyOrderName}</Typography></TableCell>
                  <TableCell>{dteLabel(row.tipoCodigo)}</TableCell>
                  <TableCell>
                    <Typography fontSize={13}>{row.razonSocial || row.customerName || '—'}</Typography>
                    {row.rutReceptor && <Typography variant="caption">{formatRut(row.rutReceptor)}</Typography>}
                  </TableCell>
                  <TableCell>{row.siiFolio ?? '—'}</TableCell>
                  <TableCell>
                    {row.emittedAt ? new Date(row.emittedAt).toLocaleString('es-CL') : '—'}
                  </TableCell>
                  <TableCell>
                    <Button
                      size="small"
                      variant="outlined"
                      disabled={!row.siiCodigo || busyOrderId === row.shopifyOrderId}
                      onClick={() => descargarPdf(row.shopifyOrderId)}
                    >
                      PDF
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {moduleTab !== 'realizadas' && (
      <Grid container spacing={2}>
        <Grid item xs={12} md={(selectedRow || selectedBoleta) ? 5 : 12}>
          <TableContainer
            component={Paper}
            variant="outlined"
            sx={{ bgcolor: '#fff', maxHeight: (selectedRow || selectedBoleta) ? 640 : undefined, overflow: 'auto' }}
          >
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontWeight: 600, bgcolor: '#f7fafc' }}>Pedido</TableCell>
                  <TableCell sx={{ fontWeight: 600, bgcolor: '#f7fafc' }}>Fecha</TableCell>
                  <TableCell sx={{ fontWeight: 600, bgcolor: '#f7fafc' }}>Cliente</TableCell>
                  {moduleTab === 'pendientes' && (
                    <TableCell align="right" sx={{ fontWeight: 600, bgcolor: '#f7fafc' }}>Total</TableCell>
                  )}
                  <TableCell sx={{ fontWeight: 600, bgcolor: '#f7fafc' }}>Estado</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {moduleTab === 'pendientes' && pendingRows.length === 0 && !loading && (
                  <TableRow>
                    <TableCell colSpan={5} align="center" sx={{ py: 6, color: 'text.secondary' }}>
                      No hay facturas pendientes (tag factura en Shopify).
                    </TableCell>
                  </TableRow>
                )}
                {moduleTab === 'boletas' && boletasRows.length === 0 && !loading && (
                  <TableRow>
                    <TableCell colSpan={4} align="center" sx={{ py: 6, color: 'text.secondary' }}>
                      No hay boletas pendientes. Llegan vía webhook al pagar pedidos sin toggle factura.
                    </TableCell>
                  </TableRow>
                )}
                {moduleTab === 'pendientes' && pendingRows.map((row) => {
                  const isSelected = selectedId === row.shopify.id;
                  const attrs = Object.fromEntries(
                    row.shopify.customAttributes.map((a) => [a.key, a.value]),
                  );
                  const rut = attrs._rut_empresa || '';
                  const razon = attrs._razon_social || '';
                  return (
                    <TableRow
                      key={row.shopify.id}
                      hover
                      selected={isSelected}
                      onClick={() => selectOrder(row)}
                      sx={{ cursor: 'pointer', '&.Mui-selected': { bgcolor: 'rgba(43, 108, 176, 0.08) !important' } }}
                    >
                      <TableCell><Typography fontWeight={600} fontSize={13}>{row.shopify.name}</Typography></TableCell>
                      <TableCell>{new Date(row.shopify.processedAt).toLocaleDateString('es-CL')}</TableCell>
                      <TableCell>
                        <Typography fontSize={13}>{razon || row.shopify.shippingAddress?.name || '—'}</Typography>
                        {rut && <Typography variant="caption">{formatRut(rut)}</Typography>}
                      </TableCell>
                      <TableCell align="right"><Typography fontWeight={600} fontSize={13}>{fmt(row.shopify.total)}</Typography></TableCell>
                      <TableCell>{statusChip(row.emision?.status)}</TableCell>
                    </TableRow>
                  );
                })}
                {moduleTab === 'boletas' && boletasRows.map((row) => {
                  const isSelected = selectedId === row.shopifyOrderId;
                  return (
                    <TableRow
                      key={row.shopifyOrderId}
                      hover
                      selected={isSelected}
                      onClick={() => selectBoleta(row)}
                      sx={{ cursor: 'pointer', '&.Mui-selected': { bgcolor: 'rgba(43, 108, 176, 0.08) !important' } }}
                    >
                      <TableCell><Typography fontWeight={600} fontSize={13}>{row.shopifyOrderName}</Typography></TableCell>
                      <TableCell>
                        {row.createdAt
                          ? new Date(row.createdAt).toLocaleDateString('es-CL')
                          : '—'}
                      </TableCell>
                      <TableCell><Typography fontSize={13}>{row.customerName || 'Consumidor final'}</Typography></TableCell>
                      <TableCell>{statusChip(row.status)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        </Grid>

        {(selectedRow || selectedBoleta) && (
          <Grid item xs={12} md={7}>
            <Paper variant="outlined" sx={{ p: 2.5, bgcolor: '#fff', position: { md: 'sticky' }, top: 16 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
                <Box>
                  <Typography variant="h6">
                    {selectedRow?.shopify.name || selectedBoleta?.shopifyOrderName}
                  </Typography>
                  <Typography variant="caption">
                    {dteLabel(payload?.tipoCodigo ?? (moduleTab === 'boletas' ? 39 : 33))}
                  </Typography>
                </Box>
                <Chip
                  label={sessionReady ? 'Sesión SII activa' : 'Sin sesión SII'}
                  color={sessionReady ? 'success' : 'default'}
                  size="small"
                  variant={sessionReady ? 'filled' : 'outlined'}
                />
              </Box>

              {payloadLoading && (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
                  <CircularProgress size={18} />
                  <Typography variant="body2" color="text.secondary">Cargando preview…</Typography>
                </Box>
              )}

              {payload && (
                <Paper variant="outlined" sx={{ p: 2, mb: 2, bgcolor: '#f7fafc' }}>
                  <Typography variant="subtitle2" sx={{ mb: 1.5, fontWeight: 600 }}>
                    Preview — datos para el SII
                  </Typography>
                  {payload.rutReceptor && !validateRut(payload.rutReceptor) && (
                    <Alert severity="warning" sx={{ mb: 1.5 }}>
                      RUT receptor inválido ({formatRut(payload.rutReceptor)}).
                    </Alert>
                  )}
                  <Box sx={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 0.75, fontSize: 13, mb: 1.5 }}>
                    {payload.rutReceptor && (
                      <>
                        <Typography color="text.secondary">RUT</Typography>
                        <Typography>{formatRut(payload.rutReceptor)}</Typography>
                      </>
                    )}
                    {payload.razonSocial && (
                      <>
                        <Typography color="text.secondary">Razón social</Typography>
                        <Typography>{payload.razonSocial}</Typography>
                      </>
                    )}
                    <Typography color="text.secondary">Modo SII</Typography>
                    <Typography>{templateLabel(payload.template)}</Typography>
                  </Box>
                  <Divider sx={{ my: 1.5 }} />
                  <Stack spacing={0.75}>
                    {payload.items.map((it) => (
                      <Typography key={it.numero} fontSize={13}>
                        {it.cantidad}× {it.descripcion} — <strong>{fmt(it.precioUnitario)}</strong>
                        {payload.tipoCodigo === 33 ? ' neto' : ''}
                      </Typography>
                    ))}
                  </Stack>
                </Paper>
              )}

              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
                <Button
                  variant="contained"
                  color="success"
                  size="large"
                  disabled={
                    isBusy || !sessionReady || siiBlocked.blocked ||
                    (moduleTab === 'pendientes' && !templateReady(payload?.template))
                  }
                  onClick={() => emitirDte(
                    selectedRow?.shopify.id || selectedBoleta!.shopifyOrderId,
                    { isBoleta: moduleTab === 'boletas' },
                  )}
                >
                  {isBusy
                    ? 'Emitiendo en SII… (~1 min)'
                    : moduleTab === 'boletas' ? 'Emitir boleta' : 'Emitir factura'}
                </Button>
              </Stack>
              <Typography variant="caption" color="text.secondary" display="block">
                Emisión automática: {autoEmitFactura ? 'facturas ON' : 'facturas OFF'} · {autoEmitBoleta ? 'boletas ON' : 'boletas OFF'} (variables Railway).
              </Typography>

              {(selectedRow?.emision?.lastError || selectedBoleta?.lastError) && (
                <Alert severity="warning" sx={{ mt: 2 }}>
                  {selectedRow?.emision?.lastError || selectedBoleta?.lastError}
                </Alert>
              )}
            </Paper>
          </Grid>
        )}
      </Grid>
      )}

      <Snackbar open={!!snack} autoHideDuration={5000} onClose={() => setSnack(null)} message={snack || ''} />
    </Box>
  );
}
