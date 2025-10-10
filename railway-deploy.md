# 🚀 Deploy a Railway - Guía paso a paso

## 📋 Configuración previa

### 1. **Variables de entorno necesarias en Railway:**
```env
SHOPIFY_API_KEY=tu_api_key_de_shopify
SHOPIFY_API_SECRET=tu_api_secret_de_shopify
SCOPES=read_products,write_products,read_orders,write_orders
HOST=https://tu-app.railway.app
NODE_ENV=production
```

### 2. **URLs que configurar en Shopify Partners:**
- **App URL**: `https://tu-app.railway.app`
- **Allowed redirection URL(s)**: `https://tu-app.railway.app/api/auth/callback`

## 🚀 Pasos para deploy en Railway

### 1. **Conectar con Railway**
```bash
# Instalar Railway CLI
npm install -g @railway/cli

# Login
railway login

# Inicializar proyecto
railway init
```

### 2. **Configurar variables de entorno**
```bash
# En Railway Dashboard o CLI
railway variables set SHOPIFY_API_KEY=tu_api_key
railway variables set SHOPIFY_API_SECRET=tu_api_secret
railway variables set HOST=https://tu-app.railway.app
```

### 3. **Deploy**
```bash
# Deploy automático
railway up

# O con git
git add .
git commit -m "Deploy to Railway"
git push railway main
```

## 🔧 Configuración en Shopify Partners

### 1. **App URLs**
- **App URL**: `https://tu-app.railway.app`
- **Allowed redirection URL(s)**: `https://tu-app.railway.app/api/auth/callback`

### 2. **Webhooks** (opcional)
- **Order creation**: `https://tu-app.railway.app/api/webhooks/orders/create`
- **Order update**: `https://tu-app.railway.app/api/webhooks/orders/updated`

### 3. **App setup**
- **App setup URL**: `https://tu-app.railway.app`

## 🧪 Testing

### 1. **Verificar deploy**
- Ve a `https://tu-app.railway.app`
- Debería mostrar la interfaz de la app

### 2. **Probar autenticación**
- Instala la app en una tienda de desarrollo
- Verifica que la autenticación funcione

### 3. **Probar funcionalidades**
- Subir PDF
- Ver facturas
- Marcar como pagada

## 📱 Instalación en tienda

### 1. **Development store**
- Crea una tienda de desarrollo en Shopify Partners
- Instala tu app desde el Partner Dashboard

### 2. **Public app**
- Una vez que funcione, envía para revisión
- Shopify revisará antes de publicar

## 🔍 Troubleshooting

### 1. **Logs de Railway**
```bash
railway logs
```

### 2. **Variables de entorno**
```bash
railway variables
```

### 3. **Verificar URLs**
- Asegúrate de que las URLs en Shopify Partners coincidan con Railway
- Verifica que el HOST esté configurado correctamente

## 📞 Soporte

- Railway: [docs.railway.app](https://docs.railway.app)
- Shopify: [partners.shopify.com](https://partners.shopify.com)
- Shopify API: [shopify.dev](https://shopify.dev)
