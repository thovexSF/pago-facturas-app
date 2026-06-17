import React, { useState, useCallback, useEffect, useMemo } from 'react';
import {
  Box, Typography, Paper, Grid, Button,
  Alert, CircularProgress, Table, TableBody, TableCell, TableContainer, TableHead,
  TableRow, Chip, Dialog, DialogTitle, DialogContent, DialogActions, TextField,
  IconButton, Tooltip, Divider, LinearProgress, ToggleButton, ToggleButtonGroup,
  InputAdornment, Snackbar, Tabs, Tab, FormControl, InputLabel, Select, MenuItem,
  OutlinedInput, Checkbox, ListItemText, Accordion, AccordionSummary, AccordionDetails,
  FormControlLabel,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/esm/ExpandMore.js';
import ContentCopyIcon from '@mui/icons-material/esm/ContentCopy.js';
import RefreshIcon from '@mui/icons-material/esm/Refresh.js';
import ReceiptIcon from '@mui/icons-material/esm/Receipt.js';
import AddIcon from '@mui/icons-material/esm/Add.js';
import DeleteIcon from '@mui/icons-material/esm/Delete.js';
import VisibilityIcon from '@mui/icons-material/esm/Visibility.js';
import OpenInNewIcon from '@mui/icons-material/esm/OpenInNew.js';
import SearchIcon from '@mui/icons-material/esm/Search.js';
import SyncIcon from '@mui/icons-material/esm/Sync.js';
import HistoryIcon from '@mui/icons-material/esm/History.js';
import PeopleIcon from '@mui/icons-material/esm/People.js';
import ListIcon from '@mui/icons-material/esm/List.js';
import PictureAsPdfIcon from '@mui/icons-material/esm/PictureAsPdf.js';
import CloseIcon from '@mui/icons-material/esm/Close.js';
import { useFontSize } from '../hooks/useFontSize';
import { useAuth } from '../hooks/useAuth';
import { API_CONFIG } from '../config/api';
import { formatRut } from '../utils/rutUtils';
import {
  partitionDetalleExtendido,
  pickCampoDesdeExtendido,
  textoSucursalEmisorCuadro,
} from '../utils/siiDteExtendidoUi';

const SII_FACTURACION_API = `${API_CONFIG.BASE_URL}/api/sii-facturacion`;

// ─── Tipos ───────────────────────────────────────────────────────────────────

interface ItemFactura {
  numero: number;
  descripcion: string;
  cantidad: number;
  unidad: string;
  precioUnitario: number;
  descuento: number;
  subtotal: number;
  codigo?: string;
  imptoAdicPct?: number;
}

interface Factura {
  id: number;
  codigo: string;
  rutReceptor: string;
  razonSocial: string;
  tipoCodigo: number;
  tipoDocumento: string;
  folio: number;
  fecha: string;
  monto: number;
  estado: string;
  items: ItemFactura[] | null;
  dirReceptor: string;
  comunaReceptor: string;
  ciudadReceptor: string;
  giroReceptor: string;
  formaPago: string;
  neto: number;
  iva: number;
  total: number;
  detalleCompleto: boolean;
  hasPdf?: boolean;
  detalleExtendido?: Record<string, string> | null;
}

const EMPRESA_TOGGLE_ORANGE = '#ff6600';

const fmt = (n: number) => `$${(n || 0).toLocaleString('es-CL')}`;

function esErrorSesionSiiRecuperable(e: unknown): boolean {
  const err = e as { status?: number; message?: string };
  return (
    err?.status === 401 ||
    /sesión no encontrada|sesion no encontrada|expirada/i.test(String(err?.message || ''))
  );
}

function montoDesdeCampoSii(s: string | undefined): number {
  if (!s) return 0;
  return parseInt(String(s).replace(/\D/g, ''), 10) || 0;
}

const REC_EFXP_MAIN = new Set([
  'EFXP_RUT_RECEP',
  'EFXP_DV_RECEP',
  'EFXP_RZN_SOC_RECEP',
  'EFXP_DIR_RECEP',
  'EFXP_DIR_RECEP_DEFUALT',
  'EFXP_DIR_RECEP_DEFAULT',
  'EFXP_CMNA_RECEP',
  'EFXP_CIUDAD_RECEP',
  'EFXP_GIRO_RECEP',
  'EFXP_GIRO_RECEP_DEFUALT',
  'EFXP_GIRO_RECEP_DEFAULT',
]);

function DteKvRows({
  rows,
}: {
  rows: Array<{ key: string; label: string; value: string }>;
}) {
  if (!rows.length) return null;
  return (
    <Grid container spacing={0.75} sx={{ mt: 0.5 }}>
      {rows.map((r) => (
        <React.Fragment key={r.key}>
          <Grid item xs={12} sm={4} md={3}>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', lineHeight: 1.2 }}>
              {r.label}
            </Typography>
          </Grid>
          <Grid item xs={12} sm={8} md={9}>
            <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>{r.value}</Typography>
          </Grid>
        </React.Fragment>
      ))}
    </Grid>
  );
}

const TIPO_DOC_OPTIONS: { value: number; label: string }[] = [
  { value: 33, label: 'Factura (33)' },
  { value: 34, label: 'Exenta (34)' },
  { value: 52, label: 'Guía (52)' },
  { value: 61, label: 'N.Crédito (61)' },
  { value: 56, label: 'N.Débito (56)' },
  { value: 46, label: 'F.compra (46)' },
  { value: 43, label: 'Liq.fact. (43)' },
  { value: 39, label: 'Boleta (39)' },
  { value: 41, label: 'Bol.exenta (41)' },
  { value: 110, label: 'Exp. (110)' },
];

function rutSoloAlfanumerico(rut: string): string {
  return (rut || '').replace(/\./g, '').replace(/-/g, '').trim().toLowerCase();
}

function etiquetaTipoDoc(tipoCodigo: number): string {
  const m: Record<number, string> = {
    33: 'Factura',
    34: 'Exenta',
    39: 'Boleta',
    41: 'Bol.exenta',
    43: 'Liq.fact.',
    46: 'F.compra',
    52: 'Guía',
    56: 'N.Débito',
    61: 'N.Crédito',
    110: 'Exp.',
    111: 'NDB exp.',
    112: 'NCR exp.',
  };
  return m[tipoCodigo] ?? `T${tipoCodigo}`;
}

function facturaAnio(fecha: string | undefined | null): number | null {
  if (!fecha) return null;
  const m = fecha.trim().match(/^(\d{4})/);
  return m ? parseInt(m[1], 10) : null;
}

/** YYYY-MM-DD o DD-MM-YYYY (Chile). */
function parseFacturaFechaParts(fecha: string | undefined | null): { y: number; m: number; d: number } | null {
  if (!fecha) return null;
  const t = fecha.trim();
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const y = parseInt(iso[1], 10);
    const m = parseInt(iso[2], 10);
    const d = parseInt(iso[3], 10);
    if (m >= 1 && m <= 12) return { y, m, d };
  }
  const cl = t.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);
  if (cl) {
    let y = parseInt(cl[3], 10);
    if (y < 100) y += 2000;
    const m = parseInt(cl[2], 10);
    const d = parseInt(cl[1], 10);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return { y, m, d };
  }
  const ya = facturaAnio(t);
  return ya !== null ? { y: ya, m: 1, d: 1 } : null;
}

function montoFacturaKpi(f: Factura): number {
  const t = f.total || f.monto;
  return typeof t === 'number' && t > 0 ? t : 0;
}

const TIPOS_KPI_FACTURACION = new Set([33, 34, 39, 41]);

const MESES_CORTO = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

type FiltrosFacturasBilling = {
  tiposSeleccionados: number[];
  anioFiltro: number | null;
  mesFiltro: number | null;
  search: string;
  vista: 'ultima' | 'todas';
};

/** Filtros de tabla y KPI (misma lógica). */
function aplicarFiltrosFacturas(lista: Factura[], p: FiltrosFacturasBilling): Factura[] {
  let L = lista;
  if (p.tiposSeleccionados.length > 0) {
    const st = new Set(p.tiposSeleccionados);
    L = L.filter((f) => st.has(f.tipoCodigo));
  }
  if (p.anioFiltro !== null) {
    L = L.filter((f) => facturaAnio(f.fecha) === p.anioFiltro);
  }
  if (p.mesFiltro !== null) {
    L = L.filter((f) => {
      const fp = parseFacturaFechaParts(f.fecha);
      return fp && fp.m === p.mesFiltro;
    });
  }
  if (p.search.trim()) {
    const s = p.search.trim().toLowerCase();
    const qRut = rutSoloAlfanumerico(p.search);
    L = L.filter((f) => {
      if ((f.razonSocial || '').toLowerCase().includes(s)) return true;
      const rutF = rutSoloAlfanumerico(f.rutReceptor || '');
      if (qRut.length >= 2 && rutF.includes(qRut)) return true;
      return (f.rutReceptor || '').toLowerCase().includes(s);
    });
  }
  if (p.vista === 'ultima') {
    const mapa = new Map<string, Factura>();
    for (const f of L) {
      const key = f.rutReceptor?.trim() || `__codigo:${f.codigo}`;
      const prev = mapa.get(key);
      if (!prev || (f.folio || 0) > (prev.folio || 0)) mapa.set(key, f);
    }
    L = Array.from(mapa.values());
  }
  return L;
}

/** Alineado a facturaNecesitaRefetchDetalle en el backend: sync puede dejar detalleCompleto sin ítems. */
function facturaDebeRefrescarDetalleModal(f: Factura): boolean {
  if (!f.detalleCompleto) return true;
  const monto = f.monto || 0;
  if (monto <= 0) return false;
  const items = f.items;
  const sinLineas = !Array.isArray(items) || items.length === 0;
  if (sinLineas) return true;
  const g = String(f.giroReceptor || '').trim();
  const d = String(f.dirReceptor || '').trim();
  return !g && !d;
}

// ─── Componente ───────────────────────────────────────────────────────────────

const Billing: React.FC = () => {
  const fs = useFontSize();
  const { token } = useAuth();

  useEffect(() => {
    if (typeof fs === 'number' && !Number.isNaN(fs) && fs > 0) {
      document.documentElement.style.setProperty('--salfa-table-font-size', `${fs}rem`);
      document.documentElement.style.setProperty('--salfa-modal-font-size', `${fs}rem`);
    }
  }, [fs]);

  // Empresa y sesión (lista desde SII según SII_USERNAME / SII_PASSWORD del backend)
  const [empresaRut, setEmpresaRut] = useState('');
  const [empresasSelector, setEmpresasSelector] = useState<Array<{ value: string; label: string }>>([]);
  const [cargandoEmpresas, setCargandoEmpresas] = useState(true);
  const empresaNombre = useMemo(
    () => empresasSelector.find((e) => e.value === empresaRut)?.label || formatRut(empresaRut) || empresaRut,
    [empresasSelector, empresaRut]
  );
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [conectando, setConectando] = useState(false);
  const [sincronizando, setSincronizando] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');

  // Snackbar auto-sync
  const [snackbar, setSnackbar] = useState<{ open: boolean; msg: string }>({ open: false, msg: '' });
  // Datos de DB
  const [facturas, setFacturas] = useState<Factura[]>([]);
  const [cargandoDB, setCargandoDB] = useState(false);

  // Filtros locales (no van a la DB)
  const [search, setSearch] = useState('');
  const [tiposSeleccionados, setTiposSeleccionados] = useState<number[]>([]);
  const [vista, setVista] = useState<'ultima' | 'todas'>('ultima');
  const [anioFiltro, setAnioFiltro] = useState<number | null>(null);
  const [mesFiltro, setMesFiltro] = useState<number | null>(null);
  const [pestañaDoc, setPestañaDoc] = useState<'emitidos' | 'recibidos'>('emitidos');

  // Modales
  const [previewFactura, setPreviewFactura] = useState<Factura | null>(null);
  const [emitirFactura, setEmitirFactura] = useState<Factura | null>(null);
  const [itemsEdicion, setItemsEdicion] = useState<ItemFactura[]>([]);
  const [fechaEmision, setFechaEmision] = useState(new Date().toISOString().split('T')[0]);
  const [emitiendo, setEmitiendo] = useState(false);
  /** No pulsar Guardar en el SII; para probar hasta vista previa / clave (ver SII_PLAYWRIGHT_HEADED en backend). */
  const [emitirDetenerEnPreview, setEmitirDetenerEnPreview] = useState(false);
  /** Confirmación antes de emitir */
  const [confirmarEmitir, setConfirmarEmitir] = useState(false);

  // Vista HTML del portal SII (misma sesión API que backend; no es file://)
  const [siiPortalPreview, setSiiPortalPreview] = useState<{
    blobUrl: string;
    resolvedUrl: string;
    codigo: string;
  } | null>(null);
  const [previewLoadingCodigo, setPreviewLoadingCodigo] = useState<string | null>(null);
  const [cargandoDetalleModal, setCargandoDetalleModal] = useState(false);
  /** Evita refetch en bucle si el SII sigue devolviendo sin ítems; se limpia al cerrar el modal. */
  const detalleIntentoHechoCodigoRef = React.useRef<string | null>(null);

  const [pdfModal, setPdfModal] = useState<{ url: string; codigo: string } | null>(null);
  const [abriendoPdfCodigo, setAbriendoPdfCodigo] = useState<string | null>(null);

  // Alertas
  const [error, setError] = useState('');

  // ─── API helper ───────────────────────────────────────────────────────────

  const apiFetch = useCallback(async (path: string, opts: RequestInit = {}) => {
    const res = await fetch(`${SII_FACTURACION_API}${path}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
    });
    const data = await res.json();
    if (!res.ok) {
      const err: any = new Error(data.error || `Error ${res.status}`);
      err.status = res.status;
      // Si el backend reinició y la sesión ya no existe, limpiar sessionId automáticamente
      if (res.status === 401) {
        setSessionId(null);
        setSyncMsg('');
      }
      throw err;
    }
    return data;
  }, [token]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      setCargandoEmpresas(true);
      try {
        const data = await apiFetch('/empresas-disponibles');
        const raw = (data.empresas || []) as Array<{ value: string; text: string }>;
        const list = raw.map((e) => {
          const fullText = e.text.replace(/\s+/g, ' ').trim();
          // Extraer solo el nombre: "76.123.456-7 - EMPRESA S.A." → "EMPRESA S.A."
          const nombre = fullText.replace(/^\d{1,2}\.?\d{3}\.?\d{3}-[\dkK]\s*[—\-–·\s]+/i, '').trim();
          return {
            value: e.value,
            label: nombre || fullText || e.value,
          };
        });
        if (!cancelled) {
          setEmpresasSelector(list);
          if (list.length > 0) {
            setEmpresaRut((prev) =>
              prev && list.some((x) => x.value === prev) ? prev : list[0].value
            );
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'No se pudo obtener empresas del SII';
        if (!cancelled) setError(msg);
      } finally {
        if (!cancelled) setCargandoEmpresas(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Cargar desde DB (sin filtros — filtramos localmente) ─────────────────

  const cargarDB = useCallback(async (rut: string) => {
    if (!rut) return;
    setCargandoDB(true);
    try {
      const data = await apiFetch(`/db/facturas?empresaRut=${encodeURIComponent(rut)}`);
      setFacturas(data.facturas || []);
    } catch (err: any) {
      setError(err.message || 'Error al cargar facturas');
    } finally {
      setCargandoDB(false);
    }
  }, [apiFetch]);

  // Sync histórico (background job + polling)
  // Inicializar desde localStorage para que la UI ya muestre "en progreso" al montar
  const [syncHistoricoActivo, setSyncHistoricoActivo] = useState(
    () => !!localStorage.getItem('sii_sync_job')
  );
  const [syncHistoricoProgress, setSyncHistoricoProgress] = useState<{
    quarter: string; quarterIndex: number; totalQuarters: number; acumulado: number;
    totalEncontradas: number; nuevasEnTrimestre: number;
  } | null>(null);
  const syncJobIdRef = React.useRef<string | null>(localStorage.getItem('sii_sync_job'));
  const pollIntervalRef = React.useRef<number | null>(null);
  const syncMsgTimerRef = React.useRef<number | null>(null);
  // Ref para apiFetch y cargarDB — evita stale closures en el polling interval
  const apiFetchRef = React.useRef(apiFetch);
  const cargarDBRef = React.useRef(cargarDB);
  const empresaRutRef = React.useRef(empresaRut);
  useEffect(() => { apiFetchRef.current = apiFetch; }, [apiFetch]);
  useEffect(() => { cargarDBRef.current = cargarDB; }, [cargarDB]);
  useEffect(() => { empresaRutRef.current = empresaRut; }, [empresaRut]);

  // Auto-dismiss syncMsg tras 15s cuando es un mensaje de éxito (✅)
  useEffect(() => {
    if (syncMsgTimerRef.current) { clearTimeout(syncMsgTimerRef.current); syncMsgTimerRef.current = null; }
    if (syncMsg && syncMsg.startsWith('✅')) {
      syncMsgTimerRef.current = window.setTimeout(() => setSyncMsg(''), 15000);
    }
    return () => { if (syncMsgTimerRef.current) clearTimeout(syncMsgTimerRef.current); };
  }, [syncMsg]);

  useEffect(() => {
    setFacturas([]);
    setSearch('');
    setAnioFiltro(null);
    setSessionId(null);
    if (!localStorage.getItem('sii_sync_job')) setSyncMsg('');
    cargarDB(empresaRut);
  }, [empresaRut]); // eslint-disable-line react-hooks/exhaustive-deps

  const kpiFechaDefaultEmpresaRef = React.useRef('');
  useEffect(() => {
    if (facturas.length === 0) return;
    if (kpiFechaDefaultEmpresaRef.current === empresaRut) return;
    const now = new Date();
    setAnioFiltro(now.getFullYear());
    setMesFiltro(now.getMonth() + 1);
    kpiFechaDefaultEmpresaRef.current = empresaRut;
  }, [empresaRut, facturas.length]);

  // Sesión SII + descarga automática de PDFs pendientes (sin re-sincronizar el listado)
  // Deshabilitado temporalmente: el auto-login al montar choca con Bioma y abre Playwright
  // sin que el usuario lo pida. La sesión se crea al pulsar «Sincronizar» (sincronizar()).
  /*
  useEffect(() => {
    if (!token || !empresaRut) return;
    let cancelled = false;
    let refreshTimer: number | null = null;
    (async () => {
      try {
        const data = await apiFetch('/session/create', {
          method: 'POST',
          body: JSON.stringify({ empresaRut }),
        });
        if (!cancelled && data.sessionId) {
          setSessionId(data.sessionId);
          refreshTimer = window.setTimeout(() => {
            if (!cancelled) cargarDBRef.current(empresaRutRef.current);
          }, 5000);
        }
      } catch {
      }
    })();
    return () => {
      cancelled = true;
      if (refreshTimer !== null) clearTimeout(refreshTimer);
    };
  }, [empresaRut, token]); // eslint-disable-line react-hooks/exhaustive-deps
  */

  // ─── Sincronizar nuevas facturas ──────────────────────────────────────────

  const sincronizar = async () => {
    if (!empresaRut) return;
    setError('');

    const crearSesionSii = async (): Promise<string> => {
      setConectando(true);
      try {
        const loginData = await apiFetch('/session/create', {
          method: 'POST',
          body: JSON.stringify({ empresaRut: empresaRut }),
        });
        const id = loginData.sessionId as string;
        setSessionId(id);
        return id;
      } finally {
        setConectando(false);
      }
    };

    try {
      let sid = sessionId;
      if (!sid) {
        sid = await crearSesionSii();
      }

      setSincronizando(true);
      setSyncMsg('Sincronizando facturas nuevas...');

      const postSync = (sessionToUse: string) => {
        const payload: Record<string, unknown> = { sessionId: sessionToUse, empresaRut: empresaRut };
        if (facturas.length === 0) payload.maxDocs = 10;
        return apiFetch('/sync', { method: 'POST', body: JSON.stringify(payload) });
      };

      let syncData: { synced: number; skipped: number };
      try {
        syncData = await postSync(sid);
      } catch (e: unknown) {
        if (!esErrorSesionSiiRecuperable(e)) throw e;
        setSessionId(null);
        setSyncMsg('Reconectando con el SII…');
        const nuevo = await crearSesionSii();
        syncData = await postSync(nuevo);
      }

      const limiteMsg = facturas.length === 0 ? ' (últimos 10)' : '';
      setSyncMsg(`✅ ${syncData.synced} nuevas${limiteMsg} · ${syncData.skipped} ya en base`);
      await cargarDB(empresaRut);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String((err as { message?: string })?.message ?? err);
      setError(msg || 'Error al sincronizar');
      setSyncMsg('');
    } finally {
      setConectando(false);
      setSincronizando(false);
    }
  };

  // ─── Auto-refresh hasPdf cada 60s cuando hay sesión activa ───────────────

  const hasPdfRefreshRef = React.useRef<number | null>(null);

  useEffect(() => {
    if (sessionId && empresaRut) {
      if (hasPdfRefreshRef.current !== null) clearInterval(hasPdfRefreshRef.current);
      hasPdfRefreshRef.current = window.setInterval(() => {
        cargarDBRef.current(empresaRutRef.current);
      }, 25_000);
    } else {
      if (hasPdfRefreshRef.current !== null) {
        clearInterval(hasPdfRefreshRef.current);
        hasPdfRefreshRef.current = null;
      }
    }
    return () => {
      if (hasPdfRefreshRef.current !== null) {
        clearInterval(hasPdfRefreshRef.current);
        hasPdfRefreshRef.current = null;
      }
    };
  }, [sessionId, empresaRut]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!previewFactura) {
      detalleIntentoHechoCodigoRef.current = null;
      setCargandoDetalleModal(false);
      return;
    }
    if (!sessionId) {
      setCargandoDetalleModal(false);
      return;
    }
    if (!facturaDebeRefrescarDetalleModal(previewFactura)) {
      setCargandoDetalleModal(false);
      return;
    }
    const cod = previewFactura.codigo;
    if (detalleIntentoHechoCodigoRef.current === cod) {
      setCargandoDetalleModal(false);
      return;
    }

    const tipoCodigo = previewFactura.tipoCodigo;
    let cancelled = false;
    setCargandoDetalleModal(true);
    (async () => {
      try {
        const data = await apiFetch('/detalle/refresh', {
          method: 'POST',
          body: JSON.stringify({
            sessionId,
            empresaRut: empresaRut,
            codigo: cod,
            tipoCodigo,
          }),
        });
        if (cancelled) return;
        detalleIntentoHechoCodigoRef.current = cod;
        const d = data.detalle;
        setPreviewFactura((prev) => {
          if (!prev || prev.codigo !== cod) return prev;
          return {
            ...prev,
            items: d.items,
            dirReceptor: d.dirReceptor,
            comunaReceptor: d.comunaReceptor,
            ciudadReceptor: d.ciudadReceptor,
            giroReceptor: d.giroReceptor,
            formaPago: d.formaPago,
            neto: d.neto,
            iva: d.iva,
            total: d.total,
            detalleCompleto: true,
            razonSocial: d.razonSocial,
            rutReceptor: d.rutReceptor,
            tipoDocumento: d.tipoDocumento,
            tipoCodigo: d.tipoCodigo,
            fecha: d.fecha || prev.fecha,
            monto: d.monto ?? prev.monto,
            folio: d.folio > 0 ? d.folio : prev.folio,
            detalleExtendido: d.detalleExtendido ?? prev.detalleExtendido,
          };
        });
        await cargarDBRef.current(empresaRut);
      } catch (err: any) {
        if (!cancelled) {
          detalleIntentoHechoCodigoRef.current = cod;
          setError(err.message || 'No se pudo cargar el detalle de ítems');
        }
      } finally {
        if (!cancelled) setCargandoDetalleModal(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    previewFactura?.codigo,
    previewFactura?.detalleCompleto,
    previewFactura?.items,
    previewFactura?.monto,
    previewFactura?.giroReceptor,
    previewFactura?.dirReceptor,
    previewFactura?.tipoCodigo,
    sessionId,
    empresaRut,
    apiFetch,
  ]);

  const añosDisponibles = useMemo(() => {
    const ys = new Set<number>();
    for (const f of facturas) {
      const y = facturaAnio(f.fecha);
      if (y !== null) ys.add(y);
    }
    return Array.from(ys).sort((a, b) => b - a);
  }, [facturas]);

  const dialogPaperFontSx = useMemo(
    () => ({
      '& .MuiTableCell-root': { fontSize: `${fs}rem` },
      '& .MuiTableCell-head': { fontSize: `${fs}rem` },
      '& .MuiInputBase-root': { fontSize: `${fs}rem` },
      '& .MuiButton-root': { fontSize: `${fs}rem` },
      '& .MuiChip-label': { fontSize: `${fs}rem` },
      '& .MuiAlert-message': { fontSize: `${fs}rem` },
    }),
    [fs]
  );

  // ─── Filtrado local ───────────────────────────────────────────────────────

  const facturasFiltradas = useMemo(
    () =>
      aplicarFiltrosFacturas(facturas, {
        tiposSeleccionados,
        anioFiltro,
        mesFiltro,
        search,
        vista,
      }),
    [facturas, tiposSeleccionados, anioFiltro, mesFiltro, search, vista]
  );

  const kpisEmitidos = useMemo(() => {
    const filtros: FiltrosFacturasBilling = {
      tiposSeleccionados,
      anioFiltro,
      mesFiltro,
      search,
      vista,
    };

    const base = aplicarFiltrosFacturas(facturas, filtros).filter((f) =>
      TIPOS_KPI_FACTURACION.has(f.tipoCodigo)
    );
    const sum = (arr: Factura[]) => arr.reduce((s, f) => s + montoFacturaKpi(f), 0);
    const total = sum(base);
    const n = base.length;
    const ticket = n > 0 ? total / n : 0;

    let prevBase: Factura[] = [];
    let etiquetaComparacion = '';

    if (anioFiltro !== null && mesFiltro !== null) {
      prevBase = aplicarFiltrosFacturas(facturas, {
        ...filtros,
        anioFiltro: anioFiltro - 1,
        mesFiltro,
      }).filter((f) => TIPOS_KPI_FACTURACION.has(f.tipoCodigo));
      etiquetaComparacion = `${MESES_CORTO[mesFiltro - 1]} ${anioFiltro - 1} (mismo mes, año anterior)`;
    } else if (anioFiltro !== null && mesFiltro === null) {
      prevBase = aplicarFiltrosFacturas(facturas, {
        ...filtros,
        anioFiltro: anioFiltro - 1,
        mesFiltro: null,
      }).filter((f) => TIPOS_KPI_FACTURACION.has(f.tipoCodigo));
      etiquetaComparacion = `Año ${anioFiltro - 1} (año completo anterior)`;
    }

    const sPrev = sum(prevBase);
    let varPct: number | null = null;
    if (sPrev > 0) varPct = Math.round(((total - sPrev) / sPrev) * 1000) / 10;
    else if (total > 0 && sPrev === 0) varPct = null;

    const byRut = new Map<string, number>();
    for (const f of base) {
      const k = f.rutReceptor?.trim();
      if (!k) continue;
      byRut.set(k, (byRut.get(k) || 0) + montoFacturaKpi(f));
    }
    const top3 = [...byRut.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    const top3sum = top3.reduce((s, [, v]) => s + v, 0);
    const concPct = total > 0 ? Math.round((top3sum / total) * 1000) / 10 : 0;

    let tituloPrincipal = 'Facturación (filtros)';
    if (anioFiltro !== null && mesFiltro !== null) {
      tituloPrincipal = `${MESES_CORTO[mesFiltro - 1]} ${anioFiltro}`;
    } else if (anioFiltro !== null) {
      tituloPrincipal = `Año ${anioFiltro} (todos los meses)`;
    } else if (mesFiltro !== null) {
      tituloPrincipal = `${MESES_CORTO[mesFiltro - 1]} · todos los años`;
    } else if (search.trim()) {
      tituloPrincipal = 'Resultado de búsqueda';
    }

    const subtituloFiltros = [
      tiposSeleccionados.length ? `${tiposSeleccionados.length} tipo(s) doc.` : null,
      vista === 'ultima' ? 'Vista: última por cliente' : 'Vista: todas las filas',
    ]
      .filter(Boolean)
      .join(' · ');

    return {
      tituloPrincipal,
      subtituloFiltros,
      total,
      n,
      ticket,
      sPrev,
      varPct,
      etiquetaComparacion,
      puedeComparar: anioFiltro !== null,
      comparacionEsMesYoY: anioFiltro !== null && mesFiltro !== null,
      concPct,
      top3,
    };
  }, [facturas, tiposSeleccionados, anioFiltro, mesFiltro, search, vista]);

  // ─── Ver factura real en SII (Puppeteer) ─────────────────────────────────

  const verFacturaReal = async (f: Factura) => {
    if (!sessionId) return;
    setError('');
    setPreviewLoadingCodigo(f.codigo);
    try {
      const res = await fetch(
        `${SII_FACTURACION_API}/preview/${encodeURIComponent(f.codigo)}?sessionId=${encodeURIComponent(sessionId)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || `Error ${res.status}`);
      }
      const html = await res.text();
      const resolvedRaw = res.headers.get('X-SII-Resolved-Doc-Url');
      const resolvedUrl = resolvedRaw ? decodeURIComponent(resolvedRaw) : '';
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      setSiiPortalPreview({ blobUrl: url, resolvedUrl, codigo: f.codigo });
    } catch (err: any) {
      setError(err.message || 'Error al cargar la factura del SII');
    } finally {
      setPreviewLoadingCodigo(null);
    }
  };

  const cerrarVistaSiiPortal = () => {
    setSiiPortalPreview((prev) => {
      if (prev) URL.revokeObjectURL(prev.blobUrl);
      return null;
    });
  };

  // ─── Abrir PDF guardado (fetch + blob: window.open no envía Authorization) ─

  const cerrarPdfModal = useCallback(() => {
    setPdfModal((prev) => {
      if (prev?.url) URL.revokeObjectURL(prev.url);
      return null;
    });
  }, []);

  const abrirPdf = async (f: Factura) => {
    try {
      setError('');
      setAbriendoPdfCodigo(f.codigo);
      const res = await fetch(`${SII_FACTURACION_API}/pdf/${encodeURIComponent(f.codigo)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const text = await res.text();
        let msg = `Error ${res.status}`;
        try {
          const j = JSON.parse(text);
          msg = j.error || j.message || msg;
        } catch {
          if (text) msg = text.slice(0, 200);
        }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      setPdfModal((prev) => {
        if (prev?.url) URL.revokeObjectURL(prev.url);
        return { url, codigo: f.codigo };
      });
    } catch (err: any) {
      setError(err.message || 'Error al abrir PDF');
    } finally {
      setAbriendoPdfCodigo(null);
    }
  };

  // ─── Sync histórico 2 años (background job + polling) ────────────────────

  const stopPolling = React.useCallback(() => {
    if (pollIntervalRef.current !== null) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }, []);

  const startPolling = React.useCallback((jobId: string, currentEmpresaRut: string) => {
    if (pollIntervalRef.current !== null) clearInterval(pollIntervalRef.current);
    pollIntervalRef.current = window.setInterval(async () => {
      try {
        // Usar refs para evitar stale closures
        const data = await apiFetchRef.current(`/sync-historico/status?jobId=${jobId}`);
        if (data.status === 'running') {
          setSyncHistoricoActivo(true);
          setSyncHistoricoProgress({
            quarter: data.quarter,
            quarterIndex: data.quarterIndex,
            totalQuarters: data.totalQuarters,
            acumulado: data.acumulado,
            totalEncontradas: data.totalEncontradas ?? 0,
            nuevasEnTrimestre: data.nuevasEnTrimestre ?? 0,
          });
          setSyncMsg(data.message || '');
        } else {
          clearInterval(pollIntervalRef.current!);
          pollIntervalRef.current = null;
          localStorage.removeItem('sii_sync_job');
          localStorage.removeItem('sii_sync_empresa');
          syncJobIdRef.current = null;
          setSyncHistoricoActivo(false);
          setSyncHistoricoProgress(null);
          if (data.status === 'done') {
            setSyncMsg(`✅ ${data.message}`);
            cargarDBRef.current(currentEmpresaRut);
          } else {
            setError(data.message || 'Error en sync histórico');
            setSyncMsg('');
          }
        }
      } catch (err: any) {
        // 404 = servidor se reinició y perdió el job en memoria
        if (err?.status === 404) {
          clearInterval(pollIntervalRef.current!);
          pollIntervalRef.current = null;
          localStorage.removeItem('sii_sync_job');
          localStorage.removeItem('sii_sync_empresa');
          syncJobIdRef.current = null;
          setSyncHistoricoActivo(false);
          setSyncHistoricoProgress(null);
          setSyncMsg('⚠️ El servidor fue reiniciado. El sync histórico se interrumpió — puedes volver a iniciarlo.');
        }
        // Otros errores de red: ignorar y reintentar en el próximo tick
      }
    }, 3000);
  }, []); // Sin dependencias — usa refs para todo

  // Al montar: reanudar polling si había un job activo (incluso tras navegar)
  useEffect(() => {
    const savedJob = localStorage.getItem('sii_sync_job');
    const savedEmpresa = localStorage.getItem('sii_sync_empresa');
    if (savedJob && savedEmpresa) {
      setSyncHistoricoActivo(true);
      setSyncMsg('Sync histórico en progreso...');
      if (savedEmpresa) setEmpresaRut(prev => prev || savedEmpresa);
      startPolling(savedJob, savedEmpresa);
    }
    return () => stopPolling();
  }, [startPolling, stopPolling]);

  const sincronizarHistorico = async () => {
    if (!empresaRut) return;
    setError('');

    const crearSesionHist = async (): Promise<string> => {
      setConectando(true);
      try {
        const loginData = await apiFetch('/session/create', {
          method: 'POST',
          body: JSON.stringify({ empresaRut: empresaRut }),
        });
        const id = loginData.sessionId as string;
        setSessionId(id);
        return id;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String((err as { message?: string })?.message ?? err);
        setError(msg || 'Error al conectar');
        throw err;
      } finally {
        setConectando(false);
      }
    };

    try {
      let sid = sessionId;
      if (!sid) sid = await crearSesionHist();

      const postStart = (s: string) =>
        apiFetch('/sync-historico/start', {
          method: 'POST',
          body: JSON.stringify({ sessionId: s, empresaRut: empresaRut }),
        });

      let data: { jobId: string };
      try {
        data = await postStart(sid);
      } catch (e: unknown) {
        if (!esErrorSesionSiiRecuperable(e)) throw e;
        setSessionId(null);
        setSyncMsg('Reconectando con el SII…');
        const nuevo = await crearSesionHist();
        data = await postStart(nuevo);
      }

      const jobId = data.jobId;
      syncJobIdRef.current = jobId;
      localStorage.setItem('sii_sync_job', jobId);
      localStorage.setItem('sii_sync_empresa', empresaRut);
      setSyncHistoricoActivo(true);
      setSyncHistoricoProgress(null);
      setSyncMsg('Login exitoso ✅ — iniciando scraping de 8 trimestres...');
      startPolling(jobId, empresaRut);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String((err as { message?: string })?.message ?? err);
      setError(msg || 'Error al iniciar sync');
    }
  };

  // ─── Modal emisión ────────────────────────────────────────────────────────

  const DRAFT_KEY = (codigo: string) => `sii_draft_${empresaRut}_${codigo}`;

  const abrirEmitir = (f: Factura) => {
    // Restaurar borrador guardado si existe
    try {
      const raw = localStorage.getItem(DRAFT_KEY(f.codigo));
      if (raw) {
        const draft = JSON.parse(raw);
        setItemsEdicion(draft.items ?? (f.items ? f.items.map((it: ItemFactura) => ({ ...it })) : []));
        if (draft.fecha) setFechaEmision(draft.fecha);
        setEmitirFactura(f);
        setPreviewFactura(null);
        return;
      }
    } catch { /* ignorar errores de parse */ }
    setEmitirFactura(f);
    setItemsEdicion(f.items ? f.items.map(it => ({ ...it })) : []);
    setPreviewFactura(null);
  };

  const editarItem = (idx: number, campo: keyof ItemFactura, valor: string | number) => {
    setItemsEdicion(prev => {
      const next = prev.map((it, i) => i === idx ? { ...it, [campo]: valor } : it);
      // Guardar borrador automáticamente
      if (emitirFactura) {
        try { localStorage.setItem(DRAFT_KEY(emitirFactura.codigo), JSON.stringify({ items: next, fecha: fechaEmision })); } catch { /* quota */ }
      }
      return next;
    });
  };

  const emitir = async () => {
    if (!emitirFactura || itemsEdicion.length === 0 || !sessionId) return;
    setEmitiendo(true);
    setError('');
    try {
      const data = await apiFetch('/emitir', {
        method: 'POST',
        body: JSON.stringify({
          sessionId,
          codigoOriginal: emitirFactura.codigo,
          tipoCodigo: emitirFactura.tipoCodigo,
          fechaEmision,
          detenerEnPreview: emitirDetenerEnPreview,
          // Datos del receptor para rellenar campos vacíos en el formulario del SII
          comunaReceptor: emitirFactura.comunaReceptor || '',
          ciudadReceptor: emitirFactura.ciudadReceptor || '',
          dirReceptor: emitirFactura.dirReceptor || '',
          items: itemsEdicion.map(it => ({
            numero: it.numero,
            descripcion: it.descripcion,
            cantidad: it.cantidad,
            precioUnitario: it.precioUnitario,
          })),
        }),
      });
      if (data.success) {
        // Borrador cumplió su propósito: limpiar
        try { localStorage.removeItem(DRAFT_KEY(emitirFactura.codigo)); } catch { /* ok */ }
        if (data.detenidoEnPreview) {
          const u = data.previewUrl ? ` · ${data.previewUrl}` : '';
          setSyncMsg(
            `⏸ Vista previa SII (sin guardar)${data.folio != null ? ` — Folio previo ${data.folio}` : ''}${u}${data.aviso ? ` — ${data.aviso}` : ''}`
          );
        } else {
          setSyncMsg(`✅ Factura emitida${data.folio ? ` — Folio ${data.folio}` : ''}`);
        }
        setEmitirFactura(null);
      } else {
        setError(data.error || 'Error al emitir');
      }
    } catch (err: any) {
      setError(err.message || 'Error al emitir');
    } finally {
      setEmitiendo(false);
    }
  };

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <Box p={3} sx={{
      fontSize: `${fs}rem`,
      '& .MuiTypography-root': { fontSize: 'inherit' },
      '& .MuiTypography-h4': { fontSize: `${fs * 1.5}rem` },
      '& .MuiTypography-h6': { fontSize: `${fs * 1.1}rem` },
      '& .MuiTypography-subtitle1': { fontSize: `${fs}rem` },
      '& .MuiTypography-subtitle2': { fontSize: `${fs}rem` },
      '& .MuiTypography-body1': { fontSize: `${fs}rem` },
      '& .MuiTypography-body2': { fontSize: `${fs}rem` },
      '& .MuiTypography-caption': { fontSize: `${fs * 0.92}rem` },
      '& .MuiButton-root': { fontSize: `${fs}rem` },
      '& .MuiTableCell-root': { fontSize: `${fs}rem` },
      '& .MuiTableCell-head': { fontSize: `${fs}rem` },
      '& .MuiChip-label': { fontSize: `${fs}rem` },
      '& .MuiInputBase-input': { fontSize: `${fs}rem` },
      '& .MuiInputLabel-root': { fontSize: `${fs}rem` },
      '& .MuiMenuItem-root': { fontSize: `${fs}rem` },
      '& .MuiToggleButton-root': { fontSize: `${fs}rem` },
      '& .MuiAlert-message': { fontSize: `${fs}rem` },
      '& .MuiDialogTitle-root': { fontSize: `${fs * 1.1}rem` },
    }}>
      <Typography variant="h4" sx={{ mb: 1.5, fontSize: `${fs * 1.5}rem`, fontWeight: 600 }}>
        Facturación SII
      </Typography>

      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}

      <Paper sx={{ p: 1.5, mb: 2 }}>
        <Box
          sx={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 1.5,
            rowGap: 1,
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
            {cargandoEmpresas && <CircularProgress size={22} />}
            <ToggleButtonGroup
              value={empresaRut}
              exclusive
              disabled={cargandoEmpresas || empresasSelector.length === 0}
              onChange={(_, v) => {
                if (v) setEmpresaRut(v);
              }}
              size="medium"
              sx={{
                '& .MuiToggleButton-root': {
                  px: { xs: 1.5, sm: 2 },
                  py: 1,
                  maxWidth: { xs: '100%', sm: 280 },
                  fontWeight: 700,
                  textTransform: 'none',
                  color: 'text.primary',
                  borderColor: 'divider',
                  '&.Mui-selected': {
                    backgroundColor: EMPRESA_TOGGLE_ORANGE,
                    color: '#fff',
                    borderColor: EMPRESA_TOGGLE_ORANGE,
                    '&:hover': { backgroundColor: '#e65c00' },
                  },
                },
              }}
            >
              {empresasSelector.map((e) => (
                <ToggleButton key={e.value} value={e.value} title={e.label}>
                  <Box
                    component="span"
                    sx={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      display: 'block',
                      maxWidth: { xs: 200, sm: 260 },
                    }}
                  >
                    {e.label}
                  </Box>
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
          </Box>

          <Tabs
            value={pestañaDoc}
            onChange={(_, v) => setPestañaDoc(v as 'emitidos' | 'recibidos')}
            sx={{
              minHeight: 40,
              '& .MuiTabs-flexContainer': { flexWrap: 'wrap' },
              '& .MuiTab-root': {
                minHeight: 40,
                py: 0.5,
                fontWeight: 700,
                textTransform: 'none',
                color: 'text.primary',
                fontSize: `${fs}rem`,
              },
              '& .Mui-selected': { color: 'primary.main' },
            }}
          >
            <Tab label="Emitidos" value="emitidos" />
            <Tab label="Recibidos" value="recibidos" title="DTE recibidos (proveedores)" />
          </Tabs>
        </Box>

        {syncMsg && (
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', mt: 1.25, gap: 0.5 }}>
            <Typography variant="body2" color="text.secondary" sx={{ wordBreak: 'break-all', textAlign: 'center' }}>
              {syncMsg}
            </Typography>
            <IconButton size="small" onClick={() => setSyncMsg('')} sx={{ opacity: 0.5, '&:hover': { opacity: 1 }, p: 0.25 }}>
              <CloseIcon sx={{ fontSize: '0.85rem' }} />
            </IconButton>
          </Box>
        )}

        {syncHistoricoProgress && (
          <Box sx={{ mt: 1.5 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5, flexWrap: 'wrap', gap: 1 }}>
              <Typography variant="body2" color="text.secondary">
                {syncHistoricoProgress.quarter} — {syncHistoricoProgress.quarterIndex}/{syncHistoricoProgress.totalQuarters} trimestres
                {syncHistoricoProgress.totalEncontradas > 0 &&
                  ` · ${syncHistoricoProgress.totalEncontradas} encontradas, +${syncHistoricoProgress.nuevasEnTrimestre} nuevas`}
              </Typography>
              <Typography variant="body2" color="primary" sx={{ fontWeight: 600 }}>
                {syncHistoricoProgress.acumulado} acumuladas ·{' '}
                {Math.round((syncHistoricoProgress.quarterIndex / syncHistoricoProgress.totalQuarters) * 100)}%
              </Typography>
            </Box>
            <LinearProgress
              variant="determinate"
              value={(syncHistoricoProgress.quarterIndex / syncHistoricoProgress.totalQuarters) * 100}
            />
          </Box>
        )}

        {(conectando || sincronizando) && <LinearProgress sx={{ mt: 1.5 }} />}
      </Paper>

      {pestañaDoc === 'recibidos' ? (
        <Paper sx={{ p: 3, mb: 2 }}>
          <Box sx={{ display: 'flex', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 1, mb: 2 }}>
            <Button
              variant="contained"
              onClick={sincronizar}
              disabled={conectando || sincronizando}
              startIcon={
                conectando || sincronizando ? <CircularProgress size={18} color="inherit" /> : <SyncIcon />
              }
              sx={{ py: 0.75 }}
            >
              {conectando ? 'Conectando...' : sincronizando ? 'Sincronizando...' : 'Sincronizar SII'}
            </Button>
            <Button
              variant="outlined"
              onClick={sincronizarHistorico}
              disabled={conectando || sincronizando || syncHistoricoActivo}
              startIcon={
                syncHistoricoActivo ? <CircularProgress size={18} color="inherit" /> : <HistoryIcon />
              }
              sx={{ py: 0.75 }}
            >
              {syncHistoricoActivo ? 'Sincronizando...' : 'Sync histórico (2 años)'}
            </Button>
          </Box>
          <Alert severity="info">
            Los DTE que te emiten terceros (compras al proveedor) aún no se sincronizan desde este módulo: hay que integrar el listado
            «Documentos recibidos» del portal MIPYME. La «Factura de compra electrónica» (tipo 46) que registras como comprador sí
            aparece en la pestaña Emitidos; elige el tipo «F.compra (46)» en el filtro.
          </Alert>
        </Paper>
      ) : (
        <>
      {/* Filtros + contador en una línea (wrap en móvil) */}
      <Paper sx={{ p: 1.5, mb: 2 }}>
        <Box
          sx={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 1.5,
            rowGap: 1,
          }}
        >
          <TextField
            size="small"
            placeholder="Cliente o RUT (con o sin puntos)…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            sx={{ flex: { xs: '1 1 100%', sm: '1 1 220px' }, minWidth: { sm: 200 }, maxWidth: { sm: 320 } }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            }}
          />

          <FormControl size="small" sx={{ flex: { xs: '1 1 100%', sm: '0 1 240px' }, minWidth: { sm: 200 } }}>
            <InputLabel id="billing-tipo-label">Tipo documento</InputLabel>
            <Select
              labelId="billing-tipo-label"
              multiple
              value={tiposSeleccionados}
              onChange={(e) => {
                const v = e.target.value;
                setTiposSeleccionados(typeof v === 'string' ? [] : (v as number[]));
              }}
              input={<OutlinedInput label="Tipo documento" />}
              renderValue={(selected) =>
                (selected as number[]).length === 0
                  ? 'Todos'
                  : (selected as number[]).map((n) => TIPO_DOC_OPTIONS.find((o) => o.value === n)?.label ?? String(n)).join(', ')
              }
              MenuProps={{ PaperProps: { style: { maxHeight: 320 } } }}
            >
              {TIPO_DOC_OPTIONS.map((opt) => (
                <MenuItem key={opt.value} value={opt.value}>
                  <Checkbox checked={tiposSeleccionados.indexOf(opt.value) > -1} size="small" sx={{ py: 0 }} />
                  <ListItemText primary={opt.label} primaryTypographyProps={{ sx: { fontSize: `${fs}rem` } }} />
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <ToggleButtonGroup
            size="small"
            value={vista}
            exclusive
            onChange={(_, v) => v && setVista(v)}
            sx={{
              flexShrink: 0,
              '& .MuiToggleButton-root': { color: 'text.primary', fontWeight: 600, textTransform: 'none' },
            }}
          >
            <ToggleButton value="ultima">
              <PeopleIcon fontSize="small" sx={{ mr: 0.5 }} />
              Última por cliente
            </ToggleButton>
            <ToggleButton value="todas">
              <ListIcon fontSize="small" sx={{ mr: 0.5 }} />
              Todas
            </ToggleButton>
          </ToggleButtonGroup>

          <Box sx={{ flexGrow: 1, minWidth: 0, display: { xs: 'none', md: 'block' } }} />

          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.5,
              flexShrink: 0,
              ml: { xs: 0, md: 'auto' },
              width: { xs: '100%', md: 'auto' },
              justifyContent: { xs: 'flex-end', md: 'flex-end' },
            }}
          >
            {cargandoDB && <CircularProgress size={18} />}
            <Typography variant="body2" sx={{ color: 'text.primary', fontWeight: 600, whiteSpace: 'nowrap' }}>
              {facturasFiltradas.length} de {facturas.length} registros
            </Typography>
            <Tooltip title="Recargar desde DB">
              <Box component="span" sx={{ display: 'inline-flex' }}>
                <IconButton
                  size="small"
                  onClick={() => cargarDB(empresaRut)}
                  disabled={!empresaRut || cargandoDB}
                >
                  <RefreshIcon fontSize="small" />
                </IconButton>
              </Box>
            </Tooltip>
          </Box>
        </Box>
      </Paper>

      <Grid container spacing={1.5} sx={{ mb: 2 }}>
        <Grid item xs={12} md={4}>
          <Paper variant="outlined" sx={{ p: 1.5, height: '100%', borderColor: 'divider' }}>
            <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.primary', display: 'block' }}>
              {kpisEmitidos.tituloPrincipal}
            </Typography>
            {empresaNombre && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.25 }}>
                {empresaNombre}
              </Typography>
            )}
            <Typography variant="h6" sx={{ fontWeight: 700, color: 'text.primary', my: 0.5 }}>
              {fmt(kpisEmitidos.total)}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {kpisEmitidos.n} docs (tipos 33, 34, 39, 41) · ticket {fmt(Math.round(kpisEmitidos.ticket))}
            </Typography>
            {kpisEmitidos.subtituloFiltros ? (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
                {kpisEmitidos.subtituloFiltros}
              </Typography>
            ) : null}
          </Paper>
        </Grid>
        <Grid item xs={12} md={4}>
          <Paper variant="outlined" sx={{ p: 1.5, height: '100%', borderColor: 'divider' }}>
            <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.primary', display: 'block' }}>
              {kpisEmitidos.puedeComparar
                ? `vs ${kpisEmitidos.etiquetaComparacion}`
                : 'Comparación'}
            </Typography>
            <Typography variant="h6" sx={{ fontWeight: 700, color: 'text.primary', my: 0.5 }}>
              {kpisEmitidos.puedeComparar ? fmt(kpisEmitidos.sPrev) : '—'}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {!kpisEmitidos.puedeComparar
                ? 'Elige un año para comparar. Con año y mes: mismo mes del año anterior; solo año: año completo vs el anterior.'
                : kpisEmitidos.varPct === null
                  ? kpisEmitidos.sPrev === 0 && kpisEmitidos.total > 0
                    ? 'Sin facturación en el período de comparación'
                    : '—'
                  : `${kpisEmitidos.varPct >= 0 ? '+' : ''}${kpisEmitidos.varPct}% vs ${
                      kpisEmitidos.comparacionEsMesYoY ? 'mismo mes, año anterior' : 'año anterior (total)'
                    }`}
            </Typography>
          </Paper>
        </Grid>
        <Grid item xs={12} md={4}>
          <Paper variant="outlined" sx={{ p: 1.5, height: '100%', borderColor: 'divider' }}>
            <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.primary', display: 'block' }}>
              Top 3 clientes (conjunto filtrado)
            </Typography>
            <Typography variant="h6" sx={{ fontWeight: 700, color: 'text.primary', my: 0.5 }}>
              {kpisEmitidos.total > 0 ? `${kpisEmitidos.concPct}%` : '—'}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ wordBreak: 'break-word' }}>
              {kpisEmitidos.top3.length > 0
                ? kpisEmitidos.top3.map(([rut]) => formatRut(rut)).join(' · ')
                : 'Sin RUT en el conjunto'}
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
              % del total {fmt(kpisEmitidos.total)} mostrado arriba
            </Typography>
          </Paper>
        </Grid>
      </Grid>

      {/* Tabla + chips año / mes */}
      <Paper sx={{ overflow: 'hidden' }}>
        <Box
          sx={{
            px: 2,
            py: 1.25,
            display: 'flex',
            flexDirection: 'column',
            gap: 1,
            borderBottom: 1,
            borderColor: 'divider',
            bgcolor: '#fafafa',
          }}
        >
          <Box
            sx={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 1,
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, alignItems: 'center' }}>
              <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.primary', mr: 0.5 }}>
                Año
              </Typography>
              <Chip
                label="Todos"
                size="small"
                onClick={() => setAnioFiltro(null)}
                color={anioFiltro === null ? 'primary' : 'default'}
                variant={anioFiltro === null ? 'filled' : 'outlined'}
                sx={{ fontSize: `${fs}rem` }}
              />
              {añosDisponibles.map((y) => (
                <Chip
                  key={y}
                  label={String(y)}
                  size="small"
                  onClick={() => setAnioFiltro(anioFiltro === y ? null : y)}
                  color={anioFiltro === y ? 'primary' : 'default'}
                  variant={anioFiltro === y ? 'filled' : 'outlined'}
                  sx={{ fontSize: `${fs}rem` }}
                />
              ))}
            </Box>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, alignItems: 'center', ml: { xs: 0, sm: 'auto' } }}>
              <Button
                variant="contained"
                size="small"
                onClick={sincronizar}
                disabled={conectando || sincronizando}
                startIcon={
                  conectando || sincronizando ? <CircularProgress size={16} color="inherit" /> : <SyncIcon />
                }
              >
                {conectando ? 'Conectando...' : sincronizando ? 'Sincronizando...' : 'Sincronizar SII'}
              </Button>
              <Button
                variant="outlined"
                size="small"
                onClick={sincronizarHistorico}
                disabled={conectando || sincronizando || syncHistoricoActivo}
                startIcon={
                  syncHistoricoActivo ? <CircularProgress size={16} color="inherit" /> : <HistoryIcon />
                }
              >
                {syncHistoricoActivo ? 'Sincronizando...' : 'Sync histórico (2 años)'}
              </Button>
            </Box>
          </Box>

          <Box
            sx={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 0.5,
              alignItems: 'center',
              pt: 1,
              borderTop: 1,
              borderColor: 'divider',
            }}
          >
            <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.primary', mr: 0.5 }}>
              Mes
            </Typography>
            <Chip
              label="Todos los meses"
              size="small"
              onClick={() => setMesFiltro(null)}
              color={mesFiltro === null ? 'primary' : 'default'}
              variant={mesFiltro === null ? 'filled' : 'outlined'}
              sx={{ fontSize: `${fs * 0.92}rem` }}
            />
            {MESES_CORTO.map((label, idx) => {
              const m = idx + 1;
              return (
                <Chip
                  key={label}
                  label={label}
                  size="small"
                  onClick={() => setMesFiltro(mesFiltro === m ? null : m)}
                  color={mesFiltro === m ? 'primary' : 'default'}
                  variant={mesFiltro === m ? 'filled' : 'outlined'}
                  sx={{ fontSize: `${fs * 0.92}rem` }}
                />
              );
            })}
            <Typography variant="caption" color="text.secondary" sx={{ width: '100%', mt: 0.25 }}>
              Comparación KPI: con año + mes, se compara con el <strong>mismo mes del año anterior</strong>. Solo año: se
              compara el año completo con el anterior.
            </Typography>
          </Box>
        </Box>
        <TableContainer sx={{ maxHeight: 600 }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                {['Fecha', 'Folio', 'Tipo', 'Cliente', 'RUT', 'Monto', 'Estado', ''].map(h => (
                  <TableCell key={h} sx={{ fontWeight: 600, backgroundColor: '#f5f5f5' }}>
                    {h}
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {facturasFiltradas.length === 0 && !cargandoDB && (
                <TableRow>
                  <TableCell colSpan={8} align="center" sx={{ py: 5, color: 'text.secondary' }}>
                    {facturas.length === 0
                      ? 'Sin facturas en la base de datos. Usa "Sincronizar" para traerlas del SII.'
                      : 'Sin resultados para la búsqueda.'}
                  </TableCell>
                </TableRow>
              )}
              {facturasFiltradas.map(f => (
                <TableRow key={f.id} hover sx={{ cursor: 'pointer' }} onClick={() => setPreviewFactura(f)}>
                  <TableCell>{f.fecha}</TableCell>
                  <TableCell>{f.folio}</TableCell>
                  <TableCell>
                    <Chip
                      label={etiquetaTipoDoc(f.tipoCodigo)}
                      size="small"
                      color={f.tipoCodigo === 33 ? 'primary' : 'default'}
                    />
                  </TableCell>
                  <TableCell sx={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {f.razonSocial}
                  </TableCell>
                  <TableCell>{formatRut(f.rutReceptor || '')}</TableCell>
                  <TableCell align="right">{fmt(f.monto)}</TableCell>
                  <TableCell>
                    <Chip
                      label={f.estado || '—'}
                      size="small"
                      variant="outlined"
                      color={/vigente/i.test(f.estado) ? 'success' : /anulad/i.test(f.estado) ? 'error' : 'default'}
                    />
                  </TableCell>
                  <TableCell align="center" onClick={e => e.stopPropagation()}>
                    <Tooltip title="Ver detalle guardado">
                      <IconButton size="small" onClick={() => setPreviewFactura(f)}>
                        <VisibilityIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="HTML portal SII (sesión API)">
                      <span>
                        <IconButton
                          size="small"
                          onClick={() => verFacturaReal(f)}
                          disabled={!sessionId || !!previewLoadingCodigo}
                        >
                          {previewLoadingCodigo === f.codigo ? (
                            <CircularProgress color="inherit" size={18} />
                          ) : (
                            <OpenInNewIcon fontSize="small" />
                          )}
                        </IconButton>
                      </span>
                    </Tooltip>
                    {f.hasPdf && (
                      <Tooltip title="Ver PDF">
                        <span>
                          <IconButton
                            size="small"
                            color="error"
                            onClick={() => abrirPdf(f)}
                            disabled={abriendoPdfCodigo === f.codigo}
                          >
                            {abriendoPdfCodigo === f.codigo ? (
                              <CircularProgress color="inherit" size={18} />
                            ) : (
                              <PictureAsPdfIcon fontSize="small" />
                            )}
                          </IconButton>
                        </span>
                      </Tooltip>
                    )}
                    <Tooltip title={sessionId ? 'Replicar factura' : 'Sincroniza primero para replicar'}>
                      <span>
                        <IconButton size="small" color="success" onClick={() => abrirEmitir(f)} disabled={!sessionId}>
                          <ContentCopyIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>
        </>
      )}

      {/* ── Modal preview ─────────────────────────────────────────────────── */}
      <Dialog
        open={!!previewFactura}
        onClose={() => setPreviewFactura(null)}
        maxWidth="lg"
        fullWidth
        PaperProps={{ sx: dialogPaperFontSx }}
      >
        {previewFactura && (() => {
          const ext = previewFactura.detalleExtendido;
          const part = partitionDetalleExtendido(ext || undefined);
          const sucursalLinea = textoSucursalEmisorCuadro(ext || undefined, part.emisor);
          const impAdic =
            montoDesdeCampoSii(ext?.EFXP_MNT_IMP_ADIC) ||
            montoDesdeCampoSii(ext?.EFXP_MNT_IVA_NO_REC) ||
            0;
          const giroUi = previewFactura.giroReceptor?.trim() || pickCampoDesdeExtendido(ext, 'giro');
          const dirUi = previewFactura.dirReceptor?.trim() || pickCampoDesdeExtendido(ext, 'dir');
          const formaUi = previewFactura.formaPago?.trim() || pickCampoDesdeExtendido(ext, 'formaPago');
          const totalEff = previewFactura.total || previewFactura.monto;
          let netoUi = previewFactura.neto;
          let ivaUi = previewFactura.iva;
          if (previewFactura.tipoCodigo === 33 && totalEff > 0 && netoUi <= 0 && ivaUi <= 0) {
            netoUi = Math.round(totalEff / 1.19);
            ivaUi = Math.max(0, totalEff - netoUi);
          }
          const normTxt = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
          const receptorExtra = part.receptor.filter((r) => {
            const k = r.key.toUpperCase();
            if (REC_EFXP_MAIN.has(k)) return false;
            if (/DEFUALT|DEFAULT/.test(k) && (/DIR|GIRO|DIREC/i.test(k) || /REC.*GIRO|REC.*DIR/i.test(k))) {
              return false;
            }
            const v = (r.value || '').trim();
            if (dirUi && v && normTxt(v) === normTxt(dirUi) && /DIR|DIREC|DEFUALT|DEFAULT/i.test(k)) {
              return false;
            }
            if (giroUi && v && normTxt(v) === normTxt(giroUi) && /GIRO|DEFUALT|DEFAULT/i.test(k)) {
              return false;
            }
            return true;
          });
          const referenciasUi = (ext?.EFXP_REFERENCIAS_RESUMEN || '').trim();
          const otrosAccordionRows = part.otros.filter((r) => r.key !== 'EFXP_REFERENCIAS_RESUMEN');
          const esFacturaExentaTipo = [34, 41].includes(previewFactura.tipoCodigo);
          const totalesYaEnResumen = new Set(
            [
              'EFXP_SUBTOTAL',
              'EFXP_MNT_NETO',
              'EFXP_MNT_TOTAL',
              'EFXP_IVA',
              'EFXP_TASA_IVA',
              'EFXP_TOTAL',
              'MNT_NETO_TEMP',
              'IVA_TEMP',
            ].map((k) => k.toUpperCase())
          );
          const totalesFormularioExtra = part.totales.filter((r) => !totalesYaEnResumen.has(r.key.toUpperCase()));
          const accordionFormularioRows = [...totalesFormularioExtra, ...otrosAccordionRows];
          return (
          <>
            <DialogTitle sx={{ fontWeight: 600, fontSize: `${fs * 1.1}rem` }}>
              Vista detalle DTE (formulario SII)
              <Typography variant="body2" color="text.secondary">
                {previewFactura.tipoDocumento} · Folio N° {previewFactura.folio} · {previewFactura.fecha}
              </Typography>
            </DialogTitle>
            <DialogContent dividers>
              <Box sx={{ border: '1px solid', borderColor: 'divider', p: 2, bgcolor: 'background.paper' }}>
                <Grid container spacing={2} sx={{ mb: 2 }}>
                  <Grid item xs={12} md={7}>
                    <Typography variant="overline" color="text.secondary" sx={{ fontWeight: 700 }}>
                      Emisor
                    </Typography>
                    {part.emisor.length > 0 ? (
                      <DteKvRows rows={part.emisor} />
                    ) : (
                      <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                        Los datos de empresa emisora no vienen en el formulario copiar documento; el RUT emisor es el de la sesión (
                        {empresaRut ? formatRut(empresaRut) : '—'}).
                      </Typography>
                    )}
                  </Grid>
                  <Grid item xs={12} md={5}>
                    <Paper
                      elevation={0}
                      sx={{
                        border: '2px solid',
                        borderColor: 'error.main',
                        p: 1.5,
                        bgcolor: '#ffebee',
                      }}
                    >
                      <Typography sx={{ fontWeight: 700 }}>
                        R.U.T.: {empresaRut ? formatRut(empresaRut) : '—'}
                      </Typography>
                      <Typography sx={{ fontWeight: 700 }}>{previewFactura.tipoDocumento}</Typography>
                      <Typography sx={{ fontWeight: 700 }}>N° {previewFactura.folio}</Typography>
                      {sucursalLinea ? (
                        <Typography variant="body2" sx={{ mt: 1, color: 'error.dark', fontWeight: 600 }}>
                          {sucursalLinea}
                        </Typography>
                      ) : (
                        <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
                          Sin datos de sucursal en el formulario copiar documento (ver PDF). El código numérico SII, si
                          aparece más abajo en «Emisor», identifica la sucursal ante el SII pero no sustituye comuna/ciudad.
                        </Typography>
                      )}
                    </Paper>
                  </Grid>
                </Grid>

                <Paper variant="outlined" sx={{ p: 1.5, mb: 2, borderWidth: 2 }}>
                  <Typography variant="subtitle2" fontWeight={700} gutterBottom>
                    Receptor (a quien se emitió el documento)
                  </Typography>
                  <Grid container spacing={1}>
                    <Grid item xs={12} sm={6}>
                      <Typography variant="caption" color="text.secondary">Nombre / Razón social</Typography>
                      <Typography variant="body2" fontWeight={500}>{previewFactura.razonSocial || '—'}</Typography>
                    </Grid>
                    <Grid item xs={12} sm={6}>
                      <Typography variant="caption" color="text.secondary">R.U.T.</Typography>
                      <Typography variant="body2" fontWeight={500}>{formatRut(previewFactura.rutReceptor || '')}</Typography>
                    </Grid>
                    <Grid item xs={12} sm={6}>
                      <Typography variant="caption" color="text.secondary">Giro</Typography>
                      <Typography variant="body2">{giroUi || '—'}</Typography>
                    </Grid>
                    <Grid item xs={12} sm={6}>
                      <Typography variant="caption" color="text.secondary">Dirección</Typography>
                      <Typography variant="body2">{dirUi || '—'}</Typography>
                    </Grid>
                    <Grid item xs={6} sm={3}>
                      <Typography variant="caption" color="text.secondary">Comuna</Typography>
                      <Typography variant="body2">{previewFactura.comunaReceptor || '—'}</Typography>
                    </Grid>
                    <Grid item xs={6} sm={3}>
                      <Typography variant="caption" color="text.secondary">Ciudad</Typography>
                      <Typography variant="body2">{previewFactura.ciudadReceptor || '—'}</Typography>
                    </Grid>
                  </Grid>
                  {receptorExtra.length > 0 && (
                    <>
                      <Divider sx={{ my: 1.5 }} />
                      <Typography variant="caption" color="text.secondary">Otros datos receptor / operación</Typography>
                      <DteKvRows rows={receptorExtra} />
                    </>
                  )}
                </Paper>

                {part.transporte.length > 0 && (
                  <Paper variant="outlined" sx={{ p: 1.5, mb: 2 }}>
                    <Typography variant="subtitle2" fontWeight={700} gutterBottom>
                      Transporte / traslado
                    </Typography>
                    <DteKvRows rows={part.transporte} />
                  </Paper>
                )}

                {previewFactura.items && previewFactura.items.length > 0 ? (
                  <Table size="small" sx={{ mb: 2, border: '1px solid', borderColor: 'divider' }}>
                    <TableHead>
                      <TableRow sx={{ backgroundColor: '#f5f5f5' }}>
                        <TableCell sx={{ fontWeight: 600 }}>Código</TableCell>
                        <TableCell sx={{ fontWeight: 600 }}>Descripción</TableCell>
                        <TableCell sx={{ fontWeight: 600 }} align="center">Cant.</TableCell>
                        <TableCell sx={{ fontWeight: 600 }} align="right">Precio</TableCell>
                        <TableCell sx={{ fontWeight: 600 }} align="right">% Impto adic.</TableCell>
                        <TableCell sx={{ fontWeight: 600 }} align="right">% Desc.</TableCell>
                        <TableCell sx={{ fontWeight: 600 }} align="right">Valor</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {previewFactura.items.map((it) => (
                        <TableRow key={it.numero}>
                          <TableCell>{it.codigo?.trim() || '—'}</TableCell>
                          <TableCell sx={{ maxWidth: 280, whiteSpace: 'normal', wordBreak: 'break-word' }}>
                            {it.descripcion}
                          </TableCell>
                          <TableCell align="center">{it.cantidad}</TableCell>
                          <TableCell align="right">{fmt(it.precioUnitario)}</TableCell>
                          <TableCell align="right">
                            {it.imptoAdicPct != null && it.imptoAdicPct !== 0 ? `${it.imptoAdicPct}%` : '—'}
                          </TableCell>
                          <TableCell align="right">
                            {it.descuento ? `${it.descuento}%` : '—'}
                          </TableCell>
                          <TableCell align="right">
                            {fmt(it.subtotal || it.cantidad * it.precioUnitario)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : cargandoDetalleModal ? (
                  <Box sx={{ py: 2, mb: 2 }}>
                    <LinearProgress />
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
                      Obteniendo ítems desde el SII…
                    </Typography>
                  </Box>
                ) : previewFactura.detalleCompleto ? (
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                    Sin líneas de detalle en el documento.
                  </Typography>
                ) : (
                  <Alert severity="warning" sx={{ mb: 2 }}>
                    {sessionId
                      ? 'No se pudo obtener el detalle. Reintenta o sincroniza de nuevo.'
                      : 'Inicia sesión SII (la página crea sesión al cargar) o pulsa «Sincronizar» y vuelve a abrir.'}
                  </Alert>
                )}

                {referenciasUi ? (
                  <Paper variant="outlined" sx={{ p: 1.5, mb: 2, bgcolor: 'grey.50' }}>
                    <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>
                      Referencias
                    </Typography>
                    <Typography variant="body2" sx={{ mt: 0.5 }}>{referenciasUi}</Typography>
                  </Paper>
                ) : null}

                <Grid container spacing={2} alignItems="flex-start">
                  <Grid item xs={12} md={6}>
                    <Typography variant="caption" color="text.secondary">Forma de pago</Typography>
                    <Typography variant="body1" fontWeight={500}>
                      {formaUi || '—'}
                    </Typography>
                    {!formaUi ? (
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                        El portal suele cargar este dato con JavaScript; si falta, revísalo en el PDF.
                      </Typography>
                    ) : null}
                  </Grid>
                  <Grid item xs={12} md={6}>
                    <Paper variant="outlined" sx={{ p: 1.5, borderWidth: 2, maxWidth: 320, ml: { md: 'auto' } }}>
                      <Typography variant="subtitle2" fontWeight={700} gutterBottom>
                        Totales
                      </Typography>
                      {esFacturaExentaTipo ? (
                        <>
                          <Typography variant="body2">Impuesto adicional: {fmt(impAdic)}</Typography>
                          <Typography variant="body2">Exento: {fmt(netoUi || totalEff)}</Typography>
                          <Typography variant="body2" color="text.secondary">
                            I.V.A.: No aplica (documento exento)
                          </Typography>
                        </>
                      ) : (
                        <>
                          <Typography variant="body2">Monto neto: {fmt(netoUi)}</Typography>
                          <Typography variant="body2">I.V.A. 19%: {fmt(ivaUi)}</Typography>
                          <Typography variant="body2">Impuesto adicional: {fmt(impAdic)}</Typography>
                        </>
                      )}
                      <Divider sx={{ my: 1 }} />
                      <Typography variant="subtitle1" fontWeight={700}>
                        Total: {fmt(previewFactura.total || previewFactura.monto)}
                      </Typography>
                    </Paper>
                  </Grid>
                </Grid>

                <Alert severity="info" sx={{ mt: 2 }}>
                  Al replicar el documento, el folio y el timbre electrónico del SII se generan de nuevo. Descripción y datos de
                  receptor suelen ser los mismos; conviene revisar precios y fechas.
                </Alert>

                {accordionFormularioRows.length > 0 && (
                  <Accordion disableGutters sx={{ mt: 1, boxShadow: 'none', border: '1px solid', borderColor: 'divider' }}>
                    <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                      <Typography variant="subtitle2">
                        Campos adicionales del formulario SII ({accordionFormularioRows.length})
                      </Typography>
                    </AccordionSummary>
                    <AccordionDetails>
                      <DteKvRows rows={accordionFormularioRows} />
                    </AccordionDetails>
                  </Accordion>
                )}
              </Box>
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setPreviewFactura(null)}>Cerrar</Button>
              {previewFactura.hasPdf && (
                <Button
                  variant="outlined"
                  color="error"
                  startIcon={
                    abriendoPdfCodigo === previewFactura.codigo ? (
                      <CircularProgress size={18} color="inherit" />
                    ) : (
                      <PictureAsPdfIcon />
                    )
                  }
                  onClick={() => abrirPdf(previewFactura)}
                  disabled={abriendoPdfCodigo === previewFactura.codigo}
                >
                  Ver PDF
                </Button>
              )}
              <Button
                variant="contained"
                color="success"
                startIcon={<ContentCopyIcon />}
                onClick={() => abrirEmitir(previewFactura)}
                disabled={!sessionId}
              >
                {sessionId ? 'Replicar factura' : 'Sincroniza primero'}
              </Button>
            </DialogActions>
          </>
          );
        })()}
      </Dialog>

      {/* Vista portal SII (HTML de la sesión del servidor — iframe embebido en la app) */}
      <Dialog
        open={!!siiPortalPreview}
        onClose={cerrarVistaSiiPortal}
        maxWidth="xl"
        fullWidth
        PaperProps={{ sx: [{ height: '90vh' }, dialogPaperFontSx] }}
      >
        {siiPortalPreview && (
          <>
            <DialogTitle sx={{ fontWeight: 600, fontSize: `${fs * 1.05}rem` }}>
              Documento en portal SII (sesión API)
              <Typography variant="caption" display="block" color="text.secondary" sx={{ mt: 0.5 }}>
                CODIGO {siiPortalPreview.codigo} · URL resuelta con token desde listado
              </Typography>
            </DialogTitle>
            <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1, pt: 0, overflow: 'hidden' }}>
              <Alert severity="info" sx={{ py: 0.5 }}>
                Es el mismo HTML que entrega el backend con tu sesión SII; no es un archivo <code>file://</code>.
                Si el recuadro central falla, los iframes del SII pueden pedir cookies del navegador en sii.cl — prueba también «Abrir en pestaña».
              </Alert>
              {siiPortalPreview.resolvedUrl && (
                <Typography variant="caption" color="text.secondary" sx={{ wordBreak: 'break-all', fontFamily: 'monospace' }}>
                  {siiPortalPreview.resolvedUrl}
                </Typography>
              )}
              <Box
                component="iframe"
                title="SII documento"
                src={siiPortalPreview.blobUrl}
                sx={{
                  flex: 1,
                  minHeight: 480,
                  width: '100%',
                  border: '1px solid',
                  borderColor: 'divider',
                  borderRadius: 1,
                }}
              />
            </DialogContent>
            <DialogActions>
              <Button onClick={cerrarVistaSiiPortal}>Cerrar</Button>
              <Button
                variant="outlined"
                startIcon={<OpenInNewIcon />}
                onClick={() => window.open(siiPortalPreview.blobUrl, '_blank')}
              >
                Abrir en pestaña
              </Button>
            </DialogActions>
          </>
        )}
      </Dialog>

      <Dialog
        open={!!pdfModal}
        onClose={cerrarPdfModal}
        maxWidth={false}
        fullWidth
        PaperProps={{
          sx: {
            width: 'min(96vw, 1200px)',
            height: '92vh',
            maxHeight: '92vh',
            m: 1.5,
            display: 'flex',
            flexDirection: 'column',
          },
        }}
      >
        {pdfModal && (
          <>
            <DialogTitle
              sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 1,
                flexShrink: 0,
                py: 1.25,
                pr: 1,
              }}
            >
              <Typography sx={{ fontWeight: 600 }}>PDF · CODIGO {pdfModal.codigo}</Typography>
              <IconButton aria-label="Cerrar" onClick={cerrarPdfModal} size="small">
                <CloseIcon />
              </IconButton>
            </DialogTitle>
            <DialogContent
              sx={{
                p: 0,
                flex: 1,
                minHeight: 0,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
              }}
            >
              <Box
                component="iframe"
                title="PDF factura SII"
                src={pdfModal.url}
                sx={{
                  flex: 1,
                  minHeight: 320,
                  width: '100%',
                  border: 0,
                  borderTop: '1px solid',
                  borderColor: 'divider',
                }}
              />
            </DialogContent>
            <DialogActions sx={{ flexShrink: 0 }}>
              <Button onClick={cerrarPdfModal}>Cerrar</Button>
              <Button variant="outlined" startIcon={<OpenInNewIcon />} onClick={() => window.open(pdfModal.url, '_blank')}>
                Abrir en pestaña
              </Button>
            </DialogActions>
          </>
        )}
      </Dialog>

      {/* ── Confirmación emisión ──────────────────────────────────────────── */}
      <Dialog open={confirmarEmitir} onClose={() => setConfirmarEmitir(false)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontWeight: 600 }}>¿Confirmar emisión?</DialogTitle>
        <DialogContent>
          <Typography variant="body1" gutterBottom>
            Estás a punto de emitir una factura electrónica a:
          </Typography>
          <Typography variant="body1" fontWeight={600} gutterBottom>
            {emitirFactura?.razonSocial}
          </Typography>
          <Typography variant="body2" color="text.secondary" gutterBottom>
            RUT {formatRut(emitirFactura?.rutReceptor || '')} · Total{' '}
            <strong>
              ${itemsEdicion.reduce((s, i) => s + (i.cantidad || 1) * (i.precioUnitario || 0), 0).toLocaleString('es-CL')}
            </strong>{' '}
            neto + IVA
          </Typography>
          <Typography variant="caption" color="warning.main">
            Esta acción emitirá el documento ante el SII y no se puede deshacer.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmarEmitir(false)}>Cancelar</Button>
          <Button
            variant="contained" color="error"
            onClick={() => { setConfirmarEmitir(false); emitir(); }}
          >
            Sí, emitir factura
          </Button>
        </DialogActions>
      </Dialog>

      {/* ── Modal emisión ─────────────────────────────────────────────────── */}
      <Dialog
        open={!!emitirFactura}
        onClose={() => !emitiendo && setEmitirFactura(null)}
        maxWidth="md"
        fullWidth
        PaperProps={{ sx: dialogPaperFontSx }}
      >
        {emitirFactura && (
          <>
            <DialogTitle sx={{ fontWeight: 600, fontSize: `${fs * 1.1}rem` }}>
              Emitir {emitirFactura.tipoDocumento}
              <Typography variant="body2" color="text.secondary">
                {emitirFactura.razonSocial} · {formatRut(emitirFactura.rutReceptor || '')}
              </Typography>
            </DialogTitle>
            <DialogContent dividers>
              <Grid container spacing={2} sx={{ mb: 2 }}>
                {emitirFactura.dirReceptor && (
                  <Grid item xs={12} md={8}>
                    <Typography variant="caption" color="text.secondary">Dirección receptor</Typography>
                    <Typography sx={{ fontSize: `${fs}rem` }}>
                      {[emitirFactura.dirReceptor, emitirFactura.comunaReceptor].filter(Boolean).join(', ')}
                    </Typography>
                  </Grid>
                )}
                <Grid item xs={12} md={4}>
                  <TextField
                    label="Fecha emisión"
                    type="date"
                    value={fechaEmision}
                    onChange={e => {
                      setFechaEmision(e.target.value);
                      if (emitirFactura) {
                        try { localStorage.setItem(DRAFT_KEY(emitirFactura.codigo), JSON.stringify({ items: itemsEdicion, fecha: e.target.value })); } catch { /* quota */ }
                      }
                    }}
                    size="small" fullWidth
                    InputLabelProps={{ shrink: true }}
                  />
                </Grid>
              </Grid>

              <Divider sx={{ mb: 1.5 }} />

              <Box display="flex" justifyContent="space-between" alignItems="center" mb={1}>
                <Box display="flex" alignItems="center" gap={1}>
                  <Typography variant="subtitle2" fontWeight={600}>Ítems a facturar</Typography>
                  {emitirFactura && (() => {
                    try { return !!localStorage.getItem(DRAFT_KEY(emitirFactura.codigo)); } catch { return false; }
                  })() && (
                    <Typography
                      variant="caption"
                      color="warning.main"
                      sx={{ cursor: 'pointer', textDecoration: 'underline' }}
                      onClick={() => {
                        if (emitirFactura) {
                          try { localStorage.removeItem(DRAFT_KEY(emitirFactura.codigo)); } catch { /* ok */ }
                          setItemsEdicion(emitirFactura.items ? emitirFactura.items.map(it => ({ ...it })) : []);
                          setFechaEmision(new Date().toISOString().split('T')[0]);
                        }
                      }}
                    >
                      📋 Borrador guardado · Descartar
                    </Typography>
                  )}
                </Box>
                <Button size="small" startIcon={<AddIcon />} onClick={() =>
                  setItemsEdicion(prev => {
                    const next = [...prev, { numero: prev.length + 1, descripcion: '', cantidad: 1, unidad: '', precioUnitario: 0, descuento: 0, subtotal: 0 }];
                    if (emitirFactura) {
                      try { localStorage.setItem(DRAFT_KEY(emitirFactura.codigo), JSON.stringify({ items: next, fecha: fechaEmision })); } catch { /* quota */ }
                    }
                    return next;
                  })
                }>
                  Agregar línea
                </Button>
              </Box>

              <Table size="small">
                <TableHead>
                  <TableRow sx={{ backgroundColor: '#f5f5f5' }}>
                    <TableCell sx={{ fontWeight: 600, width: '5%' }}>#</TableCell>
                    <TableCell sx={{ fontWeight: 600, width: '47%' }}>Descripción</TableCell>
                    <TableCell sx={{ fontWeight: 600, width: '10%' }} align="center">Cant.</TableCell>
                    <TableCell sx={{ fontWeight: 600, width: '20%' }} align="right">Precio Unit.</TableCell>
                    <TableCell sx={{ fontWeight: 600, width: '13%' }} align="right">Subtotal</TableCell>
                    <TableCell sx={{ width: '5%' }} />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {itemsEdicion.map((it, idx) => (
                    <TableRow key={idx}>
                      <TableCell>{it.numero}</TableCell>
                      <TableCell>
                        <TextField
                          value={it.descripcion}
                          onChange={e => editarItem(idx, 'descripcion', e.target.value)}
                          size="small" fullWidth multiline minRows={1} maxRows={3}
                        />
                      </TableCell>
                      <TableCell>
                        <TextField
                          value={it.cantidad}
                          onChange={e => editarItem(idx, 'cantidad', parseFloat(e.target.value) || 1)}
                          size="small" type="number"
                          inputProps={{ min: 1, style: { textAlign: 'center', width: 55 } }}
                        />
                      </TableCell>
                      <TableCell>
                        <TextField
                          value={it.precioUnitario}
                          onChange={e => editarItem(idx, 'precioUnitario', parseInt(e.target.value) || 0)}
                          size="small" type="number"
                          inputProps={{ style: { textAlign: 'right', width: 100 } }}
                        />
                      </TableCell>
                      <TableCell align="right">
                        {fmt(it.cantidad * it.precioUnitario * (1 - (it.descuento || 0) / 100))}
                      </TableCell>
                      <TableCell>
                        <IconButton size="small" color="error" onClick={() =>
                          setItemsEdicion(prev => prev.filter((_, i) => i !== idx).map((x, i) => ({ ...x, numero: i + 1 })))
                        } disabled={itemsEdicion.length <= 1}>
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              <Box display="flex" justifyContent="flex-end" mt={2}>
                <Box textAlign="right">
                  {emitirFactura.tipoCodigo === 33 && (() => {
                    const neto = itemsEdicion.reduce((s, it) => s + it.cantidad * it.precioUnitario, 0);
                    const iva = Math.round(neto * 0.19);
                    const total = neto + iva;
                    return (
                      <>
                        <Typography variant="body2">Neto: {fmt(neto)}</Typography>
                        <Typography variant="body2">IVA (19%): {fmt(iva)}</Typography>
                        <Typography variant="subtitle1" fontWeight={600}>Total: {fmt(total)}</Typography>
                      </>
                    );
                  })()}
                  {emitirFactura.tipoCodigo !== 33 && (
                    <Typography variant="subtitle1" fontWeight={600}>
                      Total: {fmt(itemsEdicion.reduce((s, it) => s + it.cantidad * it.precioUnitario, 0))}
                    </Typography>
                  )}
                </Box>
              </Box>

              <FormControlLabel
                sx={{ mt: 1, alignItems: 'flex-start' }}
                control={
                  <Checkbox
                    checked={emitirDetenerEnPreview}
                    onChange={(_, c) => setEmitirDetenerEnPreview(c)}
                    disabled={emitiendo}
                  />
                }
                label={
                  <Box>
                    <Typography variant="body2">Detener en vista previa (no guardar ni firmar)</Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                      Para emitir en automático, configura{' '}
                      <code style={{ fontSize: '0.85em' }}>SII_FIRMA_CLAVE</code> en el <code style={{ fontSize: '0.85em' }}>.env</code>.
                      Para ver el browser:{' '}
                      <code style={{ fontSize: '0.85em' }}>SII_PLAYWRIGHT_HEADED=1</code>.
                    </Typography>
                  </Box>
                }
              />
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setEmitirFactura(null)} disabled={emitiendo}>Cancelar</Button>
              <Button
                variant="contained" color="success"
                onClick={() => emitirDetenerEnPreview ? emitir() : setConfirmarEmitir(true)}
                disabled={emitiendo || itemsEdicion.length === 0}
                startIcon={emitiendo ? <CircularProgress size={18} color="inherit" /> : <ReceiptIcon />}
              >
                {emitiendo ? (emitirDetenerEnPreview ? 'Enviando…' : 'Emitiendo...') : emitirDetenerEnPreview ? 'Ir a vista previa' : 'Emitir Factura'}
              </Button>
            </DialogActions>
          </>
        )}
      </Dialog>

      {/* Snackbar auto-sync */}
      <Snackbar
        open={snackbar.open}
        autoHideDuration={6000}
        onClose={() => setSnackbar(s => ({ ...s, open: false }))}
        message={snackbar.msg}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </Box>
  );
};

export default Billing;
