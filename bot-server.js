require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const axios = require('axios');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const { Pool } = require('pg');
const AdmZip = require('adm-zip');

// --- CONFIGURACIÓN DINÁMICA DE REMITENTES ---
const PHONE_NUMBER_IDS = process.env.PHONE_NUMBER_IDS ? process.env.PHONE_NUMBER_IDS.split(',') : [];
const WHATSAPP_TOKENS = process.env.WHATSAPP_TOKENS ? process.env.WHATSAPP_TOKENS.split(',') : [];
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = process.env.PORT || 3000;
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

if (PHONE_NUMBER_IDS.length === 0 || PHONE_NUMBER_IDS.length !== WHATSAPP_TOKENS.length) {
    console.error("❌ Error Crítico: La configuración de remitentes en .env es inválida.");
    process.exit(1);
}

const senderPool = PHONE_NUMBER_IDS.map((id, index) => ({ id: id.trim(), token: WHATSAPP_TOKENS[index].trim() }));
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json());

const UPLOADS_DIR = path.join(__dirname, 'uploads');
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
const upload = multer({ dest: TEMP_DIR });

// --- ESTADO GLOBAL: GESTIÓN DE MÚLTIPLES CONVERSACIONES CONCURRENTES ---
let taskQueue = [];
let availableWorkers = new Set(senderPool.map((_, index) => index));
let activeConversations = new Map(); // Clave: workerIndex, Valor: { task, state, timeout, messageIdToWaitFor }

// --- FUNCIÓN DE LOGGING ---
function logAndEmit(text, type = 'log-info') {
    console.log(text);
    io.emit('status-update', { text, type });
}

// --- INICIALIZACIÓN DE BASE DE DATOS (DOS TABLAS SEPARADAS) ---
async function initializeDatabase() {
    const client = await pool.connect();
    try {
        await client.query(`CREATE TABLE IF NOT EXISTS envios (id SERIAL PRIMARY KEY, numero_destino VARCHAR(255) NOT NULL, nombre_imagen VARCHAR(255), remitente_usado VARCHAR(255), estado VARCHAR(50), creado_en TIMESTAMPTZ DEFAULT NOW());`);
        await client.query(`CREATE TABLE IF NOT EXISTS confirmados (id SERIAL PRIMARY KEY, numero_confirmado VARCHAR(255) NOT NULL, mensaje_confirmacion VARCHAR(255), confirmado_en TIMESTAMPTZ DEFAULT NOW());`);
        console.log("✅ Tablas 'envios' y 'confirmados' verificadas.");
    } catch (err) {
        console.error("❌ Error al inicializar la base de datos:", err);
    } finally {
        client.release();
    }
}

// --- LÓGICA DE SOCKET.IO ---
io.on('connection', (socket) => { /* Sin cambios */ });

// --- ENDPOINTS ---
app.get('/panel', (req, res) => res.sendFile(path.join(__dirname, 'panel.html')));
app.use('/uploads', express.static(UPLOADS_DIR));
app.get('/', (req, res) => res.send('Servidor activo. Visita /panel para usar el control.'));

// WEBHOOK CON MATCHING DE CONTEXTO
app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return;

    const from = message.from;
    const repliedMessageId = message.context?.id;

    // 1. Lógica Pasiva de Confirmación (siempre se ejecuta)
    if (message.type === 'text') {
        const textBody = message.text.body.trim();
        if (/^confirmado\s+\d{8}$/i.test(textBody)) {
            const cedula = textBody.split(/\s+/)[1];
            logAndEmit(`[Confirmación Pasiva] ✅ Detectada cédula ${cedula} de ${from}`, 'log-success');
            try {
                await pool.query(`INSERT INTO confirmados (numero_confirmado, mensaje_confirmacion) VALUES ($1, $2)`, [from, cedula]);
                io.emit('ver-confirmados');
            } catch (dbError) { /* ... */ }
        }
    }

    // 2. Lógica Activa de Conversación (solo si es una respuesta a un mensaje nuestro)
    if (!repliedMessageId) return;

    // Buscamos en todas las conversaciones activas cuál esperaba este mensaje
    for (const [workerIndex, conversation] of activeConversations.entries()) {
        if (conversation.messageIdToWaitFor === repliedMessageId) {
            clearTimeout(conversation.timeout);

            if (conversation.state === 'AWAITING_INITIAL_REPLY') {
                logAndEmit(`[Worker ${workerIndex}] 💬 Respuesta inicial recibida. Continuando...`, 'log-info');
                await continueSequence(workerIndex);
            } else if (conversation.state === 'AWAITING_FINAL_REPLY') {
                logAndEmit(`[Worker ${workerIndex}] 🏁 Respuesta final recibida. Cerrando conversación.`, 'log-info');
                releaseAndContinue(workerIndex);
            }
            break; // Salimos del bucle una vez encontrada la conversación
        }
    }
});


// ENDPOINT PARA SUBIR EL ZIP
app.post('/subir-zip', async (req, res) => { /* Sin cambios */ });

// --- LÓGICA DE PROCESAMIENTO CONCURRENTE ---
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function releaseAndContinue(workerIndex) {
    if (activeConversations.has(workerIndex)) {
        const conversation = activeConversations.get(workerIndex);
        clearTimeout(conversation.timeout);
        availableWorkers.add(workerIndex);
        activeConversations.delete(workerIndex);
        logAndEmit(`🟢 [Worker ${workerIndex}] liberado. Libres: ${availableWorkers.size}.`, 'log-info');
        setTimeout(processQueue, 500);
    }
}

async function processQueue() {
    while (availableWorkers.size > 0 && taskQueue.length > 0) {
        const workerIndex = availableWorkers.values().next().value;
        availableWorkers.delete(workerIndex); // Marcar como ocupado

        const task = taskQueue.shift();
        io.emit('queue-update', taskQueue.length);

        logAndEmit(`▶️ [Worker ${workerIndex}] iniciando tarea para ${task.recipientNumber}.`, 'log-info');
        startSequence(task, workerIndex); // Iniciar sin await para permitir concurrencia
    }
}

async function startSequence(task, workerIndex) {
    const sender = senderPool[workerIndex];
    const API_URL = `https://graph.facebook.com/v19.0/${sender.id}/messages`;
    const HEADERS = { 'Authorization': `Bearer ${sender.token}`, 'Content-Type': 'application/json' };

    try {
        await pool.query('INSERT INTO envios (numero_destino, nombre_imagen, remitente_usado, estado) VALUES ($1, $2, $3, $4)', [task.recipientNumber, task.imageName, sender.id, 'procesando']);
        
        logAndEmit(`[Worker ${workerIndex}] 📤 1/3: Enviando Template...`, 'log-info');
        const response = await axios.post(API_URL, { messaging_product: "whatsapp", to: task.recipientNumber, type: "template", template: { name: "hello_world", language: { code: "en_US" } } }, { headers: HEADERS });
        
        const messageId = response.data.messages[0].id; // Capturamos el ID del mensaje enviado
        
        activeConversations.set(workerIndex, {
            task,
            state: 'AWAITING_INITIAL_REPLY',
            messageIdToWaitFor: messageId, // Lo guardamos en el estado
            timeout: setTimeout(() => {
                logAndEmit(`[Worker ${workerIndex}] ⏰ ¡TIMEOUT! (Respuesta inicial).`, 'log-warn');
                releaseAndContinue(workerIndex);
            }, 300000)
        });

        logAndEmit(`[Worker ${workerIndex}] ⏳ Esperando respuesta al mensaje ${messageId}...`, 'log-info');
    } catch (error) {
        logAndEmit(`[Worker ${workerIndex}] 🚫 Falló el envío del template.`, 'log-error');
        releaseAndContinue(workerIndex);
    }
}

async function continueSequence(workerIndex) {
    const conversation = activeConversations.get(workerIndex);
    if (!conversation) return;
    const { task } = conversation;

    const sender = senderPool[workerIndex];
    const API_URL = `https://graph.facebook.com/v19.0/${sender.id}/messages`;
    const HEADERS = { 'Authorization': `Bearer ${sender.token}`, 'Content-Type': 'application/json' };

    try {
        logAndEmit(`[Worker ${workerIndex}] 📤 2/3: Enviando "3"...`, 'log-info');
        await axios.post(API_URL, { messaging_product: "whatsapp", to: task.recipientNumber, type: "text", text: { body: "3" } }, { headers: HEADERS });
        await delay(3000);
        
        const publicImageUrl = `${RENDER_EXTERNAL_URL}/uploads/${task.imageName}`;
        logAndEmit(`[Worker ${workerIndex}] 📤 3/3: Enviando imagen ${task.imageName}...`, 'log-info');
        const response = await axios.post(API_URL, { messaging_product: "whatsapp", to: task.recipientNumber, type: "image", image: { link: publicImageUrl } }, { headers: HEADERS });

        const messageId = response.data.messages[0].id; // Capturamos el ID del nuevo mensaje

        await pool.query('UPDATE envios SET estado = $1 WHERE nombre_imagen = $2 AND remitente_usado = $3', ['enviado', task.imageName, sender.id]);
        
        // Actualizamos el estado de la conversación con el nuevo ID que estamos esperando
        conversation.state = 'AWAITING_FINAL_REPLY';
        conversation.messageIdToWaitFor = messageId;
        conversation.timeout = setTimeout(() => {
            logAndEmit(`[Worker ${workerIndex}] ⏰ ¡TIMEOUT! (Respuesta final).`, 'log-warn');
            releaseAndContinue(workerIndex);
        }, 300000);

        logAndEmit(`[Worker ${workerIndex}] ⏳ Esperando respuesta final al mensaje ${messageId}...`, 'log-info');
    } catch (error) {
        logAndEmit(`[Worker ${workerIndex}] 🚫 Falló el envío de la imagen.`, 'log-error');
        releaseAndContinue(workerIndex);
    } finally {
        const imagePath = path.join(UPLOADS_DIR, task.imageName);
        setTimeout(() => fs.unlink(imagePath, () => {}), 60000 * 10);
    }
}

// --- INICIO DEL SERVIDOR ---
server.listen(PORT, async () => {
    console.log(`🚀 Servidor iniciado. Pool de ${senderPool.length} remitente(s) listo.`);
    await initializeDatabase();
});