# 🚀 Deploy Manual a Railway

## 📋 Pasos desde Railway Dashboard

### 1. **Crear proyecto en Railway**
1. Ve a [railway.app](https://railway.app)
2. Haz clic en "New Project"
3. Selecciona "Deploy from GitHub repo" o "Empty Project"
4. Si usas GitHub, conecta tu repositorio
5. Si usas Empty Project, sube los archivos manualmente

### 2. **Configurar el proyecto**
1. En el dashboard de Railway, ve a tu proyecto
2. Haz clic en "Settings"
3. En "Start Command", pon: `node railway-simple.js`
4. En "Healthcheck Path", pon: `/`

### 3. **Variables de entorno**
En Railway Dashboard → Variables:
- `NODE_ENV` = `production`
- (Opcional) `SHOPIFY_API_KEY` = tu_api_key
- (Opcional) `SHOPIFY_API_SECRET` = tu_api_secret

### 4. **Deploy**
1. Railway detectará automáticamente que es Node.js
2. Instalará las dependencias del package.json
3. Ejecutará `node railway-simple.js`

### 5. **Obtener URL**
1. En el dashboard, ve a "Deployments"
2. Haz clic en el deployment más reciente
3. Copia la URL (ej: `https://facturas-sii-app-production.up.railway.app`)

## 🔧 Configuración alternativa con CLI

Si el CLI funciona, puedes usar:

```bash
# Crear proyecto
npx @railway/cli init

# Link a proyecto existente
npx @railway/cli link

# Deploy
npx @railway/cli up

# Ver logs
npx @railway/cli logs

# Obtener URL
npx @railway/cli domain
```

## 📱 Archivos necesarios

Asegúrate de tener estos archivos en tu proyecto:
- ✅ `railway-simple.js` - Servidor principal
- ✅ `package.json` - Dependencias
- ✅ `public/` - Archivos estáticos
- ✅ `railway.json` - Configuración (opcional)

## 🧪 Testing

Una vez deployado:
1. Ve a la URL de Railway
2. Deberías ver la interfaz de gestión de facturas
3. Prueba subir un PDF
4. Verifica que se guarden las facturas

## 🔍 Troubleshooting

### 1. **Ver logs**
En Railway Dashboard → Deployments → Logs

### 2. **Verificar variables**
En Railway Dashboard → Variables

### 3. **Re-deploy**
En Railway Dashboard → Deployments → Redeploy

## 🎉 ¡Listo!

Una vez completado, tendrás tu app funcionando en Railway con:
- ✅ Extracción de PDF
- ✅ Base de datos SQLite
- ✅ API REST
- ✅ Interfaz web
- ✅ Gestión completa de facturas
