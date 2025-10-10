# 🚀 Configuración para proyecto "Pago Facturas" en Railway

## 📋 Pasos para conectar tu proyecto

### 1. **Obtener el Project ID**
1. Ve a [railway.app/dashboard](https://railway.app/dashboard)
2. Haz clic en tu proyecto "Pago Facturas"
3. En la URL verás algo como: `https://railway.app/project/abc123`
4. El Project ID es `abc123`

### 2. **Conectar desde CLI**
```bash
npx @railway/cli link abc123
```
(Reemplaza `abc123` con tu Project ID real)

### 3. **Deploy**
```bash
npx @railway/cli up
```

## 🔧 Configuración del proyecto

### **Start Command:**
```
node railway-simple.js
```

### **Variables de entorno:**
- `NODE_ENV` = `production`
- (Opcional) `SHOPIFY_API_KEY` = tu_api_key
- (Opcional) `SHOPIFY_API_SECRET` = tu_api_secret

### **Healthcheck:**
- Path: `/`
- Timeout: 100s

## 📁 Archivos que se subirán

- ✅ `railway-simple.js` - Servidor principal
- ✅ `package.json` - Dependencias
- ✅ `public/` - Archivos estáticos
- ✅ `railway.json` - Configuración
- ✅ `Procfile` - Comando de inicio

## 🧪 Testing después del deploy

1. **Obtener URL:**
```bash
npx @railway/cli domain
```

2. **Ver logs:**
```bash
npx @railway/cli logs
```

3. **Probar la app:**
- Ve a la URL de Railway
- Deberías ver la interfaz de gestión de facturas
- Prueba subir un PDF

## 📱 URLs para Shopify Partners

Una vez que tengas la URL de Railway:
- **App URL**: `https://tu-app.railway.app`
- **Callback URL**: `https://tu-app.railway.app/api/auth/callback`

## 🔍 Troubleshooting

### Si el CLI no funciona:
1. Usa el dashboard de Railway
2. Sube los archivos manualmente
3. Configura el Start Command: `node railway-simple.js`
4. Agrega las variables de entorno

### Si hay errores:
1. Revisa los logs en Railway Dashboard
2. Verifica que todas las dependencias estén en package.json
3. Asegúrate de que el Start Command sea correcto
