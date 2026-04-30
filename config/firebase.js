// config/firebase.js
const admin = require("firebase-admin");
require('dotenv').config();

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
  storageBucket: "prostem-db-68733.appspot.com",
});

const db = admin.firestore();
const bucket = admin
  .storage()
  .bucket("gs://prostem-db-68733.firebasestorage.app");

module.exports = { admin, db, bucket };