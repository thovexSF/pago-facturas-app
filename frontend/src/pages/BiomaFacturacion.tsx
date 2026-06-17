import { useCallback, useEffect, useState, Fragment } from 'react';
import {
  Box, Typography, Paper, Button, Alert, CircularProgress, Table, TableBody,
  TableCell, TableContainer, TableHead, TableRow, Chip, Snackbar,
  Stack, LinearProgress, Accordion, AccordionSummary, AccordionDetails,
  TextField, Collapse,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/esm/ExpandMore.js';
import RefreshIcon from '@mui/icons-material/esm/Refresh.js';
import { API_CONFIG } from '../config/api';
import { formatRut, validateRut } from '../utils/rutUtils';

const BIOMA_API = `${API_CONFIG.BASE_URL}/api/bioma`;
const SII_API = `${API_CONFIG.BASE_URL}/api/sii-facturacion`;

type ScraperStep = 'abrir' | 'rellenar' | 'emitir';

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
}

interface PendingRow {
  shopify: ShopifyOrderForBioma;
  emision: BiomaEmision | null;
}

interface PayloadData {
  rutReceptor: string | null;
  razonSocial: string | null;
  giroReceptor: string | null;
  items: Array<{ numero: number; descripcion: string; cantidad: number; precioUnitario: number; subtotal: number }>;
  template: {
    codigo: string | null;
    folio?: number | null;
    templateCliente?: string | null;
    source?: 'env' | 'cliente_emision' | 'cliente_sii' | 'nueva';
  };
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

const STEP_LABELS: Record<ScraperStep, string> = {
  abrir: '① Abrir formulario SII',
  rellenar: '② Rellenar con datos Shopify',
  emitir: '③ Emitir factura',
};

export default function BiomaFacturacion() {
  const [empresaRut, setEmpresaRut] = useState(() => localStorage.getItem('biomaEmpresaRut') || '');
  const [sessionId, setSessionId] = useState<string | null>(() => localStorage.getItem('biomaSiiSessionId'));
  const [configOpen, setConfigOpen] = useState(() => !localStorage.getItem('biomaSiiSessionId'));

  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<PendingRow[]>([]);
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

  useEffect(() => { loadPending(); }, [loadPending]);

  useEffect(() => {
    if (empresaRut && !localStorage.getItem('biomaEmpresaRut')) {
      fetch(`${BIOMA_API}/template-codigo`)
        .then((r) => r.json())
        .then((d) => { if (d.empresaRut) setEmpresaRut(d.empresaRut); })
        .catch(() => {});
    }
  }, [empresaRut]);

  const selectOrder = useCallback((row: PendingRow) => {
    const id = row.shopify.id;
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
      setError('Ingresa el RUT emisor (ej. 78015129-3)');
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
      localStorage.setItem('biomaEmpresaRut', empresaRut);
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

  const runScraperStep = useCallback(async (orderId: string, step: ScraperStep) => {
    if (siiBlocked.blocked) {
      setError(`SII en pausa ~${siiBlocked.retryAfterMinutes} min. No reintentes el scraper.`);
      return;
    }
    if (!sessionReady) {
      setError('Abre sesión SII en Configuración antes de usar el scraper');
      setConfigOpen(true);
      return;
    }
    if (step !== 'abrir' && !templateReady(payload?.template)) {
      setError('No se pudo resolver plantilla SII ni modo factura nueva.');
      return;
    }
    if (step === 'emitir') {
      const ok = window.confirm(
        '¿Emitir la factura en el SII?\n\nSe validará, firmará y guardará el DTE. ' +
        'Asegúrate de haber revisado el formulario (paso ②) o los datos del preview.',
      );
      if (!ok) return;
    }
    setBusyOrderId(orderId);
    setError(null);
    try {
      const res = await fetch(`${BIOMA_API}/scraper/${encodeURIComponent(orderId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, step }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || data.result?.error || `HTTP ${res.status}`);
      }
      setSnack(data.message || data.result?.aviso || `${STEP_LABELS[step]} — OK`);
      setLastAviso(data.message || data.result?.aviso || null);
      await loadPending();
      if (selectedId === orderId) await loadPayload(orderId);
    } catch (e: any) {
      setError(`${STEP_LABELS[step]}: ${e?.message || e}`);
      await loadBlockStatus();
    } finally {
      setBusyOrderId(null);
    }
  }, [sessionReady, sessionId, payload, loadPending, loadPayload, selectedId, siiBlocked, loadBlockStatus]);

  const pendingCount = rows.filter((r) => r.emision?.status !== 'emitted').length;

  return (
    <Box sx={{ p: 3, maxWidth: 1100, mx: 'auto' }}>
      <Typography variant="h5" gutterBottom>Facturación SII</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Emisión de DTE. Pedidos con tag <code>factura</code> (etiquetados por la app <strong>Facturación</strong> de pago).
      </Typography>

      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
        <Chip label={`${pendingCount} pendientes`} color={pendingCount ? 'warning' : 'default'} size="small" />
        <Box sx={{ flex: 1 }} />
        <Button size="small" startIcon={<RefreshIcon />} onClick={loadPending} disabled={loading}>
          Refrescar pedidos
        </Button>
      </Stack>

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

      <Accordion expanded={configOpen} onChange={(_, exp) => setConfigOpen(exp)} sx={{ mb: 2 }}>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Typography fontWeight={500}>
            Configuración SII {sessionReady ? '· sesión activa' : '· requerida para pasos ①②③'}
          </Typography>
        </AccordionSummary>
        <AccordionDetails>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }}>
            <TextField
              label="RUT emisor"
              size="small"
              value={empresaRut}
              onChange={(e) => setEmpresaRut(e.target.value)}
              placeholder="78015129-3"
              sx={{ minWidth: 200 }}
            />
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
            Usa <code>SII_PLAYWRIGHT_HEADED=true</code> en .env para ver Chrome al ejecutar el scraper.
          </Typography>
        </AccordionDetails>
      </Accordion>

      {lastAviso && !error && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setLastAviso(null)}>
          {lastAviso}
        </Alert>
      )}

      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}
      {loading && <LinearProgress sx={{ mb: 2 }} />}

      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Pedido</TableCell>
              <TableCell>Fecha</TableCell>
              <TableCell>Cliente</TableCell>
              <TableCell align="right">Total</TableCell>
              <TableCell>Estado</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.length === 0 && !loading && (
              <TableRow>
                <TableCell colSpan={5} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                  No hay pedidos con tag factura pendientes de emitir.
                </TableCell>
              </TableRow>
            )}
            {rows.map((row) => {
              const isSelected = selectedId === row.shopify.id;
              const isBusy = busyOrderId === row.shopify.id;
              const attrs = Object.fromEntries(
                row.shopify.customAttributes.map((a) => [a.key, a.value]),
              );
              const rut = attrs._rut_empresa || '';
              const razon = attrs._razon_social || '';
              return (
                <Fragment key={row.shopify.id}>
                  <TableRow
                    hover
                    selected={isSelected}
                    onClick={() => selectOrder(row)}
                    sx={{ cursor: 'pointer' }}
                  >
                    <TableCell><strong>{row.shopify.name}</strong></TableCell>
                    <TableCell>{new Date(row.shopify.processedAt).toLocaleDateString('es-CL')}</TableCell>
                    <TableCell>
                      <div>{razon || row.shopify.shippingAddress?.name || '—'}</div>
                      {rut && <Typography variant="caption" color="text.secondary">{formatRut(rut)}</Typography>}
                    </TableCell>
                    <TableCell align="right">{fmt(row.shopify.total)}</TableCell>
                    <TableCell>{statusChip(row.emision?.status)}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell colSpan={5} sx={{ py: 0, border: 0 }}>
                      <Collapse in={isSelected}>
                        <Box sx={{ py: 2, px: 1 }}>
                          {payloadLoading && <CircularProgress size={20} sx={{ mb: 1 }} />}

                          {payload && (
                            <Paper variant="outlined" sx={{ p: 2, mb: 2, bgcolor: 'grey.50' }}>
                              <Typography variant="subtitle2" gutterBottom>
                                Datos que enviaremos al SII (desde Shopify)
                              </Typography>
                              {payload.rutReceptor && !validateRut(payload.rutReceptor) && (
                                <Alert severity="warning" sx={{ mb: 1 }}>
                                  RUT receptor inválido ({formatRut(payload.rutReceptor)}). Corrígelo en Shopify antes de emitir.
                                </Alert>
                              )}
                              <Stack spacing={0.5} sx={{ fontFamily: 'monospace', fontSize: 13 }}>
                                <div><strong>RUT:</strong> {payload.rutReceptor ? formatRut(payload.rutReceptor) : '—'}</div>
                                <div><strong>Razón social:</strong> {payload.razonSocial || '—'}</div>
                                <div><strong>Giro:</strong> {payload.giroReceptor || '—'}</div>
                                <div><strong>Modo SII:</strong> {templateLabel(payload.template)}</div>
                                {payload.items.map((it) => (
                                  <div key={it.numero}>
                                    · {it.cantidad}× {it.descripcion} — {fmt(it.precioUnitario)} neto
                                  </div>
                                ))}
                              </Stack>
                              <Button size="small" sx={{ mt: 1 }} onClick={() => loadPayload(row.shopify.id)}>
                                Actualizar datos
                              </Button>
                            </Paper>
                          )}

                          <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
                            <Typography variant="subtitle2" gutterBottom>Checklist antes del SII</Typography>
                            <Stack spacing={0.5} sx={{ fontSize: 13 }}>
                              <div>{sessionReady ? '✅' : '⬜'} Sesión SII abierta</div>
                              <div>{templateReady(payload?.template) ? '✅' : '⬜'} Modo SII (copiar cliente o factura nueva)</div>
                              <div>{payload?.rutReceptor && payload?.razonSocial ? '✅' : '⬜'} RUT y razón social del cliente</div>
                              <div>{!siiBlocked.blocked ? '✅' : '⬜'} SII no bloqueado por el workbench</div>
                            </Stack>
                          </Paper>

                          <Typography variant="subtitle2" gutterBottom>Scraper — un pedido, paso a paso</Typography>
                          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                            Recomendado: <strong>② Rellenar</strong> (abre Chrome con el formulario lleno) → revisar → <strong>③ Emitir</strong>.
                          </Typography>
                          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                            {(Object.keys(STEP_LABELS) as ScraperStep[]).map((step) => (
                              <Button
                                key={step}
                                variant={step === 'emitir' ? 'contained' : step === 'rellenar' ? 'contained' : 'outlined'}
                                color={step === 'emitir' ? 'success' : step === 'rellenar' ? 'primary' : 'inherit'}
                                size="small"
                                disabled={isBusy || !sessionReady || siiBlocked.blocked || (step !== 'abrir' && !templateReady(payload?.template))}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  runScraperStep(row.shopify.id, step);
                                }}
                              >
                                {isBusy ? '…' : STEP_LABELS[step]}
                              </Button>
                            ))}
                          </Stack>
                          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
                            ① Solo diagnóstico · ② Copia plantilla + datos Shopify (Chrome queda abierto) · ③ Valida, firma y emite
                          </Typography>

                          {row.emision?.lastError && (
                            <Alert severity="warning" sx={{ mt: 2 }}>{row.emision.lastError}</Alert>
                          )}
                        </Box>
                      </Collapse>
                    </TableCell>
                  </TableRow>
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>

      <Snackbar open={!!snack} autoHideDuration={5000} onClose={() => setSnack(null)} message={snack || ''} />
    </Box>
  );
}
