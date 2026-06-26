import { Component, useCallback, useState, type ReactNode } from 'react';
import {
  ThemeProvider,
  CssBaseline,
  Box,
  Typography,
  Button,
} from '@mui/material';
import { biomaTheme } from './theme';
import BiomaFacturacion from './pages/BiomaFacturacion';
import FacturacionModuleTabs from './components/FacturacionModuleTabs';
import { API_CONFIG } from './config/api';
import {
  getDefaultModule,
  resolveInitialModule,
  setDefaultModule,
  type FacturacionModule,
} from './utils/modulePreference';

const EMPRESA_LABEL = 'Bioma Coffee · 78015129-3';
const PROVEEDORES_EMBED_SRC = `${API_CONFIG.BASE_URL}/?embed=1`;

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

function FacturacionApp() {
  const [activeModule, setActiveModule] = useState<FacturacionModule>(resolveInitialModule);
  const [defaultModule, setDefaultModuleState] = useState<FacturacionModule>(getDefaultModule);

  const handleModuleChange = useCallback((mod: FacturacionModule) => {
    setActiveModule(mod);
    const url = new URL(window.location.href);
    if (mod === getDefaultModule()) {
      url.searchParams.delete('mod');
    } else {
      url.searchParams.set('mod', mod);
    }
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  }, []);

  const handleSetDefault = useCallback((mod: FacturacionModule) => {
    setDefaultModule(mod);
    setDefaultModuleState(mod);
  }, []);

  return (
    <Box sx={{ maxWidth: 1200, mx: 'auto', px: { xs: 2, sm: 2.5 }, py: 3 }}>
      <Box sx={{ mb: 0.5 }}>
        <Typography variant="h5" sx={{ mb: 0.25 }}>
          Facturación
        </Typography>
        <Typography variant="caption">{EMPRESA_LABEL}</Typography>
      </Box>

      <FacturacionModuleTabs
        value={activeModule}
        defaultModule={defaultModule}
        onChange={handleModuleChange}
        onSetDefault={handleSetDefault}
      />

      {activeModule === 'clientes' ? (
        <BiomaFacturacion />
      ) : (
        <Box
          component="iframe"
          title="Facturas por pagar — proveedores"
          src={PROVEEDORES_EMBED_SRC}
          sx={{
            display: 'block',
            width: '100%',
            minHeight: 'calc(100vh - 180px)',
            border: 'none',
            borderRadius: 1,
            bgcolor: 'background.paper',
          }}
        />
      )}
    </Box>
  );
}

export default function App() {
  return (
    <ThemeProvider theme={biomaTheme}>
      <CssBaseline />
      <ErrorBoundary>
        <FacturacionApp />
      </ErrorBoundary>
    </ThemeProvider>
  );
}
