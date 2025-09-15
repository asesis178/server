require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const axios = require('axios');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

// --- CONFIGURACIÓN ---
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PORT = process.env.PORT || 3000;
const RENDER_EXTERNAL_URL = "https://server-2-ydpr.onrender.com";
const PAUSE_DURATION = 5000;

// --- PREPARACIÓN DEL SISTEMA DE ARCHIVOS Y MULTER ---
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage: storage });

// --- INICIALIZACIÓN DE SERVIDORES ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json());

// --- FUNCIONES Y SECUENCIA ---
const API_URL = `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`;
const HEADERS = { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' };
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function executeSendSequence(recipientNumber, imageFile, socket) { /* ... (código completo al final) ... */ }
async function sendWhatsAppMessage(data, recipient) { /* ... (código completo al final) ... */ }

// --- LÓGICA DE SOCKET.IO ---
io.on('connection', (socket) => {
    // Log para saber que el navegador se conectó correctamente
    console.log(`[Socket.IO] ✅ Un usuario se ha conectado al panel web. ID: ${socket.id}`);
    
    socket.on('disconnect', () => {
        console.log(`[Socket.IO] ❌ Un usuario se ha desconectado. ID: ${socket.id}`);
    });
});

// --- ENDPOINTS DE EXPRESS ---
app.get('/panel', (req, res) => res.sendFile(path.join(__dirname, 'panel.html')));
app.get('/webhook', (req, res) => { /* ... (código completo al final) ... */ });

// WEBHOOK CORREGIDO Y CON MÁS LOGS
// ... (todo el código anterior a esto se queda igual) ...

// WEBHOOK MÁS INTELIGENTE Y MENOS RUIDOSO
app.post('/webhook', (req, res) => {
    const body = req.body;

    // Inmediatamente respondemos a Meta para que no espere.
    // Esto es crucial para un buen rendimiento.
    res.sendStatus(200);

    // Verificamos si la notificación es sobre un MENSAJE NUEVO.
    // Los mensajes de usuarios están en 'entry[0].changes[0].value.messages'.
    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    // Si 'message' existe, significa que es un mensaje de un usuario.
    if (message) {
        console.log(`[Webhook] Mensaje de usuario detectado de ${message.from}.`);
        const dataToSend = {
            from: message.from,
            text: message.text?.body || `(Mensaje de tipo ${message.type})`
        };
        
        // Solo si es un mensaje de usuario, lo emitimos al panel.
        io.emit('nueva-respuesta', dataToSend);
        
        console.log('[Socket.IO] Evento "nueva-respuesta" emitido al panel.');
        
        return; // Terminamos la ejecución para este caso.
    }

    // Verificamos si la notificación es sobre un ESTADO (delivered, read, sent).
    // Estos son los que generan "ruido".
    const status = body.entry?.[0]?.changes?.[0]?.value?.statuses?.[0];
    if (status) {
        // Simplemente lo registramos de forma silenciosa y no hacemos nada más.
        // Puedes incluso comentar la siguiente línea si no quieres ver NADA.
        console.log(`[Webhook] Notificación de estado recibida: ${status.status}. Ignorando.`);
        
        return; // Terminamos la ejecución.
    }

    // Si llega aquí, es otro tipo de notificación que no manejamos.
    console.log('[Webhook] Notificación recibida que no es ni mensaje ni estado. Ignorando.');
});


// ... (el resto del código, como app.post('/iniciar-secuencia'), etc., se queda igual) ...

app.post('/iniciar-secuencia', upload.single('imageFile'), (req, res) => {
    const { destinationNumber } = req.body;
    const imageFile = req.file;
    if (!destinationNumber || !imageFile) {
        return res.status(400).json({ message: "Faltan datos." });
    }
    // Usamos 'io' para emitir estados a todos, ya que no tenemos un socket específico para esta petición HTTP
    executeSendSequence(destinationNumber, imageFile, io);
    res.status(200).json({ message: "Solicitud recibida." });
});

app.use('/uploads', express.static(UPLOADS_DIR));
app.get('/', (req, res) => res.send('¡Servidor activo! Visita /panel para usar el control.'));

// --- INICIO DEL SERVIDOR HTTP ---
server.listen(PORT, () => {
    console.log(`🚀 Servidor iniciado. Escuchando en el puerto ${PORT}`);
});

// --- CÓDIGO COMPLETO DE FUNCIONES REUTILIZADAS ---
async function executeSendSequence(recipientNumber, imageFile, socket) {
    const publicImageUrl = `${RENDER_EXTERNAL_URL}/uploads/${imageFile.filename}`;
    socket.emit('status-update', { text: `Enviando secuencia a ${recipientNumber}...`, isError: false });
    try {
        await sendWhatsAppMessage({ type: "template", template: { name: "hello_world", language: { code: "en_US" } } }, recipientNumber);
        await delay(PAUSE_DURATION);
        await sendWhatsAppMessage({ type: "text", text: { body: "3" } }, recipientNumber);
        await delay(PAUSE_DURATION);
        await sendWhatsAppMessage({ type: "image", image: { link: publicImageUrl } }, recipientNumber);
        socket.emit('status-update', { text: `✅ Secuencia enviada a ${recipientNumber} con éxito.`, isError: false, isComplete: true });
    } catch (error) {
        socket.emit('status-update', { text: `🚫 Falló la secuencia para ${recipientNumber}. Revisa los logs.`, isError: true, isComplete: true });
    } finally {
        setTimeout(() => {
            fs.unlink(imageFile.path, (err) => {
                if (err) console.error(`Error al borrar archivo ${imageFile.path}:`, err);
                else console.log(`Archivo temporal ${imageFile.path} borrado.`);
            });
        }, 60000);
    }
}
async function sendWhatsAppMessage(data, recipientNumber) {
    try {
        await axios.post(API_URL, { messaging_product: "whatsapp", to: recipientNumber, ...data }, { headers: HEADERS });
    } catch (error) {
        console.error(`❌ Error al enviar mensaje de tipo '${data.type}':`, error.response?.data?.error || error.message);
        throw error;
    }
}
app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else { res.sendStatus(403); }
});