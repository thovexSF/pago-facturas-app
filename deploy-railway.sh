#!/bin/bash

echo "🚀 Deploying to Railway..."

# Verificar que Railway CLI esté instalado
if ! command -v railway &> /dev/null; then
    echo "❌ Railway CLI no está instalado. Instalando..."
    npm install -g @railway/cli
fi

# Login a Railway
echo "🔐 Logging in to Railway..."
railway login

# Inicializar proyecto si no existe
if [ ! -f "railway.json" ]; then
    echo "📝 Inicializando proyecto en Railway..."
    railway init
fi

# Configurar variables de entorno
echo "⚙️ Configurando variables de entorno..."
echo "Por favor, configura estas variables en Railway Dashboard:"
echo "- SHOPIFY_API_KEY"
echo "- SHOPIFY_API_SECRET" 
echo "- HOST=https://tu-app.railway.app"
echo "- SCOPES=read_products,write_products,read_orders,write_orders"

# Deploy
echo "🚀 Deploying..."
railway up

echo "✅ Deploy completado!"
echo "📱 Tu app estará disponible en: https://tu-app.railway.app"
echo "🔧 Configura las URLs en Shopify Partners:"
echo "   - App URL: https://tu-app.railway.app"
echo "   - Callback URL: https://tu-app.railway.app/api/auth/callback"
