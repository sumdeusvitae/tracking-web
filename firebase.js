// firebase.js
const admin = require('firebase-admin');
// const serviceAccount = require('./serviceAccountKey.json'); // for local

admin.initializeApp({
//   credential: admin.credential.cert(serviceAccount), // for local
    credential: admin.credential.applicationDefault(), // prod
});

const db = admin.firestore();

module.exports = db;

