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

// Validar que tengamos la misma cantidad de IDs y Tokens
if (PHONE_NUMBER_IDS.length === 0 || PHONE_NUMBER_IDS.length !== WHATSAPP_TOKENS.length) {
    console.error("❌ Error Crítico: La cantidad de PHONE_NUMBER_IDS y WHATSAPP_TOKENS en el .env no coincide o está vacía.");
    process.exit(1); // Detener la aplicación si la configuración es inválida
}

// Crear el pool de "trabajadores"
const senderPool = PHONE_NUMBER_IDS.map((id, index) => ({
    id: id.trim(),
    token: WHATSAPP_TOKENS[index].trim(),
}));

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

// --- ESTADO GLOBAL REFACTORIZADO PARA CONCURRENCIA ---
let taskQueue = [];
let activeConversations = new Map(); // Clave: recipientNumber, Valor: { task, state, timeout, workerIndex }
// Pool de trabajadores disponibles, guardamos sus índices (0, 1, 2, ...)
let availableWorkers = new Set(senderPool.map((_, index) => index));


// --- FUNCIÓN DE LOGGING ---
function logAndEmit(text, type = 'log-info') {
    console.log(text);
    io.emit('status-update', { text, type });
}

// --- INICIALIZACIÓN DE BASE DE DATOS ---
async function initializeDatabase() {
    const client = await pool.connect();
    try {
        await client.query(`CREATE TABLE IF NOT EXISTS envios (id SERIAL PRIMARY KEY, numero_destino VARCHAR(255) NOT NULL, nombre_imagen VARCHAR(255), estado VARCHAR(50), creado_en TIMESTAMPTZ DEFAULT NOW());`);
        await client.query(`CREATE TABLE IF NOT EXISTS confirmados (id SERIAL PRIMARY KEY, numero_confirmado VARCHAR(255) NOT NULL, mensaje_confirmacion VARCHAR(255), confirmado_en TIMESTAMPTZ DEFAULT NOW());`);
        console.log("✅ Tablas 'envios' y 'confirmados' verificadas.");
    } catch (err) {
        console.error("❌ Error al inicializar la base de datos:", err);
    } finally {
        client.release();
    }
}

// --- LÓGICA DE SOCKET.IO ---
io.on('connection', (socket) => {
    console.log(`[Socket.IO] Usuario conectado: ${socket.id}`);
    socket.emit('queue-update', taskQueue.length);
    socket.on('ver-confirmados', async () => { /* ... */ });
    socket.on('limpiar-confirmados', async () => { /* ... */ });
});

// --- ENDPOINTS ---
app.get('/panel', (req, res) => res.sendFile(path.join(__dirname, 'panel.html')));
app.use('/uploads', express.static(UPLOADS_DIR));
app.get('/', (req, res) => res.send('Servidor activo. Visita /panel para usar el control.'));

// WEBHOOK PARA MÚLTIPLES CONVERSACIONES
app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const from = message?.from;

    const conversation = activeConversations.get(from);
    if (!conversation || !message || message.type !== 'text') return;

    const textBody = message.text.body.trim();
    clearTimeout(conversation.timeout);

    if (conversation.state === 'AWAITING_INITIAL_REPLY') {
        logAndEmit(`[${from}] 💬 Respuesta inicial: "${textBody}". Continuando...`, 'log-info');
        await continueSequenceAfterInitialReply(conversation.task, conversation.workerIndex);
    } else if (conversation.state === 'AWAITING_CONFIRMATION') {
        if (/^confirmado\s+\d{8}$/i.test(textBody)) {
            const cedula = textBody.split(/\s+/)[1];
            logAndEmit(`[${from}] ✅ Confirmación VÁLIDA con cédula: ${cedula}`, 'log-success');
            try {
                await pool.query(`INSERT INTO confirmados (numero_confirmado, mensaje_confirmacion) VALUES ($1, $2)`, [from, cedula]);
                const result = await pool.query('SELECT * FROM confirmados ORDER BY confirmado_en DESC');
                io.emit('datos-confirmados', result.rows);
            } catch (dbError) {
                logAndEmit(`[${from}] ❌ Error al guardar en DB.`, 'log-error');
            }
        } else {
            logAndEmit(`[${from}] ❌ Respuesta no es una confirmación: "${textBody}".`, 'log-warn');
        }
        releaseAndContinue(from);
    }
});

// ENDPOINT PARA SUBIR EL ZIP
app.post('/subir-zip', upload.single('zipFile'), async (req, res) => {
    // (Este código no cambia, solo encola tareas y llama a processQueue)
    const { destinationNumber } = req.body;
    const zipFile = req.file;

    if (!destinationNumber || !zipFile) return res.status(400).json({ message: "Faltan datos." });

    try {
        const zip = new AdmZip(zipFile.path);
        zip.extractAllTo(UPLOADS_DIR, true);
        const imageFiles = zip.getEntries().filter(e => !e.isDirectory && /\.(jpg|jpeg|png)$/i.test(e.entryName)).map(e => e.entryName);
        if (imageFiles.length === 0) return res.status(400).json({ message: "El ZIP no contiene imágenes." });

        const newTasks = imageFiles.map(imageName => ({ recipientNumber: destinationNumber, imageName }));
        taskQueue.push(...newTasks);

        logAndEmit(`📦 Se agregaron ${newTasks.length} tareas. Total en cola: ${taskQueue.length}`, 'log-info');
        io.emit('queue-update', taskQueue.length);
        
        processQueue(); // Despertar al despachador

        res.status(200).json({ message: `Se han encolado ${newTasks.length} envíos.` });
    } catch (error) {
        res.status(500).json({ message: "Error al procesar el ZIP." });
    } finally {
        fs.unlink(zipFile.path, () => {});
    }
});

// --- LÓGICA DE PROCESAMIENTO DE TAREAS MULTI-REMITENTE ---
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function releaseAndContinue(recipientNumber) {
    const conversation = activeConversations.get(recipientNumber);
    if (conversation) {
        clearTimeout(conversation.timeout);
        availableWorkers.add(conversation.workerIndex); // Devolver el trabajador al pool de disponibles
        activeConversations.delete(recipientNumber);
        logAndEmit(`🟢 [Worker ${conversation.workerIndex}] liberado. Trabajadores libres: ${availableWorkers.size}. Conversaciones activas: ${activeConversations.size}`, 'log-info');
        setTimeout(processQueue, 500); // Intentar despachar una nueva tarea
    }
}

async function processQueue() {
    // Mientras haya trabajadores libres Y tareas en la cola
    while (availableWorkers.size > 0 && taskQueue.length > 0) {
        // Tomar el primer trabajador disponible del Set
        const workerIndex = availableWorkers.values().next().value;
        availableWorkers.delete(workerIndex); // Marcarlo como ocupado

        const task = taskQueue.shift();
        io.emit('queue-update', taskQueue.length);

        if (activeConversations.has(task.recipientNumber)) {
            logAndEmit(`🟡 Número ${task.recipientNumber} ya está en una conversación. Devolviendo tarea a la cola.`, 'log-warn');
            taskQueue.push(task);
            availableWorkers.add(workerIndex); // Devolver el trabajador, no se usó
            continue;
        }

        logAndEmit(`▶️ [Worker ${workerIndex}] asignado a la tarea para ${task.recipientNumber}.`, 'log-info');
        // Iniciar la secuencia de forma asíncrona (sin await)
        startSequence(task, workerIndex);
    }
}

async function startSequence(task, workerIndex) {
    const sender = senderPool[workerIndex];
    const API_URL = `https://graph.facebook.com/v19.0/${sender.id}/messages`;
    const HEADERS = { 'Authorization': `Bearer ${sender.token}`, 'Content-Type': 'application/json' };

    try {
        activeConversations.set(task.recipientNumber, { task, state: 'SENDING_TEMPLATE', timeout: null, workerIndex });

        logAndEmit(`[Worker ${workerIndex}] 📤 1/3: Enviando Template a ${task.recipientNumber}...`, 'log-info');
        await axios.post(API_URL, { messaging_product: "whatsapp", to: task.recipientNumber, type: "template", template: { name: "hello_world", language: { code: "en_US" } } }, { headers: HEADERS });
        
        const conversation = activeConversations.get(task.recipientNumber);
        conversation.state = 'AWAITING_INITIAL_REPLY';
        conversation.timeout = setTimeout(() => {
            logAndEmit(`[Worker ${workerIndex}] ⏰ ¡TIMEOUT! (Respuesta inicial) para ${task.recipientNumber}.`, 'log-warn');
            releaseAndContinue(task.recipientNumber);
        }, 300000);

        logAndEmit(`[Worker ${workerIndex}] ⏳ Esperando primera respuesta de ${task.recipientNumber}...`, 'log-info');
    } catch (error) {
        logAndEmit(`[Worker ${workerIndex}] 🚫 Falló el envío del template a ${task.recipientNumber}.`, 'log-error');
        releaseAndContinue(task.recipientNumber);
    }
}

async function continueSequenceAfterInitialReply(task, workerIndex) {
    const sender = senderPool[workerIndex];
    const API_URL = `https://graph.facebook.com/v19.0/${sender.id}/messages`;
    const HEADERS = { 'Authorization': `Bearer ${sender.token}`, 'Content-Type': 'application/json' };

    try {
        const conversation = activeConversations.get(task.recipientNumber);
        conversation.state = 'SENDING_IMAGE';
        
        logAndEmit(`[Worker ${workerIndex}] 📤 2/3: Enviando "3" a ${task.recipientNumber}...`, 'log-info');
        await axios.post(API_URL, { messaging_product: "whatsapp", to: task.recipientNumber, type: "text", text: { body: "3" } }, { headers: HEADERS });
        await delay(3000);
        
        const publicImageUrl = `${RENDER_EXTERNAL_URL}/uploads/${task.imageName}`;
        logAndEmit(`[Worker ${workerIndex}] 📤 3/3: Enviando imagen ${task.imageName}...`, 'log-info');
        await axios.post(API_URL, { messaging_product: "whatsapp", to: task.recipientNumber, type: "image", image: { link: publicImageUrl } }, { headers: HEADERS });

        await pool.query('INSERT INTO envios (numero_destino, nombre_imagen, estado) VALUES ($1, $2, $3)', [task.recipientNumber, task.imageName, 'enviado']);
        
        conversation.state = 'AWAITING_CONFIRMATION';
        conversation.timeout = setTimeout(() => {
            logAndEmit(`[Worker ${workerIndex}] ⏰ ¡TIMEOUT! (Confirmación final) para ${task.recipientNumber}.`, 'log-warn');
            releaseAndContinue(task.recipientNumber);
        }, 300000);

        logAndEmit(`[Worker ${workerIndex}] ⏳ Esperando confirmación final de ${task.recipientNumber}...`, 'log-info');
    } catch (error) {
        logAndEmit(`[Worker ${workerIndex}] 🚫 Falló el envío de la imagen a ${task.recipientNumber}.`, 'log-error');
        releaseAndContinue(task.recipientNumber);
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