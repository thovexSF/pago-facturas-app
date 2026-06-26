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
  FormControl,
  Checkbox,
  Alert,
  Select,
  MenuItem,
  FormControlLabel,
} from '@mui/material';
import CheckCircleOutlineIcon from '@mui/icons-material/esm/CheckCircleOutline.js';
import ErrorOutlineIcon from '@mui/icons-material/esm/ErrorOutline.js';
import DeleteOutlineIcon from '@mui/icons-material/esm/DeleteOutline.js';
import AddIcon from '@mui/icons-material/esm/Add.js';
import { formatRut } from '../utils/rutUtils';
import { normalizeDraftItems, computeTotalesFacturaPreview } from '../utils/facturaPreview';
import type { SiiEmitFormSnapshot } from '../utils/siiFormSnapshot';
import { compareSiiSnapshotWithPayload, fmtClp } from '../utils/siiFormSnapshot';
import {
  SII_EFXP_DSC_ITEM_MAX,
  SII_EFXP_NMB_MAX,
  SII_MIPYME_FIELDS,
  FORMA_PAGO_MIPYME_OPTIONS,
  formaPagoMipymeLabel,
  previewNombreEnSii,
  siiCharMeta,
  type FormaPagoMipyme,
} from '../utils/siiFormFields';

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
    tituloExtendido?: string;
    descripcionExtendida?: string;
    cantidad: number;
    precioUnitario: number;
    subtotal: number;
  }>;
  /** Activar checkbox «Descripción» extendida en MiPyme al rellenar/emitir. */
  useDescripcionExtendida?: boolean;
  formaPago?: FormaPagoMipyme;
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

  const lineasNombreLargo = payload.items.filter(
    (it) => siiCharMeta(it.descripcion, SII_EFXP_NMB_MAX).over,
  );

  const patch = (partial: Partial<FacturaEmitPreviewData>) => {
    onPayloadChange?.({ ...payload, ...partial });
  };

  const patchItem = (
    idx: number,
    field: 'descripcion' | 'descripcionExtendida' | 'cantidad' | 'precioUnitario',
    value: string,
  ) => {
    const next = payload.items.map((it, i) => {
      if (i !== idx) return it;
      if (field === 'descripcion') {
        return { ...it, descripcion: value };
      }
      if (field === 'descripcionExtendida') {
        return { ...it, descripcionExtendida: value };
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
            ? 'FORMULARIO MIPYME — Vista previa editable'
            : 'FORMULARIO MIPYME — Vista previa antes de emitir'}
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

        <Paper variant="outlined" sx={{ p: 1.5, mb: 2, bgcolor: '#fafafa', borderColor: '#bdbdbd' }}>
          <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" gap={1} sx={{ mb: 1 }}>
            <Typography variant="subtitle2" fontWeight={700}>
              Detalle de productos / servicios
            </Typography>
            {editable && (
              <FormControlLabel
                control={
                  <Checkbox
                    size="small"
                    checked={!!payload.useDescripcionExtendida}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      const items = payload.items.map((it) => ({
                        ...it,
                        descripcionExtendida: checked
                          ? (it.descripcionExtendida || it.tituloExtendido || '')
                          : undefined,
                      }));
                      patch({ useDescripcionExtendida: checked, items });
                    }}
                  />
                }
                label={
                  <Typography variant="body2">
                    Activar columna «Descripción extendida»
                  </Typography>
                }
              />
            )}
          </Stack>

          {lineasNombreLargo.length > 0 && (
            <Alert severity="warning" sx={{ mb: 1.5, py: 0.5 }}>
              {lineasNombreLargo.length === 1
                ? `La línea ${lineasNombreLargo[0].numero} supera ${SII_EFXP_NMB_MAX} caracteres en el nombre corto.`
                : `${lineasNombreLargo.length} líneas superan ${SII_EFXP_NMB_MAX} caracteres en el nombre corto.`}{' '}
              El SII guardará solo el nombre corto truncado; activa «Descripción extendida» para el detalle completo.
            </Alert>
          )}

          <TableContainer sx={{ border: '1px solid #e0e0e0', bgcolor: '#fff' }}>
            <Table size="small">
              <TableHead>
                <TableRow sx={{ bgcolor: '#eceff1' }}>
                  <TableCell sx={{ fontWeight: 700, width: 36 }}>#</TableCell>
                  <TableCell sx={{ fontWeight: 700, minWidth: 200 }}>
                    Nombre
                    <Typography variant="caption" display="block" color="text.secondary">
                      máx. {SII_EFXP_NMB_MAX} caracteres
                    </Typography>
                  </TableCell>
                  {payload.useDescripcionExtendida && (
                    <TableCell sx={{ fontWeight: 700, minWidth: 220 }}>
                      Descripción extendida
                      <Typography variant="caption" display="block" color="text.secondary">
                        opcional
                      </Typography>
                    </TableCell>
                  )}
                  <TableCell sx={{ fontWeight: 700 }} align="center" width={72}>
                    Cant.
                  </TableCell>
                  <TableCell sx={{ fontWeight: 700 }} align="right" width={100}>
                    P. unit.{esAfecta ? ' neto' : ''}
                  </TableCell>
                  <TableCell sx={{ fontWeight: 700 }} align="right" width={100}>
                    Subtotal
                  </TableCell>
                  {editable && <TableCell width={44} />}
                </TableRow>
              </TableHead>
              <TableBody>
                {payload.items.map((it, idx) => {
                  const lineSub = (it.cantidad || 0) * (it.precioUnitario || 0);
                  const nombreMeta = siiCharMeta(it.descripcion, SII_EFXP_NMB_MAX);
                  const nombreEnSii = previewNombreEnSii(it.descripcion);
                  const extText = it.descripcionExtendida ?? it.tituloExtendido ?? '';
                  const extMeta = siiCharMeta(extText, SII_EFXP_DSC_ITEM_MAX);
                  const snapLine = siiFormSnapshot?.lineas.find((l) => l.numero === it.numero);

                  return (
                    <TableRow key={it.numero} hover sx={{ verticalAlign: 'top' }}>
                      <TableCell>{it.numero}</TableCell>
                      <TableCell>
                        {editable ? (
                          <TextField
                            fullWidth
                            size="small"
                            multiline
                            minRows={2}
                            value={it.descripcion}
                            onChange={(e) => patchItem(idx, 'descripcion', e.target.value)}
                            error={nombreMeta.over}
                            helperText={
                              nombreMeta.over
                                ? `${nombreMeta.helper} → en SII: «${nombreEnSii}»`
                                : nombreMeta.helper
                            }
                            FormHelperTextProps={{ sx: { fontSize: 11 } }}
                          />
                        ) : (
                          <Box>
                            <Typography variant="body2" fontFamily="monospace" fontSize="0.85rem">
                              {nombreEnSii}
                            </Typography>
                            {nombreMeta.over && (
                              <Typography variant="caption" color="warning.main">
                                Original ({nombreMeta.length} car.): {it.descripcion}
                              </Typography>
                            )}
                          </Box>
                        )}
                        {snapLine && snapLine.nombre.toUpperCase() !== nombreEnSii.toUpperCase() && (
                          <Chip
                            size="small"
                            color="warning"
                            variant="outlined"
                            sx={{ mt: 0.5, fontSize: 10 }}
                            label={`SII tiene: ${snapLine.nombre}`}
                          />
                        )}
                      </TableCell>
                      {payload.useDescripcionExtendida && (
                        <TableCell>
                          {editable ? (
                            <TextField
                              fullWidth
                              size="small"
                              multiline
                              minRows={2}
                              value={extText}
                              onChange={(e) => patchItem(idx, 'descripcionExtendida', e.target.value)}
                              error={extMeta.over}
                              helperText={extMeta.helper}
                              FormHelperTextProps={{ sx: { fontSize: 11 } }}
                              placeholder="Detalle largo (checkbox Descripción en MiPyme)"
                            />
                          ) : (
                            <Typography variant="body2" fontSize="0.8rem" color="text.secondary">
                              {extText || '—'}
                            </Typography>
                          )}
                          {snapLine?.descripcionExtendida && (
                            <Typography variant="caption" display="block" color="text.secondary" sx={{ mt: 0.5 }}>
                              SII: {snapLine.descripcionExtendida.slice(0, 80)}
                              {snapLine.descripcionExtendida.length > 80 ? '…' : ''}
                            </Typography>
                          )}
                        </TableCell>
                      )}
                      <TableCell align="center">
                        {editable ? (
                          <TextField
                            size="small"
                            type="number"
                            inputProps={{ min: 1, style: { textAlign: 'center' } }}
                            value={it.cantidad}
                            onChange={(e) => patchItem(idx, 'cantidad', e.target.value)}
                            sx={{ width: 64 }}
                          />
                        ) : (
                          it.cantidad
                        )}
                      </TableCell>
                      <TableCell align="right">{fmt(it.precioUnitario)}</TableCell>
                      <TableCell align="right" sx={{ fontWeight: 600 }}>{fmt(lineSub)}</TableCell>
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
            <Button size="small" startIcon={<AddIcon />} onClick={addItem} sx={{ mt: 1 }}>
              Agregar línea
            </Button>
          )}
        </Paper>

        <Grid container spacing={2} alignItems="flex-start">
          <Grid item xs={12} md={5}>
            <Paper variant="outlined" sx={{ p: 1.5, bgcolor: '#fafafa' }}>
              <Typography variant="subtitle2" fontWeight={700} gutterBottom>
                Otros campos MiPyme
              </Typography>
              {editable ? (
                <FormControl fullWidth size="small" sx={{ mb: 1.5 }}>
                  <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.5 }}>
                    {SII_MIPYME_FIELDS.formaPago}
                  </Typography>
                  <Select
                    value={payload.formaPago ?? 'contado'}
                    onChange={(e) => patch({ formaPago: e.target.value as FormaPagoMipyme })}
                  >
                    {FORMA_PAGO_MIPYME_OPTIONS.map((opt) => (
                      <MenuItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              ) : (
                <MipymeField
                  label={SII_MIPYME_FIELDS.formaPago}
                  value={formaPagoMipymeLabel(payload.formaPago)}
                />
              )}
              <MipymeField label="Pedido Shopify" value={orderName} />
              {showDescuentoGlobal && (
                <MipymeField
                  label="Glosa descuento global"
                  value={payload.descuentoGlobal?.glosa || 'Descuento pedido'}
                />
              )}
            </Paper>
          </Grid>
          <Grid item xs={12} md={7}>
            <Paper variant="outlined" sx={{ p: 1.5, borderWidth: 2, borderColor: '#90a4ae', bgcolor: '#fff' }}>
              <Typography variant="subtitle2" fontWeight={700} gutterBottom>
                Totales
              </Typography>
              <MipymeField label={SII_MIPYME_FIELDS.subtotal} value={fmt(montoNeto)} mono />
              <MipymeField
                label={SII_MIPYME_FIELDS.descuentoGlobalPct}
                value={
                  showDescuentoGlobal
                    ? `${descuentoGlobalPct}%  (−${fmt(descuentoGlobalNeto)} neto)`
                    : '0 %'
                }
                highlight={showDescuentoGlobal}
                siiValue={
                  siiFormSnapshot
                    ? siiFormSnapshot.totales.descuentoGlobalPct > 0
                      ? `${siiFormSnapshot.totales.descuentoGlobalPct}%`
                      : siiFormSnapshot.totales.descuentoGlobalMonto > 0
                        ? fmtClp(siiFormSnapshot.totales.descuentoGlobalMonto)
                        : '0'
                    : undefined
                }
              />
              {esAfecta ? (
                <>
                  <MipymeField
                    label={SII_MIPYME_FIELDS.montoNeto}
                    value={fmt(totales.netoImponible)}
                    mono
                    siiValue={siiFormSnapshot ? fmtClp(siiFormSnapshot.totales.neto) : undefined}
                  />
                  <MipymeField
                    label={SII_MIPYME_FIELDS.iva}
                    value={fmt(iva)}
                    mono
                    siiValue={siiFormSnapshot ? fmtClp(siiFormSnapshot.totales.iva) : undefined}
                  />
                </>
              ) : (
                <MipymeField label="Monto exento" value={fmt(totales.netoImponible)} mono />
              )}
              <Divider sx={{ my: 1 }} />
              <MipymeField
                label={SII_MIPYME_FIELDS.total}
                value={fmt(total)}
                bold
                mono
                siiValue={siiFormSnapshot ? fmtClp(siiFormSnapshot.totales.total) : undefined}
              />
              {shopifyTotal != null && shopifyTotal > 0 && (
                <Box sx={{ mt: 1, pt: 1, borderTop: '1px dashed #ccc' }}>
                  <MipymeField
                    label="Total Shopify (referencia)"
                    value={fmt(shopifyTotal)}
                    warn={!montosValidacion?.ok}
                  />
                </Box>
              )}
            </Paper>
          </Grid>
        </Grid>
      </Box>

      {siiFormSnapshot && (
        <SiiSnapshotDiff
          snapshot={siiFormSnapshot}
          payload={payload}
          shopifyTotal={montosValidacion?.shopify.total ?? shopifyTotal ?? 0}
          descuentoGlobalPct={descuentoGlobalPct}
        />
      )}
    </Paper>
  );
}

function MipymeField({
  label,
  value,
  mono,
  bold,
  highlight,
  warn,
  siiValue,
}: {
  label: string;
  value: string;
  mono?: boolean;
  bold?: boolean;
  highlight?: boolean;
  warn?: boolean;
  siiValue?: string;
}) {
  return (
    <Box
      sx={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        gap: 2,
        py: 0.4,
        color: highlight ? 'success.dark' : warn ? 'error.main' : 'inherit',
      }}
    >
      <Typography variant="body2" color="text.secondary" sx={{ fontSize: '0.8rem' }}>
        {label}
      </Typography>
      <Box sx={{ textAlign: 'right' }}>
        <Typography
          variant="body2"
          fontWeight={bold ? 800 : 600}
          fontFamily={mono ? 'monospace' : undefined}
        >
          {value}
        </Typography>
        {siiValue != null && siiValue !== value && (
          <Typography variant="caption" color="warning.main">
            SII: {siiValue}
          </Typography>
        )}
      </Box>
    </Box>
  );
}

function SiiSnapshotDiff({
  snapshot,
  payload,
  shopifyTotal,
  descuentoGlobalPct,
}: {
  snapshot: SiiEmitFormSnapshot;
  payload: FacturaEmitPreviewData;
  shopifyTotal: number;
  descuentoGlobalPct: number;
}) {
  const issues = compareSiiSnapshotWithPayload(snapshot, {
    items: payload.items.map((it) => ({
      descripcion: previewNombreEnSii(it.descripcion),
      descripcionExtendida: payload.useDescripcionExtendida
        ? (it.descripcionExtendida || it.tituloExtendido)
        : undefined,
      cantidad: it.cantidad,
      precioUnitario: it.precioUnitario,
    })),
    shopifyTotal,
    descuentoGlobalPct,
    useDescripcionExtendida: payload.useDescripcionExtendida,
  });
  const allWarnings = [...snapshot.warnings, ...issues];
  const ok = allWarnings.length === 0;

  return (
    <Box sx={{ px: 2, pb: 2 }}>
      <Paper variant="outlined" sx={{ p: 1.5, bgcolor: ok ? '#f1f8e9' : '#fff8e1' }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
          {ok ? (
            <CheckCircleOutlineIcon color="success" fontSize="small" />
          ) : (
            <ErrorOutlineIcon color="warning" fontSize="small" />
          )}
          <Typography variant="subtitle2" fontWeight={700}>
            Lectura del formulario SII tras «Rellenar en MiPyme»
          </Typography>
          <Chip
            size="small"
            label={new Date(snapshot.capturedAt).toLocaleTimeString('es-CL')}
            variant="outlined"
            sx={{ ml: 'auto' }}
          />
        </Stack>
        {allWarnings.length > 0 ? (
          <Alert severity="warning" sx={{ mb: 0 }}>
            {allWarnings.map((w) => (
              <Box key={w} component="div">
                {w}
              </Box>
            ))}
          </Alert>
        ) : (
          <Alert severity="success">El formulario SII coincide con esta vista previa.</Alert>
        )}
      </Paper>
    </Box>
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
