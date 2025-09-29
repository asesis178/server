// /config.js
require('dotenv').config();

const PORT = process.env.PORT || 3000;

module.exports = {
    // Credenciales y Tokens
    PHONE_NUMBER_IDS: process.env.PHONE_NUMBER_ID ? process.env.PHONE_NUMBER_ID.split(',') : [],
    WHATSAPP_TOKENS: process.env.WHATSAPP_TOKEN ? process.env.WHATSAPP_TOKEN.split(',') : [],
    ADMIN_USER: process.env.ADMIN_USER,
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
    NORMAL_USER: process.env.NORMAL_USER,
    NORMAL_USER_PASSWORD: process.env.NORMAL_USER_PASSWORD,

    // Conexión a la Base de Datos
    DATABASE_URL: process.env.DATABASE_URL,

    // Configuración del Servidor
    PORT: PORT,
    RENDER_EXTERNAL_URL: process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`,

    // Constantes de la Aplicación
    ACTIVATION_IMAGE_NAME: 'activation_image.jpeg',
    CONCURRENT_IMAGE_PROCESSING_LIMIT: 4, // Aunque no se usa explícitamente, lo mantenemos por si acaso.
    WATCHDOG_TIMEOUT: 120000,
};