import { Component, useState, type ReactNode } from 'react';
import { ThemeProvider, createTheme, CssBaseline, Box, Typography, Button, Tabs, Tab } from '@mui/material';
import Billing from './pages/Billing';
import BiomaFacturacion from './pages/BiomaFacturacion';

const theme = createTheme();

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
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
            Consola del navegador (F12) suele tener más detalle. Si acabas de actualizar el repo:{' '}
            <code style={{ fontSize: 'inherit' }}>rm -rf frontend/node_modules/.vite</code> y vuelve a ejecutar{' '}
            <code style={{ fontSize: 'inherit' }}>npm run dev</code>.
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
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <ErrorBoundary>
        <Box sx={{ borderBottom: 1, borderColor: 'divider', px: 2, display: 'flex', alignItems: 'center', gap: 2 }}>
          <Button href="/" size="small" sx={{ mr: 1 }}>🧾 Facturas por pagar</Button>
          <Tabs value={tab} onChange={handleTab} sx={{ flex: 1 }}>
            <Tab value="bioma" label="Facturación SII" />
            <Tab value="billing" label="SII Billing (avanzado)" />
          </Tabs>
        </Box>
        {tab === 'billing' ? <Billing /> : <BiomaFacturacion />}
      </ErrorBoundary>
    </ThemeProvider>
  );
}
