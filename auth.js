// /auth.js
const basicAuth = require('express-basic-auth');
const config    = require('./config');

// --- Validaciones al arrancar ---
if (!config.ADMIN_USER || !config.ADMIN_PASSWORD || !config.NORMAL_USER || !config.NORMAL_USER_PASSWORD) {
    console.error('❌ Error Crítico: Faltan credenciales de ADMIN o USER en .env');
    process.exit(1);
}
if (!config.WHATSAPP_APP_SECRET) {
    console.error('❌ Error Crítico: Falta WHATSAPP_APP_SECRET en .env (Meta > Configuración básica > Clave secreta)');
    process.exit(1);
}
if (!config.VERIFY_TOKEN) {
    console.error('❌ Error Crítico: Falta VERIFY_TOKEN en .env');
    process.exit(1);
}
if (config.PHONE_NUMBER_IDS.length === 0 || config.PHONE_NUMBER_IDS.length !== config.WHATSAPP_TOKENS.length) {
    console.error('❌ Error Crítico: Configuración de remitentes inválida (PHONE_NUMBER_ID y WHATSAPP_TOKEN no coinciden)');
    process.exit(1);
}

const users = {
    [config.ADMIN_USER]:  config.ADMIN_PASSWORD,
    [config.NORMAL_USER]: config.NORMAL_USER_PASSWORD,
};

const userRoles = {
    [config.ADMIN_USER]:  'admin',
    [config.NORMAL_USER]: 'user',
};

const requireAuth = basicAuth({
    authorizer: (username, password) => {
        const userPassword = users[username];
        return userPassword && basicAuth.safeCompare(password, userPassword);
    },
    authorizeAsync: false,
    challenge: true,
});

const requireAdmin = (req, res, next) => {
    if (userRoles[req.auth.user] === 'admin') return next();
    return res.status(403).send('Acceso denegado: se requiere rol de administrador.');
};

module.exports = { requireAuth, requireAdmin };
