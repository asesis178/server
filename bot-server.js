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

// --- ESTADO GLOBAL: COLA DE TAREAS Y TRABAJADORES LIBRES ---
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
    const activeWorkersCount = senderPool.length - availableWorkers.size;
    socket.emit('queue-update', taskQueue.length);
    socket.emit('workers-status-update', { available: availableWorkers.size, active: activeWorkersCount });
    socket.on('ver-confirmados', async () => { /* ... */ });
    socket.on('limpiar-confirmados', async () => { /* ... */ });
});

// --- ENDPOINTS ---
app.get('/panel', (req, res) => res.sendFile(path.join(__dirname, 'panel.html')));
app.use('/uploads', express.static(UPLOADS_DIR));
app.get('/', (req, res) => res.send('Servidor activo. Visita /panel para usar el control.'));

// WEBHOOK PASIVO
app.post('/webhook', async (req, res) => { /* ... */ });

// ===== ENDPOINT PARA SUBIR EL ZIP (CORREGIDO) =====
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
            return res.status(400).json({ message: "El ZIP no contiene imágenes válidas (jpg, jpeg, png)." });
        }

        const createdImageNames = [];
        for (const entry of imageEntries) {
            // 1. Obtenemos solo el nombre del archivo, ignorando la carpeta
            const simpleFileName = path.basename(entry.entryName);
            // 2. Definimos la ruta de destino en la raíz de /uploads
            const targetPath = path.join(UPLOADS_DIR, simpleFileName);
            // 3. Escribimos el contenido del archivo en esa ruta
            fs.writeFileSync(targetPath, entry.getData());
            // 4. Guardamos el nombre simple para crear la tarea
            createdImageNames.push(simpleFileName);
        }

        const newTasks = createdImageNames.map(imageName => ({ recipientNumber: destinationNumber, imageName }));
        taskQueue.push(...newTasks);

        logAndEmit(`📦 Se agregaron ${newTasks.length} tareas. Total en cola: ${taskQueue.length}`, 'log-info');
        io.emit('queue-update', taskQueue.length);
        processQueue();
        res.status(200).json({ message: `Se han encolado ${newTasks.length} envíos.` });

    } catch (error) {
        console.error("Error procesando el ZIP:", error);
        logAndEmit(`❌ Error fatal al procesar el ZIP: ${error.message}`, 'log-error');
        res.status(500).json({ message: "Error interno al procesar el archivo ZIP." });
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
        executeSendSequence(task, workerIndex);
    }
}

async function executeSendSequence(task, workerIndex) {
    const sender = senderPool[workerIndex];
    const API_URL = `https://graph.facebook.com/v19.0/${sender.id}/messages`;
    const HEADERS = { 'Authorization': `Bearer ${sender.token}`, 'Content-Type': 'application/json' };
    const { recipientNumber, imageName } = task;
    try {
        await pool.query('INSERT INTO envios (numero_destino, nombre_imagen, remitente_usado, estado) VALUES ($1, $2, $3, $4)', [recipientNumber, imageName, sender.id, 'procesando']);
        logAndEmit(`[Worker ${workerIndex}] 📤 1/3: Enviando Template...`, 'log-info');
        await axios.post(API_URL, { messaging_product: "whatsapp", to: recipientNumber, type: "template", template: { name: "hello_world", language: { code: "en_US" } } }, { headers: HEADERS });
        await delay(10000);
        logAndEmit(`[Worker ${workerIndex}] 📤 2/3: Enviando "3"...`, 'log-info');
        await axios.post(API_URL, { messaging_product: "whatsapp", to: recipientNumber, type: "text", text: { body: "3" } }, { headers: HEADERS });
        await delay(2000);
        const publicImageUrl = `${RENDER_EXTERNAL_URL}/uploads/${imageName}`;
        logAndEmit(`[Worker ${workerIndex}] 📤 3/3: Enviando imagen ${imageName}...`, 'log-info');
        await axios.post(API_URL, { messaging_product: "whatsapp", to: recipientNumber, type: "image", image: { link: publicImageUrl } }, { headers: HEADERS });
        logAndEmit(`[Worker ${workerIndex}] ✅ Secuencia completada para ${imageName}.`, 'log-success');
        await pool.query('UPDATE envios SET estado = $1 WHERE nombre_imagen = $2 AND remitente_usado = $3', ['enviado', imageName, sender.id]);
         await delay(5000);
    } catch (error) {
        const errorMessage = error.response?.data?.error?.message || error.message;
        logAndEmit(`[Worker ${workerIndex}] 🚫 Falló la secuencia para ${imageName}. Razón: ${errorMessage}`, 'log-error');
        await pool.query('UPDATE envios SET estado = $1 WHERE nombre_imagen = $2 AND remitente_usado = $3', ['fallido', imageName, sender.id]);
    } finally {
        releaseWorkerAndContinue(workerIndex);
        const imagePath = path.join(UPLOADS_DIR, imageName);
        setTimeout(() => {
            fs.unlink(imagePath, (err) => {
                if (err && err.code !== 'ENOENT') {
                    console.error(`Error al intentar borrar ${imageName}:`, err);
                } else if (!err) {
                    logAndEmit(`🗑️ Archivo ${imageName} eliminado.`, 'log-info');
                }
            });
        }, 1800000); // 30 minutos
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
server.listen(PORT, async () => {
    console.log(`🚀 Servidor iniciado. Pool de ${senderPool.length} remitente(s) listo para enviar.`);
    await initializeDatabase();
    cleanupOldFiles();
});