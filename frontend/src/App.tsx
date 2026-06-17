import { Component, useState, type ReactNode } from 'react';
import {
  ThemeProvider,
  CssBaseline,
  Box,
  Typography,
  Button,
  Tabs,
  Tab,
} from '@mui/material';
import { biomaTheme } from './theme';
import Billing from './pages/Billing';
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
  const [tab, setTab] = useState<'billing' | 'bioma'>(() => {
    const saved = localStorage.getItem('workbenchTab');
    return saved === 'billing' ? 'billing' : 'bioma';
  });

  const handleTab = (_e: React.SyntheticEvent, value: 'billing' | 'bioma') => {
    setTab(value);
    localStorage.setItem('workbenchTab', value);
  };

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
                {tab === 'bioma' ? 'Facturación SII' : 'SII Billing'}
              </Typography>
              <Typography variant="caption">{EMPRESA_LABEL}</Typography>
            </Box>
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
              <Button
                href="/"
                variant="outlined"
                size="small"
                sx={{
                  borderColor: '#e2e8f0',
                  color: '#4a5568',
                  bgcolor: '#edf2f7',
                  '&:hover': { bgcolor: '#e2e8f0', borderColor: '#cbd5e0' },
                }}
              >
                🧾 Facturas por pagar
              </Button>
            </Box>
          </Box>

          <Tabs
            value={tab}
            onChange={handleTab}
            sx={{
              mb: 2.5,
              borderBottom: '2px solid #e2e8f0',
              minHeight: 44,
              '& .MuiTabs-flexContainer': { gap: 0.5 },
            }}
          >
            <Tab value="bioma" label="Pedidos Shopify" />
            <Tab value="billing" label="SII avanzado" />
          </Tabs>

          {tab === 'billing' ? <Billing /> : <BiomaFacturacion />}
        </Box>
      </ErrorBoundary>
    </ThemeProvider>
  );
}
