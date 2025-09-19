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


if (!process.env.ADMIN_USER || !process.env.ADMIN_PASSWORD) {
    console.error("❌ Error Crítico: Faltan las credenciales ADMIN_USER o ADMIN_PASSWORD en el archivo .env.");
    process.exit(1);
}
const requireAuth = basicAuth({
    users: { [process.env.ADMIN_USER]: process.env.ADMIN_PASSWORD },
    challenge: true, // Esto hace que el navegador muestre el pop-up de login
    unauthorizedResponse: 'Acceso no autorizado. Se requieren credenciales válidas.'
});

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
const ASSETS_DIR = path.join(__dirname, 'assets');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
if (!fs.existsSync(ASSETS_DIR)) fs.mkdirSync(ASSETS_DIR, { recursive: true });
const upload = multer({ dest: TEMP_DIR });

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

// --- LÓGICA DE GESTIÓN DE VENTANA (CORREGIDA) ---
async function getConversationWindowState(recipientNumber) {
    const windowResult = await pool.query('SELECT last_activation_time FROM conversation_windows WHERE recipient_number = $1', [recipientNumber]);
    if (windowResult.rowCount === 0) {
        return { status: 'INACTIVE', details: 'Nunca activada' };
    }
    const lastActivation = new Date(windowResult.rows[0].last_activation_time).getTime();
    const minutesSinceActivation = (Date.now() - lastActivation) / (1000 * 60);
    const minutesLeft = 24 * 60 - minutesSinceActivation;

    // 1. Comprobar si está en período de enfriamiento (primeros 10 minutos).
    if (minutesSinceActivation < 10) {
        return { status: 'COOL_DOWN', details: `Enfriamiento por ${Math.round(10 - minutesSinceActivation)} min más` };
    }

    // 2. <<< CORRECCIÓN: Comprobar si está expirada PRIMERO.
    // Esta es la condición más importante después del cooldown.
    if (minutesLeft <= 0) {
        return { status: 'INACTIVE', details: 'Expirada' };
    }

    // 3. <<< CORRECCIÓN: Ahora comprobar si expira pronto.
    // Este bloque solo se ejecutará si minutesLeft está entre 0 y 20 (ej: 15).
    if (minutesLeft < 20) {
        return { status: 'EXPIRING_SOON', details: `Expira en ${Math.round(minutesLeft)} min` };
    }

    // 4. Si ninguna de las condiciones anteriores se cumple, está activa.
    return { status: 'ACTIVE', details: `Activa por ${Math.floor(minutesLeft / 60)}h ${Math.round(minutesLeft % 60)}m más` };
}

// --- INICIALIZACIÓN DE BASE DE DATOS ---
async function initializeDatabase() {
    const client = await pool.connect();
    try {
        await client.query(`CREATE TABLE IF NOT EXISTS envios (id SERIAL PRIMARY KEY, numero_destino VARCHAR(255) NOT NULL, nombre_imagen VARCHAR(255), remitente_usado VARCHAR(255), estado VARCHAR(50), creado_en TIMESTAMPTZ DEFAULT NOW());`);
        await client.query(`CREATE TABLE IF NOT EXISTS confirmados (id SERIAL PRIMARY KEY, numero_confirmado VARCHAR(255) NOT NULL, mensaje_confirmacion VARCHAR(255), confirmado_en TIMESTAMPTZ DEFAULT NOW());`);
        await client.query(`CREATE TABLE IF NOT EXISTS conversation_windows (id SERIAL PRIMARY KEY, recipient_number VARCHAR(255) NOT NULL UNIQUE, last_activation_time TIMESTAMPTZ NOT NULL);`);
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
    const activeWorkersCount = senderPool.length - availableWorkers.size;
    socket.emit('queue-update', taskQueue.length);
    socket.emit('workers-status-update', { available: availableWorkers.size, active: activeWorkersCount });
    socket.on('request-window-status', async ({ number }) => {
        try {
            const state = await getConversationWindowState(number);

            // <<<--- INICIO DE LA CORRECCIÓN
            // En lugar de actualizar la UI principal, enviamos el resultado como un log
            // personalizado solo al usuario que lo solicitó.
            // El evento 'status-update' ya es manejado por el frontend para añadir logs.
            let logType = 'log-info';
            if (state.status === 'ACTIVE' || state.status === 'COOL_DOWN') logType = 'log-success';
            if (state.status === 'INACTIVE' || state.status === 'EXPIRING_SOON') logType = 'log-warn';

            socket.emit('status-update', {
                text: `[Consulta] Estado para ${number}: <strong>${state.status}</strong> (${state.details})`,
                type: logType
            });
            // <<<--- FIN DE LA CORRECCIÓN

        } catch (error) {
            // El manejo de errores ya era correcto. Se envía a los logs globales.
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
            await pool.query('DELETE FROM confirmados');
            io.emit('datos-confirmados', []);
            socket.emit('status-update', { text: "✅ DB de confirmados limpiada.", isError: false, isComplete: true });
        } catch (dbError) {
            socket.emit('status-update', { text: "❌ Error al limpiar la DB.", isError: true, isComplete: true });
        }
    });
});

// --- ENDPOINTS ---
app.get('/panel', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'panel.html')));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/assets', express.static(ASSETS_DIR));
app.get('/', (req, res) => res.send('Servidor activo. Visita /panel para usar el control.'));

// WEBHOOK PASIVO
app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message || message.type !== 'text') return;
    const from = message.from;
    const textBody = message.text.body.trim();
 const match = textBody.match(/confirmado\s+(\d{8})/i);

    // `match` será `null` si no se encuentra el patrón.
    // Si se encuentra, será un array, y el número de 8 dígitos estará en `match[1]`.
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

// ENDPOINT DE DEPURACIÓN (CORREGIDO)
app.post('/debug-update-window', requireAuth, async (req, res) => { // <-- Se eliminó upload.none()
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

// ENDPOINT DE ACTIVACIÓN MANUAL
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

// ENDPOINT PARA SUBIR EL ZIP
// ENDPOINT PARA SUBIR EL ZIP (MODIFICADO PARA SER MÁS ESTABLE)
app.post('/subir-zip', requireAuth, upload.single('zipFile'), async (req, res) => {
    const { destinationNumber } = req.body;
    const zipFile = req.file;
    if (!destinationNumber || !zipFile) return res.status(400).json({ message: "Faltan datos." });

    const zipFilePath = zipFile.path;
    try {
        const zip = new AdmZip(zipFilePath);
        const imageEntries = zip.getEntries().filter(e => !e.isDirectory && /\.(jpg|jpeg|png)$/i.test(e.entryName));
        if (imageEntries.length === 0) return res.status(400).json({ message: "El ZIP no contiene imágenes válidas." });
        
        // <<< CAMBIO 1: Eliminamos el ZIP temporal inmediatamente después de abrirlo en memoria.
        // Ya tenemos las entradas del ZIP en la variable `imageEntries`, no necesitamos más el archivo físico.
        fs.unlinkSync(zipFilePath); 
        logAndEmit(`📦 ZIP recibido y borrado. Optimizando ${imageEntries.length} imágenes una por una...`, 'log-info');

        // <<< CAMBIO 2: Procesamiento en serie para evitar picos de CPU y RAM.
        // Reemplazamos Promise.all por un bucle `for...of`.
        const optimizedImageNames = [];
        for (const entry of imageEntries) {
            const originalFileName = path.basename(entry.entryName);
            const optimizedFileName = `opt-${Date.now()}-${originalFileName.replace(/\s/g, '_')}`;
            const targetPath = path.join(UPLOADS_DIR, optimizedFileName);
            const imageBuffer = entry.getData();

            try {
                // `await` dentro del bucle asegura que procesamos una imagen a la vez.
                await sharp(imageBuffer)
                    .resize({ width: 1920, withoutEnlargement: true })
                    .jpeg({ quality: 80 })
                    .toFile(targetPath);
                
                optimizedImageNames.push(optimizedFileName);
                // Opcional: emitir un log por cada imagen optimizada para dar feedback en ZIPs grandes.
                // logAndEmit(`  - Optimizada: ${originalFileName}`, 'log-info');

            } catch (sharpError) {
                logAndEmit(`⚠️ No se pudo optimizar la imagen ${originalFileName}. Saltando... Error: ${sharpError.message}`, 'log-warn');
            }
        }

        if (optimizedImageNames.length === 0) {
            logAndEmit(`❌ No se pudo optimizar ninguna imagen del ZIP.`, 'log-error');
            return res.status(400).json({ message: "Ninguna imagen en el ZIP pudo ser procesada." });
        }

        const newTasks = optimizedImageNames.map(imageName => ({ recipientNumber: destinationNumber, imageName }));
        taskQueue.push(...newTasks);

        logAndEmit(`✅ Optimización completa. Se agregaron ${newTasks.length} tareas a la cola.`, 'log-success');
        io.emit('queue-update', taskQueue.length);
        processQueue();
        res.status(200).json({ message: `Se han encolado ${newTasks.length} envíos optimizados.` });

    } catch (error) {
        logAndEmit(`❌ Error fatal al procesar el ZIP: ${error.message}`, 'log-error');
        res.status(500).json({ message: "Error interno al procesar el ZIP." });
    } 
    // <<< CAMBIO 3: Ya no necesitamos el `finally` para borrar el ZIP porque lo hacemos antes.
});
// --- LÓGICA DE PROCESAMIENTO ---
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function releaseWorkerAndContinue(workerIndex) {
    availableWorkers.add(workerIndex);
    const activeWorkersCount = senderPool.length - availableWorkers.size;
    io.emit('workers-status-update', { available: availableWorkers.size, active: activeWorkersCount });
    setTimeout(processQueue, 500);
}

async function processQueue() {
    if (availableWorkers.size === 0 || taskQueue.length === 0) {
        if (taskQueue.length > 0) io.emit('window-status-update', await getConversationWindowState(taskQueue[0].recipientNumber));
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
        setTimeout(processQueue, 60000);
        return;
    }
    isQueuePaused = false;
    while (availableWorkers.size > 0 && taskQueue.length > 0) {
        const workerIndex = availableWorkers.values().next().value;
        availableWorkers.delete(workerIndex);
        io.emit('workers-status-update', { available: availableWorkers.size, active: senderPool.length - availableWorkers.size });
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
        const windowState = await getConversationWindowState(recipientNumber);
        if (windowState.status === 'INACTIVE') {
            logAndEmit(`[Worker ${workerIndex}] ⚠️ Ventana cerrada. Activación automática...`, 'log-warn');
            taskQueue.unshift(task);
            io.emit('queue-update', taskQueue.length);
            await executeActivationSequence(recipientNumber, workerIndex);
            return;
        }
        await pool.query('INSERT INTO envios (numero_destino, nombre_imagen, remitente_usado, estado) VALUES ($1, $2, $3, $4)', [recipientNumber, imageName, sender.id, 'procesando']);
        logAndEmit(`[Worker ${workerIndex}] 📤 1/3: Enviando "activar" (gratis)...`, 'log-info');
        await axios.post(API_URL, { messaging_product: "whatsapp", to: recipientNumber, type: "text", text: { body: "activar" } }, { headers: HEADERS });
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

function cleanupOldFiles(directory, maxAge) {
    fs.readdir(directory, (err, files) => {
        if (err) {
            console.error(`Error al leer el directorio ${directory}:`, err);
            return;
        }

        files.forEach(file => {
            const filePath = path.join(directory, file);
            fs.stat(filePath, (err, stats) => {
                if (err) {
                    console.error(`Error al obtener stats de ${file}:`, err);
                    return;
                }
                
                if (Date.now() - stats.mtime.getTime() > maxAge) {
                    fs.unlink(filePath, (unlinkErr) => {
                        if (unlinkErr) {
                            console.error(`Error al borrar archivo antiguo ${file}:`, unlinkErr);
                        } else {
                            console.log(`🧹 Archivo antiguo borrado: ${file}`);
                        }
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
        server.listen(PORT, () => {
            console.log(`🚀 Servidor iniciado. Pool de ${senderPool.length} remitente(s) listo.`);
            
            // <<< CAMBIO 5: Configuración de la limpieza periódica.
            const unaSemanaEnMs = 7 * 24 * 60 * 60 * 1000;
            
            // Ejecutamos la limpieza una vez al iniciar...
            console.log('🧹 Realizando limpieza inicial de archivos antiguos...');
            cleanupOldFiles(UPLOADS_DIR, unaSemanaEnMs);

            // ...y luego la programamos para que se ejecute cada 24 horas.
            setInterval(() => {
                console.log('🧹 Ejecutando limpieza periódica programada de archivos antiguos...');
                cleanupOldFiles(UPLOADS_DIR, unaSemanaEnMs);
            }, 24 * 60 * 60 * 1000); // Cada 24 horas

        });
    } catch (error) {
        console.error("🔥🔥🔥 FALLO CRÍTICO AL INICIAR EL SERVIDOR 🔥🔥🔥");
        console.error("No se pudo conectar o inicializar la base de datos.");
        console.error("Error detallado:", error);
        process.exit(1);
    }
}

startServer();