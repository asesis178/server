require('dotenv').config();
const express = require('express');
const path = require('path');
const axios = require('axios');

// --- CONFIGURACIÓN DESDE .ENV ---
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN; // Ahora lo leemos desde .env
const PORT = process.env.PORT || 3000; // El servidor nos dará un puerto, si no, usamos 3000

const RECIPIENT_PHONE_NUMBER = "59892484684";
const LOCAL_IMAGE_FOLDER = 'public';
const LOCAL_IMAGE_FILENAME = 'cedula_ejemplo.jpg';
const PAUSE_DURATION = 5000;

// --- INICIALIZACIÓN DEL SERVIDOR EXPRESS ---
const app = express();
app.use(express.json());

// --- FUNCIONES DE ENVÍO (sin cambios) ---
const API_URL = `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`;
const HEADERS = { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' };
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function sendWhatsAppMessage(data) { /* ... esta función no cambia ... */ }

// --- WEBHOOK (sin cambios) ---
app.get('/webhook', (req, res) => { /* ... esta función no cambia ... */ });
app.post('/webhook', (req, res) => { /* ... esta función no cambia ... */ });

// --- RUTA DE PRUEBA Y PARA SERVIR IMÁGENES ---
// Hacemos que la carpeta 'public' sea accesible
app.use('/static', express.static(path.join(__dirname, LOCAL_IMAGE_FOLDER)));
// Una ruta raíz para saber que el servidor está vivo
app.get('/', (req, res) => {
    res.send('¡El servidor del bot de WhatsApp está vivo y coleando!');
});

// --- FUNCIÓN DE INICIO DEL SERVIDOR ---
async function startServer() {
    app.listen(PORT, async () => {
        console.log(`🚀 Servidor iniciado y escuchando en el puerto ${PORT}`);
        
        // --- Opcional: Enviar secuencia al iniciar ---
        // Descomenta las siguientes líneas si quieres que el bot envíe la secuencia CADA VEZ que el servidor se reinicie.
        // OJO: Los servicios gratuitos se reinician aprox. una vez al día.
        /*
        try {
            console.log("Ejecutando secuencia de envío inicial...");
            const publicUrl = `TU_URL_DE_RENDER/static/${LOCAL_IMAGE_FILENAME}`; // Necesitarás la URL final aquí
            await sendWhatsAppMessage({ type: "template", template: { name: "hello_world", language: { code: "en_US" } } });
            await delay(PAUSE_DURATION);
            await sendWhatsAppMessage({ type: "text", text: { body: "3" } });
            await delay(PAUSE_DURATION);
            await sendWhatsAppMessage({ type: "image", image: { link: publicUrl } });
            console.log("✅ Secuencia de envío inicial completada.");
        } catch (error) {
            console.error("Falló la secuencia de envío inicial:", error);
        }
        */
       console.log("🤖 El bot está en modo de escucha permanente.");
    });
}

// Re-pego las funciones que marqué como "sin cambios" para que tengas el código completo y funcional
async function sendWhatsAppMessage(data) {
    try {
        await axios.post(API_URL, { messaging_product: "whatsapp", to: RECIPIENT_PHONE_NUMBER, ...data }, { headers: HEADERS });
        console.log(`✅ Mensaje de tipo '${data.type}' enviado con éxito.`);
    } catch (error) {
        console.error(`❌ Error al enviar mensaje de tipo '${data.type}':`, error.response?.data?.error || error.message);
    }
}
app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else {
        res.status(403).send("Forbidden");
    }
});
app.post('/webhook', (req, res) => {
    const body = req.body;
    if (body.object === 'whatsapp_business_account' && body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
        const message = body.entry[0].changes[0].value.messages[0];
        console.log("\n=============================================");
        console.log(`<<<<< MENSAJE RECIBIDO DE ${message.from}! >>>>>`);
        if (message.type === 'text') console.log(`   💬 Contenido: "${message.text.body}"`);
        else console.log(`   ❔ Tipo de mensaje: ${message.type}`);
        console.log("=============================================\n");
    }
    res.sendStatus(200);
});


// ¡Ejecutar el servidor!
startServer();