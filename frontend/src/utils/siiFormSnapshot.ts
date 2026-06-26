/** Tipos alineados con SiiEmitFormSnapshot del backend. */

export interface SiiEmitFormLineSnapshot {
  numero: number;
  nombre: string;
  descripcionExtendida: string;
  cantidad: number;
  precioUnitario: number;
  subtotal: number;
}

export interface SiiEmitFormTotalesSnapshot {
  subtotal: number;
  descuentoGlobalPct: number;
  descuentoGlobalMonto: number;
  neto: number;
  iva: number;
  total: number;
}

export interface SiiEmitFormSnapshot {
  capturedAt: string;
  lineas: SiiEmitFormLineSnapshot[];
  totales: SiiEmitFormTotalesSnapshot;
  descuentoGlobalPctField: string;
  warnings: string[];
}

export function fmtClp(n: number): string {
  return `$${Math.round(n || 0).toLocaleString('es-CL')}`;
}

export function compareSiiSnapshotWithPayload(
  snap: SiiEmitFormSnapshot,
  expected: {
    items: Array<{ descripcion: string; descripcionExtendida?: string; cantidad: number; precioUnitario: number }>;
    shopifyTotal: number;
    descuentoGlobalPct?: number;
    useDescripcionExtendida?: boolean;
  },
): string[] {
  const issues: string[] = [];
  const n = Math.min(snap.lineas.length, expected.items.length);
  for (let i = 0; i < n; i++) {
    const s = snap.lineas[i];
    const e = expected.items[i];
    if (s.nombre.toUpperCase() !== e.descripcion.toUpperCase()) {
      issues.push(
        `Línea ${i + 1}: nombre SII "${s.nombre}" ≠ esperado "${e.descripcion}"`,
      );
    }
    if (expected.useDescripcionExtendida && e.descripcionExtendida && !s.descripcionExtendida) {
      issues.push(`Línea ${i + 1}: falta descripción extendida en el SII`);
    }
    if (Math.abs(s.cantidad - e.cantidad) > 0.001) {
      issues.push(`Línea ${i + 1}: cantidad SII ${s.cantidad} ≠ ${e.cantidad}`);
    }
    if (Math.abs(s.precioUnitario - e.precioUnitario) > 2) {
      issues.push(
        `Línea ${i + 1}: precio SII ${fmtClp(s.precioUnitario)} ≠ ${fmtClp(e.precioUnitario)}`,
      );
    }
  }
  if (expected.descuentoGlobalPct && expected.descuentoGlobalPct > 0) {
    if (snap.totales.descuentoGlobalPct <= 0 && snap.totales.descuentoGlobalMonto <= 0) {
      issues.push('Descuento global no aplicado en el SII');
    }
  }
  if (expected.shopifyTotal > 0 && snap.totales.total > 0) {
    const diff = snap.totales.total - expected.shopifyTotal;
    if (Math.abs(diff) > 10) {
      issues.push(
        `Total SII ${fmtClp(snap.totales.total)} ≠ Shopify ${fmtClp(expected.shopifyTotal)} (dif. ${diff > 0 ? '+' : ''}${fmtClp(diff)})`,
      );
    }
  }
  return issues;
}
