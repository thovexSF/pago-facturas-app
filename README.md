# Bioma Facturación

Monorepo unificado en Railway: **facturas por pagar** + **emisión SII** (Shopify).

## Módulos

| Ruta | Qué es |
|------|--------|
| `/` | **Facturas proveedores** — recibidas del SII, calendario, vencimientos |
| `/sii` | **Facturación** — facturas pendientes, boletas, realizadas, emisión SII |
| `/api/bioma/*` | API emisión Shopify (facturas + boletas + auto-emit) |
| `/api/sii-facturacion/*` | API SII interna (sesión, PDF, scraper) |

## Railway

Un solo servicio, un solo `DATABASE_URL`, un solo deploy:

```
npm install
npm run build    # backend + frontend
npm run start    # unifica todo en PORT
```

`railway.json` y `nixpacks.toml` ya configurados. Apunta el repo **bioma-facturacion** (este) al servicio Railway existente de pago facturas.

### Variables de entorno (mismas que antes + Bioma)

```bash
# PostgreSQL (compartida)
DATABASE_URL=...

# Facturas por pagar (módulo /)
SII_RUT=...
SII_PASSWORD=...
SII_EMPRESA_RUT=78015129-3
NOTIF_EMAIL_TO=...          # opcional
NOTIF_EMAIL_FROM=...
NOTIF_EMAIL_PASS=...

# Facturación SII Shopify (módulo /sii)
BIOMA_SHOPIFY_SHOP=biomacoffee.myshopify.com
BIOMA_SHOPIFY_API_CLIENT_ID=...
BIOMA_SHOPIFY_API_CLIENT_SECRET=...
BIOMA_EMPRESA_RUT=78015129-3
BIOMA_AUTO_EMIT=1              # opcional: emitir factura al pagar (toggle checkout)
BIOMA_AUTO_EMIT_BOLETA=1       # opcional: emitir boleta si NO hay toggle factura

# SII workbench
SII_USERNAME=...
SII_PASSWORD=...
SII_FIRMA_CLAVE=...
```

## Desarrollo local

```bash
npm install
npm run build
PORT=3890 npm run start
# → http://localhost:3890/       facturas por pagar
# → http://localhost:3890/sii    facturación SII
```

Solo API + UI SII (sin pago):

```bash
npm run dev
```

Solo pago facturas (standalone):

```bash
npm run dev:pago
```

## Shopify

Una app en Dev Dashboard: **Facturación** → App URL = tu dominio Railway (`https://xxx.railway.app`).

- `/` = gestión de facturas recibidas
- `/sii` = emitir facturas a clientes Shopify

## Estructura

```
apps/pago-facturas/   ← facturas por pagar (antes repo aparte)
backend/              ← APIs SII + montaje unificado
frontend/             ← UI /sii
shopify/              ← app embebida Admin (opcional)
```
