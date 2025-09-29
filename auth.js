// /auth.js
const basicAuth = require('express-basic-auth');
const config = require('./config');

// --- VALIDACIONES DE INICIO Y AUTENTICACIÓN ---
if (!config.ADMIN_USER || !config.ADMIN_PASSWORD || !config.NORMAL_USER || !config.NORMAL_USER_PASSWORD) {
    console.error("❌ Error Crítico: Faltan credenciales de ADMIN o USER en el archivo .env.");
    process.exit(1);
}
if (config.PHONE_NUMBER_IDS.length === 0 || config.PHONE_NUMBER_IDS.length !== config.WHATSAPP_TOKENS.length) {
    console.error("❌ Error Crítico: Configuración de remitentes inválida.");
    process.exit(1);
}

const users = {
    [config.ADMIN_USER]: config.ADMIN_PASSWORD,
    [config.NORMAL_USER]: config.NORMAL_USER_PASSWORD
};

const userRoles = {
    [config.ADMIN_USER]: 'admin',
    [config.NORMAL_USER]: 'user'
};

const requireAuth = basicAuth({
    authorizer: (username, password) => {
        const userPassword = users[username];
        return userPassword && basicAuth.safeCompare(password, userPassword);
    },
    authorizeAsync: false,
    challenge: true
});

// Middleware para restringir a solo admins
const requireAdmin = (req, res, next) => {
    const user = req.auth.user;
    if (userRoles[user] === 'admin') {
        return next();
    }
    return res.status(403).send('Acceso denegado: se requiere rol de administrador.');
};

module.exports = {
    requireAuth,
    requireAdmin
};