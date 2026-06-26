export type FacturacionModule = 'clientes' | 'proveedores';

const STORAGE_KEY = 'biomaFacturacionDefaultModule';

export function getDefaultModule(): FacturacionModule {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === 'proveedores' ? 'proveedores' : 'clientes';
  } catch {
    return 'clientes';
  }
}

export function setDefaultModule(mod: FacturacionModule): void {
  try {
    localStorage.setItem(STORAGE_KEY, mod);
  } catch {
    /* ignore */
  }
}

export function resolveInitialModule(): FacturacionModule {
  try {
    const params = new URLSearchParams(window.location.search);
    const mod = params.get('mod');
    if (mod === 'clientes' || mod === 'proveedores') return mod;
  } catch {
    /* ignore */
  }
  return getDefaultModule();
}
