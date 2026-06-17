export function validateRut(rut: string): boolean {
  if (!rut || rut.length < 7) return false;
  try {
    const cleanRut = rut.replace(/\./g, '').replace(/-/g, '').trim().toLowerCase();
    const dv = cleanRut.charAt(cleanRut.length - 1);
    const rutBody = cleanRut.substring(0, cleanRut.length - 1);
    if (!/^\d+$/.test(rutBody)) return false;
    let sum = 0;
    let multiplier = 2;
    for (let i = rutBody.length - 1; i >= 0; i--) {
      sum += parseInt(rutBody.charAt(i), 10) * multiplier;
      multiplier = multiplier === 7 ? 2 : multiplier + 1;
    }
    const resto = sum % 11;
    const dvEsperado = resto === 0 ? '0' : resto === 1 ? 'k' : (11 - resto).toString();
    return dv.toLowerCase() === dvEsperado.toLowerCase();
  } catch {
    return false;
  }
}

export function formatRut(rut: string): string {
  if (!rut) return '';
  const cleanRut = rut.replace(/\./g, '').replace(/-/g, '').trim();
  const dv = cleanRut.charAt(cleanRut.length - 1);
  const rutBody = cleanRut.substring(0, cleanRut.length - 1);
  let formattedRut = '';
  for (let i = rutBody.length - 1, j = 0; i >= 0; i--, j++) {
    formattedRut = rutBody.charAt(i) + formattedRut;
    if (j === 2 && i !== 0) {
      formattedRut = '.' + formattedRut;
      j = -1;
    }
  }
  return `${formattedRut}-${dv}`;
}
