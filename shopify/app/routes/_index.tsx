import { useCallback, useEffect, useState } from 'react';
import {
  Page,
  Layout,
  Card,
  Button,
  Banner,
  Badge,
  TextField,
  BlockStack,
  InlineStack,
  Text,
  Divider,
  Frame,
  Toast,
  Collapsible,
  DataTable,
} from '@shopify/polaris';
import { BIOMA_API, SII_API } from '../lib/workbench';
import { formatRut, validateRut } from '../lib/rut';
import { formatSessionExpiresIn, isSiiSessionError, useSiiSessionMonitor } from '../hooks/useSiiSessionMonitor';

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
  items: Array<{
    numero: number;
    descripcion: string;
    cantidad: number;
    precioUnitario: number;
    subtotal: number;
  }>;
  template: {
    codigo: string | null;
    folio?: number | null;
    templateCliente?: string | null;
    source?: 'env' | 'cliente_emision' | 'cliente_sii' | 'nueva';
  };
}

const STEP_LABELS: Record<ScraperStep, string> = {
  abrir: '① Abrir formulario SII',
  rellenar: '② Rellenar con datos Shopify',
  emitir: '③ Emitir factura',
};

const fmt = (n: number) => `$${(n || 0).toLocaleString('es-CL')}`;

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

function statusBadge(status?: BiomaEmision['status']) {
  if (!status || status === 'pending') return <Badge tone="warning">Pendiente</Badge>;
  if (status === 'drafting') return <Badge tone="info">Borrador</Badge>;
  if (status === 'emitting') return <Badge tone="info">Emitiendo</Badge>;
  if (status === 'emitted') return <Badge tone="success">Emitida</Badge>;
  if (status === 'error') return <Badge tone="critical">Error</Badge>;
  return <Badge>{String(status)}</Badge>;
}

export default function FacturacionIndex() {
  const [empresaRut, setEmpresaRut] = useState(() =>
    typeof window !== 'undefined' ? localStorage.getItem('biomaEmpresaRut') || '' : '',
  );
  const [sessionId, setSessionId] = useState<string | null>(() =>
    typeof window !== 'undefined' ? localStorage.getItem('biomaSiiSessionId') : null,
  );
  const [configOpen, setConfigOpen] = useState(() =>
    typeof window !== 'undefined' ? !localStorage.getItem('biomaSiiSessionId') : true,
  );

  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<PendingRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [payload, setPayload] = useState<PayloadData | null>(null);
  const [payloadLoading, setPayloadLoading] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [lastAviso, setLastAviso] = useState<string | null>(null);
  const [busyOrderId, setBusyOrderId] = useState<string | null>(null);
  const [creatingSession, setCreatingSession] = useState(false);
  const [siiBlocked, setSiiBlocked] = useState<{
    blocked: boolean;
    reason?: string;
    retryAfterMinutes?: number;
    blockedUntil?: number;
  }>({ blocked: false });
  const [blockCountdown, setBlockCountdown] = useState('');

  const loadBlockStatus = useCallback(async () => {
    try {
      const res = await fetch(`${SII_API()}/block-status`);
      const data = await res.json();
      setSiiBlocked({
        blocked: !!data.blocked,
        reason: data.reason,
        retryAfterMinutes: data.retryAfterMinutes,
        blockedUntil: data.blockedUntil,
      });
    } catch {
      setSiiBlocked({ blocked: false });
    }
  }, []);

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
      const res = await fetch(`${BIOMA_API()}/pedidos-pendientes?pageSize=50`);
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      setRows(data.rows || []);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`Pedidos Shopify: ${msg}`);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadPayload = useCallback(async (orderId: string) => {
    setPayloadLoading(true);
    try {
      const res = await fetch(`${BIOMA_API()}/payload/${encodeURIComponent(orderId)}`);
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      setPayload(data.payload);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`Datos del pedido: ${msg}`);
      setPayload(null);
    } finally {
      setPayloadLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPending();
  }, [loadPending]);

  useEffect(() => {
    if (empresaRut && typeof window !== 'undefined' && !localStorage.getItem('biomaEmpresaRut')) {
      fetch(`${BIOMA_API()}/template-codigo`)
        .then((r) => r.json())
        .then((d) => {
          if (d.empresaRut) setEmpresaRut(d.empresaRut);
        })
        .catch(() => {});
    }
  }, [empresaRut]);

  const selectOrder = useCallback(
    (row: PendingRow) => {
      const id = row.shopify.id;
      setSelectedId((prev) => (prev === id ? null : id));
      setPayload(null);
      if (id) loadPayload(id);
    },
    [loadPayload],
  );

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
      const res = await fetch(`${SII_API()}/session/create`, {
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
      setToast('Sesión SII lista. Playwright se abre al usar el scraper.');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`Sesión SII: ${msg}`);
    } finally {
      setCreatingSession(false);
    }
  }, [empresaRut, siiBlocked]);

  const closeSession = useCallback(async () => {
    if (!sessionId) return;
    try {
      await fetch(`${SII_API()}/session/${sessionId}`, { method: 'DELETE' });
    } finally {
      setSessionId(null);
      localStorage.removeItem('biomaSiiSessionId');
      setConfigOpen(true);
    }
  }, [sessionId]);

  const handleSiiSessionInvalid = useCallback((reason?: string) => {
    setSessionId(null);
    localStorage.removeItem('biomaSiiSessionId');
    setConfigOpen(true);
    setError(reason || 'Sesión SII expirada. Vuelve a abrir sesión en Configuración.');
  }, []);

  const siiSession = useSiiSessionMonitor({
    siiApiBase: SII_API(),
    sessionId,
    onInvalid: handleSiiSessionInvalid,
  });

  const sessionReady = siiSession.sessionReady;

  const stopAllSii = useCallback(async () => {
    try {
      await fetch(`${SII_API()}/session/close-all`, { method: 'POST' });
      setSessionId(null);
      localStorage.removeItem('biomaSiiSessionId');
      setToast('Sesiones workbench cerradas');
      await loadBlockStatus();
    } catch {
      setError('No se pudieron cerrar las sesiones');
    }
  }, [loadBlockStatus]);

  const clearSiiBlock = useCallback(async () => {
    try {
      const res = await fetch(`${SII_API()}/block-status/clear`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setSiiBlocked({ blocked: false });
      setToast('Bloqueo workbench limpiado');
      await loadBlockStatus();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`Limpiar bloqueo: ${msg}`);
    }
  }, [loadBlockStatus]);

  const runScraperStep = useCallback(
    async (orderId: string, step: ScraperStep) => {
      if (siiBlocked.blocked) {
        setError(`SII en pausa ~${siiBlocked.retryAfterMinutes} min.`);
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
        const res = await fetch(`${BIOMA_API()}/scraper/${encodeURIComponent(orderId)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, step }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          const errMsg = data.error || data.result?.error || `HTTP ${res.status}`;
          if (isSiiSessionError(res.status, errMsg)) handleSiiSessionInvalid(errMsg);
          throw new Error(errMsg);
        }
        setToast(data.message || data.result?.aviso || `${STEP_LABELS[step]} — OK`);
        setLastAviso(data.message || data.result?.aviso || null);
        await loadPending();
        if (selectedId === orderId) await loadPayload(orderId);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(`${STEP_LABELS[step]}: ${msg}`);
        await loadBlockStatus();
      } finally {
        setBusyOrderId(null);
      }
    },
    [sessionReady, sessionId, payload, loadPending, loadPayload, selectedId, siiBlocked, loadBlockStatus, handleSiiSessionInvalid],
  );

  const pendingCount = rows.filter((r) => r.emision?.status !== 'emitted').length;

  const tableRows = rows.map((row) => {
    const attrs = Object.fromEntries(row.shopify.customAttributes.map((a) => [a.key, a.value]));
    const rut = attrs._rut_empresa || '';
    const razon = attrs._razon_social || '';
    const cliente = razon || row.shopify.shippingAddress?.name || '—';
    const isSelected = selectedId === row.shopify.id;
    const isBusy = busyOrderId === row.shopify.id;

    return [
      <Button variant="plain" onClick={() => selectOrder(row)}>
        {row.shopify.name}
      </Button>,
      new Date(row.shopify.processedAt).toLocaleDateString('es-CL'),
      <>
        <div>{cliente}</div>
        {rut ? <Text as="span" tone="subdued" variant="bodySm">{formatRut(rut)}</Text> : null}
      </>,
      fmt(row.shopify.total),
      statusBadge(row.emision?.status),
      isSelected ? (
        <BlockStack gap="400">
          {payloadLoading ? <Text as="p">Cargando preview…</Text> : null}
          {payload ? (
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">
                  Preview — datos que enviaremos al SII
                </Text>
                {payload.rutReceptor && !validateRut(payload.rutReceptor) ? (
                  <Banner tone="warning">
                    RUT receptor inválido ({formatRut(payload.rutReceptor)}). Corrígelo en Shopify.
                  </Banner>
                ) : null}
                <Text as="p" variant="bodySm">
                  <strong>RUT:</strong> {payload.rutReceptor ? formatRut(payload.rutReceptor) : '—'}
                </Text>
                <Text as="p" variant="bodySm">
                  <strong>Razón social:</strong> {payload.razonSocial || '—'}
                </Text>
                <Text as="p" variant="bodySm">
                  <strong>Giro:</strong> {payload.giroReceptor || '—'}
                </Text>
                <Text as="p" variant="bodySm">
                  <strong>Modo SII:</strong> {templateLabel(payload.template)}
                </Text>
                {payload.items.map((it) => (
                  <Text as="p" variant="bodySm" key={it.numero}>
                    · {it.cantidad}× {it.descripcion} — {fmt(it.precioUnitario)} neto
                  </Text>
                ))}
                <Button size="slim" onClick={() => loadPayload(row.shopify.id)}>
                  Actualizar preview
                </Button>
              </BlockStack>
            </Card>
          ) : null}

          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm">Checklist</Text>
              <Text as="p" variant="bodySm">{sessionReady ? '✅' : '⬜'} Sesión SII abierta</Text>
              <Text as="p" variant="bodySm">
                {templateReady(payload?.template) ? '✅' : '⬜'} Modo SII (copiar cliente o factura nueva)
              </Text>
              <Text as="p" variant="bodySm">
                {payload?.rutReceptor && payload?.razonSocial ? '✅' : '⬜'} RUT y razón social
              </Text>
              <Text as="p" variant="bodySm">{!siiBlocked.blocked ? '✅' : '⬜'} SII no bloqueado</Text>
            </BlockStack>
          </Card>

          <BlockStack gap="200">
            <Text as="h3" variant="headingSm">Facturación SII</Text>
            <Text as="p" tone="subdued" variant="bodySm">
              Recomendado: ② Rellenar → revisar Chrome → ③ Emitir.
            </Text>
            <InlineStack gap="200" wrap>
              {(Object.keys(STEP_LABELS) as ScraperStep[]).map((step) => (
                <Button
                  key={step}
                  variant={step === 'emitir' || step === 'rellenar' ? 'primary' : undefined}
                  tone={step === 'emitir' ? 'success' : undefined}
                  disabled={
                    isBusy ||
                    !sessionReady ||
                    siiBlocked.blocked ||
                    (step !== 'abrir' && !templateReady(payload?.template))
                  }
                  loading={isBusy}
                  onClick={() => runScraperStep(row.shopify.id, step)}
                >
                  {STEP_LABELS[step]}
                </Button>
              ))}
            </InlineStack>
          </BlockStack>

          {row.emision?.lastError ? (
            <Banner tone="warning">{row.emision.lastError}</Banner>
          ) : null}
        </BlockStack>
      ) : (
        <Text as="span" tone="subdued" variant="bodySm">Clic en el pedido para ver preview y facturar</Text>
      ),
    ];
  });

  return (
    <Frame>
      <Page
        title="Facturación SII"
        subtitle="Emisión de DTE en el SII — pedidos con tag factura (la app Facturación de pago los etiqueta)."
        primaryAction={{
          content: 'Refrescar pedidos',
          onAction: loadPending,
          loading,
        }}
      >
        <Layout>
          <Layout.Section>
            <InlineStack gap="200">
              <Badge tone={pendingCount ? 'warning' : undefined}>{`${pendingCount} pendientes`}</Badge>
            </InlineStack>
          </Layout.Section>

          {siiBlocked.blocked ? (
            <Layout.Section>
              <Banner tone="critical" title="El SII te bloqueó temporalmente">
                <BlockStack gap="200">
                  <Text as="p" variant="headingLg" fontWeight="bold">
                    {blockCountdown || 'calculando…'}
                  </Text>
                  <Text as="p">{siiBlocked.reason || 'Demasiados intentos'}</Text>
                  <InlineStack gap="200">
                    <Button onClick={stopAllSii}>Cerrar sesiones workbench</Button>
                    <Button onClick={clearSiiBlock}>Ya entré manual al SII</Button>
                  </InlineStack>
                </BlockStack>
              </Banner>
            </Layout.Section>
          ) : null}

          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Button
                  variant="plain"
                  onClick={() => setConfigOpen((v) => !v)}
                  textAlign="left"
                >
                  Configuración SII {sessionReady ? '· sesión activa' : '· requerida'}
                </Button>
                <Collapsible open={configOpen} id="sii-config">
                  <BlockStack gap="300">
                    <TextField
                      label="RUT emisor"
                      value={empresaRut}
                      onChange={setEmpresaRut}
                      placeholder="78015129-3"
                      autoComplete="off"
                    />
                    <InlineStack gap="200">
                      {sessionReady ? (
                        <>
                          <Badge tone={siiSession.expiresSoon ? 'warning' : 'success'}>
                            Sesión OK
                            {siiSession.status?.valid
                              ? ` · ${formatSessionExpiresIn(siiSession.status.expiresInMs)}`
                              : ''}
                          </Badge>
                          <Button onClick={closeSession}>Cerrar sesión</Button>
                        </>
                      ) : sessionId ? (
                        <>
                          <Badge tone="critical">Sesión inválida</Badge>
                          <Button
                            variant="primary"
                            onClick={createSession}
                            loading={creatingSession}
                            disabled={!empresaRut || siiBlocked.blocked}
                          >
                            Reabrir sesión SII
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="primary"
                          onClick={createSession}
                          loading={creatingSession}
                          disabled={!empresaRut || siiBlocked.blocked}
                        >
                          Abrir sesión SII
                        </Button>
                      )}
                    </InlineStack>
                  </BlockStack>
                </Collapsible>
              </BlockStack>
            </Card>
          </Layout.Section>

          {sessionId && siiSession.status && !siiSession.status.valid ? (
            <Layout.Section>
              <Banner tone="critical">
                Sesión SII no válida{siiSession.status.reason ? `: ${siiSession.status.reason}` : ''}. Abre sesión de nuevo en Configuración antes de usar el scraper.
              </Banner>
            </Layout.Section>
          ) : null}

          {siiSession.expiresSoon && siiSession.status?.valid ? (
            <Layout.Section>
              <Banner tone="warning">
                La sesión SII caduca en {formatSessionExpiresIn(siiSession.status.expiresInMs)}. Reabre sesión pronto para evitar fallos al emitir.
              </Banner>
            </Layout.Section>
          ) : null}

          {lastAviso && !error ? (
            <Layout.Section>
              <Banner tone="success" onDismiss={() => setLastAviso(null)}>
                {lastAviso}
              </Banner>
            </Layout.Section>
          ) : null}

          {error ? (
            <Layout.Section>
              <Banner tone="critical" onDismiss={() => setError(null)}>
                {error}
              </Banner>
            </Layout.Section>
          ) : null}

          <Layout.Section>
            <Card>
              {rows.length === 0 && !loading ? (
                <Text as="p" tone="subdued" alignment="center">
                  No hay pedidos con tag factura pendientes de emitir.
                </Text>
              ) : (
                <DataTable
                  columnContentTypes={['text', 'text', 'text', 'numeric', 'text', 'text']}
                  headings={['Pedido', 'Fecha', 'Cliente', 'Total', 'Estado', 'Acciones / Preview']}
                  rows={tableRows}
                />
              )}
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
      {toast ? <Toast content={toast} onDismiss={() => setToast(null)} /> : null}
    </Frame>
  );
}
