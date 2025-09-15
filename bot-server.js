require('dotenv').config();
const express = require('express');
const http = require('http'); // Necesitamos el módulo http de Node
const { Server } = require("socket.io"); // Importamos Socket.IO
const axios = require('axios');
const path = require('path');

// --- CONFIGURACIÓN ---
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PORT = process.env.PORT || 3000;
const RENDER_EXTERNAL_URL = "https://server-2-ydpr.onrender.com";

const PUBLIC_FOLDER = 'public';
const IMAGE_FILENAME = 'cedula_ejemplo.jpg';
const PAUSE_DURATION = 5000;

// --- INICIALIZACIÓN DE SERVIDORES ---
const app = express();
const server = http.createServer(app); // Creamos un servidor http
const io = new Server(server); // Conectamos Socket.IO al servidor http

app.use(express.json());

// --- FUNCIONES Y SECUENCIA (no cambian) ---
const API_URL = `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`;
const HEADERS = { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' };
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function sendWhatsAppMessage(data, recipientNumber) { /* ... (código completo al final) ... */ }
async function executeSendSequence(recipientNumber, socket) { /* ... (código completo al final) ... */ }


// --- LÓGICA DE SOCKET.IO ---
io.on('connection', (socket) => {
    console.log('✅ Un usuario se ha conectado al panel web.');
    
    socket.on('iniciar-secuencia', (phoneNumber) => {
        console.log(`Recibida orden de iniciar secuencia para: ${phoneNumber}`);
        // Pasamos el socket a la función para que pueda enviar actualizaciones de estado
        executeSendSequence(phoneNumber, socket);
    });

    socket.on('disconnect', () => {
        console.log('❌ Un usuario se ha desconectado del panel web.');
    });
});


// --- ENDPOINTS DE EXPRESS ---
app.get('/panel', (req, res) => res.sendFile(path.join(__dirname, 'panel.html')));
app.get('/webhook', (req, res) => { /* ... (no cambia) ... */ });
app.post('/webhook', (req, res) => {
    const body = req.body;
    if (body.object === 'whatsapp_business_account' && body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
        const message = body.entry[0].changes[0].value.messages[0];
        console.log(`Mensaje recibido de ${message.from}: "${message.text?.body}"`);
        
        // ¡Magia! Enviamos el mensaje recibido a TODOS los paneles web conectados.
        io.emit('nueva-respuesta', {
            from: message.from,
            text: message.text?.body || `(Mensaje de tipo ${message.type})`
        });
    }
    res.sendStatus(200);
});
app.use('/static', express.static(path.join(__dirname, PUBLIC_FOLDER)));
app.get('/', (req, res) => res.send('¡Servidor activo! Visita /panel para usar el control.'));


// --- INICIO DEL SERVIDOR HTTP (en lugar de app.listen) ---
server.listen(PORT, () => {
    console.log(`🚀 Servidor iniciado. Escuchando en el puerto ${PORT}`);
    console.log("🤖 El bot y el panel interactivo están listos.");
});


// --- CÓDIGO COMPLETO DE FUNCIONES REUTILIZADAS ---
async function sendWhatsAppMessage(data, recipientNumber) {
    try {
        await axios.post(API_URL, { messaging_product: "whatsapp", to: recipientNumber, ...data }, { headers: HEADERS });
        console.log(`✅ Mensaje de tipo '${data.type}' enviado a ${recipientNumber}.`);
        return true;
    } catch (error) {
        console.error(`❌ Error al enviar mensaje de tipo '${data.type}':`, error.response?.data?.error || error.message);
        return false;
    }
}
async function executeSendSequence(recipientNumber, socket) {
    socket.emit('status-update', { text: `Enviando secuencia a ${recipientNumber}...`, isError: false });
    try {
        await sendWhatsAppMessage({ type: "template", template: { name: "hello_world", language: { code: "en_US" } } }, recipientNumber);
        await delay(PAUSE_DURATION);
        await sendWhatsAppMessage({ type: "text", text: { body: "3" } }, recipientNumber);
        await delay(PAUSE_DURATION);
        const publicImageUrl = `${RENDER_EXTERNAL_URL}/static/${IMAGE_FILENAME}`;
        await sendWhatsAppMessage({ type: "image", image: { link: publicImageUrl } }, recipientNumber);
        socket.emit('status-update', { text: `✅ Secuencia enviada a ${recipientNumber} con éxito.`, isError: false });
    } catch (error) {
        socket.emit('status-update', { text: `🚫 Falló la secuencia para ${recipientNumber}.`, isError: true });
    }
}
app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else { res.sendStatus(403); }
});