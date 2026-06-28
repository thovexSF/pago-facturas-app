import { Component, useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  ThemeProvider,
  CssBaseline,
  Box,
  Typography,
  Button,
  Chip,
  Stack,
} from '@mui/material';
import { biomaTheme } from './theme';
import BiomaFacturacion from './pages/BiomaFacturacion';
import FacturacionModuleTabs from './components/FacturacionModuleTabs';
import { API_CONFIG } from './config/api';
import { formatSessionExpiresIn } from './hooks/useSiiSessionMonitor';
import {
  getDefaultModule,
  resolveInitialModule,
  setDefaultModule,
  type FacturacionModule,
} from './utils/modulePreference';

const EMPRESA_LABEL = 'Bioma Coffee · 78015129-3';

function proveedoresEmbedSrc(): string {
  const base = API_CONFIG.BASE_URL || window.location.origin;
  const url = new URL(base);
  url.pathname = '/';
  url.search = '';
  url.searchParams.set('embed', '1');
  const sid = localStorage.getItem('biomaSiiSessionId');
  if (sid) url.searchParams.set('siiSessionId', sid);
  return url.toString();
}

function ProveedoresEmbed() {
  const [src, setSrc] = useState(proveedoresEmbedSrc);

  useEffect(() => {
    setSrc(proveedoresEmbedSrc());
  }, []);

  return (
    <Box
      component="iframe"
      title="Facturas por pagar — proveedores"
      src={src}
      sx={{
        display: 'block',
        width: '100%',
        minHeight: 'calc(100vh - 180px)',
        border: 'none',
        borderRadius: 1,
        bgcolor: 'background.paper',
      }}
    />
  );
}

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

const SII_API = `${API_CONFIG.BASE_URL}/api/sii-facturacion`;

interface GlobalSiiStatus {
  sessionActive: boolean;
  expiresInMs: number;
  globalBusy: boolean;
  busyLabel: string | null;
}

function useGlobalSessionStatus() {
  const [status, setStatus] = useState<GlobalSiiStatus>({
    sessionActive: false,
    expiresInMs: 0,
    globalBusy: false,
    busyLabel: null,
  });

  useEffect(() => {
    let active = true;
    const check = async () => {
      try {
        const r = await fetch(`${SII_API}/shared/status`);
        const d = await r.json();
        if (active) {
          setStatus({
            sessionActive: !!d.clientesSessionActive,
            expiresInMs: d.expiresInMs ?? 0,
            globalBusy: !!d.globalBusy,
            busyLabel: d.busyLabel ?? null,
          });
        }
      } catch {
        if (active) setStatus((s) => ({ ...s, sessionActive: false }));
      }
    };
    check();
    const t = setInterval(check, 10_000);
    return () => { active = false; clearInterval(t); };
  }, []);

  return status;
}

function FacturacionApp() {
  const [activeModule, setActiveModule] = useState<FacturacionModule>(resolveInitialModule);
  const [defaultModule, setDefaultModuleState] = useState<FacturacionModule>(getDefaultModule);
  const [proveedoresKey, setProveedoresKey] = useState(0);
  const siiStatus = useGlobalSessionStatus();

  const handleModuleChange = useCallback((mod: FacturacionModule) => {
    setActiveModule(mod);
    if (mod === 'proveedores') setProveedoresKey((k) => k + 1);
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
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 0.5 }}>
        <Box>
          <Typography variant="h5" sx={{ mb: 0.25 }}>
            Facturación
          </Typography>
          <Typography variant="caption">{EMPRESA_LABEL}</Typography>
        </Box>
        <Chip
          size="small"
          label={
            siiStatus.globalBusy
              ? `⏳ ${siiStatus.busyLabel ?? 'SII ocupado'}`
              : siiStatus.sessionActive
                ? `Sesión SII · ${formatSessionExpiresIn(siiStatus.expiresInMs)}`
                : 'Sin sesión SII'
          }
          color={
            siiStatus.globalBusy ? 'warning'
              : siiStatus.sessionActive ? 'success'
                : 'default'
          }
          variant={siiStatus.sessionActive || siiStatus.globalBusy ? 'filled' : 'outlined'}
          sx={{ fontWeight: 500 }}
        />
      </Stack>

      <FacturacionModuleTabs
        value={activeModule}
        defaultModule={defaultModule}
        onChange={handleModuleChange}
        onSetDefault={handleSetDefault}
      />

      {activeModule === 'clientes' ? (
        <BiomaFacturacion />
      ) : (
        <ProveedoresEmbed key={proveedoresKey} />
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
