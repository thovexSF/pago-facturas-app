# App Shopify Admin — Facturación

Opcional. La UI principal vive en el mismo Railway:

- `https://tu-app.railway.app/` — facturas por pagar
- `https://tu-app.railway.app/sii` — emisión SII

Si quieres la pantalla **dentro del Admin de Shopify**, configura App URL = la misma URL Railway (o `/sii`).

## Dev Dashboard

- Una sola app: **Facturación**
- Client ID + Secret → `BIOMA_SHOPIFY_API_*` en Railway
- Scopes: `read_orders`, `write_orders`, `read_all_orders`, `read_customers`

Ver [README raíz](../README.md) para variables y deploy.
