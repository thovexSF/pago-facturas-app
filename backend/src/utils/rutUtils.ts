/** Separa RUT chileno en cuerpo y dígito verificador. */
export function splitRutDv(raw: string): { rut: string; dv: string } | null {
  const clean = raw.replace(/\./g, '').replace(/\s/g, '').toUpperCase();
  const m = clean.match(/^(\d{1,8})-([\dkK])$/);
  if (!m) return null;
  return { rut: m[1], dv: m[2].toUpperCase() };
}

export function normalizeRutKey(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw.replace(/\./g, '').replace(/-/g, '').replace(/\s/g, '').toLowerCase();
}
