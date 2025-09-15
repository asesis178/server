require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');

// --- CONFIGURACIÓN ---
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PORT = process.env.PORT || 3000;
const RENDER_EXTERNAL_URL = "https://server-2-ydpr.onrender.com"; // <-- ¡Verifica que sea tu URL!

// El número de teléfono al que el botón siempre enviará la secuencia
const TARGET_PHONE_NUMBER = "59892484684"; // <-- Define aquí el número de destino

const PUBLIC_FOLDER = 'public';
const IMAGE_FILENAME = 'cedula_ejemplo.jpg';
const PAUSE_DURATION = 5000;

// --- INICIALIZACIÓN DE EXPRESS ---
const app = express();
app.use(express.json());

// --- FUNCIONES AUXILIARES ---
const API_URL = `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`;
const HEADERS = { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' };
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function sendWhatsAppMessage(data, recipientNumber) {
    /* ... (esta función no cambia, la incluyo al final para que el código esté completo) ... */
}

// --- SECUENCIA DE ENVÍO ---
async function executeSendSequence(recipientNumber) {
    console.log(`🚀 Iniciando secuencia de envío para ${recipientNumber} desde el panel...`);
    try {
        await sendWhatsAppMessage({ type: "template", template: { name: "hello_world", language: { code: "en_US" } } }, recipientNumber);
        await delay(PAUSE_DURATION);
        await sendWhatsAppMessage({ type: "text", text: { body: "3" } }, recipientNumber);
        await delay(PAUSE_DURATION);
        const publicImageUrl = `${RENDER_EXTERNAL_URL}/static/${IMAGE_FILENAME}`;
        await sendWhatsAppMessage({ type: "image", image: { link: publicImageUrl } }, recipientNumber);
        console.log("✅ Secuencia completada exitosamente.");
    } catch (error) {
        console.error("🚫 La secuencia fue interrumpida por un error.", error);
    }
}

// --- ENDPOINTS DEL SERVIDOR ---

// 1. Endpoint para servir el panel de control
app.get('/panel', (req, res) => {
    res.sendFile(path.join(__dirname, 'panel.html'));
});

// 2. Endpoint que se activa al hacer clic en el botón
app.post('/iniciar-secuencia', async (req, res) => {
    console.log("Recibida solicitud para iniciar secuencia desde el panel web.");
    // Ejecuta la secuencia al número de teléfono definido arriba
    executeSendSequence(TARGET_PHONE_NUMBER);
    // Responde al navegador inmediatamente para que el usuario sepa que funcionó
    res.send("<h1>Secuencia iniciada...</h1><p>Revisa el WhatsApp del número de destino y los logs de Render para ver el progreso.</p>");
});

// 3. Endpoint del Webhook para recibir respuestas
app.get('/webhook', (req, res) => { /* ... (no cambia) ... */ });
app.post('/webhook', (req, res) => { /* ... (ahora solo imprime, no tiene comandos) ... */ });

// 4. Endpoint para servir imágenes y la raíz
app.use('/static', express.static(path.join(__dirname, PUBLIC_FOLDER)));
app.get('/', (req, res) => res.send('¡Servidor del bot activo! Visita /panel para usar el control manual.'));

// --- INICIO DEL SERVIDOR ---
app.listen(PORT, () => {
    console.log(`🚀 Servidor iniciado. Escuchando en el puerto ${PORT}`);
    console.log("🤖 El bot está en modo de escucha permanente.");
});


// --- Re-pego las funciones completas para que solo copies y pegues ---
async function sendWhatsAppMessage(data, recipientNumber) {
    try {
        await axios.post(API_URL, {
            messaging_product: "whatsapp", to: recipientNumber, ...data
        }, { headers: HEADERS });
        console.log(`✅ Mensaje de tipo '${data.type}' enviado a ${recipientNumber}.`);
    } catch (error) {
        console.error(`❌ Error al enviar mensaje de tipo '${data.type}':`, error.response?.data?.error || error.message);
    }
}
app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else { res.sendStatus(403); }
});
app.post('/webhook', (req, res) => {
    const body = req.body;
    if (body.object === 'whatsapp_business_account' && body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
        const message = body.entry[0].changes[0].value.messages[0];
        console.log("\n=============================================");
        console.log(`<<<<< MENSAJE RECIBIDO DE ${message.from}! >>>>>`);
        if (message.type === 'text') { console.log(`   💬 Contenido: "${message.text.body}"`); }
        else { console.log(`   ❔ Tipo de mensaje: ${message.type}`); }
        console.log("=============================================\n");
    }
    res.sendStatus(200);
});