// Configuración para Shopify App
const SHOPIFY_CONFIG = {
  // Estos valores los obtienes del Partner Dashboard
  apiKey: 'TU_API_KEY_AQUI',
  apiSecret: 'TU_API_SECRET_AQUI',
  scopes: [
    'read_products',
    'write_products', 
    'read_orders',
    'write_orders',
    'read_customers',
    'write_customers'
  ],
  host: process.env.HOST || 'https://tu-app.herokuapp.com',
  port: process.env.PORT || 3000
};

module.exports = SHOPIFY_CONFIG;
