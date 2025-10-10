# 🚀 Guía de Deploy a Railway

## 📋 Pasos para deploy manual

### 1. **Login a Railway**
```bash
npx @railway/cli login
```
- Se abrirá el navegador
- Autoriza la aplicación con tu cuenta de Railway

### 2. **Crear proyecto**
```bash
npx @railway/cli init
```
- Selecciona "Create new project"
- Nombre: `facturas-sii-app`
- Selecciona el template de Node.js

### 3. **Deploy inicial**
```bash
npx @railway/cli up
```
- Esto subirá todos los archivos
- Railway detectará automáticamente que es una app Node.js

### 4. **Obtener URL de la app**
```bash
npx @railway/cli domain
```
- Copia la URL que te dé (ej: `https://facturas-sii-app-production.up.railway.app`)

### 5. **Configurar variables de entorno (opcional)**
En Railway Dashboard:
- Ve a tu proyecto
- Pestaña "Variables"
- Agrega:
  - `NODE_ENV` = `production`
  - `SHOPIFY_API_KEY` = tu_api_key (si tienes)
  - `SHOPIFY_API_SECRET` = tu_api_secret (si tienes)

### 6. **Probar la app**
- Ve a la URL de Railway
- Deberías ver la interfaz de gestión de facturas
- Prueba subir un PDF

## 🔧 Configuración en Shopify Partners (opcional)

Si quieres integrar con Shopify:

### 1. **App URLs**
- **App URL**: `https://tu-app.railway.app`
- **Allowed redirection URL(s)**: `https://tu-app.railway.app/api/auth/callback`

### 2. **Webhooks** (opcional)
- **Order creation**: `https://tu-app.railway.app/api/webhooks/orders/create`
- **Order update**: `https://tu-app.railway.app/api/webhooks/orders/updated`

## 🧪 Testing

### 1. **Funcionalidades básicas**
- ✅ Subir PDF
- ✅ Ver facturas
- ✅ Marcar como pagada
- ✅ Ordenar por fecha

### 2. **Funcionalidades avanzadas** (con Shopify)
- ✅ Autenticación OAuth
- ✅ Integración con tienda
- ✅ Webhooks

## 📱 URLs importantes

- **Railway Dashboard**: https://railway.app/dashboard
- **Tu app**: `https://tu-app.railway.app`
- **Shopify Partners**: https://partners.shopify.com

## 🔍 Troubleshooting

### 1. **Logs de Railway**
```bash
npx @railway/cli logs
```

### 2. **Verificar variables**
```bash
npx @railway/cli variables
```

### 3. **Re-deploy**
```bash
npx @railway/cli up
```

## 🎉 ¡Listo!

Una vez completado, tendrás:
- ✅ App funcionando en Railway
- ✅ Base de datos SQLite
- ✅ API REST completa
- ✅ Interfaz web responsive
- ✅ Extracción de PDF automática
- ✅ Gestión de facturas completa
