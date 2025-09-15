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

// --- PREPARACIÓN DEL SISTEMA DE ARCHIVOS Y MULTER (VERSIÓN CORREGIDA) ---
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Configuración avanzada de Multer para preservar el nombre del archivo original
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, UPLOADS_DIR); // Guardar en la carpeta 'uploads'
    },
    filename: function (req, file, cb) {
        // Usar un timestamp + nombre original para evitar colisiones, pero manteniendo la extensión
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + file.originalname);
    }
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

async function executeSendSequence(recipientNumber, imageFile, socket) {
    // ¡CORRECCIÓN CLAVE! Construimos la URL pública usando el nombre del archivo que guardamos.
    const publicImageUrl = `${RENDER_EXTERNAL_URL}/uploads/${imageFile.filename}`;
    
    console.log(`🚀 Iniciando secuencia para ${recipientNumber} con la imagen pública: ${publicImageUrl}`);
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
        // Borramos la imagen después de 1 minuto
        setTimeout(() => {
            fs.unlink(imageFile.path, (err) => {
                if (err) console.error(`Error al borrar el archivo temporal ${imageFile.path}:`, err);
                else console.log(`Archivo temporal ${imageFile.path} borrado.`);
            });
        }, 60000);
    }
}

// --- LÓGICA DE SOCKET.IO ---
io.on('connection', (socket) => {
    console.log('✅ Un usuario se ha conectado al panel web.');
});

// --- ENDPOINTS DE EXPRESS ---
app.get('/panel', (req, res) => res.sendFile(path.join(__dirname, 'panel.html')));
app.get('/webhook', (req, res) => { /* ... (no cambia) ... */ });
app.post('/webhook', (req, res) => { /* ... (no cambia) ... */ });

app.post('/iniciar-secuencia', upload.single('imageFile'), (req, res) => {
    const { destinationNumber } = req.body;
    const imageFile = req.file;

    if (!destinationNumber || !imageFile) {
        return res.status(400).json({ message: "Faltan datos." });
    }
    executeSendSequence(destinationNumber, imageFile, io);
    res.status(200).json({ message: "Solicitud recibida." });
});

// ¡CORRECCIÓN CLAVE! Hacemos la carpeta 'uploads' accesible públicamente.
// Ahora, cuando se pida '/uploads/nombre-del-archivo.png', Express lo buscará en la carpeta UPLOADS_DIR.
app.use('/uploads', express.static(UPLOADS_DIR));
app.get('/', (req, res) => res.send('¡Servidor activo! Visita /panel para usar el control.'));

// --- INICIO DEL SERVIDOR HTTP ---
server.listen(PORT, () => {
    console.log(`🚀 Servidor iniciado. Escuchando en el puerto ${PORT}`);
});

// --- CÓDIGO COMPLETO DE FUNCIONES REUTILIZADAS (sin cambios) ---
async function sendWhatsAppMessage(data, recipientNumber) { /* ... */ }
app.get('/webhook', (req, res) => { /* ... */ });
app.post('/webhook', (req, res) => { /* ... */ });

// Pego el código completo de las funciones que no cambiaron para que sea un solo bloque
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
app.post('/webhook', (req, res) => {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (message) {
        console.log(`Mensaje recibido de ${message.from}: "${message.text?.body}"`);
        io.emit('nueva-respuesta', {
            from: message.from,
            text: message.text?.body || `(Mensaje de tipo ${message.type})`
        });
    }
    res.sendStatus(200);
});