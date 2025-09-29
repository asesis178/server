// /services/db.js
const { Pool } = require('pg');
const config = require('../config');
const { logAndEmit } = require('../utils/helpers');
const state = require('../state');

const pool = new Pool({
    connectionString: config.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

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

async function loadPendingTasks(io) {
    try {
        logAndEmit('🔄 Cargando tareas pendientes...', 'log-info');
        const res = await pool.query("SELECT id, numero_destino, nombre_imagen FROM envios WHERE estado IN ('pending', 'procesando') ORDER BY id ASC");
        if (res.rowCount > 0) {
            state.taskQueue = res.rows.map(row => ({
                id: row.id,
                recipientNumber: row.numero_destino,
                imageName: row.nombre_imagen
            }));
            logAndEmit(`✅ ${state.taskQueue.length} tareas cargadas.`, 'log-success');
        } else {
            logAndEmit('👍 No se encontraron tareas pendientes.', 'log-info');
        }
        io.emit('queue-update', state.taskQueue.length);
    } catch (error) {
        logAndEmit(`❌ Error fatal al cargar tareas: ${error.message}`, 'log-error');
        process.exit(1);
    }
}

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


module.exports = {
    pool,
    initializeDatabase,
    loadPendingTasks,
    getConversationWindowState,
};