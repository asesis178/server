require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const multer = require('multer'); // Importamos multer
const fs = require('fs'); // Módulo de sistema de archivos para borrar la imagen después

// --- CONFIGURACIÓN ---
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID; // Volvemos a usar un solo ID
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PORT = process.env.PORT || 3000;
const RENDER_EXTERNAL_URL = "https://server-2-ydpr.onrender.com"; // <-- ¡Verifica que sea tu URL!
const PAUSE_DURATION = 5000;

// --- CONFIGURACIÓN DE SUBIDA DE ARCHIVOS ---
// Le decimos a multer dónde guardar los archivos temporalmente
const upload = multer({ dest: 'uploads/' });

// --- INICIALIZACIÓN DE EXPRESS ---
const app = express();
app.use(express.json());

// --- FUNCIONES Y SECUENCIA ---
const API_URL_BASE = "https://graph.facebook.com/v22.0";
const HEADERS = { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' };
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function sendWhatsAppMessage(data, recipientNumber) {
    const API_URL = `${API_URL_BASE}/${PHONE_NUMBER_ID}/messages`;
    try {
        await axios.post(API_URL, { messaging_product: "whatsapp", to: recipientNumber, ...data }, { headers: HEADERS });
        console.log(`✅ Mensaje de tipo '${data.type}' enviado a ${recipientNumber}.`);
    } catch (error) {
        console.error(`❌ Error al enviar mensaje de tipo '${data.type}':`, error.response?.data?.error || error.message);
    }
}

async function executeSendSequence(recipientNumber, imageFile) {
    // Construimos la URL pública de la imagen subida
    const publicImageUrl = `${RENDER_EXTERNAL_URL}/${imageFile.path}`;
    console.log(`🚀 Iniciando secuencia para ${recipientNumber} con la imagen: ${publicImageUrl}`);

    try {
        await sendWhatsAppMessage({ type: "template", template: { name: "hello_world", language: { code: "en_US" } } }, recipientNumber);
        await delay(PAUSE_DURATION);
        await sendWhatsAppMessage({ type: "text", text: { body: "3" } }, recipientNumber);
        await delay(PAUSE_DURATION);
        await sendWhatsAppMessage({ type: "image", image: { link: publicImageUrl } }, recipientNumber);
        console.log("✅ Secuencia completada exitosamente.");
    } catch (error) {
        console.error("🚫 La secuencia fue interrumpida por un error.", error);
    } finally {
        // ¡Importante! Borramos la imagen del servidor después de un tiempo para no acumular archivos.
        setTimeout(() => {
            fs.unlink(imageFile.path, (err) => {
                if (err) console.error("Error al borrar el archivo temporal:", err);
                else console.log(`Archivo temporal ${imageFile.path} borrado.`);
            });
        }, 60000); // Borra después de 1 minuto
    }
}

// --- ENDPOINTS ---
app.get('/panel', (req, res) => res.sendFile(path.join(__dirname, 'panel.html')));
app.get('/webhook', (req, res) => { /* ... (no cambia) ... */ });
app.post('/webhook', (req, res) => { /* ... (no cambia) ... */ });

// NUEVO ENDPOINT PARA INICIAR SECUENCIA (con subida de archivo)
// 'upload.single('imageFile')' es el middleware que procesa la imagen
app.post('/iniciar-secuencia', upload.single('imageFile'), (req, res) => {
    const destinationNumber = req.body.destinationNumber;
    const imageFile = req.file;

    if (!destinationNumber || !imageFile) {
        return res.status(400).send("Faltan el número de destino o el archivo de imagen.");
    }

    // Disparamos la secuencia en segundo plano para no hacer esperar al usuario
    executeSendSequence(destinationNumber, imageFile);

    res.send("<h1>¡Solicitud recibida!</h1><p>La secuencia de mensajes se está enviando. Revisa WhatsApp y los logs de Render.</p>");
});

// Hacemos la carpeta 'uploads' accesible públicamente para que Meta pueda descargar la imagen
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.get('/', (req, res) => res.send('¡Servidor activo! Visita /panel para enviar.'));

// --- INICIO DEL SERVIDOR ---
app.listen(PORT, () => {
    console.log(`🚀 Servidor iniciado. Escuchando en el puerto ${PORT}`);
});

// --- CÓDIGO COMPLETO DE FUNCIONES REUTILIZADAS ---
app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else { res.sendStatus(403); }
});
app.post('/webhook', (req, res) => {
    const body = req.body;
    if (body.object === 'whatsapp_business_account' && body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
        const message = body.entry[0].changes[0].value.messages[0];
        console.log(`\n> Mensaje de ${message.from}: "${message.text?.body || `(Tipo: ${message.type})`}"`);
    }
    res.sendStatus(200);
});