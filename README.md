# 📄 App de Gestión de Facturas SII para Shopify

Una aplicación de Shopify que te permite gestionar tus facturas del SII (Servicio de Impuestos Internos de Chile) con recordatorios automáticos y pagos integrados con Mercado Pago.

## 🚀 Características

- **Sincronización automática** con el portal del SII
- **Recordatorios por email** antes del vencimiento
- **Dashboard intuitivo** con estadísticas en tiempo real
- **Integración con Mercado Pago** para pagos automáticos
- **Interfaz responsive** optimizada para móviles
- **Gestión completa** de facturas pendientes y pagadas

## 🛠️ Tecnologías Utilizadas

- **Backend**: Node.js + Express
- **Frontend**: HTML5, CSS3, JavaScript (Vanilla)
- **Base de datos**: SQLite
- **Autenticación**: Shopify OAuth
- **Web scraping**: Puppeteer
- **Email**: Nodemailer
- **Pagos**: Mercado Pago API
- **Scheduling**: Node-cron

## 📋 Requisitos Previos

- Node.js 16+ 
- Cuenta de Shopify Partner
- Cuenta de Mercado Pago
- Email configurado (Gmail recomendado)
- ngrok para desarrollo local

## 🔧 Instalación

1. **Clona el repositorio**
   ```bash
   git clone <tu-repositorio>
   cd facturas
   ```

2. **Instala las dependencias**
   ```bash
   npm install
   ```

3. **Configura las variables de entorno**
   ```bash
   cp env.example .env
   ```
   
   Edita el archivo `.env` con tus credenciales:
   ```env
   SHOPIFY_API_KEY=tu_api_key_aqui
   SHOPIFY_API_SECRET=tu_api_secret_aqui
   SHOPIFY_APP_URL=https://tu-dominio.ngrok.io
   EMAIL_USER=tu-email@gmail.com
   EMAIL_PASSWORD=tu-password-de-aplicacion
   MERCADOPAGO_ACCESS_TOKEN=tu_access_token_aqui
   ```

4. **Configura ngrok para desarrollo**
   ```bash
   ngrok http 3000
   ```
   
   Copia la URL HTTPS generada y úsala en `SHOPIFY_APP_URL`

5. **Inicia la aplicación**
   ```bash
   npm start
   ```

## 🏗️ Configuración en Shopify

1. **Crea una app en Shopify Partners**
   - Ve a [partners.shopify.com](https://partners.shopify.com)
   - Crea una nueva app
   - Configura la URL de redirección: `https://tu-dominio.ngrok.io/api/auth/callback`

2. **Configura los permisos necesarios**
   - `read_products`
   - `write_products` 
   - `read_orders`
   - `write_orders`

3. **Instala la app en tu tienda de prueba**

## 📧 Configuración de Email

Para usar Gmail:
1. Habilita la verificación en 2 pasos
2. Genera una contraseña de aplicación
3. Usa esa contraseña en `EMAIL_PASSWORD`

## 💳 Configuración de Mercado Pago

1. Crea una cuenta en [Mercado Pago](https://www.mercadopago.cl)
2. Ve a "Desarrolladores" > "Tus credenciales"
3. Copia tu Access Token de prueba o producción

## 🔄 Funcionalidades

### Dashboard
- Estadísticas en tiempo real
- Facturas recientes
- Resumen de pagos pendientes

### Gestión de Facturas
- Agregar facturas manualmente
- Sincronizar con SII automáticamente
- Marcar como pagadas
- Filtros por estado y fecha

### Recordatorios Automáticos
- Envío de emails 3 días antes del vencimiento
- Configuración personalizable
- Historial de recordatorios enviados

### Integración SII
- Login automático con RUT y contraseña
- Extracción de facturas pendientes
- Sincronización programada

## 🚀 Despliegue en Producción

1. **Configura un servidor** (Heroku, DigitalOcean, AWS, etc.)
2. **Configura la base de datos** PostgreSQL para producción
3. **Actualiza las URLs** en Shopify Partners
4. **Configura el dominio** en las variables de entorno
5. **Habilita HTTPS** para seguridad

## 📱 Uso de la Aplicación

1. **Instala la app** en tu tienda Shopify
2. **Configura tus credenciales** del SII en la pestaña "Configuración"
3. **Sincroniza tus facturas** desde el SII
4. **Configura tu email** para recibir recordatorios
5. **Integra Mercado Pago** para pagos automáticos

## 🔒 Seguridad

- Autenticación OAuth de Shopify
- Encriptación de contraseñas
- Validación de datos de entrada
- HTTPS obligatorio en producción
- Tokens seguros para APIs externas

## 🐛 Solución de Problemas

### Error de conexión con SII
- Verifica que tu RUT y contraseña sean correctos
- El SII puede tener medidas anti-bot, intenta más tarde

### Emails no se envían
- Verifica la configuración de Gmail
- Revisa que la contraseña de aplicación sea correcta
- Verifica que el puerto 587 esté abierto

### Sincronización falla
- Revisa los logs del servidor
- Verifica que Puppeteer esté instalado correctamente
- Asegúrate de que el SII esté accesible

## 📞 Soporte

Para soporte técnico o reportar bugs, contacta al desarrollador o crea un issue en el repositorio.

## 📄 Licencia

MIT License - Ver archivo LICENSE para más detalles.

---

**Desarrollado con ❤️ para la comunidad Shopify Chile**

