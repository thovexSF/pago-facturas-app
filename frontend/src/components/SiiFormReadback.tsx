import {
  Alert,
  Box,
  Chip,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import CheckCircleOutlineIcon from '@mui/icons-material/esm/CheckCircleOutline.js';
import ErrorOutlineIcon from '@mui/icons-material/esm/ErrorOutline.js';
import type { SiiEmitFormSnapshot } from '../utils/siiFormSnapshot';
import { compareSiiSnapshotWithPayload, fmtClp } from '../utils/siiFormSnapshot';

type Props = {
  snapshot: SiiEmitFormSnapshot;
  expectedItems: Array<{
    descripcion: string;
    descripcionExtendida?: string;
    cantidad: number;
    precioUnitario: number;
  }>;
  shopifyTotal: number;
  descuentoGlobalPct?: number;
  capturedLabel?: string;
  useDescripcionExtendida?: boolean;
};

export default function SiiFormReadback({
  snapshot,
  expectedItems,
  shopifyTotal,
  descuentoGlobalPct,
  capturedLabel,
  useDescripcionExtendida,
}: Props) {
  const compareIssues = compareSiiSnapshotWithPayload(snapshot, {
    items: expectedItems,
    shopifyTotal,
    descuentoGlobalPct,
    useDescripcionExtendida,
  });
  const allWarnings = [...snapshot.warnings, ...compareIssues];
  const ok = allWarnings.length === 0;

  return (
    <Paper variant="outlined" sx={{ p: 2, mt: 2, bgcolor: ok ? '#f1f8e9' : '#fff8e1' }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5 }}>
        {ok ? (
          <CheckCircleOutlineIcon color="success" fontSize="small" />
        ) : (
          <ErrorOutlineIcon color="warning" fontSize="small" />
        )}
        <Typography variant="subtitle2" fontWeight={700}>
          Lo que quedó en el formulario SII
        </Typography>
        {capturedLabel && (
          <Chip size="small" label={capturedLabel} variant="outlined" sx={{ ml: 'auto' }} />
        )}
      </Stack>

      {allWarnings.length > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {allWarnings.map((w) => (
            <Box key={w} component="div">
              {w}
            </Box>
          ))}
        </Alert>
      )}

      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>#</TableCell>
              <TableCell>Nombre</TableCell>
              <TableCell>Descripción extendida</TableCell>
              <TableCell align="right">Cant.</TableCell>
              <TableCell align="right">P. unit.</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {snapshot.lineas.map((ln) => (
              <TableRow key={ln.numero}>
                <TableCell>{ln.numero}</TableCell>
                <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{ln.nombre || '—'}</TableCell>
                <TableCell sx={{ fontSize: '0.75rem', color: 'text.secondary', maxWidth: 280 }}>
                  {ln.descripcionExtendida || '—'}
                </TableCell>
                <TableCell align="right">{ln.cantidad}</TableCell>
                <TableCell align="right">{fmtClp(ln.precioUnitario)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      <Box sx={{ mt: 2, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 1 }}>
        <Typography variant="body2">
          <strong>Sub total:</strong> {fmtClp(snapshot.totales.subtotal)}
        </Typography>
        <Typography variant="body2">
          <strong>Dcto global:</strong>{' '}
          {snapshot.totales.descuentoGlobalPct > 0
            ? `${snapshot.totales.descuentoGlobalPct}%`
            : snapshot.totales.descuentoGlobalMonto > 0
              ? fmtClp(snapshot.totales.descuentoGlobalMonto)
              : '0'}
        </Typography>
        <Typography variant="body2">
          <strong>Neto:</strong> {fmtClp(snapshot.totales.neto)}
        </Typography>
        <Typography variant="body2">
          <strong>IVA:</strong> {fmtClp(snapshot.totales.iva)}
        </Typography>
        <Typography variant="body2">
          <strong>Total:</strong> {fmtClp(snapshot.totales.total)}
        </Typography>
      </Box>
    </Paper>
  );
}
