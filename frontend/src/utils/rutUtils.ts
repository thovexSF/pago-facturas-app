/**
 * Utility functions for working with Chilean RUT numbers
 */

/**
 * Validates a Chilean RUT number
 * @param rut The RUT to validate
 * @returns boolean indicating if the RUT is valid
 */
export const validateRut = (rut: string): boolean => {
  if (!rut || rut.length < 7) return false;
  
  try {
    // Limpiar el RUT de puntos y guiones
    const cleanRut = rut.replace(/\./g, '').replace(/-/g, '').trim().toLowerCase();
    
    // Extraer dígito verificador
    const dv = cleanRut.charAt(cleanRut.length - 1);
    
    // Extraer cuerpo del RUT (sin dígito verificador)
    const rutBody = cleanRut.substring(0, cleanRut.length - 1);
    
    // Si no es un número, no es válido
    if (!/^\d+$/.test(rutBody)) return false;
    
    // Calcular dígito verificador
    let sum = 0;
    let multiplier = 2;
    
    // Recorrer el RUT de derecha a izquierda
    for (let i = rutBody.length - 1; i >= 0; i--) {
      sum += parseInt(rutBody.charAt(i)) * multiplier;
      multiplier = multiplier === 7 ? 2 : multiplier + 1;
    }
    
    // Calcular dígito verificador esperado
    const resto = sum % 11;
    let dvEsperado = resto === 0 ? '0' : resto === 1 ? 'k' : (11 - resto).toString();
    
    // Comparar dígito verificador calculado con el ingresado (ambos en minúsculas)
    return dv.toLowerCase() === dvEsperado.toLowerCase();
  } catch (error) {
    console.error("Error validando RUT:", error);
    return false;
  }
};

/**
 * Formats a RUT with dots and dash
 * @param rut The RUT to format
 * @returns formatted RUT string
 */
export const formatRut = (rut: string): string => {
  if (!rut) return '';
  
  // Limpiar RUT de puntos y guiones
  let cleanRut = rut.replace(/\./g, '').replace(/-/g, '').trim();
  
  // Extraer el dígito verificador
  const dv = cleanRut.charAt(cleanRut.length - 1);
  const rutBody = cleanRut.substring(0, cleanRut.length - 1);
  
  // Formatear con puntos y guión
  let formattedRut = '';
  for (let i = rutBody.length - 1, j = 0; i >= 0; i--, j++) {
    formattedRut = rutBody.charAt(i) + formattedRut;
    if (j === 2 && i !== 0) {
      formattedRut = '.' + formattedRut;
      j = -1;
    }
  }
  
  return formattedRut + '-' + dv;
}; 