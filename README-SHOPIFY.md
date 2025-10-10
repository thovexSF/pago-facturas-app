# 🚀 Guía para subir la App a Shopify

## 📋 Pasos para crear la App en Shopify

### 1. **Crear cuenta en Shopify Partners**
- Ve a [partners.shopify.com](https://partners.shopify.com)
- Regístrate como desarrollador
- Accede al Partner Dashboard

### 2. **Crear nueva app**
- En el Partner Dashboard → "Apps"
- Clic en "Create app"
- Selecciona "Public app"
- Completa la información básica

### 3. **Configurar la app**
- **App URL**: `https://tu-app.herokuapp.com`
- **Allowed redirection URL(s)**: `https://tu-app.herokuapp.com/api/auth/callback`
- **Webhook API version**: Latest
- **App setup URL**: `https://tu-app.herokuapp.com`

### 4. **Obtener credenciales**
- Copia el **API key** y **API secret key**
- Configúralos en las variables de entorno

## 🛠️ Configuración del código

### 1. **Instalar dependencias de Shopify**
```bash
npm install @shopify/shopify-api @shopify/shopify-app-express
```

### 2. **Configurar variables de entorno**
Copia `env-shopify.example` a `.env` y configura:
```env
SHOPIFY_API_KEY=tu_api_key_aqui
SHOPIFY_API_SECRET=tu_api_secret_aqui
SCOPES=read_products,write_products,read_orders,write_orders
HOST=https://tu-app.herokuapp.com
```

### 3. **Usar el servidor de Shopify**
```bash
node server-shopify.js
```

## 🚀 Deploy a Heroku

### 1. **Crear cuenta en Heroku**
- Ve a [heroku.com](https://heroku.com)
- Crea una cuenta gratuita

### 2. **Instalar Heroku CLI**
```bash
# macOS
brew install heroku/brew/heroku

# Windows
# Descarga desde heroku.com
```

### 3. **Deploy**
```bash
# Login
heroku login

# Crear app
heroku create tu-app-facturas

# Configurar variables
heroku config:set SHOPIFY_API_KEY=tu_api_key
heroku config:set SHOPIFY_API_SECRET=tu_api_secret
heroku config:set HOST=https://tu-app-facturas.herokuapp.com

# Deploy
git add .
git commit -m "Initial commit"
git push heroku main
```

## 📱 Configuración en Shopify Partners

### 1. **App URLs**
- **App URL**: `https://tu-app.herokuapp.com`
- **Allowed redirection URL(s)**: `https://tu-app.herokuapp.com/api/auth/callback`

### 2. **Webhooks** (opcional)
- **Order creation**: `https://tu-app.herokuapp.com/api/webhooks/orders/create`
- **Order update**: `https://tu-app.herokuapp.com/api/webhooks/orders/updated`

### 3. **App setup**
- **App setup URL**: `https://tu-app.herokuapp.com`

## 🔧 Permisos necesarios

La app necesita estos permisos:
- `read_products` - Leer productos
- `write_products` - Modificar productos  
- `read_orders` - Leer órdenes
- `write_orders` - Modificar órdenes
- `read_customers` - Leer clientes
- `write_customers` - Modificar clientes

## 🧪 Testing

### 1. **Development store**
- Crea una tienda de desarrollo en Shopify Partners
- Instala tu app en la tienda de desarrollo
- Prueba todas las funcionalidades

### 2. **Submit for review**
- Una vez que funcione correctamente
- Envía la app para revisión en Shopify Partners
- Shopify revisará la app antes de publicarla

## 📞 Soporte

Si tienes problemas:
1. Revisa los logs de Heroku: `heroku logs --tail`
2. Verifica las variables de entorno
3. Asegúrate de que las URLs estén correctas
4. Revisa la documentación de Shopify Partners
