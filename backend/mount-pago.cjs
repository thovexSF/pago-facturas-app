const path = require('path');
const pagoPath = path.join(__dirname, '..', '..', 'apps', 'pago-facturas', 'server-postgres.js');
module.exports = require(pagoPath);
