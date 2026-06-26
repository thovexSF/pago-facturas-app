import {
  Box,
  Button,
  Chip,
  Divider,
  Grid,
  IconButton,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import CheckCircleOutlineIcon from '@mui/icons-material/esm/CheckCircleOutline.js';
import ErrorOutlineIcon from '@mui/icons-material/esm/ErrorOutline.js';
import DeleteOutlineIcon from '@mui/icons-material/esm/DeleteOutline.js';
import AddIcon from '@mui/icons-material/esm/Add.js';
import { formatRut } from '../utils/rutUtils';
import { normalizeDraftItems, computeTotalesFacturaPreview } from '../utils/facturaPreview';
import type { SiiEmitFormSnapshot } from '../utils/siiFormSnapshot';
import SiiFormReadback from './SiiFormReadback';

export interface FacturaEmitPreviewData {
  rutReceptor: string | null;
  razonSocial: string | null;
  giroReceptor: string | null;
  comunaReceptor?: string | null;
  ciudadReceptor?: string | null;
  dirReceptor?: string | null;
  fechaEmision?: string;
  tipoCodigo?: number;
  descuentoGlobal?: {
    montoNeto: number;
    porcentaje: number;
    glosa: string;
  } | null;
  items: Array<{
    numero: number;
    descripcion: string;
    descripcionExtendida?: string;
    cantidad: number;
    precioUnitario: number;
    subtotal: number;
  }>;
}

export interface MontosValidacionPreview {
  ok: boolean;
  diff: number;
  shopify: {
    total: number;
    shipping: number;
    totalDiscounts: number;
    lineDiscounts: number;
  };
  factura: {
    neto: number;
    iva: number;
    total: number;
    subtotalLineas?: number;
    descuentoGlobalNeto?: number;
    descuentoGlobalPct?: number;
  };
  issues: string[];
}

export interface FacturaEmitPreviewProps {
  empresaRut: string;
  empresaRazon?: string;
  orderName: string;
  customerName?: string | null;
  payload: FacturaEmitPreviewData;
  montosValidacion?: MontosValidacionPreview;
  rutInvalido?: boolean;
  editable?: boolean;
  draftDirty?: boolean;
  onPayloadChange?: (payload: FacturaEmitPreviewData) => void;
  onResetDraft?: () => void;
  /** Lectura real del formulario MiPyme tras «Rellenar en SII». */
  siiFormSnapshot?: SiiEmitFormSnapshot | null;
}

const fmt = (n: number) =>
  `$${Math.round(n || 0).toLocaleString('es-CL', { maximumFractionDigits: 0 })}`;

function formatFecha(iso?: string): string {
  if (!iso) return new Date().toLocaleDateString('es-CL');
  const d = new Date(iso.includes('T') ? iso : `${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('es-CL');
}

function tipoDocumentoLabel(tipo?: number): string {
  if (tipo === 34) return 'FACTURA NO AFECTA O EXENTA ELECTRÓNICA';
  if (tipo === 61) return 'NOTA DE CRÉDITO ELECTRÓNICA';
  return 'FACTURA ELECTRÓNICA';
}

export default function FacturaEmitPreview({
  empresaRut,
  empresaRazon = 'BIOMA COFFEE',
  orderName,
  customerName,
  payload,
  montosValidacion,
  rutInvalido,
  editable,
  draftDirty,
  onPayloadChange,
  onResetDraft,
  siiFormSnapshot,
}: FacturaEmitPreviewProps) {
  const tipo = payload.tipoCodigo ?? 33;
  const esAfecta = tipo === 33;

  const totales = computeTotalesFacturaPreview(payload.items, {
    shopifyTotal: montosValidacion?.shopify.total ?? 0,
    totalDiscounts: montosValidacion?.shopify.totalDiscounts,
    descuentoGlobal: payload.descuentoGlobal,
    tipoCodigo: tipo,
  });

  const montoNeto = totales.montoNeto;
  const descuentoGlobalNeto = totales.descuentoGlobalNeto;
  const descuentoGlobalPct = totales.descuentoGlobalPct;
  const iva = totales.iva;
  const total = totales.total;
  const showDescuentoGlobal = totales.showDescuentoGlobal;
  const shopifyTotal = montosValidacion?.shopify.total;

  const receptorNombre = payload.razonSocial || customerName || '—';
  const receptorRut = payload.rutReceptor ? formatRut(payload.rutReceptor) : '—';

  const patch = (partial: Partial<FacturaEmitPreviewData>) => {
    onPayloadChange?.({ ...payload, ...partial });
  };

  const patchItem = (idx: number, field: 'descripcion' | 'cantidad' | 'precioUnitario', value: string) => {
    const next = payload.items.map((it, i) => {
      if (i !== idx) return it;
      if (field === 'descripcion') {
        return { ...it, descripcion: value };
      }
      const n = Math.max(field === 'cantidad' ? 1 : 1, Math.round(Number(value) || 0));
      const precio = field === 'precioUnitario' ? n : it.precioUnitario;
      const cantidad = field === 'cantidad' ? n : it.cantidad;
      return {
        ...it,
        cantidad,
        precioUnitario: precio,
        subtotal: cantidad * precio,
      };
    });
    onPayloadChange?.({ ...payload, items: normalizeDraftItems(next) });
  };

  const addItem = () => {
    const next = [
      ...payload.items,
      {
        numero: payload.items.length + 1,
        descripcion: '',
        cantidad: 1,
        precioUnitario: 1,
        subtotal: 1,
      },
    ];
    onPayloadChange?.({ ...payload, items: normalizeDraftItems(next) });
  };

  const removeItem = (idx: number) => {
    if (payload.items.length <= 1) return;
    const next = payload.items.filter((_, i) => i !== idx);
    onPayloadChange?.({ ...payload, items: normalizeDraftItems(next) });
  };

  return (
    <Paper
      elevation={0}
      sx={{
        border: '1px solid #bdbdbd',
        bgcolor: '#fff',
        overflow: 'hidden',
        fontFamily: '"Helvetica Neue", Helvetica, Arial, sans-serif',
      }}
    >
      <Box
        sx={{
          px: 2,
          py: 0.75,
          bgcolor: editable ? '#e3f2fd' : '#fff8e1',
          borderBottom: editable ? '1px solid #90caf9' : '1px solid #ffe082',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 1,
          flexWrap: 'wrap',
        }}
      >
        <Typography
          variant="caption"
          sx={{
            fontWeight: 700,
            letterSpacing: 0.5,
            color: editable ? '#1565c0' : '#f57c00',
          }}
        >
          {editable
            ? 'VISTA PREVIA EDITABLE — Los cambios se envían al SII al emitir'
            : 'VISTA PREVIA — Documento no emitido en el SII'}
        </Typography>
        <Stack direction="row" spacing={1} alignItems="center">
          {draftDirty && editable && (
            <Chip label="Borrador guardado" size="small" color="info" variant="outlined" />
          )}
          {editable && onResetDraft && (
            <Button size="small" variant="text" onClick={onResetDraft}>
              Restaurar Shopify
            </Button>
          )}
          <StackChip montos={montosValidacion} orderName={orderName} />
        </Stack>
      </Box>

      <Box sx={{ p: 2.5 }}>
        <Grid container spacing={2} sx={{ mb: 2 }}>
          <Grid item xs={12} md={7}>
            <Typography variant="overline" sx={{ color: 'text.secondary', fontWeight: 700, letterSpacing: 1 }}>
              Emisor
            </Typography>
            <Typography sx={{ fontWeight: 700, fontSize: '1.15rem', mt: 0.5 }}>{empresaRazon}</Typography>
            <Typography variant="body2" sx={{ mt: 0.5 }}>
              R.U.T. {empresaRut ? formatRut(empresaRut) : '—'}
            </Typography>
          </Grid>

          <Grid item xs={12} md={5}>
            <Paper
              elevation={0}
              sx={{ border: '2.5px solid #c62828', bgcolor: '#ffebee', p: 1.75, textAlign: 'center' }}
            >
              <Typography sx={{ fontWeight: 700, fontSize: '0.95rem', color: '#b71c1c' }}>
                R.U.T. {empresaRut ? formatRut(empresaRut) : '—'}
              </Typography>
              <Typography sx={{ fontWeight: 800, fontSize: '0.8rem', color: '#c62828', mt: 0.5, lineHeight: 1.3 }}>
                {tipoDocumentoLabel(tipo)}
              </Typography>
              <Typography sx={{ fontWeight: 700, fontSize: '1.1rem', color: '#b71c1c', mt: 0.75 }}>
                N°{' '}
                <Box component="span" sx={{ fontStyle: 'italic', fontWeight: 500, color: 'text.secondary' }}>
                  por asignar
                </Box>
              </Typography>
              <Divider sx={{ my: 1, borderColor: '#ef9a9a' }} />
              <Typography variant="body2" sx={{ fontWeight: 600, color: '#b71c1c' }}>
                Fecha emisión
              </Typography>
              {editable ? (
                <TextField
                  type="date"
                  size="small"
                  value={payload.fechaEmision || ''}
                  onChange={(e) => patch({ fechaEmision: e.target.value })}
                  sx={{ mt: 0.5, bgcolor: '#fff', maxWidth: 180 }}
                  inputProps={{ style: { textAlign: 'center' } }}
                />
              ) : (
                <Typography variant="body2">{formatFecha(payload.fechaEmision)}</Typography>
              )}
            </Paper>
          </Grid>
        </Grid>

        <Paper variant="outlined" sx={{ p: 1.75, mb: 2, borderWidth: 2, borderColor: '#e0e0e0' }}>
          <Typography variant="subtitle2" fontWeight={700} gutterBottom>
            Señor(es)
          </Typography>
          <Grid container spacing={1.5}>
            <Grid item xs={12} sm={7}>
              <Typography variant="caption" color="text.secondary" display="block">
                Razón social
              </Typography>
              {editable ? (
                <TextField
                  fullWidth
                  size="small"
                  value={payload.razonSocial || ''}
                  onChange={(e) => patch({ razonSocial: e.target.value })}
                />
              ) : (
                <Typography variant="body2" fontWeight={600}>{receptorNombre}</Typography>
              )}
            </Grid>
            <Grid item xs={12} sm={5}>
              <Typography variant="caption" color="text.secondary" display="block">
                R.U.T.
              </Typography>
              {editable ? (
                <TextField
                  fullWidth
                  size="small"
                  value={payload.rutReceptor || ''}
                  onChange={(e) => patch({ rutReceptor: e.target.value })}
                  error={rutInvalido}
                  placeholder="12345678-9"
                />
              ) : (
                <Typography variant="body2" fontWeight={600} sx={rutInvalido ? { color: 'error.main' } : undefined}>
                  {receptorRut}
                </Typography>
              )}
            </Grid>
            <Grid item xs={12} sm={6}>
              <Typography variant="caption" color="text.secondary" display="block">Giro</Typography>
              {editable ? (
                <TextField
                  fullWidth
                  size="small"
                  value={payload.giroReceptor || ''}
                  onChange={(e) => patch({ giroReceptor: e.target.value })}
                />
              ) : (
                <Typography variant="body2">{payload.giroReceptor || '—'}</Typography>
              )}
            </Grid>
            <Grid item xs={12} sm={6}>
              <Typography variant="caption" color="text.secondary" display="block">Dirección</Typography>
              {editable ? (
                <TextField
                  fullWidth
                  size="small"
                  value={payload.dirReceptor || ''}
                  onChange={(e) => patch({ dirReceptor: e.target.value })}
                />
              ) : (
                <Typography variant="body2">{payload.dirReceptor || '—'}</Typography>
              )}
            </Grid>
            <Grid item xs={6} sm={3}>
              <Typography variant="caption" color="text.secondary" display="block">Comuna</Typography>
              {editable ? (
                <TextField
                  fullWidth
                  size="small"
                  value={payload.comunaReceptor || ''}
                  onChange={(e) => patch({ comunaReceptor: e.target.value })}
                />
              ) : (
                <Typography variant="body2">{payload.comunaReceptor || '—'}</Typography>
              )}
            </Grid>
            <Grid item xs={6} sm={3}>
              <Typography variant="caption" color="text.secondary" display="block">Ciudad</Typography>
              {editable ? (
                <TextField
                  fullWidth
                  size="small"
                  value={payload.ciudadReceptor || ''}
                  onChange={(e) => patch({ ciudadReceptor: e.target.value })}
                />
              ) : (
                <Typography variant="body2">{payload.ciudadReceptor || '—'}</Typography>
              )}
            </Grid>
          </Grid>
        </Paper>

        <TableContainer sx={{ mb: 1, border: '1px solid #e0e0e0' }}>
          <Table size="small">
            <TableHead>
              <TableRow sx={{ bgcolor: '#f5f5f5' }}>
                <TableCell sx={{ fontWeight: 700, width: 40 }}>#</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>Descripción</TableCell>
                <TableCell sx={{ fontWeight: 700 }} align="center" width={editable ? 88 : 72}>
                  Cant.
                </TableCell>
                <TableCell sx={{ fontWeight: 700 }} align="right" width={editable ? 120 : 100}>
                  P. unit.{esAfecta ? ' neto' : ''}
                </TableCell>
                <TableCell sx={{ fontWeight: 700 }} align="right" width={110}>
                  Total{esAfecta ? ' neto' : ''}
                </TableCell>
                {editable && <TableCell width={44} />}
              </TableRow>
            </TableHead>
            <TableBody>
              {payload.items.map((it, idx) => {
                const lineSub = (it.cantidad || 0) * (it.precioUnitario || 0);
                return (
                  <TableRow key={it.numero} hover>
                    <TableCell>{it.numero}</TableCell>
                    <TableCell sx={{ whiteSpace: 'normal', wordBreak: 'break-word' }}>
                      {editable ? (
                        <TextField
                          fullWidth
                          size="small"
                          multiline
                          minRows={1}
                          value={it.descripcion}
                          onChange={(e) => patchItem(idx, 'descripcion', e.target.value)}
                        />
                      ) : (
                        <Box>
                          <Typography variant="body2">{it.descripcion}</Typography>
                          {it.descripcionExtendida && (
                            <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
                              + detalle SII: {it.descripcionExtendida.slice(0, 120)}
                              {it.descripcionExtendida.length > 120 ? '…' : ''}
                            </Typography>
                          )}
                        </Box>
                      )}
                    </TableCell>
                    <TableCell align="center">
                      {editable ? (
                        <TextField
                          size="small"
                          type="number"
                          inputProps={{ min: 1, style: { textAlign: 'center' } }}
                          value={it.cantidad}
                          onChange={(e) => patchItem(idx, 'cantidad', e.target.value)}
                          sx={{ width: 72 }}
                        />
                      ) : (
                        it.cantidad
                      )}
                    </TableCell>
                    <TableCell align="right">
                      {fmt(it.precioUnitario)}
                    </TableCell>
                    <TableCell align="right" sx={{ fontWeight: 600 }}>
                      {fmt(lineSub)}
                    </TableCell>
                    {editable && (
                      <TableCell padding="checkbox">
                        <IconButton
                          size="small"
                          color="error"
                          disabled={payload.items.length <= 1}
                          onClick={() => removeItem(idx)}
                          aria-label="Quitar línea"
                        >
                          <DeleteOutlineIcon fontSize="small" />
                        </IconButton>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>

        {editable && (
          <Button size="small" startIcon={<AddIcon />} onClick={addItem} sx={{ mb: 2 }}>
            Agregar línea
          </Button>
        )}

        <Grid container spacing={2} alignItems="flex-start">
          <Grid item xs={12} md={6}>
            <Typography variant="caption" color="text.secondary" display="block">Forma de pago</Typography>
            <Typography variant="body2" fontWeight={500}>Contado</Typography>
            <Typography variant="caption" color="text.secondary" sx={{ mt: 1.5, display: 'block' }}>
              Pedido Shopify: <strong>{orderName}</strong>
            </Typography>
            {montosValidacion && montosValidacion.shopify.totalDiscounts > 0 && (
              <Typography variant="caption" color="warning.dark" sx={{ mt: 0.5, display: 'block' }}>
                Descuento Shopify: {fmt(montosValidacion.shopify.totalDiscounts)}
              </Typography>
            )}
          </Grid>
          <Grid item xs={12} md={6}>
            <Paper variant="outlined" sx={{ p: 1.75, borderWidth: 2, maxWidth: 320, ml: { md: 'auto' }, bgcolor: '#fafafa' }}>
              <Typography variant="subtitle2" fontWeight={700} gutterBottom>Totales</Typography>
              {esAfecta ? (
                <>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                    <Typography variant="body2">Monto neto</Typography>
                    <Typography variant="body2">{fmt(montoNeto)}</Typography>
                  </Box>
                  {showDescuentoGlobal && (
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                      <Typography variant="body2" color="success.dark">
                        Descuento global{descuentoGlobalPct > 0 ? ` (${descuentoGlobalPct}%)` : ''}
                      </Typography>
                      <Typography variant="body2" color="success.dark">
                        −{fmt(descuentoGlobalNeto)}
                      </Typography>
                    </Box>
                  )}
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                    <Typography variant="body2">I.V.A. 19%</Typography>
                    <Typography variant="body2">{fmt(iva)}</Typography>
                  </Box>
                </>
              ) : (
                <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                  <Typography variant="body2">Monto exento</Typography>
                  <Typography variant="body2">{fmt(totales.netoImponible)}</Typography>
                </Box>
              )}
              <Divider sx={{ my: 1 }} />
              <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                <Typography variant="subtitle1" fontWeight={800}>Total factura</Typography>
                <Typography variant="subtitle1" fontWeight={800}>{fmt(total)}</Typography>
              </Box>
              {shopifyTotal != null && shopifyTotal > 0 && (
                <Box
                  sx={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    mt: 1,
                    pt: 1,
                    borderTop: '1px dashed #ccc',
                  }}
                >
                  <Typography variant="body2" color="text.secondary">Total Shopify</Typography>
                  <Typography
                    variant="body2"
                    fontWeight={700}
                    color={montosValidacion?.ok ? 'success.main' : 'error.main'}
                  >
                    {fmt(shopifyTotal)}
                  </Typography>
                </Box>
              )}
            </Paper>
          </Grid>
        </Grid>
      </Box>

      {siiFormSnapshot && (
        <SiiFormReadback
          snapshot={siiFormSnapshot}
          expectedItems={payload.items.map((it) => ({
            descripcion: it.descripcion,
            descripcionExtendida: it.descripcionExtendida,
            cantidad: it.cantidad,
            precioUnitario: it.precioUnitario,
          }))}
          shopifyTotal={montosValidacion?.shopify.total ?? shopifyTotal ?? 0}
          descuentoGlobalPct={descuentoGlobalPct}
          capturedLabel={new Date(siiFormSnapshot.capturedAt).toLocaleTimeString('es-CL')}
        />
      )}
    </Paper>
  );
}

function StackChip({
  montos,
  orderName,
}: {
  montos?: MontosValidacionPreview;
  orderName: string;
}) {
  if (montos?.ok) {
    return (
      <Chip
        icon={<CheckCircleOutlineIcon />}
        label="Cuadra con Shopify"
        size="small"
        color="success"
        variant="outlined"
      />
    );
  }
  if (montos && !montos.ok) {
    return (
      <Chip
        icon={<ErrorOutlineIcon />}
        label={`Dif. ${montos.diff > 0 ? '+' : ''}${fmt(montos.diff)}`}
        size="small"
        color="error"
        variant="outlined"
      />
    );
  }
  return <Chip label={orderName} size="small" variant="outlined" />;
}
