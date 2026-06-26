import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Box, Typography, Paper, Button, Alert, CircularProgress, Table, TableBody,
  TableCell, TableContainer, TableHead, TableRow, Chip, Snackbar,
  Stack, LinearProgress, Grid, Divider, Tabs, Tab,
  Dialog, DialogTitle, DialogContent, DialogActions, IconButton, Tooltip, SvgIcon,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/esm/Refresh.js';
import CloseIcon from '@mui/icons-material/esm/Close.js';
import EmailOutlinedIcon from '@mui/icons-material/esm/EmailOutlined.js';
import { API_CONFIG } from '../config/api';
import { formatRut, validateRut } from '../utils/rutUtils';
import StatCard from '../components/StatCard';
import FacturaEmitPreview from '../components/FacturaEmitPreview';
import {
  computeDescuentoGlobalPreview,
  computePreviewMontos,
  FACTURA_DRAFT_KEY,
  normalizeDraftItems,
  payloadToDraft,
  type FacturaEditDraft,
} from '../utils/facturaPreview';
import { draftMetaForStorage, mergeDraftMeta } from '../utils/facturaDraft';
import type { SiiEmitFormSnapshot } from '../utils/siiFormSnapshot';
import { formatSessionExpiresIn, isSiiSessionError, useSiiSessionMonitor } from '../hooks/useSiiSessionMonitor';
import { fetchFacturaPdfFile, shareWhatsAppWithPdf } from '../utils/whatsappShare';

const BIOMA_API = `${API_CONFIG.BASE_URL}/api/bioma`;
const SII_API = `${API_CONFIG.BASE_URL}/api/sii-facturacion`;
const EBOLETA_API = `${API_CONFIG.BASE_URL}/api/eboleta`;


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
  status: 'pending' | 'drafting' | 'emitting' | 'emitted' | 'error' | 'dismissed';
  lastError: string | null;
  siiFolio: number | null;
  siiCodigo?: string | null;
  rutReceptor?: string | null;
  razonSocial?: string | null;
  customerName?: string | null;
  tipoCodigo?: number;
}

interface PendingRow {
  shopify: ShopifyOrderForBioma;
  emision: BiomaEmision | null;
}

interface MontosValidacion {
  ok: boolean;
  diff: number;
  tolerancia: number;
  shopify: {
    total: number;
    subtotal: number;
    tax: number;
    shipping: number;
    totalDiscounts: number;
    lineItemsBruto: number;
    lineDiscounts: number;
  };
  factura: {
    neto: number;
    iva: number;
    total: number;
  };
  ajusteNeto: number;
  issues: string[];
}

interface PayloadData {
  rutReceptor: string | null;
  razonSocial: string | null;
  giroReceptor: string | null;
  comunaReceptor?: string | null;
  ciudadReceptor?: string | null;
  dirReceptor?: string | null;
  fechaEmision?: string;
  tipoCodigo?: number;
  items: Array<{
    numero: number;
    descripcion: string;
    descripcionExtendida?: string;
    cantidad: number;
    precioUnitario: number;
    subtotal: number;
  }>;
  descuentoGlobal?: {
    montoNeto: number;
    porcentaje: number;
    glosa: string;
  } | null;
  template: {
    codigo: string | null;
    folio?: number | null;
    templateCliente?: string | null;
    source?: 'env' | 'cliente_emision' | 'cliente_sii' | 'nueva';
  };
  montosValidacion?: MontosValidacion;
}

interface EmisionDbRow {
  shopifyOrderId: string;
  shopifyOrderName: string;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  rutReceptor: string | null;
  razonSocial: string | null;
  tipoCodigo: number;
  status: BiomaEmision['status'];
  siiFolio: number | null;
  siiCodigo: string | null;
  emittedAt: string | null;
  whatsappSentAt: string | null;
  createdAt?: string | null;
  lastError: string | null;
}

function WhatsAppIcon(props: { fontSize?: 'small' | 'inherit' | 'medium' | 'large' }) {
  return (
    <SvgIcon {...props} viewBox="0 0 24 24">
      <path
        fill="currentColor"
        d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.435 9.884-9.881 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"
      />
    </SvgIcon>
  );
}

type ModuleTab = 'pendientes' | 'boletas' | 'realizadas';
type BoletasRango = 'semana' | 'mes' | 'historico';

function dteLabel(tipo: number): string {
  if (tipo === 39) return 'Boleta';
  if (tipo === 41) return 'Boleta exenta';
  if (tipo === 34) return 'Factura exenta';
  return 'Factura';
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
  if (status === 'dismissed') return <Chip size="small" label="Descartada" color="default" />;
  if (status === 'error') return <Chip size="small" label="Error" color="error" />;
  return <Chip size="small" label={String(status)} />;
}

function clienteFactura(row: PendingRow): { razon: string; rut: string; nombre: string } {
  const attrs = Object.fromEntries(row.shopify.customAttributes.map((a) => [a.key, a.value]));
  const rut = row.emision?.rutReceptor || attrs._rut_empresa || '';
  const nombre =
    [row.shopify.customer?.firstName, row.shopify.customer?.lastName].filter(Boolean).join(' ') ||
    row.emision?.customerName ||
    row.shopify.shippingAddress?.name ||
    '';
  const razon = row.emision?.razonSocial || attrs._razon_social || nombre;
  return { razon, rut, nombre };
}

export default function BiomaFacturacion() {
  const [moduleTab, setModuleTab] = useState<ModuleTab>('pendientes');
  const [boletasRango, setBoletasRango] = useState<BoletasRango>(() => {
    const saved = localStorage.getItem('biomaBoletasRango');
    return saved === 'mes' || saved === 'historico' ? saved : 'semana';
  });
  const [empresaRut, setEmpresaRut] = useState('');
  const [autoEmitFactura, setAutoEmitFactura] = useState(false);
  const [autoEmitBoleta, setAutoEmitBoleta] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(() => localStorage.getItem('biomaSiiSessionId'));
  const [eboletaSessionId, setEboletaSessionId] = useState<string | null>(
    () => localStorage.getItem('biomaEboletaSessionId'),
  );
  const [facturaModalOpen, setFacturaModalOpen] = useState(false);

  const activeSessionId = moduleTab === 'boletas' ? eboletaSessionId : sessionId;
  const handleSiiSessionInvalid = useCallback((reason?: string) => {
    setSessionId(null);
    localStorage.removeItem('biomaSiiSessionId');
    const r = (reason || '').toLowerCase();
    if (r.includes('no encontrada') || r.includes('reinicio del backend')) {
      setError(null);
      return;
    }
    setError(reason || 'Sesión MiPyme expirada. Vuelve a abrir sesión SII.');
  }, []);

  const siiSession = useSiiSessionMonitor({
    siiApiBase: SII_API,
    sessionId: moduleTab === 'boletas' ? null : sessionId,
    onInvalid: handleSiiSessionInvalid,
    closeOnPageHide: moduleTab !== 'boletas',
  });

  const sessionReady =
    moduleTab === 'boletas' ? !!eboletaSessionId : siiSession.sessionReady;

  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<PendingRow[]>([]);
  const [boletasRows, setBoletasRows] = useState<EmisionDbRow[]>([]);
  const [realizadasRows, setRealizadasRows] = useState<EmisionDbRow[]>([]);
  const [realizadasTotal, setRealizadasTotal] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [payload, setPayload] = useState<PayloadData | null>(null);
  const [payloadLoading, setPayloadLoading] = useState(false);
  const [editDraft, setEditDraft] = useState<FacturaEditDraft | null>(null);
  const [draftDirty, setDraftDirty] = useState(false);
  const [shopifyTotalRef, setShopifyTotalRef] = useState(0);
  const [siiFormSnapshot, setSiiFormSnapshot] = useState<SiiEmitFormSnapshot | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [snack, setSnack] = useState<string | null>(null);
  const [lastAviso, setLastAviso] = useState<string | null>(null);
  const [ncAviso, setNcAviso] = useState<{ orderId: string; text: string } | null>(null);
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
      const res = await fetch(`${BIOMA_API}/pedidos-pendientes?pageSize=100`);
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

  const boletasDaysBack = boletasRango === 'semana' ? 14 : boletasRango === 'mes' ? 45 : 0;

  const loadBoletas = useCallback(async (opts?: { quiet?: boolean; daysBack?: number; sync?: boolean }) => {
    const days = opts?.daysBack ?? boletasDaysBack;
    const sync = opts?.sync ?? false;
    setLoading(true);
    if (!opts?.quiet) setError(null);
    try {
      const res = await fetch(
        `${BIOMA_API}/boletas-pendientes?pageSize=100&sync=${sync ? 1 : 0}&daysBack=${days}`,
      );
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      setBoletasRows(data.rows || []);
      if (data.syncStats && !opts?.quiet) {
        const s = data.syncStats;
        const rango =
          days === 0 ? 'histórico' : days <= 14 ? 'últimos 14 días' : `últimos ${days} días`;
        setSnack(
          `Boletas (${rango}): ${data.total ?? 0} pendientes — ${s.registered} nuevas de ${s.scanned} pedidos revisados en Shopify`,
        );
      }
    } catch (e: any) {
      setError(`Boletas: ${e?.message || e}`);
      setBoletasRows([]);
    } finally {
      setLoading(false);
    }
  }, [boletasDaysBack]);

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
    setEditDraft(null);
    setDraftDirty(false);
    setSiiFormSnapshot(null);
    try {
      const res = await fetch(`${BIOMA_API}/payload/${encodeURIComponent(orderId)}`);
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      setPayload(data.payload);
      setShopifyTotalRef(Math.round(data.shopify?.total || data.payload?.montosValidacion?.shopify?.total || 0));
      const base = payloadToDraft(data.payload);
      try {
        const raw = localStorage.getItem(FACTURA_DRAFT_KEY(orderId));
        if (raw) {
          const saved = JSON.parse(raw) as FacturaEditDraft;
          setEditDraft(mergeDraftMeta(base, saved));
          setDraftDirty(true);
          return;
        }
      } catch {
        /* ignore corrupt draft */
      }
      setEditDraft(base);
    } catch (e: any) {
      setError(`Datos del pedido: ${e?.message || e}`);
      setPayload(null);
      setEditDraft(null);
    } finally {
      setPayloadLoading(false);
    }
  }, []);

  useEffect(() => {
    const d = boletasRango === 'semana' ? 14 : boletasRango === 'mes' ? 45 : 0;
    void loadBoletas({ quiet: true, daysBack: d, sync: false });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (moduleTab === 'boletas') {
      const d = boletasRango === 'semana' ? 14 : boletasRango === 'mes' ? 45 : 0;
      void loadBoletas({ quiet: true, daysBack: d, sync: false });
    }
  }, [moduleTab, boletasRango, loadBoletas]);

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

  useEffect(() => {
    void loadPending();
    void loadRealizadas();
  }, [loadPending, loadRealizadas]);

  const openFacturaModal = useCallback((row: PendingRow) => {
    setSelectedId(row.shopify.id);
    setFacturaModalOpen(true);
    setPayload(null);
    void loadPayload(row.shopify.id);
  }, [loadPayload]);

  const closeFacturaModal = useCallback(() => {
    setFacturaModalOpen(false);
    setSelectedId(null);
    setPayload(null);
    setEditDraft(null);
    setDraftDirty(false);
  }, []);

  const handleDraftChange = useCallback((next: FacturaEditDraft) => {
    const normalized = {
      ...next,
      items: normalizeDraftItems(next.items),
    };
    const descuentoGlobal = computeDescuentoGlobalPreview(
      normalized.items,
      shopifyTotalRef,
      normalized.tipoCodigo ?? 33,
      { totalDiscounts: payload?.montosValidacion?.shopify.totalDiscounts },
    );
    const withTotals = { ...normalized, descuentoGlobal };
    setEditDraft(withTotals);
    setDraftDirty(true);
    if (selectedId) {
      try {
        localStorage.setItem(FACTURA_DRAFT_KEY(selectedId), JSON.stringify(draftMetaForStorage(withTotals)));
      } catch {
        /* quota */
      }
    }
  }, [selectedId, shopifyTotalRef, payload?.montosValidacion?.shopify.totalDiscounts]);

  const resetDraftFromShopify = useCallback(() => {
    if (!payload || !selectedId) return;
    const base = payloadToDraft(payload);
    setEditDraft(base);
    setDraftDirty(false);
    try {
      localStorage.removeItem(FACTURA_DRAFT_KEY(selectedId));
    } catch {
      /* ok */
    }
  }, [payload, selectedId]);

  const selectOrder = useCallback((row: PendingRow) => {
    openFacturaModal(row);
  }, [openFacturaModal]);

  const selectBoleta = useCallback((row: EmisionDbRow) => {
    const id = row.shopifyOrderId;
    setSelectedId((prev) => (prev === id ? null : id));
    setPayload(null);
    if (id) loadPayload(id);
  }, [loadPayload]);

  const createSession = useCallback(async () => {
    if (moduleTab !== 'boletas' && siiBlocked.blocked) {
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
      if (moduleTab === 'boletas') {
        const res = await fetch(`${EBOLETA_API}/session/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ empresaRut }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
        setEboletaSessionId(data.sessionId);
        localStorage.setItem('biomaEboletaSessionId', data.sessionId);
        setSnack('Sesión e-Boleta lista (eboleta.sii.cl). Playwright abre al emitir.');
        return;
      }
      const res = await fetch(`${SII_API}/session/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ empresaRut, deferPlaywright: true }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      setSessionId(data.sessionId);
      localStorage.setItem('biomaSiiSessionId', data.sessionId);
      setSnack('Sesión MiPyme lista (facturas). Playwright se abre al emitir.');
      void siiSession.refresh({ probe: false });
    } catch (e: any) {
      setError(`Sesión: ${e?.message || e}`);
    } finally {
      setCreatingSession(false);
    }
  }, [empresaRut, siiBlocked, moduleTab, siiSession]);

  const closeSession = useCallback(async () => {
    if (moduleTab === 'boletas') {
      if (!eboletaSessionId) return;
      try {
        await fetch(`${EBOLETA_API}/session/${eboletaSessionId}`, { method: 'DELETE' });
      } finally {
        setEboletaSessionId(null);
        localStorage.removeItem('biomaEboletaSessionId');
      }
      return;
    }
    if (!sessionId) return;
    try {
      await fetch(`${SII_API}/session/${sessionId}`, { method: 'DELETE' });
    } finally {
      setSessionId(null);
      localStorage.removeItem('biomaSiiSessionId');
    }
  }, [sessionId, eboletaSessionId, moduleTab]);

  const stopAllSii = useCallback(async () => {
    try {
      await fetch(`${SII_API}/session/close-all`, { method: 'POST' });
      await fetch(`${EBOLETA_API}/session/close-all`, { method: 'POST' });
      setSessionId(null);
      setEboletaSessionId(null);
      localStorage.removeItem('biomaSiiSessionId');
      localStorage.removeItem('biomaEboletaSessionId');
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

  const rellenarEnSii = useCallback(async (orderId: string) => {
    if (siiBlocked.blocked) {
      setError(`SII en pausa ~${siiBlocked.retryAfterMinutes} min.`);
      return;
    }
    if (!sessionReady || !activeSessionId) {
      setError('Abre sesión MiPyme antes de rellenar');
      return;
    }
    if (!templateReady(payload?.template)) {
      setError('No se pudo resolver plantilla SII.');
      return;
    }
    if (!editDraft) {
      setError('Carga el preview del pedido primero.');
      return;
    }

    setBusyOrderId(orderId);
    setError(null);
    setSiiFormSnapshot(null);
    try {
      const dg =
        payload?.descuentoGlobal ??
        computeDescuentoGlobalPreview(editDraft.items, shopifyTotalRef, editDraft.tipoCodigo ?? 33, {
          totalDiscounts: payload?.montosValidacion?.shopify.totalDiscounts,
        });
      const body: Record<string, unknown> = {
        sessionId: activeSessionId,
        step: 'rellenar',
        tipoCodigo: 33,
        codigoOriginal: payload?.template?.codigo ?? undefined,
        fechaEmision: editDraft.fechaEmision,
        rutReceptor: editDraft.rutReceptor || undefined,
        razonSocial: editDraft.razonSocial || undefined,
        giroReceptor: editDraft.giroReceptor || undefined,
        comunaReceptor: editDraft.comunaReceptor || undefined,
        ciudadReceptor: editDraft.ciudadReceptor || undefined,
        dirReceptor: editDraft.dirReceptor || undefined,
        items: editDraft.items.map((it) => ({
          numero: it.numero,
          descripcion: it.descripcion,
          cantidad: it.cantidad,
          descripcionExtendida: editDraft.useDescripcionExtendida
            ? (it.descripcionExtendida || it.tituloExtendido || undefined)
            : undefined,
        })),
        useDescripcionExtendida: !!editDraft.useDescripcionExtendida,
        skipMontosValidation: !!draftDirty,
      };
      if (dg) body.descuentoGlobal = dg;

      const res = await fetch(`${BIOMA_API}/preview/${encodeURIComponent(orderId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        const errMsg = data.error || data.result?.error || `HTTP ${res.status}`;
        if (isSiiSessionError(res.status, errMsg)) handleSiiSessionInvalid(errMsg);
        throw new Error(errMsg);
      }
      const snap = data.result?.formSnapshot as SiiEmitFormSnapshot | undefined;
      if (snap) {
        setSiiFormSnapshot(snap);
        setSnack('Formulario SII rellenado — revisa la lectura abajo y Chrome si está visible');
      } else {
        setSnack(data.message || 'Formulario rellenado en MiPyme (sin lectura de campos)');
      }
    } catch (e: any) {
      setError(`Rellenar SII: ${e?.message || e}`);
    } finally {
      setBusyOrderId(null);
    }
  }, [
    siiBlocked.blocked,
    siiBlocked.retryAfterMinutes,
    sessionReady,
    activeSessionId,
    payload,
    editDraft,
    draftDirty,
    shopifyTotalRef,
    handleSiiSessionInvalid,
  ]);

  const emitirDte = useCallback(async (orderId: string, opts?: { isBoleta?: boolean }) => {
    const isBoleta = opts?.isBoleta ?? moduleTab === 'boletas';
    if (!isBoleta && siiBlocked.blocked) {
      setError(`SII en pausa ~${siiBlocked.retryAfterMinutes} min.`);
      return;
    }
    if (!sessionReady || !activeSessionId) {
      setError(isBoleta ? 'Abre sesión e-Boleta antes de emitir' : 'Abre sesión MiPyme antes de emitir');
      return;
    }
    if (!isBoleta && !templateReady(payload?.template)) {
      setError('No se pudo resolver plantilla SII.');
      return;
    }
    if (!isBoleta && editDraft) {
      const rut = (editDraft.rutReceptor || '').trim();
      if (rut && !validateRut(rut)) {
        setError('RUT receptor inválido en el preview. Corrígelo antes de emitir.');
        return;
      }
      if (!editDraft.items.length || editDraft.items.some((it) => !it.descripcion.trim() || it.precioUnitario < 1)) {
        setError('Cada línea debe tener descripción y precio unitario mayor a 0.');
        return;
      }
    }

    const previewMontos = editDraft && !isBoleta
      ? computePreviewMontos(editDraft.items, editDraft.tipoCodigo ?? 33, shopifyTotalRef)
      : null;
    const montosWarn = previewMontos && !previewMontos.ok
      ? `\n\nAtención: el total editado (${fmt(previewMontos.factura.total)}) no cuadra con Shopify (${fmt(shopifyTotalRef)}).`
      : '';

    const ok = window.confirm(
      isBoleta
        ? '¿Emitir boleta en e-Boleta (eboleta.sii.cl)?\n\nTarda ~1 minuto.'
        : `¿Emitir factura en MiPyme con los datos del preview?${montosWarn}\n\nTarda ~1 minuto.`,
    );
    if (!ok) return;

    setBusyOrderId(orderId);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        sessionId: activeSessionId,
        tipoCodigo: isBoleta ? 39 : 33,
      };
      if (!isBoleta && editDraft) {
        body.codigoOriginal = payload?.template?.codigo ?? undefined;
        body.fechaEmision = editDraft.fechaEmision;
        body.rutReceptor = editDraft.rutReceptor || undefined;
        body.razonSocial = editDraft.razonSocial || undefined;
        body.giroReceptor = editDraft.giroReceptor || undefined;
        body.comunaReceptor = editDraft.comunaReceptor || undefined;
        body.ciudadReceptor = editDraft.ciudadReceptor || undefined;
        body.dirReceptor = editDraft.dirReceptor || undefined;
        body.items = editDraft.items.map((it) => ({
          numero: it.numero,
          descripcion: it.descripcion,
          cantidad: it.cantidad,
          descripcionExtendida: editDraft.useDescripcionExtendida
            ? (it.descripcionExtendida || it.tituloExtendido || undefined)
            : undefined,
        }));
        body.useDescripcionExtendida = !!editDraft.useDescripcionExtendida;
        const dg =
          payload?.descuentoGlobal ??
          computeDescuentoGlobalPreview(editDraft.items, shopifyTotalRef, editDraft.tipoCodigo ?? 33, {
            totalDiscounts: payload?.montosValidacion?.shopify.totalDiscounts,
          });
        if (dg) body.descuentoGlobal = dg;
        body.skipMontosValidation = !!draftDirty;
      }

      const res = await fetch(`${BIOMA_API}/emitir/${encodeURIComponent(orderId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        const errMsg = data.error || data.result?.error || `HTTP ${res.status}`;
        if (!isBoleta && isSiiSessionError(res.status, errMsg)) handleSiiSessionInvalid(errMsg);
        throw new Error(errMsg);
      }
      const folio = data.row?.siiFolio || data.result?.folio;
      const tipo = data.row?.tipoCodigo ?? (isBoleta ? 39 : 33);
      setSnack(folio ? `${dteLabel(tipo)} emitida — folio ${folio}` : `${dteLabel(tipo)} emitida en el SII`);
      try {
        localStorage.removeItem(FACTURA_DRAFT_KEY(orderId));
      } catch {
        /* ok */
      }
      if (!isBoleta) closeFacturaModal();
      await loadPending();
      await loadBoletas();
      await loadRealizadas();
      if (selectedId === orderId) await loadPayload(orderId);
    } catch (e: any) {
      setError(`Emitir: ${e?.message || e}`);
      if (!isBoleta) await loadBlockStatus();
    } finally {
      setBusyOrderId(null);
    }
  }, [
    sessionReady,
    activeSessionId,
    payload,
    editDraft,
    draftDirty,
    shopifyTotalRef,
    moduleTab,
    loadPending,
    loadBoletas,
    loadRealizadas,
    loadPayload,
    selectedId,
    siiBlocked,
    loadBlockStatus,
    closeFacturaModal,
    handleSiiSessionInvalid,
  ]);

  const descargarPdf = useCallback(async (orderId: string) => {
    setBusyOrderId(orderId);
    setError(null);
    try {
      if (moduleTab !== 'boletas' && sessionReady && sessionId) {
        try {
          const res = await fetch(`${BIOMA_API}/pdf/${encodeURIComponent(orderId)}/fetch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId }),
          });
          const data = await res.json();
          if (!res.ok || !data.success) console.warn('PDF fetch failed, trying direct:', data.error);
        } catch (fetchErr: any) {
          console.warn('PDF fetch error, trying direct:', fetchErr?.message);
        }
      }
      window.open(`${BIOMA_API}/pdf/${encodeURIComponent(orderId)}`, '_blank');
    } catch (e: any) {
      setError(`PDF: ${e?.message || e}`);
    } finally {
      setBusyOrderId(null);
    }
  }, [moduleTab, sessionReady, sessionId]);

  const enviarWhatsApp = useCallback(async (orderId: string) => {
    setBusyOrderId(orderId);
    setError(null);
    try {
      const res = await fetch(`${BIOMA_API}/whatsapp-link/${encodeURIComponent(orderId)}`);
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      if (!data.phone) {
        throw new Error('Sin teléfono del cliente en Shopify (revisa el pedido)');
      }

      let mode: 'native' | 'fallback' | 'text-only' = 'text-only';

      if (data.hasPdf) {
        const filename = String(data.pdfFilename || 'factura.pdf');
        const file = await fetchFacturaPdfFile(
          `${BIOMA_API}/pdf/${encodeURIComponent(orderId)}`,
          filename,
        );
        try {
          mode = await shareWhatsAppWithPdf({
            phone: data.phone,
            text: data.text,
            file,
            waUrl: data.url,
          });
        } catch (err: unknown) {
          if (err instanceof DOMException && err.name === 'AbortError') return;
          throw err;
        }
      } else if (data.url) {
        window.open(data.url, '_blank', 'noopener,noreferrer');
      } else {
        throw new Error('No se pudo armar el enlace de WhatsApp');
      }

      await fetch(`${BIOMA_API}/whatsapp-sent/${encodeURIComponent(orderId)}`, { method: 'POST' });
      await loadRealizadas();
      if (mode === 'native') {
        setSnack('WhatsApp abierto con el PDF adjunto');
      } else if (mode === 'fallback') {
        setSnack('PDF descargado — adjúntalo en WhatsApp antes de enviar');
      } else {
        setSnack('WhatsApp abierto (sin PDF disponible todavía)');
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`WhatsApp: ${msg}`);
    } finally {
      setBusyOrderId(null);
    }
  }, [loadRealizadas]);

  const enviarCorreo = useCallback(async (orderId: string) => {
    setBusyOrderId(orderId);
    setError(null);
    try {
      const res = await fetch(`${BIOMA_API}/email-draft/${encodeURIComponent(orderId)}`);
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      if (!data.url || !data.to) {
        throw new Error('Sin correo del cliente en Shopify (revisa el pedido)');
      }
      window.location.href = data.url;
      setSnack('Borrador de correo abierto — adjunta el PDF antes de enviar');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`Correo: ${msg}`);
    } finally {
      setBusyOrderId(null);
    }
  }, []);

  const marcarComoEmitida = useCallback(async (orderId: string) => {
    const folioStr = window.prompt(
      'Folio SII de la factura ya emitida (solo número):\n\nEl pedido saldrá de pendientes y el tag en Shopify será "factura #folio".',
    );
    if (!folioStr?.trim()) return;
    const folio = parseInt(folioStr.trim(), 10);
    if (!Number.isFinite(folio) || folio <= 0) {
      setError('Folio inválido');
      return;
    }
    const codigo = window.prompt('Código SII (opcional, Enter para omitir):')?.trim() || undefined;
    setBusyOrderId(orderId);
    setError(null);
    try {
      const res = await fetch(`${BIOMA_API}/marcar-emitida/${encodeURIComponent(orderId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siiFolio: folio, siiCodigo: codigo }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      setSnack(data.message || `Asociado a factura #${folio}`);
      closeFacturaModal();
      await loadPending();
      await loadRealizadas();
    } catch (e: any) {
      setError(`Marcar emitida: ${e?.message || e}`);
    } finally {
      setBusyOrderId(null);
    }
  }, [loadPending, loadRealizadas, closeFacturaModal]);

  const descartarFactura = useCallback(async (orderId: string) => {
    const ok = window.confirm(
      '¿Quitar este pedido de facturas pendientes?\n\nSe descartará en el módulo y se quitará el tag "factura" en Shopify (si aún lo tiene).',
    );
    if (!ok) return;
    setBusyOrderId(orderId);
    setError(null);
    try {
      const res = await fetch(`${BIOMA_API}/descartar/${encodeURIComponent(orderId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ removeTag: true }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      setSnack(data.message || 'Pedido descartado');
      closeFacturaModal();
      await loadPending();
    } catch (e: any) {
      setError(`Descartar: ${e?.message || e}`);
    } finally {
      setBusyOrderId(null);
    }
  }, [loadPending, closeFacturaModal]);

  const dismissNcAviso = useCallback(async () => {
    const aviso = ncAviso;
    setNcAviso(null);
    if (aviso?.orderId) {
      try {
        await fetch(`${BIOMA_API}/limpiar-aviso-nc/${encodeURIComponent(aviso.orderId)}`, {
          method: 'POST',
        });
        await loadPending();
      } catch {
        /* aviso solo informativo */
      }
    }
  }, [ncAviso, loadPending]);

  const prepararNotaCredito = useCallback(async (orderId: string, orderName: string) => {
    const ok = window.confirm(
      `¿Preparar ${orderName} para re-emisión?\n\n` +
      `El pedido volverá a Facturas pendientes.\n` +
      `Si la factura anterior sigue vigente en el SII, emite la NC en MiPyme antes o después — no es un requisito del sistema.\n\n¿Continuar?`,
    );
    if (!ok) return;
    setBusyOrderId(orderId);
    setError(null);
    try {
      const res = await fetch(`${BIOMA_API}/preparar-nc/${encodeURIComponent(orderId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      const msg = data.avisoNc || data.message || 'Pedido movido a Facturas pendientes.';
      setNcAviso({ orderId, text: msg });
      setSnack(`${orderName} listo para re-emitir en Facturas pendientes`);
      setModuleTab('pendientes');
      await loadPending();
      await loadRealizadas();
    } catch (e: any) {
      setError(`NC / re-emisión: ${e?.message || e}`);
    } finally {
      setBusyOrderId(null);
    }
  }, [loadPending, loadRealizadas]);

  const importarBoletas = useCallback(async () => {
    await loadBoletas({ sync: true });
  }, [loadBoletas]);

  const pendingRows = rows.filter((r) => r.emision?.status !== 'emitted' && r.emision?.status !== 'dismissed');
  const pendingCount = pendingRows.length;
  const boletasCount = boletasRows.length;
  const pendingMonto = pendingRows.reduce((sum, r) => sum + (r.shopify.total || 0), 0);
  const selectedRow = rows.find((r) => r.shopify.id === selectedId) ?? null;
  const previewMontos = useMemo(() => {
    if (!editDraft) return payload?.montosValidacion;
    const tipo = editDraft.tipoCodigo ?? 33;
    const shopifyTotal = shopifyTotalRef || payload?.montosValidacion?.shopify.total || 0;
    const shopifyDiscounts = payload?.montosValidacion?.shopify.totalDiscounts ?? 0;
    const live = computePreviewMontos(editDraft.items, tipo, shopifyTotal, {
      totalDiscounts: shopifyDiscounts,
      descuentoGlobal: payload?.descuentoGlobal ?? editDraft.descuentoGlobal,
    });
    return {
      ...live,
      shopify: {
        ...live.shopify,
        shipping: payload?.montosValidacion?.shopify.shipping ?? 0,
        totalDiscounts: shopifyDiscounts,
        lineDiscounts: payload?.montosValidacion?.shopify.lineDiscounts ?? 0,
      },
    };
  }, [editDraft, payload, shopifyTotalRef]);
  const previewRut = editDraft?.rutReceptor ?? payload?.rutReceptor ?? null;
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
        onChange={(_, v: ModuleTab) => { setModuleTab(v); setSelectedId(null); setPayload(null); setFacturaModalOpen(false); }}
        sx={{ mb: 2, borderBottom: '2px solid #e2e8f0' }}
      >
        <Tab value="pendientes" label={`Facturas pendientes (${pendingCount})`} />
        <Tab value="boletas" label={`Boletas pendientes (${boletasCount})`} />
        <Tab value="realizadas" label={`Realizadas (${realizadasTotal})`} />
      </Tabs>

      {moduleTab === 'boletas' && (
        <Stack direction="row" spacing={1} sx={{ mb: 2, flexWrap: 'wrap' }}>
          {(
            [
              ['semana', 'Esta semana (14d)'],
              ['mes', 'Último mes'],
              ['historico', 'Histórico'],
            ] as const
          ).map(([key, label]) => (
            <Button
              key={key}
              size="small"
              variant={boletasRango === key ? 'contained' : 'outlined'}
              onClick={() => {
                setBoletasRango(key);
                localStorage.setItem('biomaBoletasRango', key);
                const d = key === 'semana' ? 14 : key === 'mes' ? 45 : 0;
                void loadBoletas({ daysBack: d, sync: false });
              }}
            >
              {label}
            </Button>
          ))}
        </Stack>
      )}

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
            <>Pedidos con tag <strong>factura</strong> y datos de facturación (toggle o RUT). Pedido manual: agrega tag + atributos RUT en Shopify.</>
          )}
          {moduleTab === 'boletas' && (
            <>
              Emisión vía <strong>e-Boleta</strong> (eboleta.sii.cl), no MiPyme.
              Receptor: 66.666.666-6 · SII Boleta (consumidor final).
            </>
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
        {moduleTab === 'boletas' && (
          <Button
            variant="outlined"
            onClick={importarBoletas}
            disabled={loading}
            sx={{ flexShrink: 0 }}
          >
            Importar desde Shopify
          </Button>
        )}
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

      <Paper
        variant="outlined"
        sx={{
          mb: 2,
          px: 2,
          py: 1,
          bgcolor: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 1.5,
          flexWrap: 'wrap',
        }}
      >
        <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
          <Typography variant="body2" fontWeight={600}>
            {moduleTab === 'boletas' ? 'e-Boleta' : 'MiPyme'}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {empresaRut ? formatRut(empresaRut) : '…'}
          </Typography>
          {sessionReady ? (
            <Chip
              label={
                moduleTab !== 'boletas' && siiSession.status?.valid
                  ? `Sesión OK · ${formatSessionExpiresIn(siiSession.status.expiresInMs)}`
                  : 'Sesión OK'
              }
              color={siiSession.expiresSoon ? 'warning' : 'success'}
              size="small"
            />
          ) : sessionId && moduleTab !== 'boletas' ? (
            <Chip label="Sesión inválida" color="error" size="small" />
          ) : (
            <Chip label="Sin sesión" size="small" variant="outlined" />
          )}
        </Stack>
        <Stack direction="row" spacing={1} alignItems="center">
          {sessionReady ? (
            <Button size="small" color="warning" onClick={closeSession}>
              Cerrar sesión
            </Button>
          ) : (
            <Button
              variant="contained"
              size="small"
              onClick={createSession}
              disabled={creatingSession || !empresaRut || (moduleTab !== 'boletas' && siiBlocked.blocked)}
            >
              {creatingSession
                ? 'Conectando…'
                : moduleTab === 'boletas'
                  ? 'Abrir e-Boleta'
                  : 'Abrir MiPyme'}
            </Button>
          )}
        </Stack>
      </Paper>

      {moduleTab !== 'boletas' && sessionId && siiSession.status && !siiSession.status.valid && (
        <Alert severity="error" sx={{ mb: 2 }}>
          Sesión MiPyme no válida{siiSession.status.reason ? `: ${siiSession.status.reason}` : ''}. Vuelve a abrir sesión SII antes de emitir.
        </Alert>
      )}

      {moduleTab !== 'boletas' && siiSession.expiresSoon && siiSession.status?.valid && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          La sesión MiPyme caduca en {formatSessionExpiresIn(siiSession.status.expiresInMs)}. Abre sesión de nuevo para no perder el trabajo a mitad de emisión.
        </Alert>
      )}

      {ncAviso && (
        <Alert severity="info" sx={{ mb: 2 }} onClose={() => void dismissNcAviso()}>
          {ncAviso.text}
        </Alert>
      )}

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
                <TableCell sx={{ fontWeight: 600, bgcolor: '#f7fafc' }} align="center">Enviar</TableCell>
                <TableCell sx={{ fontWeight: 600, bgcolor: '#f7fafc' }} align="center">NC</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {realizadasRows.length === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={8} align="center" sx={{ py: 6, color: 'text.secondary' }}>
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
                  <TableCell align="center">
                    <Stack direction="row" spacing={0.5} justifyContent="center">
                      <Tooltip
                        title={
                          row.customerEmail
                            ? 'Abrir borrador de correo al cliente'
                            : 'Sin correo en Shopify'
                        }
                      >
                        <span>
                          <IconButton
                            size="small"
                            color="primary"
                            disabled={!row.customerEmail || busyOrderId === row.shopifyOrderId}
                            onClick={() => enviarCorreo(row.shopifyOrderId)}
                            aria-label="Enviar por correo"
                          >
                            <EmailOutlinedIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                      <Tooltip
                        title={
                          row.customerPhone
                            ? row.whatsappSentAt
                              ? `WhatsApp enviado ${new Date(row.whatsappSentAt).toLocaleString('es-CL')}`
                              : 'Enviar mensaje por WhatsApp'
                            : 'Sin teléfono en Shopify'
                        }
                      >
                        <span>
                          <IconButton
                            size="small"
                            sx={{ color: row.whatsappSentAt ? 'success.main' : '#25D366' }}
                            disabled={!row.customerPhone || busyOrderId === row.shopifyOrderId}
                            onClick={() => enviarWhatsApp(row.shopifyOrderId)}
                            aria-label="Enviar por WhatsApp"
                          >
                            <WhatsAppIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                    </Stack>
                  </TableCell>
                  <TableCell align="center">
                    {(row.tipoCodigo === 33 || row.tipoCodigo === 34) ? (
                      <Button
                        size="small"
                        variant="outlined"
                        color="warning"
                        disabled={busyOrderId === row.shopifyOrderId}
                        onClick={() => prepararNotaCredito(row.shopifyOrderId, row.shopifyOrderName)}
                        title="Volver a pendientes para re-emitir (NC manual en MiPyme)"
                      >
                        NC
                      </Button>
                    ) : (
                      <Typography variant="caption" color="text.secondary">—</Typography>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {moduleTab === 'pendientes' && (
        <TableContainer component={Paper} variant="outlined" sx={{ bgcolor: '#fff' }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 600, bgcolor: '#f7fafc' }}>Pedido</TableCell>
                <TableCell sx={{ fontWeight: 600, bgcolor: '#f7fafc' }}>Fecha</TableCell>
                <TableCell sx={{ fontWeight: 600, bgcolor: '#f7fafc' }}>Cliente</TableCell>
                <TableCell align="right" sx={{ fontWeight: 600, bgcolor: '#f7fafc' }}>Total</TableCell>
                <TableCell sx={{ fontWeight: 600, bgcolor: '#f7fafc' }}>Estado</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {pendingRows.length === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={5} align="center" sx={{ py: 6, color: 'text.secondary' }}>
                    No hay facturas pendientes (tag factura en Shopify).
                  </TableCell>
                </TableRow>
              )}
              {pendingRows.map((row) => {
                const { razon, rut, nombre } = clienteFactura(row);
                return (
                  <TableRow
                    key={row.shopify.id}
                    hover
                    onClick={() => selectOrder(row)}
                    sx={{ cursor: 'pointer' }}
                  >
                    <TableCell><Typography fontWeight={600} fontSize={13}>{row.shopify.name}</Typography></TableCell>
                    <TableCell>{new Date(row.shopify.processedAt).toLocaleDateString('es-CL')}</TableCell>
                    <TableCell>
                      <Typography fontSize={13}>{razon || '—'}</Typography>
                      {nombre && razon && nombre !== razon && (
                        <Typography variant="caption" display="block">{nombre}</Typography>
                      )}
                      {rut && <Typography variant="caption" display="block">{formatRut(rut)}</Typography>}
                    </TableCell>
                    <TableCell align="right"><Typography fontWeight={600} fontSize={13}>{fmt(row.shopify.total)}</Typography></TableCell>
                    <TableCell>{statusChip(row.emision?.status)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <Dialog open={facturaModalOpen} onClose={closeFacturaModal} maxWidth="lg" fullWidth>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', pr: 1, pb: 1 }}>
          <Box>
            <Typography variant="h6" component="span">
              {selectedRow?.shopify.name}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {dteLabel(payload?.tipoCodigo === 61 ? 61 : 33)} · preview antes de emitir en MiPyme
            </Typography>
          </Box>
          <IconButton onClick={closeFacturaModal} aria-label="Cerrar">
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers sx={{ bgcolor: '#eceff1', p: { xs: 1.5, sm: 2.5 } }}>
          {payloadLoading && (
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1, py: 6 }}>
              <CircularProgress size={24} />
              <Typography variant="body2" color="text.secondary">Generando vista previa…</Typography>
            </Box>
          )}
          {editDraft && selectedRow && (
            <>
              {previewRut && !validateRut(previewRut) && (
                <Alert severity="warning" sx={{ mb: 2 }}>
                  RUT receptor inválido ({formatRut(previewRut)}). Corrígelo en el preview antes de emitir.
                </Alert>
              )}
              {previewMontos && !previewMontos.ok && (
                <Alert severity="warning" sx={{ mb: 2 }}>
                  <strong>Total editado no cuadra con Shopify.</strong>{' '}
                  Factura {fmt(previewMontos.factura.total)} vs pedido {fmt(previewMontos.shopify.total)}
                  {' '}(dif. {previewMontos.diff > 0 ? '+' : ''}{fmt(previewMontos.diff)}).
                  Puedes ajustar las líneas o emitir igual con confirmación.
                </Alert>
              )}
              {previewMontos?.ok && (
                <Alert severity="success" sx={{ mb: 2 }}>
                  Total factura cuadra con Shopify ({fmt(previewMontos.shopify.total)}).
                  {previewMontos.shopify.totalDiscounts > 0 && (
                    <> Incluye descuento {fmt(previewMontos.shopify.totalDiscounts)}.</>
                  )}
                </Alert>
              )}
              <FacturaEmitPreview
                editable
                draftDirty={draftDirty}
                empresaRut={empresaRut}
                orderName={selectedRow.shopify.name}
                customerName={selectedRow.emision?.customerName}
                montosValidacion={previewMontos}
                rutInvalido={!!previewRut && !validateRut(previewRut)}
                payload={editDraft}
                siiFormSnapshot={siiFormSnapshot}
                onPayloadChange={handleDraftChange}
                onResetDraft={resetDraftFromShopify}
              />
            </>
          )}
          {selectedRow?.emision?.lastError && (
            <Alert
              severity={
                selectedRow.emision.lastError.toLowerCase().includes('nota de crédito') ||
                selectedRow.emision.lastError.toLowerCase().includes('nota de credito')
                  ? 'info'
                  : 'warning'
              }
              sx={{ mt: 2 }}
              action={
                (selectedRow.emision.lastError.toLowerCase().includes('nota de crédito') ||
                  selectedRow.emision.lastError.toLowerCase().includes('nota de credito')) ? (
                  <Button
                    color="inherit"
                    size="small"
                    onClick={async () => {
                      await fetch(
                        `${BIOMA_API}/limpiar-aviso-nc/${encodeURIComponent(selectedRow.shopify.id)}`,
                        { method: 'POST' },
                      );
                      await loadPending();
                      if (selectedId === selectedRow.shopify.id) await loadPayload(selectedRow.shopify.id);
                    }}
                  >
                    Entendido
                  </Button>
                ) : undefined
              }
            >
              {selectedRow.emision.lastError}
            </Alert>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, py: 2, flexWrap: 'wrap', gap: 1 }}>
          <Button
            variant="outlined"
            color="primary"
            disabled={
              isBusy ||
              !sessionReady ||
              siiBlocked.blocked ||
              !templateReady(payload?.template) ||
              !editDraft
            }
            onClick={() => selectedRow && rellenarEnSii(selectedRow.shopify.id)}
          >
            {isBusy ? 'Rellenando…' : 'Rellenar en SII'}
          </Button>
          <Button
            variant="contained"
            color="success"
            disabled={
              isBusy ||
              !sessionReady ||
              siiBlocked.blocked ||
              !templateReady(payload?.template) ||
              !editDraft ||
              (!!previewRut && !validateRut(previewRut))
            }
            onClick={() => selectedRow && emitirDte(selectedRow.shopify.id, { isBoleta: false })}
          >
            {isBusy ? 'Emitiendo…' : 'Emitir factura'}
          </Button>
          <Button
            variant="outlined"
            color="secondary"
            disabled={isBusy || !selectedRow}
            onClick={() => selectedRow && marcarComoEmitida(selectedRow.shopify.id)}
          >
            Ya emitida (folio)
          </Button>
          <Button
            variant="outlined"
            color="error"
            disabled={isBusy || !selectedRow}
            onClick={() => selectedRow && descartarFactura(selectedRow.shopify.id)}
          >
            Quitar de pendientes
          </Button>
        </DialogActions>
      </Dialog>

      {moduleTab === 'boletas' && (
      <Grid container spacing={2}>
        <Grid item xs={12} md={selectedBoleta ? 5 : 12}>
          <TableContainer
            component={Paper}
            variant="outlined"
            sx={{ bgcolor: '#fff', maxHeight: selectedBoleta ? 640 : undefined, overflow: 'auto' }}
          >
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontWeight: 600, bgcolor: '#f7fafc' }}>Pedido</TableCell>
                  <TableCell sx={{ fontWeight: 600, bgcolor: '#f7fafc' }}>Fecha</TableCell>
                  <TableCell sx={{ fontWeight: 600, bgcolor: '#f7fafc' }}>Cliente</TableCell>
                  <TableCell sx={{ fontWeight: 600, bgcolor: '#f7fafc' }}>Estado</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {boletasRows.length === 0 && !loading && (
                  <TableRow>
                    <TableCell colSpan={4} align="center" sx={{ py: 6, color: 'text.secondary' }}>
                      No hay boletas pendientes. Pulsa <strong>Importar desde Shopify</strong>.
                    </TableCell>
                  </TableRow>
                )}
                {boletasRows.map((row) => {
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

        {selectedBoleta && (
          <Grid item xs={12} md={7}>
            <Paper variant="outlined" sx={{ p: 2.5, bgcolor: '#fff', position: { md: 'sticky' }, top: 16 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
                <Box>
                  <Typography variant="h6">{selectedBoleta.shopifyOrderName}</Typography>
                  <Typography variant="caption">{dteLabel(39)}</Typography>
                </Box>
                <Chip
                  label={sessionReady ? 'Sesión e-Boleta activa' : 'Sin sesión'}
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
                  <Alert severity="info" sx={{ mb: 1.5 }}>
                    e-Boleta: receptor <strong>66.666.666-6 · SII Boleta</strong> (consumidor final).
                  </Alert>
                  <Box sx={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 0.75, fontSize: 13, mb: 1.5 }}>
                    {selectedBoleta.customerName && (
                      <>
                        <Typography color="text.secondary">Cliente Shopify</Typography>
                        <Typography>{selectedBoleta.customerName}</Typography>
                      </>
                    )}
                    <Typography color="text.secondary">Modo SII</Typography>
                    <Typography>Boleta e-Boleta (eboleta.sii.cl)</Typography>
                  </Box>
                  <Divider sx={{ my: 1.5 }} />
                  <Stack spacing={0.75}>
                    {payload.items.map((it) => (
                      <Typography key={it.numero} fontSize={13}>
                        {it.cantidad}× {it.descripcion} — <strong>{fmt(it.precioUnitario)}</strong>
                      </Typography>
                    ))}
                  </Stack>
                </Paper>
              )}

              <Button
                variant="contained"
                color="success"
                size="large"
                disabled={isBusy || !sessionReady}
                onClick={() => emitirDte(selectedBoleta.shopifyOrderId, { isBoleta: true })}
                sx={{ mb: 1 }}
              >
                {isBusy ? 'Emitiendo en SII… (~1 min)' : 'Emitir boleta'}
              </Button>

              {selectedBoleta.lastError && (
                <Alert severity="warning" sx={{ mt: 2 }}>{selectedBoleta.lastError}</Alert>
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
