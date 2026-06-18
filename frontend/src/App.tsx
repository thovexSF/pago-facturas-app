import { Component, type ReactNode } from 'react';
import {
  ThemeProvider,
  CssBaseline,
  Box,
  Typography,
  Button,
} from '@mui/material';
import { biomaTheme } from './theme';
import BiomaFacturacion from './pages/BiomaFacturacion';

const EMPRESA_LABEL = 'Bioma Coffee · 78015129-3';

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <Box sx={{ p: 3, maxWidth: 720, mx: 'auto' }}>
          <Typography variant="h6" color="error" gutterBottom>
            Error al cargar la interfaz
          </Typography>
          <Typography
            variant="body2"
            component="pre"
            sx={{ whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: 12 }}
          >
            {this.state.error.message}
          </Typography>
          <Button sx={{ mt: 2 }} onClick={() => window.location.reload()} variant="contained">
            Recargar
          </Button>
        </Box>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <ThemeProvider theme={biomaTheme}>
      <CssBaseline />
      <ErrorBoundary>
        <Box sx={{ maxWidth: 1200, mx: 'auto', px: { xs: 2, sm: 2.5 }, py: 3 }}>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: 2,
              mb: 3,
              flexWrap: 'wrap',
            }}
          >
            <Box>
              <Typography variant="h5" sx={{ mb: 0.25 }}>
                Facturación
              </Typography>
              <Typography variant="caption">{EMPRESA_LABEL}</Typography>
            </Box>
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
              <Button
                href="/"
                variant="contained"
                size="small"
                sx={{
                  bgcolor: '#2b6cb0',
                  '&:hover': { bgcolor: '#2c5282' },
                }}
              >
                Facturas proveedores
              </Button>
            </Box>
          </Box>

          <BiomaFacturacion />
        </Box>
      </ErrorBoundary>
    </ThemeProvider>
  );
}
