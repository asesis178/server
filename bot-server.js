// Carga las variables de entorno desde el archivo .env (para pruebas locales)
// o desde el entorno del servidor (para producción en Render)
require('dotenv').config();

const express = require('express');
const path = require('path');
const axios = require('axios');

// --- CONFIGURACIÓN LEÍDA DESDE EL ENTORNO ---
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN; // ¡CRUCIAL PARA LA VALIDACIÓN!
const PORT = process.env.PORT || 3000;

// --- INICIALIZACIÓN DEL SERVIDOR EXPRESS ---
const app = express();
// Middleware esencial para que Express pueda leer el JSON que envía Meta
app.use(express.json());

// --- VERIFICACIÓN DE VARIABLES DE ENTORNO ---
// Comprobamos al inicio que todas las claves secretas estén presentes.
if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID || !VERIFY_TOKEN) {
    console.error("ERROR CRÍTICO: Faltan variables de entorno. Asegúrate de que WHATSAPP_TOKEN, PHONE_NUMBER_ID, y VERIFY_TOKEN estén configuradas.");
    process.exit(1); // Detiene la aplicación si faltan secretos
}


// --- WEBHOOK: La puerta de entrada para Meta ---

// PARTE 1: Verificación del Webhook (método GET)
// Meta usa esta ruta UNA SOLA VEZ para asegurarse de que eres el dueño del servidor.
app.get('/webhook', (req, res) => {
    console.log("Recibida petición de verificación de webhook (GET)...");

    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    // Comprueba que el modo sea 'subscribe' y que el token coincida con el nuestro.
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log("¡Verificación de Webhook exitosa!");
        res.status(200).send(challenge);
    } else {
        // Si no coinciden, rechaza la petición.
        console.error("Fallo en la verificación del Webhook. Los tokens no coinciden.");
        res.sendStatus(403); // Forbidden
    }
});

// PARTE 2: Recepción de Mensajes (método POST)
// Meta usa esta ruta cada vez que un usuario te envía un mensaje.
app.post('/webhook', (req, res) => {
    const body = req.body;

    // Imprimimos el cuerpo completo para depuración
    console.log('Recibida notificación de webhook (POST):', JSON.stringify(body, null, 2));

    // Procesamos el mensaje si es válido
    if (body.object === 'whatsapp_business_account' && body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
        const message = body.entry[0].changes[0].value.messages[0];
        
        console.log("\n=============================================");
        console.log(`<<<<< MENSAJE RECIBIDO DE ${message.from}! >>>>>`);
        if (message.type === 'text') {
            console.log(`   💬 Contenido: "${message.text.body}"`);
        } else {
            console.log(`   ❔ Tipo de mensaje: ${message.type}`);
        }
        console.log("=============================================\n");
    }

    // Le decimos a Meta que recibimos la notificación correctamente.
    // Es crucial responder siempre con 200, de lo contrario Meta pensará que tu bot está caído.
    res.sendStatus(200);
});


// --- RUTAS ADICIONALES ---

// Una ruta raíz para hacer un test rápido y saber que el servidor está vivo.
app.get('/', (req, res) => {
    res.send('¡El servidor del bot de WhatsApp está vivo y coleando!');
});


// --- INICIO DEL SERVIDOR ---
app.listen(PORT, () => {
    console.log(`🚀 Servidor iniciado. Escuchando en el puerto ${PORT}`);
    console.log("🤖 El bot está en modo de escucha permanente.");
    console.log("Ahora puedes configurar tu webhook en el panel de Meta.");
});