const texto = `ARABICA SPA
 Giro: IMPORTACION, DISTRIBUCION Y VENTA
DE CAFÉ E INFUSIONES
H DE AGUIRRE 162 OF 304- PROVIDENCIA
eMail : jnhaddad@uc.cl Telefono : 950113181
 TIPO DE VENTA: DEL GIRO
SEÑOR(ES):BIOMA COFFEE ROASTERS SPA
R.U.T.:78.015.129- 3
GIRO:VENTA AL POR MENOR POR CORREO, POR I
DIRECCION:CAM A FARELLONES 15635 LTB 1 BA
COMUNALAS CONDESCIUDAD:stgo
CONTACTO:Jorge González
TIPO DE
COMPRA:
DEL GIRO
R.U.T.:77.368.986- 5
FACTURA ELECTRONICA
Nº3102
S.I.I. - PROVIDENCIA
Fecha Emision:14 de Julio del 2025`;

console.log('=== PROBANDO REGEX ===');

// Dividir el texto en líneas para buscar la fecha de emisión en la parte superior
const lineasTexto = texto.split('\n');
const lineasSuperiores = lineasTexto.slice(0, 20); // Buscar en las primeras 20 líneas
const textoSuperior = lineasSuperiores.join('\n');

console.log('Texto superior:', textoSuperior);
console.log('');

// Buscar formato "Fecha Emision:DD de Mes del YYYY" en la parte superior
const fechaEmisionMatch1 = textoSuperior.match(/Fecha Emision:(\d{1,2}) de (\w+) del (\d{4})/);
if (fechaEmisionMatch1) {
  const [, dia, mesNombre, año] = fechaEmisionMatch1;
  const meses = {
    'Enero': '01', 'Febrero': '02', 'Marzo': '03', 'Abril': '04',
    'Mayo': '05', 'Junio': '06', 'Julio': '07', 'Agosto': '08',
    'Septiembre': '09', 'Octubre': '10', 'Noviembre': '11', 'Diciembre': '12'
  };
  const mesNumero = meses[mesNombre] || '01';
  const fechaEmision = `${año}-${mesNumero}-${dia.padStart(2, '0')}`;
  console.log('🔍 Fecha de emisión extraída del PDF (DD de Mes del YYYY):', `${dia} de ${mesNombre} del ${año}`, '->', fechaEmision);
} else {
  console.log('❌ No se encontró fecha de emisión');
}
