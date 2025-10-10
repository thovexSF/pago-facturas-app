# 🚀 Setup Railway - Pasos manuales

## 1. **Login a Railway**
```bash
npx @railway/cli login
```
- Se abrirá el navegador para autenticación
- Autoriza la aplicación

## 2. **Crear proyecto**
```bash
npx @railway/cli init
```
- Selecciona "Create new project"
- Nombre: `facturas-sii-app`

## 3. **Configurar variables de entorno**
En Railway Dashboard:
- `SHOPIFY_API_KEY` = tu_api_key_de_shopify
- `SHOPIFY_API_SECRET` = tu_api_secret_de_shopify  
- `HOST` = https://tu-app.railway.app
- `SCOPES` = read_products,write_products,read_orders,write_orders
- `NODE_ENV` = production

## 4. **Deploy**
```bash
npx @railway/cli up
```

## 5. **Obtener URL**
```bash
npx @railway/cli domain
```

## 6. **Configurar en Shopify Partners**
- **App URL**: `https://tu-app.railway.app`
- **Callback URL**: `https://tu-app.railway.app/api/auth/callback`

## 7. **Probar la app**
- Ve a la URL de Railway
- Instala en una tienda de desarrollo
- Prueba subir un PDF
