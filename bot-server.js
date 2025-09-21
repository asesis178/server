// Dependencias
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
const basicAuth = require('express-basic-auth');

// --- CONFIGURACIÓN ---
const PHONE_NUMBER_IDS = process.env.PHONE_NUMBER_ID ? process.env.PHONE_NUMBER_ID.split(',') : [];
const WHATSAPP_TOKENS = process.env.WHATSAPP_TOKEN ? process.env.WHATSAPP_TOKEN.split(',') : [];
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = process.env.PORT || 3000;
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const ACTIVATION_IMAGE_NAME = 'activation_image.jpeg';

// Límite de procesamiento de imágenes concurrentes.
// Un valor entre 3 y 5 es un buen punto de partida para la mayoría de los servidores.
const CONCURRENT_IMAGE_PROCESSING_LIMIT = 4;

// --- VALIDACIONES DE INICIO ---
if (!process.env.ADMIN_USER || !process.env.ADMIN_PASSWORD) {
    console.error("❌ Error Crítico: Faltan las credenciales ADMIN_USER o ADMIN_PASSWORD en el archivo .env.");
    process.exit(1);
}
const requireAuth = basicAuth({
    users: { [process.env.ADMIN_USER]: process.env.ADMIN_PASSWORD },
    challenge: true,
    unauthorizedResponse: 'Acceso no autorizado. Se requieren credenciales válidas.'
});

if (PHONE_NUMBER_IDS.length === 0 || PHONE_NUMBER_IDS.length !== WHATSAPP_TOKENS.length) {
    console.error("❌ Error Crítico: La configuración de remitentes en .env es inválida.");
    process.exit(1);
}

// --- INICIALIZACIÓN DE COMPONENTES ---
const senderPool = PHONE_NUMBER_IDS.map((id, index) => ({ id: id.trim(), token: WHATSAPP_TOKENS[index].trim() }));
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json());

// Creación de directorios necesarios
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const TEMP_DIR = path.join(__dirname, 'temp');
const ASSETS_DIR = path.join(__dirname, 'assets');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
if (!fs.existsSync(ASSETS_DIR)) fs.mkdirSync(ASSETS_DIR, { recursive: true });

// Configuración de Multer con límite de tamaño
const upload = multer({
    dest: TEMP_DIR,
    limits: { fileSize: 50 * 1024 * 1024 } // Límite de 50 MB
});

// Verificación de archivo de activación
const activationImagePath = path.join(ASSETS_DIR, ACTIVATION_IMAGE_NAME);
if (!fs.existsSync(activationImagePath)) {
    console.error(`🔥🔥🔥 ERROR FATAL: El archivo '${ACTIVATION_IMAGE_NAME}' no se encuentra en la carpeta '/assets'.`);
    process.exit(1);
}

// --- ESTADO GLOBAL ---
let taskQueue = [];
let availableWorkers = new Set(senderPool.map((_, index) => index));
let isQueuePaused = false;

// --- FUNCIÓN DE LOGGING ---
function logAndEmit(text, type = 'log-info') {
    console.log(text);
    io.emit('status-update', { text, type });
}

// --- LÓGICA DE GESTIÓN DE VENTANA ---
async function getConversationWindowState(recipientNumber) {
    const windowResult = await pool.query('SELECT last_activation_time FROM conversation_windows WHERE recipient_number = $1', [recipientNumber]);
    if (windowResult.rowCount === 0) {
        return { status: 'INACTIVE', details: 'Nunca activada' };
    }
    const lastActivation = new Date(windowResult.rows[0].last_activation_time).getTime();
    const minutesSinceActivation = (Date.now() - lastActivation) / (1000 * 60);
    const minutesLeft = 24 * 60 - minutesSinceActivation;

    if (minutesSinceActivation < 10) {
        return { status: 'COOL_DOWN', details: `Enfriamiento por ${Math.round(10 - minutesSinceActivation)} min más` };
    }
    if (minutesLeft <= 0) {
        return { status: 'INACTIVE', details: 'Expirada' };
    }
    if (minutesLeft < 20) {
        return { status: 'EXPIRING_SOON', details: `Expira en ${Math.round(minutesLeft)} min` };
    }
    return { status: 'ACTIVE', details: `Activa por ${Math.floor(minutesLeft / 60)}h ${Math.round(minutesLeft % 60)}m más` };
}

// --- GESTIÓN DE BASE DE DATOS ---
async function initializeDatabase() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS envios (
                id SERIAL PRIMARY KEY,
                numero_destino VARCHAR(255) NOT NULL,
                nombre_imagen VARCHAR(255),
                remitente_usado VARCHAR(255),
                estado VARCHAR(50) DEFAULT 'pending',
                creado_en TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS confirmados (
                id SERIAL PRIMARY KEY,
                numero_confirmado VARCHAR(255) NOT NULL,
                mensaje_confirmacion VARCHAR(255),
                confirmado_en TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS conversation_windows (
                id SERIAL PRIMARY KEY,
                recipient_number VARCHAR(255) NOT NULL UNIQUE,
                last_activation_time TIMESTAMPTZ NOT NULL
            );
        `);
        console.log("✅ Todas las tablas verificadas y/o creadas.");
    } catch (err) {
        console.error("❌ Error al inicializar la base de datos:", err);
        throw err;
    } finally {
        client.release();
    }
}

async function loadPendingTasks() {
    try {
        logAndEmit('🔄 Cargando tareas pendientes desde la base de datos...', 'log-info');
        const res = await pool.query("SELECT id, numero_destino, nombre_imagen FROM envios WHERE estado = 'pending' OR estado = 'procesando' ORDER BY id ASC");
        if (res.rowCount > 0) {
            taskQueue = res.rows.map(row => ({
                id: row.id,
                recipientNumber: row.numero_destino,
                imageName: row.nombre_imagen
            }));
            logAndEmit(`✅ ${taskQueue.length} tarea(s) pendiente(s) cargada(s) en la cola.`, 'log-success');
        } else {
            logAndEmit('👍 No se encontraron tareas pendientes.', 'log-info');
        }
        io.emit('queue-update', taskQueue.length);
    } catch (error) {
        logAndEmit(`❌ Error fatal al cargar tareas pendientes: ${error.message}`, 'log-error');
        process.exit(1);
    }
}

// --- LÓGICA DE SOCKET.IO ---
io.on('connection', (socket) => {
    const activeWorkersCount = senderPool.length - availableWorkers.size;
    socket.emit('queue-update', taskQueue.length);
    socket.emit('workers-status-update', { available: availableWorkers.size, active: activeWorkersCount });

    socket.on('request-window-status', async ({ number }) => {
        try {
            const state = await getConversationWindowState(number);
            let logType = 'log-info';
            if (state.status === 'ACTIVE' || state.status === 'COOL_DOWN') logType = 'log-success';
            if (state.status === 'INACTIVE' || state.status === 'EXPIRING_SOON') logType = 'log-warn';
            socket.emit('status-update', {
                text: `[Consulta] Estado para ${number}: <strong>${state.status}</strong> (${state.details})`,
                type: logType
            });
        } catch (error) {
            logAndEmit(`Error al consultar estado para ${number}: ${error.message}`, 'log-error');
        }
    });

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
            await pool.query('TRUNCATE TABLE confirmados');
            io.emit('datos-confirmados', []);
            logAndEmit("✅ DB de confirmados limpiada.", 'log-success');
        } catch (dbError) {
            logAndEmit("❌ Error al limpiar la DB de confirmados.", 'log-error');
        }
    });
});

// --- ENDPOINTS PÚBLICOS Y DE PANEL ---
app.get('/panel', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'panel.html')));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/assets', express.static(ASSETS_DIR));
app.get('/', (req, res) => res.send('Servidor activo. Visita /panel para usar el control.'));

// WEBHOOK PASIVO PARA CONFIRMACIONES
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
            io.emit('nueva-confirmacion-recibida');
        } catch (dbError) {
            logAndEmit(`[Confirmación Pasiva] ❌ Error al guardar en DB.`, 'log-error');
        }
    }
});

// --- ENDPOINTS DE ADMINISTRACIÓN (PROTEGIDOS) ---

app.post('/subir-zip', requireAuth, upload.single('zipFile'), async (req, res) => {
    const { destinationNumber } = req.body;
    const zipFile = req.file;

    if (!destinationNumber || !zipFile) {
        return res.status(400).json({ message: "Faltan datos (número de destino o archivo ZIP)." });
    }

    const zipFilePath = zipFile.path;
    try {
        const zip = new AdmZip(zipFilePath);
        const imageEntries = zip.getEntries().filter(e => !e.isDirectory && /\.(jpg|jpeg|png)$/i.test(e.entryName));
        fs.unlinkSync(zipFilePath);

        if (imageEntries.length === 0) {
            return res.status(400).json({ message: "El ZIP no contiene imágenes válidas." });
        }

        logAndEmit(`📦 ZIP recibido con ${imageEntries.length} imágenes. Optimizando por lotes (lotes de ${CONCURRENT_IMAGE_PROCESSING_LIMIT})...`, 'log-info');

        const allOptimizedImageNames = [];
        for (let i = 0; i < imageEntries.length; i += CONCURRENT_IMAGE_PROCESSING_LIMIT) {
            const chunk = imageEntries.slice(i, i + CONCURRENT_IMAGE_PROCESSING_LIMIT);
            logAndEmit(`  - Procesando lote ${Math.floor(i / CONCURRENT_IMAGE_PROCESSING_LIMIT) + 1}...`, 'log-info');

            const promises = chunk.map(entry => {
                const originalFileName = path.basename(entry.entryName);
                const optimizedFileName = `opt-${Date.now()}-${Math.random().toString(36).substring(2, 8)}-${originalFileName.replace(/\s/g, '_')}`;
                const targetPath = path.join(UPLOADS_DIR, optimizedFileName);
                const imageBuffer = entry.getData();

                return sharp(imageBuffer)
                    .resize({ width: 1920, withoutEnlargement: true })
                    .jpeg({ quality: 80 })
                    .toFile(targetPath)
                    .then(() => optimizedFileName)
                    .catch(sharpError => {
                        logAndEmit(`⚠️ No se pudo optimizar ${originalFileName}. Saltando... Error: ${sharpError.message}`, 'log-warn');
                        return null;
                    });
            });
            const results = await Promise.all(promises);
            allOptimizedImageNames.push(...results.filter(name => name !== null));
        }

        if (allOptimizedImageNames.length === 0) {
            logAndEmit(`❌ No se pudo optimizar ninguna imagen del ZIP.`, 'log-error');
            return res.status(400).json({ message: "Ninguna imagen en el ZIP pudo ser procesada." });
        }

        logAndEmit(`💾 Guardando ${allOptimizedImageNames.length} nuevas tareas en la base de datos...`, 'log-info');
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const newTasks = [];
            for (const imageName of allOptimizedImageNames) {
                const result = await client.query(
                    'INSERT INTO envios (numero_destino, nombre_imagen, estado) VALUES ($1, $2, $3) RETURNING id, numero_destino, nombre_imagen',
                    [destinationNumber, imageName, 'pending']
                );
                newTasks.push({
                    id: result.rows[0].id,
                    recipientNumber: result.rows[0].numero_destino,
                    imageName: result.rows[0].nombre_imagen
                });
            }
            await client.query('COMMIT');
            taskQueue.push(...newTasks);
            logAndEmit(`✅ ${newTasks.length} tareas agregadas a la cola. Total en cola: ${taskQueue.length}`, 'log-success');
            io.emit('queue-update', taskQueue.length);
            processQueue();
            res.status(200).json({ message: `Se han encolado ${newTasks.length} envíos optimizados.` });
        } catch (dbError) {
            await client.query('ROLLBACK');
            throw dbError;
        } finally {
            client.release();
        }
    } catch (error) {
        logAndEmit(`❌ Error fatal al procesar el ZIP: ${error.message}`, 'log-error');
        res.status(500).json({ message: "Error interno al procesar el ZIP." });
    }
});

app.post('/manual-activate', requireAuth, upload.none(), async (req, res) => {
    const { destinationNumber } = req.body;
    if (!destinationNumber) return res.status(400).json({ message: "Falta el número de destino." });
    if (availableWorkers.size === 0) return res.status(503).json({ message: "Todos los trabajadores están ocupados." });
    const workerIndex = availableWorkers.values().next().value;
    availableWorkers.delete(workerIndex);
    io.emit('workers-status-update', { available: availableWorkers.size, active: senderPool.length - availableWorkers.size });
    logAndEmit(`▶️ [Worker ${workerIndex}] iniciando activación MANUAL para ${destinationNumber}.`, 'log-info');
    executeActivationSequence(destinationNumber, workerIndex);
    res.status(202).json({ message: "Secuencia de activación manual iniciada." });
});

app.post('/debug-update-window', requireAuth, async (req, res) => {
    const { recipientNumber, newTimestamp } = req.body;
    if (!recipientNumber || !newTimestamp) return res.status(400).json({ message: "Faltan datos." });
    try {
        await pool.query(
            `INSERT INTO conversation_windows (recipient_number, last_activation_time) VALUES ($1, $2)
             ON CONFLICT (recipient_number) DO UPDATE SET last_activation_time = $2`,
            [recipientNumber, newTimestamp]
        );
        const state = await getConversationWindowState(recipientNumber);
        io.emit('window-status-update', state);
        res.json({ message: `Fecha de activación forzada para ${recipientNumber}.` });
    } catch (error) {
        console.error("Error en /debug-update-window:", error);
        res.status(500).json({ message: "Error al actualizar la fecha." });
    }
});



// --- LÓGICA DE PROCESAMIENTO DE TAREAS ---
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function releaseWorkerAndContinue(workerIndex) {
    availableWorkers.add(workerIndex);
    const activeWorkersCount = senderPool.length - availableWorkers.size;
    io.emit('workers-status-update', { available: availableWorkers.size, active: activeWorkersCount });
    setTimeout(processQueue, 500);
}

async function processQueue() {
    if (isQueuePaused || availableWorkers.size === 0 || taskQueue.length === 0) {
        if (taskQueue.length > 0) {
            const nextRecipient = taskQueue[0].recipientNumber;
            io.emit('window-status-update', await getConversationWindowState(nextRecipient));
        }
        return;
    }

    const nextRecipient = taskQueue[0].recipientNumber;
    const windowState = await getConversationWindowState(nextRecipient);
    io.emit('window-status-update', windowState);

    if (windowState.status === 'COOL_DOWN' || windowState.status === 'EXPIRING_SOON') {
        if (!isQueuePaused) {
            logAndEmit(`⏸️ Cola pausada para ${nextRecipient}. Razón: ${windowState.details}`, 'log-warn');
            isQueuePaused = true;
        }
        setTimeout(() => {
            isQueuePaused = false;
            logAndEmit('▶️ Reanudando la cola...', 'log-info');
            processQueue();
        }, 60000);
        return;
    }

    isQueuePaused = false;
    while (availableWorkers.size > 0 && taskQueue.length > 0) {
        const workerIndex = availableWorkers.values().next().value;
        availableWorkers.delete(workerIndex);
        io.emit('workers-status-update', { available: availableWorkers.size, active: senderPool.length - availableWorkers.size });
        const task = taskQueue.shift();
        io.emit('queue-update', taskQueue.length);

        try {
            await pool.query('UPDATE envios SET estado = $1, remitente_usado = $2 WHERE id = $3', ['procesando', senderPool[workerIndex].id, task.id]);
            logAndEmit(`▶️ [Worker ${workerIndex}] iniciando tarea #${task.id} para ${task.recipientNumber}.`, 'log-info');
            executeUnifiedSendSequence(task, workerIndex);
        } catch (dbError) {
            logAndEmit(`❌ Error de DB al iniciar tarea #${task.id}: ${dbError.message}`, 'log-error');
            taskQueue.unshift(task);
            io.emit('queue-update', taskQueue.length);
            releaseWorkerAndContinue(workerIndex);
        }
    }
}

async function executeUnifiedSendSequence(task, workerIndex) {
    const { id, recipientNumber, imageName } = task;
    const sender = senderPool[workerIndex];
    const API_URL = `https://graph.facebook.com/v19.0/${sender.id}/messages`;
    const HEADERS = { 'Authorization': `Bearer ${sender.token}`, 'Content-Type': 'application/json' };
    try {
        const windowState = await getConversationWindowState(recipientNumber);
        if (windowState.status === 'INACTIVE') {
            logAndEmit(`[Worker ${workerIndex}] ⚠️ Ventana cerrada para tarea #${id}. Activación automática...`, 'log-warn');
            taskQueue.unshift(task);
            io.emit('queue-update', taskQueue.length);
            await pool.query('UPDATE envios SET estado = $1 WHERE id = $2', ['pending', id]);
            await executeActivationSequence(recipientNumber, workerIndex);
            return;
        }
        logAndEmit(`[Worker ${workerIndex}] 📤 1/3: Enviando "activar" (gratis) para #${id}...`, 'log-info');
        await axios.post(API_URL, { messaging_product: "whatsapp", to: recipientNumber, type: "text", text: { body: "activar" } }, { headers: HEADERS });
        await delay(10000);
        await axios.post(API_URL, { messaging_product: "whatsapp", to: recipientNumber, type: "text", text: { body: "3" } }, { headers: HEADERS });
        await delay(2000);
        const publicImageUrl = `${RENDER_EXTERNAL_URL}/uploads/${imageName}`;
        await axios.post(API_URL, { messaging_product: "whatsapp", to: recipientNumber, type: "image", image: { link: publicImageUrl } }, { headers: HEADERS });
        logAndEmit(`[Worker ${workerIndex}] ✅ Secuencia completada para #${id}.`, 'log-success');
        await pool.query('UPDATE envios SET estado = $1 WHERE id = $2', ['enviado', id]);
    } catch (error) {
        const errorMessage = error.response?.data?.error?.message || error.message;
        logAndEmit(`[Worker ${workerIndex}] 🚫 Falló la secuencia para #${id}. Razón: ${errorMessage}`, 'log-error');
        await pool.query('UPDATE envios SET estado = $1 WHERE id = $2', ['fallido', id]);
    } finally {
        releaseWorkerAndContinue(workerIndex);
    }
}

async function executeActivationSequence(recipientNumber, workerIndex) {
    const sender = senderPool[workerIndex];
    const API_URL = `https://graph.facebook.com/v19.0/${sender.id}/messages`;
    const HEADERS = { 'Authorization': `Bearer ${sender.token}`, 'Content-Type': 'application/json' };
    const publicImageUrl = `${RENDER_EXTERNAL_URL}/assets/${ACTIVATION_IMAGE_NAME}`;
    try {
        logAndEmit(`[Worker ${workerIndex}] 📤 1/3: Enviando Template (pago)...`, 'log-info');
        await axios.post(API_URL, { messaging_product: "whatsapp", to: recipientNumber, type: "template", template: { name: "hello_world", language: { code: "en_US" } } }, { headers: HEADERS });
        await delay(2000);
        await axios.post(API_URL, { messaging_product: "whatsapp", to: recipientNumber, type: "text", text: { body: "3" } }, { headers: HEADERS });
        await delay(2000);
        await axios.post(API_URL, { messaging_product: "whatsapp", to: recipientNumber, type: "image", image: { link: publicImageUrl } }, { headers: HEADERS });
        await delay(5000);
        await pool.query(
            `INSERT INTO conversation_windows (recipient_number, last_activation_time) VALUES ($1, NOW())
             ON CONFLICT (recipient_number) DO UPDATE SET last_activation_time = NOW()`,
            [recipientNumber]
        );
        logAndEmit(`[Worker ${workerIndex}] ✅ Ventana de 24h activada para ${recipientNumber}.`, 'log-success');
        const state = await getConversationWindowState(recipientNumber);
        io.emit('window-status-update', state);
    } catch (error) {
        const errorMessage = error.response?.data?.error?.message || error.message;
        logAndEmit(`[Worker ${workerIndex}] 🚫 Falló la secuencia de activación. Razón: ${errorMessage}`, 'log-error');
    } finally {
        releaseWorkerAndContinue(workerIndex);
    }
}

// --- TAREAS DE MANTENIMIENTO ---
function cleanupOldFiles(directory, maxAge) {
    fs.readdir(directory, (err, files) => {
        if (err) return console.error(`Error al leer el directorio ${directory}:`, err);
        files.forEach(file => {
            const filePath = path.join(directory, file);
            fs.stat(filePath, (err, stats) => {
                if (err) return console.error(`Error al obtener stats de ${file}:`, err);
                if (Date.now() - stats.mtime.getTime() > maxAge) {
                    fs.unlink(filePath, (unlinkErr) => {
                        if (unlinkErr) console.error(`Error al borrar archivo antiguo ${file}:`, unlinkErr);
                        else console.log(`🧹 Archivo antiguo borrado: ${file}`);
                    });
                }
            });
        });
    });
}

// --- INICIO DEL SERVIDOR ---
async function startServer() {
    try {
        await initializeDatabase();
        await loadPendingTasks();

        server.listen(PORT, () => {
            console.log(`🚀 Servidor iniciado en el puerto ${PORT}. Pool de ${senderPool.length} remitente(s) listo.`);

            const unaSemanaEnMs = 7 * 24 * 60 * 60 * 1000;
            console.log('🧹 Realizando limpieza inicial de archivos antiguos...');
            cleanupOldFiles(UPLOADS_DIR, unaSemanaEnMs);

            setInterval(() => {
                console.log('🧹 Ejecutando limpieza periódica programada de archivos antiguos...');
                cleanupOldFiles(UPLOADS_DIR, unaSemanaEnMs);
            }, 24 * 60 * 60 * 1000); // Cada 24 horas

            if (taskQueue.length > 0) {
                logAndEmit('▶️ Iniciando procesamiento de la cola cargada.', 'log-info');
                processQueue();
            }
        });
    } catch (error) {
        console.error("🔥🔥🔥 FALLO CRÍTICO AL INICIAR EL SERVIDOR 🔥🔥🔥");
        console.error("No se pudo conectar o inicializar la base de datos.");
        console.error("Error detallado:", error);
        process.exit(1);
    }
}

startServer();