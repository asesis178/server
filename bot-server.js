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
const sharp = require('sharp');

// --- CONFIGURACIÓN ---
const PHONE_NUMBER_IDS = process.env.PHONE_NUMBER_ID ? process.env.PHONE_NUMBER_ID.split(',') : [];
const WHATSAPP_TOKENS = process.env.WHATSAPP_TOKEN ? process.env.WHATSAPP_TOKEN.split(',') : [];
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

// --- ESTADO GLOBAL ---
let taskQueue = [];
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
        await client.query(`CREATE TABLE IF NOT EXISTS envios (id SERIAL PRIMARY KEY, numero_destino VARCHAR(255) NOT NULL, nombre_imagen VARCHAR(255), remitente_usado VARCHAR(255), estado VARCHAR(50), creado_en TIMESTPTZ DEFAULT NOW());`);
        await client.query(`CREATE TABLE IF NOT EXISTS confirmados (id SERIAL PRIMARY KEY, numero_confirmado VARCHAR(255) NOT NULL, mensaje_confirmacion VARCHAR(255), confirmado_en TIMESTPTZ DEFAULT NOW());`);
        await client.query(`CREATE TABLE IF NOT EXISTS conversation_windows (id SERIAL PRIMARY KEY, recipient_number VARCHAR(255) NOT NULL UNIQUE, last_activation_time TIMESTPTZ NOT NULL);`);
        console.log("✅ Todas las tablas verificadas y listas.");
    } catch (err) {
        console.error("❌ Error al inicializar la base de datos:", err);
        throw err;
    } finally {
        client.release();
    }
}

// --- LÓGICA DE SOCKET.IO ---
io.on('connection', (socket) => {
    console.log(`[Socket.IO] Usuario conectado: ${socket.id}`);
    const activeWorkersCount = senderPool.length - availableWorkers.size;
    socket.emit('queue-update', taskQueue.length);
    socket.emit('workers-status-update', { available: availableWorkers.size, active: activeWorkersCount });

    socket.on('ver-confirmados', async () => {
        try {
            const result = await pool.query("SELECT numero_confirmado, mensaje_confirmacion, confirmado_en FROM confirmados ORDER BY confirmado_en DESC");
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

// WEBHOOK PASIVO
app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message || message.type !== 'text') return;

    const from = message.from;
    const textBody = message.text.body.trim();

    const match = textBody.match(/confirmado\s+(\d{8})/i);

    if (match) {
        const cedula = match[1];
        logAndEmit(`[Confirmación Pasiva] ✅ Detectada cédula ${cedula} de ${from}`, 'log-success');
        try {
            await pool.query(`INSERT INTO confirmados (numero_confirmado, mensaje_confirmacion) VALUES ($1, $2)`, [from, cedula]);
            io.emit('ver-confirmados');
        } catch (dbError) {
            logAndEmit(`[Confirmación Pasiva] ❌ Error al guardar en DB.`, 'log-error');
        }
    }
});

// ENDPOINT PARA SUBIR EL ZIP
app.post('/subir-zip', upload.single('zipFile'), async (req, res) => {
    const { destinationNumber } = req.body;
    const zipFile = req.file;
    if (!destinationNumber || !zipFile) {
        return res.status(400).json({ message: "Faltan datos." });
    }
    const zipFilePath = zipFile.path;
    try {
        const zip = new AdmZip(zipFilePath);
        const imageEntries = zip.getEntries().filter(e => !e.isDirectory && /\.(jpg|jpeg|png)$/i.test(e.entryName));
        if (imageEntries.length === 0) {
            return res.status(400).json({ message: "El ZIP no contiene imágenes válidas." });
        }

        logAndEmit(`📦 ZIP recibido. Optimizando ${imageEntries.length} imágenes...`, 'log-info');
        
        const optimizationPromises = imageEntries.map(async (entry) => {
            const originalFileName = path.basename(entry.entryName);
            const optimizedFileName = `opt-${Date.now()}-${originalFileName.replace(/\s/g, '_')}`;
            const targetPath = path.join(UPLOADS_DIR, optimizedFileName);
            const imageBuffer = entry.getData();
            await sharp(imageBuffer).resize({ width: 1920, withoutEnlargement: true }).jpeg({ quality: 80 }).toFile(targetPath);
            return optimizedFileName;
        });

        const optimizedImageNames = await Promise.all(optimizationPromises);

        // --- CORRECCIÓN: Se elimina la duplicación de tareas ---
        // Ahora usamos .map para crear una sola tarea por imagen.
        const newTasks = optimizedImageNames.map(imageName => ({
            recipientNumber: destinationNumber,
            imageName
        }));
        
        taskQueue.push(...newTasks);

        logAndEmit(`✅ Optimización completa. Se agregaron ${newTasks.length} tareas a la cola.`, 'log-success');
        io.emit('queue-update', taskQueue.length);
        processQueue();
        res.status(200).json({ message: `Se han encolado ${newTasks.length} envíos optimizados.` });
    } catch (error) {
        logAndEmit(`❌ Error fatal al procesar el ZIP: ${error.message}`, 'log-error');
        res.status(500).json({ message: "Error interno al procesar el ZIP." });
    } finally {
        fs.unlink(zipFilePath, (err) => {
            if (err) console.error("No se pudo eliminar el ZIP temporal:", err);
        });
    }
});

// --- LÓGICA DE PROCESAMIENTO "DISPARA Y OLVIDA" ---
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function releaseWorkerAndContinue(workerIndex) {
    availableWorkers.add(workerIndex);
    const activeWorkersCount = senderPool.length - availableWorkers.size;
    logAndEmit(`🟢 [Worker ${workerIndex}] liberado. Libres: ${availableWorkers.size}.`, 'log-info');
    io.emit('workers-status-update', { available: availableWorkers.size, active: activeWorkersCount });
    setTimeout(processQueue, 500);
}

async function processQueue() {
    while (availableWorkers.size > 0 && taskQueue.length > 0) {
        const workerIndex = availableWorkers.values().next().value;
        availableWorkers.delete(workerIndex);
        const activeWorkersCount = senderPool.length - availableWorkers.size;
        io.emit('workers-status-update', { available: availableWorkers.size, active: activeWorkersCount });
        const task = taskQueue.shift();
        io.emit('queue-update', taskQueue.length);
        logAndEmit(`▶️ [Worker ${workerIndex}] iniciando tarea para ${task.recipientNumber} con ${task.imageName}.`, 'log-info');
        executeUnifiedSendSequence(task, workerIndex);
    }
}

async function executeUnifiedSendSequence(task, workerIndex) {
    const { recipientNumber, imageName } = task;
    const sender = senderPool[workerIndex];
    const API_URL = `https://graph.facebook.com/v19.0/${sender.id}/messages`;
    const HEADERS = { 'Authorization': `Bearer ${sender.token}`, 'Content-Type': 'application/json' };
    
    try {
        const windowResult = await pool.query('SELECT last_activation_time FROM conversation_windows WHERE recipient_number = $1', [recipientNumber]);
        const isWindowOpen = windowResult.rowCount > 0 && (Date.now() - new Date(windowResult.rows[0].last_activation_time).getTime()) < (24 * 60 * 60 * 1000);

        await pool.query('INSERT INTO envios (numero_destino, nombre_imagen, remitente_usado, estado) VALUES ($1, $2, $3, $4)', [recipientNumber, imageName, sender.id, 'procesando']);
        
        if (!isWindowOpen) {
            logAndEmit(`[Worker ${workerIndex}] ⚠️ Ventana cerrada. Enviando secuencia de PAGO para ${imageName}...`, 'log-warn');
            await axios.post(API_URL, { messaging_product: "whatsapp", to: recipientNumber, type: "template", template: { name: "hello_world", language: { code: "en_US" } } }, { headers: HEADERS });
            
            await pool.query(
                `INSERT INTO conversation_windows (recipient_number, last_activation_time) VALUES ($1, NOW())
                 ON CONFLICT (recipient_number) DO UPDATE SET last_activation_time = NOW()`,
                [recipientNumber]
            );
            logAndEmit(`[Worker ${workerIndex}] ✅ Ventana de 24h activada para ${recipientNumber}.`, 'log-success');
        } else {
            logAndEmit(`[Worker ${workerIndex}] 📤 Ventana abierta. Enviando secuencia GRATUITA para ${imageName}...`, 'log-info');
            await axios.post(API_URL, { messaging_product: "whatsapp", to: recipientNumber, type: "text", text: { body: "activar" } }, { headers: HEADERS });
        }
        
        await delay(10000);
        await axios.post(API_URL, { messaging_product: "whatsapp", to: recipientNumber, type: "text", text: { body: "3" } }, { headers: HEADERS });
        await delay(2000);
        const publicImageUrl = `${RENDER_EXTERNAL_URL}/uploads/${imageName}`;
        await axios.post(API_URL, { messaging_product: "whatsapp", to: recipientNumber, type: "image", image: { link: publicImageUrl } }, { headers: HEADERS });
        
        logAndEmit(`[Worker ${workerIndex}] ✅ Secuencia completada para ${imageName}.`, 'log-success');
        await pool.query('UPDATE envios SET estado = $1 WHERE nombre_imagen = $2', ['enviado', imageName]);

    } catch (error) {
        const errorMessage = error.response?.data?.error?.message || error.message;
        logAndEmit(`[Worker ${workerIndex}] 🚫 Falló la secuencia para ${imageName}. Razón: ${errorMessage}`, 'log-error');
        await pool.query('UPDATE envios SET estado = $1 WHERE nombre_imagen = $2', ['fallido', imageName]);
    } finally {
        releaseWorkerAndContinue(workerIndex);
        const imagePath = path.join(UPLOADS_DIR, imageName);
        setTimeout(() => fs.unlink(imagePath, () => {}), 1800000);
    }
}

function cleanupOldFiles() {
    const maxAge = 3600 * 1000; // 1 hora
    fs.readdir(UPLOADS_DIR, (err, files) => {
        if (err) return;
        files.forEach(file => {
            const filePath = path.join(UPLOADS_DIR, file);
            fs.stat(filePath, (err, stats) => {
                if (err) return;
                if (Date.now() - stats.mtime.getTime() > maxAge) {
                    fs.unlink(filePath, () => {});
                }
            });
        });
    });
}

// --- INICIO DEL SERVIDOR ---
async function startServer() {
    try {
        await initializeDatabase();
        server.listen(PORT, () => {
            console.log(`🚀 Servidor iniciado. Pool de ${senderPool.length} remitente(s) listo.`);
            cleanupOldFiles();
        });
    } catch (error) {
        console.error("🔥🔥🔥 FALLO CRÍTICO AL INICIAR EL SERVIDOR 🔥🔥🔥");
        console.error("No se pudo conectar o inicializar la base de datos.");
        console.error("Error detallado:", error);
        process.exit(1);
    }
}

startServer();