// /config.js
require('dotenv').config();

const PORT = process.env.PORT || 3000;

module.exports = {
    // WhatsApp (separados por coma si hay múltiples remitentes)
    PHONE_NUMBER_IDS: process.env.PHONE_NUMBER_ID ? process.env.PHONE_NUMBER_ID.split(',') : [],
    WHATSAPP_TOKENS:  process.env.WHATSAPP_TOKEN  ? process.env.WHATSAPP_TOKEN.split(',')  : [],

    // Seguridad del Webhook
    WHATSAPP_APP_SECRET: process.env.WHATSAPP_APP_SECRET, // Meta > Configuración básica > Clave secreta
    VERIFY_TOKEN:        process.env.VERIFY_TOKEN,         // Token que vos elegís al registrar el webhook

    // Credenciales del panel
    ADMIN_USER:            process.env.ADMIN_USER,
    ADMIN_PASSWORD:        process.env.ADMIN_PASSWORD,
    NORMAL_USER:           process.env.NORMAL_USER,
    NORMAL_USER_PASSWORD:  process.env.NORMAL_USER_PASSWORD,

    // Base de datos
    DATABASE_URL: process.env.DATABASE_URL,

    // Servidor
    PORT,
    RENDER_EXTERNAL_URL: process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`,

    // Constantes
    ACTIVATION_IMAGE_NAME: 'activation_image.jpeg',
    WATCHDOG_TIMEOUT: 120000, // 2 minutos
};
