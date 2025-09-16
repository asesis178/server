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

// --- CONFIGURACIÓN ---
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = process.env.PORT || 3000;
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json());

const UPLOADS_DIR = path.join(__dirname, 'uploads');
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
const upload = multer({ dest: TEMP_DIR });

// --- ESTADO GLOBAL ---
let taskQueue = [];
let isProcessing = false;
let currentTask = null;
let currentTaskState = null;
let responseTimeout = null;

// --- FUNCIÓN DE LOGGING ---
function logAndEmit(text, type = 'log-info') {
    console.log(text);
    io.emit('status-update', { text, type });
}

// --- INICIALIZACIÓN DE BASE DE DATOS ---
async function initializeDatabase() {
    const client = await pool.connect();
    try {
        await client.query(`CREATE TABLE IF NOT EXISTS envios (
            id SERIAL PRIMARY KEY, numero_destino VARCHAR(255) NOT NULL, nombre_imagen VARCHAR(255),
            estado VARCHAR(50) DEFAULT 'enviado', creado_en TIMESTAMPTZ DEFAULT NOW()
        );`);
        // CORRECCIÓN SUTIL PERO IMPORTANTE EN LA ESTRUCTURA DE LA TABLA
        await client.query(`CREATE TABLE IF NOT EXISTS confirmados (
            id SERIAL PRIMARY KEY,
            numero_confirmado VARCHAR(255) NOT NULL , 
            mensaje_confirmacion VARCHAR(255),
            confirmado_en TIMESTAMPTZ DEFAULT NOW()
        );`);
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

    socket.on('ver-confirmados', async () => {
        try {
            const result = await pool.query('SELECT numero_confirmado, mensaje_confirmacion, confirmado_en FROM confirmados ORDER BY confirmado_en DESC');
            socket.emit('datos-confirmados', result.rows);
        } catch (dbError) {
            console.error("Error al obtener confirmados:", dbError);
        }
    });

    socket.on('limpiar-confirmados', async () => {
        try {
            await pool.query('DELETE FROM confirmados');
            console.log("[DB] Tabla 'confirmados' limpiada.");
            io.emit('datos-confirmados', []);
            socket.emit('status-update', { text: "✅ DB de confirmados limpiada.", isError: false, isComplete: true });
        } catch (dbError) {
            console.error("Error al limpiar confirmados:", dbError);
            socket.emit('status-update', { text: "❌ Error al limpiar la DB.", isError: true, isComplete: true });
        }
    });
});

// --- ENDPOINTS ---
app.get('/panel', (req, res) => res.sendFile(path.join(__dirname, 'panel.html')));
app.use('/uploads', express.static(UPLOADS_DIR));
app.get('/', (req, res) => res.send('Servidor activo. Visita /panel para usar el control.'));

// WEBHOOK CON LÓGICA DE MÁQUINA DE ESTADOS
app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const from = message?.from;

    if (!isProcessing || !message || message.type !== 'text' || !currentTask || from !== currentTask.recipientNumber) {
        return;
    }

    const textBody = message.text.body.trim();

    clearTimeout(responseTimeout);
    responseTimeout = null;

    if (currentTaskState === 'AWAITING_INITIAL_REPLY') {
        logAndEmit(`💬 Respuesta inicial de ${from}: "${textBody}". Continuando secuencia...`, 'log-info');
        await continueSequenceAfterInitialReply();
    }
    else if (currentTaskState === 'AWAITING_CONFIRMATION') {
        if (/^confirmado\s+\d{8}$/i.test(textBody)) {
            const cedula = textBody.split(/\s+/)[1];
            logAndEmit(`✅ Confirmación VÁLIDA de ${from} con cédula: ${cedula}`, 'log-success');
          // ...
            try {
                // ===== EL CAMBIO PARA PERMITIR DUPLICADOS ESTÁ AQUÍ =====
                await pool.query(
                    `INSERT INTO confirmados (numero_confirmado, mensaje_confirmacion) VALUES ($1, $2)`,
                    [from, cedula]
                );
            }catch (dbError) {
                // Añadimos más detalle al log de error para futuras depuraciones
                console.error("Error al guardar en la DB:", dbError);
                logAndEmit(`❌ Error al guardar en DB la confirmación de ${from}. Revisa los logs del servidor.`, 'log-error');
            }
        } else {
            logAndEmit(`❌ Respuesta no es una confirmación válida: "${textBody}".`, 'log-warn');
        }
        releaseAndContinue();
    }
});

// ENDPOINT PARA SUBIR EL ZIP
app.post('/subir-zip', upload.single('zipFile'), async (req, res) => {
    const { destinationNumber } = req.body;
    const zipFile = req.file;

    if (!destinationNumber || !zipFile) {
        return res.status(400).json({ message: "Faltan el número de destino o el archivo ZIP." });
    }

    const zipFilePath = zipFile.path;

    try {
        const zip = new AdmZip(zipFilePath);
        zip.extractAllTo(UPLOADS_DIR, true);
        const imageFiles = zip.getEntries()
            .filter(entry => !entry.isDirectory && /\.(jpg|jpeg|png)$/i.test(entry.entryName))
            .map(entry => entry.entryName);

        if (imageFiles.length === 0) {
            return res.status(400).json({ message: "El ZIP no contiene imágenes válidas." });
        }

        const newTasks = imageFiles.map(imageName => ({
            recipientNumber: destinationNumber,
            imageName: imageName
        }));
        taskQueue.push(...newTasks);

        logAndEmit(`📦 Se agregaron ${newTasks.length} tareas. Total en cola: ${taskQueue.length}`, 'log-info');
        io.emit('queue-update', taskQueue.length);
        
        processQueue();

        res.status(200).json({ message: `Se han encolado ${newTasks.length} envíos.` });
    } catch (error) {
        res.status(500).json({ message: "Error al procesar el ZIP." });
    } finally {
        fs.unlink(zipFilePath, () => {});
    }
});

// --- LÓGICA DE PROCESAMIENTO DE TAREAS ---
const HEADERS = { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' };
const API_URL = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`;
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function releaseAndContinue() {
    if (isProcessing) {
        logAndEmit(`🟢 Proceso liberado. Buscando siguiente tarea...`, 'log-info');
        isProcessing = false;
        currentTask = null;
        currentTaskState = null;
        if (responseTimeout) {
            clearTimeout(responseTimeout);
            responseTimeout = null;
        }
        setTimeout(processQueue, 1000);
    }
}

async function processQueue() {
    if (isProcessing || taskQueue.length === 0) return;

    isProcessing = true;
    currentTask = taskQueue.shift();
    io.emit('queue-update', taskQueue.length);

    logAndEmit(`▶️ Iniciando tarea para ${currentTask.recipientNumber} con imagen ${currentTask.imageName}...`, 'log-info');
    await startSequence(currentTask);
}

async function startSequence(task) {
    try {
        logAndEmit(`📤 1/3: Enviando Template a ${task.recipientNumber}...`, 'log-info');
        await axios.post(API_URL, {
            messaging_product: "whatsapp", to: task.recipientNumber, type: "template",
            template: { name: "hello_world", language: { code: "en_US" } }
        }, { headers: HEADERS });
        
        currentTaskState = 'AWAITING_INITIAL_REPLY';
        logAndEmit(`⏳ Esperando primera respuesta del usuario (Timeout: 5 min)...`, 'log-info');
        
        responseTimeout = setTimeout(() => {
            logAndEmit(`⏰ ¡TIMEOUT! No se recibió la primera respuesta para ${task.imageName}. Cancelando tarea.`, 'log-warn');
            releaseAndContinue();
        }, 300000);

    } catch (error) {
        const errorMessage = error.response?.data?.error?.message || error.message;
        logAndEmit(`🚫 Falló el envío del template a ${task.recipientNumber}. Razón: ${errorMessage}`, 'log-error');
        releaseAndContinue();
    }
}

async function continueSequenceAfterInitialReply() {
    const task = currentTask;
    try {
        logAndEmit(`📤 2/3: Enviando texto "3" a ${task.recipientNumber}...`, 'log-info');
        await axios.post(API_URL, {
            messaging_product: "whatsapp", to: task.recipientNumber, type: "text", text: { body: "3" }
        }, { headers: HEADERS });
        
        await delay(3000);
        
        const publicImageUrl = `${RENDER_EXTERNAL_URL}/uploads/${task.imageName}`;
        logAndEmit(`📤 3/3: Enviando imagen ${task.imageName}...`, 'log-info');
        await axios.post(API_URL, {
            messaging_product: "whatsapp", to: task.recipientNumber, type: "image", image: { link: publicImageUrl }
        }, { headers: HEADERS });

        await pool.query('INSERT INTO envios (numero_destino, nombre_imagen, estado) VALUES ($1, $2, $3)', [task.recipientNumber, task.imageName, 'enviado']);
        
        currentTaskState = 'AWAITING_CONFIRMATION';
        logAndEmit(`⏳ Imagen enviada. Esperando confirmación final (Timeout: 5 min)...`, 'log-info');

        responseTimeout = setTimeout(() => {
            logAndEmit(`⏰ ¡TIMEOUT! No se recibió confirmación final para ${task.imageName}. Continuando.`, 'log-warn');
            releaseAndContinue();
        }, 300000);

    } catch (error) {
        const errorMessage = error.response?.data?.error?.message || error.message;
        logAndEmit(`🚫 Falló el envío de la imagen a ${task.recipientNumber}. Razón: ${errorMessage}`, 'log-error');
        releaseAndContinue();
    } finally {
        const imagePath = path.join(UPLOADS_DIR, task.imageName);
        setTimeout(() => {
            fs.unlink(imagePath, () => {});
        }, 60000 * 10);
    }
}

// --- INICIO DEL SERVIDOR ---
server.listen(PORT, async () => {
    console.log(`🚀 Servidor iniciado. Escuchando en el puerto ${PORT}`);
    await initializeDatabase();
});