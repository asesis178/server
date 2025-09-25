// Dependencias
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const axios = require('axios');
const path = require('path');
const multer = require('multer');
const fsSync = require('fs'); // Para operaciones síncronas
const fs = require('fs').promises; // Para operaciones asíncronas
const { Pool } = require('pg');
const AdmZip = require('adm-zip');
const sharp = require('sharp');
const basicAuth = require('express-basic-auth');
const exceljs = require('exceljs');

// --- CONFIGURACIÓN ---
const PHONE_NUMBER_IDS = process.env.PHONE_NUMBER_ID ? process.env.PHONE_NUMBER_ID.split(',') : [];
const WHATSAPP_TOKENS = process.env.WHATSAPP_TOKEN ? process.env.WHATSAPP_TOKEN.split(',') : [];
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = process.env.PORT || 3000;
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const ACTIVATION_IMAGE_NAME = 'activation_image.jpeg';
const CONCURRENT_IMAGE_PROCESSING_LIMIT = 4;

// --- VALIDACIONES DE INICIO ---
if (!process.env.ADMIN_USER || !process.env.ADMIN_PASSWORD) {
    console.error("❌ Error Crítico: Faltan las credenciales ADMIN_USER o ADMIN_PASSWORD en el archivo .env.");
    process.exit(1);
}
if (PHONE_NUMBER_IDS.length === 0 || PHONE_NUMBER_IDS.length !== WHATSAPP_TOKENS.length) {
    console.error("❌ Error Crítico: La configuración de remitentes en .env es inválida.");
    process.exit(1);
}
const requireAuth = basicAuth({
    users: { [process.env.ADMIN_USER]: process.env.ADMIN_PASSWORD },
    challenge: true,
    unauthorizedResponse: 'Acceso no autorizado. Se requieren credenciales válidas.'
});

// --- INICIALIZACIÓN DE COMPONENTES ---
const senderPool = PHONE_NUMBER_IDS.map((id, index) => ({ id: id.trim(), token: WHATSAPP_TOKENS[index].trim() }));
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json());

// --- GESTIÓN DE DIRECTORIOS ---
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const PENDING_DIR = path.join(UPLOADS_DIR, 'pending');
const ARCHIVED_DIR = path.join(UPLOADS_DIR, 'archived');
const CONFIRMED_ARCHIVE_DIR = path.join(ARCHIVED_DIR, 'confirmed');
const NOT_CONFIRMED_ARCHIVE_DIR = path.join(ARCHIVED_DIR, 'not_confirmed');
const ZIPS_DIR = path.join(__dirname, 'zips');
const TEMP_DIR = path.join(__dirname, 'temp');
const ASSETS_DIR = path.join(__dirname, 'assets');

async function createDirectories() {
    const dirs = [UPLOADS_DIR, PENDING_DIR, ARCHIVED_DIR, CONFIRMED_ARCHIVE_DIR, NOT_CONFIRMED_ARCHIVE_DIR, ZIPS_DIR, TEMP_DIR, ASSETS_DIR];
    for (const dir of dirs) {
        try {
            await fs.mkdir(dir, { recursive: true });
        } catch (error) {
            console.error(`❌ Error creando el directorio ${dir}:`, error);
            process.exit(1);
        }
    }
    console.log('✅ Todos los directorios están listos.');
}

const upload = multer({ dest: TEMP_DIR, limits: { fileSize: 50 * 1024 * 1024 } });
const activationImagePath = path.join(ASSETS_DIR, ACTIVATION_IMAGE_NAME);

// --- ESTADO GLOBAL ---
let taskQueue = [];
let availableWorkers = new Set(senderPool.map((_, index) => index));
let isConversationCheckPaused = false;
let isQueueProcessingPaused = false;
let delaySettings = { delay1: 10000, delay2: 2000, taskSeparation: 500 };

// --- FUNCIONES UTILITARIAS ---
function logAndEmit(text, type = 'log-info') {
    console.log(text);
    io.emit('status-update', { text, type });
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- LÓGICA DE GESTIÓN DE VENTANA ---
async function getConversationWindowState(recipientNumber) {
    const windowResult = await pool.query('SELECT last_activation_time FROM conversation_windows WHERE recipient_number = $1', [recipientNumber]);
    if (windowResult.rowCount === 0) return { status: 'INACTIVE', details: 'Nunca activada' };

    const lastActivation = new Date(windowResult.rows[0].last_activation_time).getTime();
    const minutesSinceActivation = (Date.now() - lastActivation) / (1000 * 60);
    const minutesLeft = 24 * 60 - minutesSinceActivation;

    if (minutesSinceActivation < 10) return { status: 'COOL_DOWN', details: `Enfriamiento por ${Math.round(10 - minutesSinceActivation)} min más` };
    if (minutesLeft <= 0) return { status: 'INACTIVE', details: 'Expirada' };
    if (minutesLeft < 20) return { status: 'EXPIRING_SOON', details: `Expira en ${Math.round(minutesLeft)} min` };

    return { status: 'ACTIVE', details: `Activa por ${Math.floor(minutesLeft / 60)}h ${Math.round(minutesLeft % 60)}m más` };
}

// --- GESTIÓN DE BASE DE DATOS ---
async function initializeDatabase() {
    const client = await pool.connect();
    try {
        await client.query(`CREATE TABLE IF NOT EXISTS envios (id SERIAL PRIMARY KEY, numero_destino VARCHAR(255) NOT NULL, nombre_imagen VARCHAR(255), remitente_usado VARCHAR(255), estado VARCHAR(50) DEFAULT 'pending', creado_en TIMESTAMPTZ DEFAULT NOW());`);
        await client.query(`CREATE TABLE IF NOT EXISTS confirmados (id SERIAL PRIMARY KEY, numero_confirmado VARCHAR(255) NOT NULL, cedula VARCHAR(50) UNIQUE NOT NULL, fecha_nacimiento DATE, confirmado_en TIMESTAMPTZ DEFAULT NOW());`);
        await client.query(`CREATE TABLE IF NOT EXISTS no_confirmados (id SERIAL PRIMARY KEY, numero_no_confirmado VARCHAR(255) NOT NULL, cedula VARCHAR(50) UNIQUE NOT NULL, fecha_nacimiento DATE, registrado_en TIMESTAMPTZ DEFAULT NOW());`);
        await client.query(`CREATE TABLE IF NOT EXISTS conversation_windows (id SERIAL PRIMARY KEY, recipient_number VARCHAR(255) NOT NULL UNIQUE, last_activation_time TIMESTAMPTZ NOT NULL);`);
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
        const res = await pool.query("SELECT id, numero_destino, nombre_imagen FROM envios WHERE estado IN ('pending', 'procesando') ORDER BY id ASC");

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
    socket.emit('queue-update', taskQueue.length);
    socket.emit('workers-status-update', { available: availableWorkers.size, active: senderPool.length - availableWorkers.size });
    socket.emit('initial-delay-settings', delaySettings);
    socket.emit('queue-status-update', { isPaused: isQueueProcessingPaused });

    socket.on('request-window-status', async ({ number }) => {
        try {
            const state = await getConversationWindowState(number);
            let logType = 'log-info';
            if (state.status === 'ACTIVE' || state.status === 'COOL_DOWN') logType = 'log-success';
            if (state.status === 'INACTIVE' || state.status === 'EXPIRING_SOON') logType = 'log-warn';
            socket.emit('status-update', { text: `[Consulta] Estado para ${number}: <strong>${state.status}</strong> (${state.details})`, type: logType });
        } catch (error) {
            logAndEmit(`Error al consultar estado para ${number}: ${error.message}`, 'log-error');
        }
    });

    socket.on('ver-confirmados', async () => {
        try {
            const result = await pool.query("SELECT cedula, fecha_nacimiento, numero_confirmado, confirmado_en FROM confirmados ORDER BY confirmado_en DESC");
            socket.emit('datos-confirmados', result.rows);
        } catch (dbError) {
            console.error("Error al obtener confirmados:", dbError);
        }
    });

    socket.on('ver-no-confirmados', async () => {
        try {
            const result = await pool.query("SELECT cedula, fecha_nacimiento, numero_no_confirmado, registrado_en FROM no_confirmados ORDER BY registrado_en DESC");
            socket.emit('datos-no-confirmados', result.rows);
        } catch (dbError) {
            console.error("Error al obtener no confirmados:", dbError);
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

    socket.on('limpiar-no-confirmados', async () => {
        try {
            await pool.query('TRUNCATE TABLE no_confirmados');
            io.emit('datos-no-confirmados', []);
            logAndEmit("✅ DB de 'no confirmados' limpiada.", 'log-success');
        } catch (dbError) {
            logAndEmit("❌ Error al limpiar la DB de 'no confirmados'.", 'log-error');
        }
    });
});

// --- ENDPOINTS ---
app.use('/uploads/pending', express.static(PENDING_DIR));
app.use('/assets', express.static(ASSETS_DIR));
app.use('/zips', requireAuth, express.static(ZIPS_DIR));
app.get('/panel', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'panel.html')));
app.get('/', (req, res) => res.send('Servidor activo. Visita /panel para usar el control.'));

app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message || message.type !== 'text') return;

    const from = message.from;
    const textBody = message.text.body;
    const regex = /cedula:\s*(\d+)\s*fecha de nacimiento:\s*(\d{2}\/\d{2}\/\d{4})\s*ud (no )?esta habilitado/i;
    const match = textBody.match(regex);
    if (!match) return;

    const [, cedula, fechaNacStr, notKeyword] = match;
    const isConfirmed = !notKeyword;
    const status = isConfirmed ? 'Confirmado' : 'No Confirmado';
    const [day, month, year] = fechaNacStr.split('/');
    const fechaNac = `${year}-${month}-${day}`;
    const tableName = isConfirmed ? 'confirmados' : 'no_confirmados';
    const numberColumn = isConfirmed ? 'numero_confirmado' : 'numero_no_confirmado';

    try {
        const pendingFiles = await fs.readdir(PENDING_DIR);
        const imageToMove = pendingFiles.find(file => file.includes(cedula));

        if (!imageToMove) {
            logAndEmit(`[Webhook] ❌ ERROR CRÍTICO: Respuesta para CI ${cedula} recibida, pero no se encontró su imagen en 'pending'. No se registrará.`, 'log-error');
            return;
        }

        const oldPath = path.join(PENDING_DIR, imageToMove);
        const newDir = isConfirmed ? CONFIRMED_ARCHIVE_DIR : NOT_CONFIRMED_ARCHIVE_DIR;
        const newPath = path.join(newDir, imageToMove);
        await fs.rename(oldPath, newPath);
        logAndEmit(`[Webhook] 🗂️ Imagen para CI ${cedula} archivada en '${status}'.`, 'log-info');

        await pool.query(`INSERT INTO ${tableName} (cedula, fecha_nacimiento, ${numberColumn}) VALUES ($1, $2, $3) ON CONFLICT (cedula) DO NOTHING`, [cedula, fechaNac, from]);
        logAndEmit(`[Webhook] ✅ Registro guardado: ${status} para CI ${cedula}.`, 'log-success');
        io.emit('nueva-respuesta-recibida');

    } catch (error) {
        logAndEmit(`[Webhook] ❌ Error total al procesar CI ${cedula}: ${error.message}`, 'log-error');
    }
});

// --- ENDPOINTS DE ADMINISTRACIÓN (PROTEGIDOS) ---
app.post('/subir-zip', requireAuth, upload.single('zipFile'), async (req, res) => {
    const { destinationNumber } = req.body;
    const zipFile = req.file;
    if (!destinationNumber || !zipFile) return res.status(400).json({ message: "Faltan datos." });

    try {
        const zip = new AdmZip(zipFile.path);
        const imageEntries = zip.getEntries().filter(e => !e.isDirectory && /\.(jpg|jpeg|png)$/i.test(e.entryName));
        await fs.unlink(zipFile.path);

        if (imageEntries.length === 0) return res.status(400).json({ message: "El ZIP no contiene imágenes válidas." });
        logAndEmit(`📦 ZIP recibido. Optimizando ${imageEntries.length} imágenes...`, 'log-info');

        const processingPromises = imageEntries.map(entry => {
            const originalFileName = path.basename(entry.entryName);
            const cedulaMatch = originalFileName.match(/\d+/);
            if (!cedulaMatch) {
                logAndEmit(`⚠️ Imagen ${originalFileName} saltada: no contiene una cédula en el nombre.`, 'log-warn');
                return Promise.resolve(null);
            }
            const optimizedFileName = originalFileName.replace(/\s/g, '_');
            const targetPath = path.join(PENDING_DIR, optimizedFileName);
            return sharp(entry.getData())
                .resize({ width: 1920, withoutEnlargement: true })
                .jpeg({ quality: 80 })
                .toFile(targetPath)
                .then(() => optimizedFileName)
                .catch(err => {
                    logAndEmit(`⚠️ No se pudo optimizar ${originalFileName}. Saltando...`, 'log-warn');
                    return null;
                });
        });

        const allOptimizedImageNames = (await Promise.all(processingPromises)).filter(Boolean);
        if (allOptimizedImageNames.length === 0) return res.status(400).json({ message: "Ninguna imagen pudo ser procesada." });

        logAndEmit(`💾 Guardando ${allOptimizedImageNames.length} tareas en DB...`, 'log-info');
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const newTasks = [];
            for (const imageName of allOptimizedImageNames) {
                const result = await client.query('INSERT INTO envios (numero_destino, nombre_imagen, estado) VALUES ($1, $2, $3) RETURNING id, numero_destino, nombre_imagen', [destinationNumber, imageName, 'pending']);
                newTasks.push({ id: result.rows[0].id, recipientNumber: result.rows[0].numero_destino, imageName: result.rows[0].nombre_imagen });
            }
            await client.query('COMMIT');
            taskQueue.push(...newTasks);
            logAndEmit(`✅ ${newTasks.length} tareas agregadas. Total en cola: ${taskQueue.length}`, 'log-success');
            io.emit('queue-update', taskQueue.length);
            processQueue();
            res.status(200).json({ message: `Se encolaron ${newTasks.length} envíos.` });
        } catch (dbError) {
            await client.query('ROLLBACK');
            throw dbError;
        } finally {
            client.release();
        }
    } catch (error) {
        logAndEmit(`❌ Error al procesar ZIP: ${error.message}`, 'log-error');
        res.status(500).json({ message: "Error interno al procesar ZIP." });
    }
});

app.get('/download-confirmed-excel', requireAuth, async (req, res) => {
    try {
        const result = await pool.query('SELECT cedula, fecha_nacimiento, numero_confirmado, confirmado_en FROM confirmados ORDER BY confirmado_en ASC');
        const workbook = new exceljs.Workbook();
        const worksheet = workbook.addWorksheet('Confirmados');
        worksheet.columns = [
            { header: 'Cédula', key: 'cedula', width: 15 },
            { header: 'Fecha de Nacimiento', key: 'fecha_nacimiento', width: 20 },
            { header: 'Número de Contacto', key: 'numero_confirmado', width: 20 },
            { header: 'Fecha de Confirmación', key: 'confirmado_en', width: 25 }
        ];
        worksheet.addRows(result.rows);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="confirmados.xlsx"');
        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        logAndEmit(`❌ Error generando Excel: ${error.message}`, 'log-error');
        res.status(500).send("Error al generar el archivo Excel.");
    }
});

async function createAndSendZip(res, directory, zipName) {
    try {
        const files = await fs.readdir(directory);
        if (files.length === 0) {
            return res.status(404).json({ message: `No hay imágenes en la categoría '${zipName}'.` });
        }
        const zip = new AdmZip();
        for (const file of files) {
            zip.addLocalFile(path.join(directory, file));
        }
        const zipBuffer = zip.toBuffer();
        const finalZipName = `${zipName}-${new Date().toISOString().split('T')[0]}.zip`;
        await fs.writeFile(path.join(ZIPS_DIR, finalZipName), zipBuffer);
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename=${finalZipName}`);
        res.send(zipBuffer);
    } catch (error) {
        logAndEmit(`❌ Error generando ZIP de ${zipName}: ${error.message}`, 'log-error');
        res.status(500).send(`Error al generar el ZIP de ${zipName}.`);
    }
}

app.get('/download-confirmed-zip', requireAuth, (req, res) => { createAndSendZip(res, CONFIRMED_ARCHIVE_DIR, 'confirmados'); });
app.get('/download-not-confirmed-zip', requireAuth, (req, res) => { createAndSendZip(res, NOT_CONFIRMED_ARCHIVE_DIR, 'no-confirmados'); });
app.post('/pause-queue', requireAuth, (req, res) => { if (!isQueueProcessingPaused) { isQueueProcessingPaused = true; logAndEmit('⏸️ Cola pausada.', 'log-warn'); io.emit('queue-status-update', { isPaused: true }); } res.status(200).json({ message: 'Cola pausada.' }); });
app.post('/resume-queue', requireAuth, (req, res) => { if (isQueueProcessingPaused) { isQueueProcessingPaused = false; logAndEmit('▶️ Cola reanudada.', 'log-info'); io.emit('queue-status-update', { isPaused: false }); processQueue(); } res.status(200).json({ message: 'Cola reanudada.' }); });
app.post('/clear-queue', requireAuth, async (req, res) => { logAndEmit('🗑️ Vaciando la cola de tareas pendientes...', 'log-warn'); const tasksToCancel = taskQueue.length; taskQueue = []; try { await pool.query("UPDATE envios SET estado = 'cancelled' WHERE estado = 'pending'"); logAndEmit(`✅ Cola vaciada. ${tasksToCancel} tareas canceladas.`, 'log-success'); io.emit('queue-update', taskQueue.length); res.status(200).json({ message: 'Cola limpiada.' }); } catch (dbError) { logAndEmit(`❌ Error al cancelar tareas: ${dbError.message}`, 'log-error'); res.status(500).json({ message: 'Error en DB.' }); } });
app.post('/manual-activate', requireAuth, upload.none(), async (req, res) => { const { destinationNumber } = req.body; if (!destinationNumber) return res.status(400).json({ message: "Falta el número." }); if (availableWorkers.size === 0) return res.status(503).json({ message: "Workers ocupados." }); const workerIndex = availableWorkers.values().next().value; availableWorkers.delete(workerIndex); io.emit('workers-status-update', { available: availableWorkers.size, active: senderPool.length - availableWorkers.size }); logAndEmit(`▶️ [Worker ${workerIndex}] iniciando activación MANUAL para ${destinationNumber}.`, 'log-info'); executeActivationSequence(destinationNumber, workerIndex); res.status(202).json({ message: "Activación iniciada." }); });
app.post('/debug-update-window', requireAuth, async (req, res) => { const { recipientNumber, newTimestamp } = req.body; if (!recipientNumber || !newTimestamp) return res.status(400).json({ message: "Faltan datos." }); try { await pool.query(`INSERT INTO conversation_windows (recipient_number, last_activation_time) VALUES ($1, $2) ON CONFLICT (recipient_number) DO UPDATE SET last_activation_time = $2`, [recipientNumber, newTimestamp]); const state = await getConversationWindowState(recipientNumber); io.emit('window-status-update', state); res.json({ message: `Fecha forzada para ${recipientNumber}.` }); } catch (error) { console.error("Error en /debug-update-window:", error); res.status(500).json({ message: "Error al actualizar." }); } });
app.post('/update-delays', requireAuth, (req, res) => { const { delay1, delay2, taskSeparation } = req.body; const d1 = parseInt(delay1, 10), d2 = parseInt(delay2, 10), sep = parseInt(taskSeparation, 10); if (isNaN(d1) || isNaN(d2) || isNaN(sep) || d1 < 0 || d2 < 0 || sep < 0) return res.status(400).json({ message: 'Valores inválidos.' }); delaySettings.delay1 = d1; delaySettings.delay2 = d2; delaySettings.taskSeparation = sep; logAndEmit(`🔧 Tiempos actualizados: D1=${d1}ms, D2=${d2}ms, Sep=${sep}ms`, 'log-info'); io.emit('delay-settings-updated', delaySettings); res.status(200).json({ message: 'Delays actualizados.' }); });

// --- LÓGICA DE PROCESAMIENTO DE TAREAS ---
function releaseWorkerAndContinue(workerIndex) {
    availableWorkers.add(workerIndex);
    io.emit('workers-status-update', { available: availableWorkers.size, active: senderPool.length - availableWorkers.size });
    setTimeout(processQueue, delaySettings.taskSeparation);
}

async function processQueue() {
    if (isQueueProcessingPaused || isConversationCheckPaused || availableWorkers.size === 0 || taskQueue.length === 0) {
        if (taskQueue.length > 0) {
            io.emit('window-status-update', await getConversationWindowState(taskQueue[0].recipientNumber));
        }
        return;
    }

    const nextRecipient = taskQueue[0].recipientNumber;
    const windowState = await getConversationWindowState(nextRecipient);
    io.emit('window-status-update', windowState);

    if (windowState.status === 'COOL_DOWN' || windowState.status === 'EXPIRING_SOON') {
        if (!isConversationCheckPaused) {
            logAndEmit(`⏸️ Cola en espera para ${nextRecipient}: ${windowState.details}`, 'log-warn');
            isConversationCheckPaused = true;
        }
        setTimeout(() => {
            isConversationCheckPaused = false;
            logAndEmit('▶️ Reanudando la cola...', 'log-info');
            processQueue();
        }, 30000);
        return;
    }
    isConversationCheckPaused = false;

    while (availableWorkers.size > 0 && taskQueue.length > 0 && !isQueueProcessingPaused) {
        const workerIndex = availableWorkers.values().next().value;
        availableWorkers.delete(workerIndex);
        io.emit('workers-status-update', { available: availableWorkers.size, active: senderPool.length - availableWorkers.size });
        const task = taskQueue.shift();
        io.emit('queue-update', taskQueue.length);

        try {
            await pool.query('UPDATE envios SET estado = $1, remitente_usado = $2 WHERE id = $3', ['procesando', senderPool[workerIndex].id, task.id]);
            logAndEmit(`▶️ [Worker ${workerIndex}] iniciando tarea #${task.id}`, 'log-info');
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
            logAndEmit(`[Worker ${workerIndex}] ⚠️ Ventana cerrada para #${id}. Activando...`, 'log-warn');
            taskQueue.unshift(task);
            io.emit('queue-update', taskQueue.length);
            await pool.query("UPDATE envios SET estado = 'pending' WHERE id = $1", [id]);
            await executeActivationSequence(recipientNumber, workerIndex);
            return;
        }
        
        logAndEmit(`[Worker ${workerIndex}] 📤 1/3: Enviando "activar" para #${id}...`, 'log-info');
        await axios.post(API_URL, { messaging_product: "whatsapp", to: recipientNumber, type: "text", text: { body: "activar" } }, { headers: HEADERS });
        await delay(delaySettings.delay1);
        
        await axios.post(API_URL, { messaging_product: "whatsapp", to: recipientNumber, type: "text", text: { body: "3" } }, { headers: HEADERS });
        await delay(delaySettings.delay2);
        
        const publicImageUrl = `${RENDER_EXTERNAL_URL}/uploads/pending/${imageName}`;
        await axios.post(API_URL, { messaging_product: "whatsapp", to: recipientNumber, type: "image", image: { link: publicImageUrl } }, { headers: HEADERS });
        await delay(2000);
        
        logAndEmit(`[Worker ${workerIndex}] ✅ Secuencia completada para #${id}.`, 'log-success');
        await pool.query('UPDATE envios SET estado = $1 WHERE id = $2', ['enviado', id]);
        
        releaseWorkerAndContinue(workerIndex);
    } catch (error) {
        const errorMessage = error.response?.data?.error?.message || error.message;
        logAndEmit(`[Worker ${workerIndex}] 🚫 Falló secuencia para #${id}: ${errorMessage}`, 'log-error');
        await pool.query("UPDATE envios SET estado = 'failed' WHERE id = $1", [id]);
        releaseWorkerAndContinue(workerIndex);
    }
}

async function executeActivationSequence(recipientNumber, workerIndex) {
    const sender = senderPool[workerIndex];
    const API_URL = `https://graph.facebook.com/v19.0/${sender.id}/messages`;
    const HEADERS = { 'Authorization': `Bearer ${sender.token}`, 'Content-Type': 'application/json' };
    const publicImageUrl = `${RENDER_EXTERNAL_URL}/assets/${ACTIVATION_IMAGE_NAME}`;
    try {
        logAndEmit(`[Worker ${workerIndex}] 📤 Enviando Template (pago)...`, 'log-info');
        await axios.post(API_URL, { messaging_product: "whatsapp", to: recipientNumber, type: "template", template: { name: "hello_world", language: { code: "en_US" } } }, { headers: HEADERS });
        await delay(delaySettings.delay1);
        
        await axios.post(API_URL, { messaging_product: "whatsapp", to: recipientNumber, type: "text", text: { body: "3" } }, { headers: HEADERS });
        await delay(delaySettings.delay2);
        
        await axios.post(API_URL, { messaging_product: "whatsapp", to: recipientNumber, type: "image", image: { link: publicImageUrl } }, { headers: HEADERS });
        await delay(5000);
        
        await pool.query(`INSERT INTO conversation_windows (recipient_number, last_activation_time) VALUES ($1, NOW()) ON CONFLICT (recipient_number) DO UPDATE SET last_activation_time = NOW()`, [recipientNumber]);
        logAndEmit(`[Worker ${workerIndex}] ✅ Ventana de 24h activada para ${recipientNumber}.`, 'log-success');
        
        const state = await getConversationWindowState(recipientNumber);
        io.emit('window-status-update', state);
    } catch (error) {
        const errorMessage = error.response?.data?.error?.message || error.message;
        logAndEmit(`[Worker ${workerIndex}] 🚫 Falló activación: ${errorMessage}`, 'log-error');
    } finally {
        releaseWorkerAndContinue(workerIndex);
    }
}

// --- TAREAS DE MANTENIMIENTO ---
async function cleanupOldFiles(directory, maxAge) {
    try {
        const files = await fs.readdir(directory);
        for (const file of files) {
            const filePath = path.join(directory, file);
            const stats = await fs.stat(filePath);
            if (stats.isDirectory()) {
                await cleanupOldFiles(filePath, maxAge);
            } else if (Date.now() - stats.mtime.getTime() > maxAge) {
                await fs.unlink(filePath);
                console.log(`🧹 Archivo antiguo borrado: ${filePath}`);
            }
        }
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.error(`Error al limpiar ${directory}:`, err);
        }
    }
}

// --- INICIO DEL SERVIDOR ---
async function startServer() {
    try {
        await createDirectories();
        if (!fsSync.existsSync(activationImagePath)) {
            console.error(`🔥🔥🔥 ERROR FATAL: El archivo '${ACTIVATION_IMAGE_NAME}' no está en /assets.`);
            process.exit(1);
        }
        await initializeDatabase();
        await loadPendingTasks();

        server.listen(PORT, () => {
            console.log(`🚀 Servidor iniciado en puerto ${PORT}.`);
            const unaSemanaEnMs = 7 * 24 * 60 * 60 * 1000;

            console.log('🧹 Limpieza inicial de archivos...');
            cleanupOldFiles(ARCHIVED_DIR, unaSemanaEnMs);
            cleanupOldFiles(ZIPS_DIR, unaSemanaEnMs);

            setInterval(() => {
                console.log('🧹 Ejecutando limpieza periódica...');
                cleanupOldFiles(ARCHIVED_DIR, unaSemanaEnMs);
                cleanupOldFiles(ZIPS_DIR, unaSemanaEnMs);
            }, 24 * 60 * 60 * 1000);

            if (taskQueue.length > 0) {
                logAndEmit('▶️ Iniciando procesamiento de la cola.', 'log-info');
                processQueue();
            }
        });
    } catch (error) {
        console.error("🔥🔥🔥 FALLO CRÍTICO AL INICIAR SERVIDOR 🔥🔥🔥", error);
        process.exit(1);
    }
}

startServer();