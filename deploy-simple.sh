#!/bin/bash

echo "🚀 Deploying to Railway (Simple Version)..."

# Verificar que estamos en el directorio correcto
if [ ! -f "railway-simple.js" ]; then
    echo "❌ Error: railway-simple.js no encontrado"
    exit 1
fi

# Verificar que Railway CLI esté disponible
if ! command -v npx &> /dev/null; then
    echo "❌ Error: npx no está disponible"
    exit 1
fi

echo "📦 Preparando archivos para deploy..."

# Crear .gitignore si no existe
if [ ! -f ".gitignore" ]; then
    echo "node_modules/" > .gitignore
    echo "uploads/" >> .gitignore
    echo ".env" >> .gitignore
    echo "database.sqlite" >> .gitignore
fi

echo "✅ Archivos preparados"
echo ""
echo "🔧 Próximos pasos manuales:"
echo "1. Ejecuta: npx @railway/cli login"
echo "2. Ejecuta: npx @railway/cli init"
echo "3. Ejecuta: npx @railway/cli up"
echo "4. Configura las variables de entorno en Railway Dashboard"
echo "5. Obtén la URL con: npx @railway/cli domain"
echo ""
echo "📱 Variables de entorno necesarias:"
echo "- NODE_ENV=production"
echo "- (Opcional) SHOPIFY_API_KEY=tu_api_key"
echo "- (Opcional) SHOPIFY_API_SECRET=tu_api_secret"
echo ""
echo "🌐 URLs para configurar en Shopify Partners:"
echo "- App URL: https://tu-app.railway.app"
echo "- Callback URL: https://tu-app.railway.app/api/auth/callback"
