require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');

// --- CONFIGURACIÓN ---
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PORT = process.env.PORT || 3000;

// ¡IMPORTANTE! Reemplaza esto con la URL real de tu servicio en Render.
const RENDER_EXTERNAL_URL = "https://server-2-ydpr.onrender.com"; 

const PUBLIC_FOLDER = 'public';
const IMAGE_FILENAME = 'cedula_ejemplo.jpg';
const PAUSE_DURATION = 5000; // 5 segundos

// --- INICIALIZACIÓN DE EXPRESS ---
const app = express();
app.use(express.json());

// --- FUNCIONES AUXILIARES ---
const API_URL = `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`;
const HEADERS = { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' };
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function sendWhatsAppMessage(data, recipientNumber) {
    try {
        await axios.post(API_URL, {
            messaging_product: "whatsapp",
            to: recipientNumber,
            ...data
        }, { headers: HEADERS });
        console.log(`✅ Mensaje de tipo '${data.type}' enviado a ${recipientNumber}.`);
    } catch (error) {
        console.error(`❌ Error al enviar mensaje de tipo '${data.type}':`, error.response?.data?.error || error.message);
    }
}

// --- SECUENCIA DE ENVÍO ---
// Esta función será llamada cuando el usuario envíe el comando correcto.
async function executeSendSequence(recipientNumber) {
    console.log(`🚀 Iniciando secuencia de envío para ${recipientNumber}...`);
    try {
        // 1. Enviar Plantilla
        await sendWhatsAppMessage({
            type: "template",
            template: { name: "hello_world", language: { code: "en_US" } }
        }, recipientNumber);
        await delay(PAUSE_DURATION);

        // 2. Enviar Texto "3"
        await sendWhatsAppMessage({
            type: "text",
            text: { body: "3" }
        }, recipientNumber);
        await delay(PAUSE_DURATION);

        // 3. Enviar Imagen de Prueba
        const publicImageUrl = `${RENDER_EXTERNAL_URL}/static/${IMAGE_FILENAME}`;
        await sendWhatsAppMessage({
            type: "image",
            image: { link: publicImageUrl }
        }, recipientNumber);

        console.log("✅ Secuencia completada exitosamente.");
    } catch (error) {
        console.error("🚫 La secuencia fue interrumpida por un error.", error);
    }
}


// --- WEBHOOK ---
app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else {
        res.sendStatus(403);
    }
});

app.post('/webhook', (req, res) => {
    const body = req.body;

    if (body.object === 'whatsapp_business_account' && body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
        const message = body.entry[0].changes[0].value.messages[0];
        const from = message.from; // Número del usuario que envió el mensaje
        
        console.log("\n=============================================");
        console.log(`<<<<< MENSAJE RECIBIDO DE ${from}! >>>>>`);
        
        if (message.type === 'text') {
            const textBody = message.text.body.toLowerCase().trim();
            console.log(`   💬 Contenido: "${message.text.body}"`);

            // --- LÓGICA DE COMANDOS ---
            if (textBody === 'iniciar') {
                // Si el usuario escribe "iniciar", ejecutamos la secuencia.
                executeSendSequence(from);
            }
        } else {
            console.log(`   ❔ Tipo de mensaje: ${message.type}`);
        }
        console.log("=============================================\n");
    }

    res.sendStatus(200);
});

// --- RUTA PARA SERVIR IMÁGENES Y TEST ---
app.use('/static', express.static(path.join(__dirname, PUBLIC_FOLDER)));
app.get('/', (req, res) => res.send('¡El servidor del bot de WhatsApp está vivo y escuchando!'));


// --- INICIO DEL SERVIDOR ---
app.listen(PORT, () => {
    console.log(`🚀 Servidor iniciado. Escuchando en el puerto ${PORT}`);
    console.log("🤖 El bot está en modo de escucha permanente.");
});