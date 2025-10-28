const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");
const app = express();
const multer = require("multer");
const { DateTime } = require("luxon");
const nodemailer = require("nodemailer");
const cron = require("node-cron")
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
require("dotenv").config(); // carga las variables de .env
const path = require('path');
const fs = require('fs');


require("dotenv").config();

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
  storageBucket: "prostem-db-68733.appspot.com",
});


//Initialize firebase admin
const PORT = process.env.PORT || 3000;
const db = admin.firestore();
const bucket = admin
  .storage()
  .bucket("gs://prostem-db-68733.firebasestorage.app");

//File middleware
const sharp = require("sharp");
const resizeValue = 100; // This is to help save space on Firebase Storage.
const qualityValue = 65; // From 0 to 100
const upload = multer({ storage: multer.memoryStorage() });

function getFullNameFromToken(decodedTokenName) {
  const parts = decodedTokenName.trim().split(/\s+/);
  let name = "",
    lastName1 = "",
    lastName2 = "";

  if (parts.length === 1) {
    name = parts[0];
  } else if (parts.length === 2) {
    [name, lastName1] = parts;
  } else if (parts.length === 3) {
    [name, lastName1, lastName2] = parts;
  } else {
    // Assume the name is everything except the last two parts of the string
    name = parts.slice(0, -2).join(" ");
    lastName1 = parts[parts.length - 2];
    lastName2 = parts[parts.length - 1];
  }

  return { name, lastName1, lastName2 };
}

async function compressProfilePicture(multerFile, userUID) {
  //Compress the image
  const compressedImageBuffer = await sharp(multerFile.buffer)
    .resize(resizeValue)
    .webp({ quality: qualityValue })
    .toBuffer();

  const fileName = `profilePictures/${userUID}`;
  const fileInBucket = bucket.file(fileName);

  await fileInBucket.save(compressedImageBuffer, {
    metadata: {
      contentType: "image/webp",
    },
  });
  // This makes the file public
  // TODO: use signed tokens if privacy is needed
  await fileInBucket.makePublic();
  return fileInBucket.publicUrl();
}

async function deleteCollectionInBatchesIterative(
  collectionRef,
  batchSize = 500
) {
  let deletedCount = 0;

  while (true) {
    const snapshot = await collectionRef.limit(batchSize).get();

    if (snapshot.empty) {
      break;
    }

    const batch = db.batch();
    snapshot.docs.forEach((doc) => {
      batch.delete(doc.ref);
    });

    await batch.commit();
    deletedCount += snapshot.size;

    console.log(`Eliminados ${deletedCount} documentos de la subcolección...`);
  }
}

//SIGN UP WITH EMAIL & PASSWORD
app.post(
  "/api/signUp-emailPassword",
  upload.single("photo"),
  async (request, response) => {
    const {
      email,
      password,
      name,
      lastName1,
      lastName2,
      phone,
      birthDate,
      institution,
      teachingLevel,
      specializations,
    } = request.body;

    try {
      //Create user in Firebase Authentication
      const userRecord = await admin.auth().createUser({
        email,
        password,
        displayName: `${name} ${lastName1}`,
      });

      let photoURL = null;
      if (request.file) {
        //Compress the image
        const compressedImageBuffer = await sharp(request.file.buffer)
          .resize(resizeValue)
          .webp({ quality: qualityValue })
          .toBuffer();

        const fileName = `profilePictures/${userRecord.uid}.jpg`;
        const file = bucket.file(fileName);

        await file.save(compressedImageBuffer, {
          metadata: {
            contentType: "image/webp",
          },
        });
        // This makes the file public
        // TODO: use signed tokens if privacy is needed
        await file.makePublic();
        photoURL = file.publicUrl();
      }
      const parsedSpecializations = JSON.parse(specializations || "[]");
      await db.collection("users").doc(userRecord.uid).set({
        email,
        name,
        lastName1,
        lastName2,
        phone,
        birthDate,
        institution,
        teachingLevel,
        specializations: parsedSpecializations,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        active: true,
        myEvents: null,
        role: "user",
        photoURL,
      });
      response
        .status(201)
        .json({ message: "Usuario registrado", uid: userRecord.uid });
    } catch (error) {
      console.error("Error adding user:", error);
      return response.status(400).json({ error: error.message });
    }
  }
);

//SIGN UP WITH GOOGLE
app.post(
  "/api/signUp-Google",
  upload.single("photo"),
  async (request, response) => {
    const {
      idToken,
      phone,
      birthDate,
      institution,
      teachingLevel,
      specializations,
    } = request.body;

    try {
      // 1. Verify the idToken with Firebase
      const decodedToken = await admin.auth().verifyIdToken(idToken);
      const uid = decodedToken.uid;
      const email = decodedToken.email;
      const googlePhoto = decodedToken.picture;
      //Try to get the name and surnames
      const { name, lastName1, lastName2 } = getFullNameFromToken(
        decodedToken.name
      );

      let photoURL = googlePhoto || null;

      //Upload image to storage if the user uploaded their own.
      if (request.file) {
        const fileName = `profilePictures/${uid}`;
        const file = bucket.file(fileName);

        await file.save(request.file.buffer, {
          metadata: { contentType: request.file.mimetype },
        });

        await file.makePublic();
        photoURL = file.publicUrl();
      }

      //Save data to Firestore
      const parsedSpecializations = JSON.parse(specializations || "[]");
      await db.collection("users").doc(uid).set({
        email,
        name,
        lastName1,
        lastName2,
        phone,
        birthDate,
        institution,
        teachingLevel,
        specializations: parsedSpecializations,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        active: true,
        myEvents: null,
        role: "user",
        photoURL,
      });

      response
        .status(201)
        .json({ message: "Usuario registrado con Google", uid });
    } catch (error) {
      console.error("Error al registrar con Google:", error);
      response.status(400).json({ error: error.message });
    }
  }
);

//SIGN IN WITH EMAIL & PASSWORD
app.post("/api/signIn-emailPassword", async (request, response) => {
  const { idToken } = request.body;
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const uid = decodedToken.uid;

    // Search the user's data on Firestore
    const userDoc = await admin.firestore().collection("users").doc(uid).get();

    if (!userDoc.exists) {
      return response
        .status(404)
        .json({ message: "Usuario no registrado en la base de datos" });
    }

    const userData = userDoc.data();
    response.status(200).json({ message: "Login exitoso", user: userData });
  } catch (error) {
    console.error("Error verificando token:", error);
    response
      .status(401)
      .json({ message: "Token inválido", error: error.message });
  }
});

//SIGN IN WITH GOOGLE
app.post("/api/signIn-Google", async (request, response) => {
  const { idToken } = request.body;

  if (!idToken) {
    console.log("No token");
    return response.status(400).json({ message: "Token no proporcionado" });
  }
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const uid = decodedToken.uid;

    // Search the user's data on Firestore
    const userDoc = await admin.firestore().collection("users").doc(uid).get();

    if (!userDoc.exists) {
      await admin.auth().deleteUser(uid);
      return response
        .status(403)
        .json({ message: "Usuario no registrado en la base de datos" });
    }

    const userData = userDoc.data();
    return response
      .status(200)
      .json({ message: "Login exitoso", user: userData });
  } catch (error) {
    console.error("Error verificando token:", error);
    response
      .status(401)
      .json({ message: "Token inválido", error: error.message });
  }
});

//CREATE AN EVENT
app.post("/api/create-event", async (request, response) => {
  try {
    const {
      capacity,
      description,
      durationHours,
      endDate,
      endTime,
      enrollmentType,
      place,
      teachingLevels,
      specialties,
      startDate,
      startTime,
      title,
      virtualEvent,
      evaluationType,
      eventCategory,
    } = request.body;

    //const parsedSpecialties = JSON.parse(specialties || "[]");
    const eventData = {
      attendees: {},
      capacity: Number(capacity),
      description,
      durationHours,
      endDate,
      endTime,
      enrollmentType,
      place,
      teachingLevels,
      specialties,
      startDate,
      registeredUsers: [],
      startTime,
      survey: null,
      title,
      virtualEvent: Boolean(virtualEvent),
      evaluationType,
      eventCategory,
    };

    const docRef = await db.collection("events").add(eventData);
    response.status(201).json({ message: "Evento creado", id: docRef.id });
  } catch (error) {
    console.error("Error al crear evento:", error);
    response.status(500).json({ message: "Error del servidor" });
  }
});

//GET ALL EVENTS
app.get("/api/events", async (request, response) => {
  try {
    const eventsSnapshot = await db.collection("events").get();
    const events = eventsSnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));
    response.status(200).json(events);
  } catch (error) {
    console.error("Error al obtener eventos:", error);
    response.status(500).json({ message: "Error al obtener eventos" });
  }
});

//GET EVENT BY ID
app.get("/api/events/:id", async (request, response) => {
  const eventId = request.params.id;

  if (!eventId) {
    return response
      .status(400)
      .json({ error: "El ID del evento es obligatorio" });
  }

  try {
    const eventDoc = await db.collection("events").doc(eventId).get();

    if (!eventDoc.exists) {
      return response.status(404).json({ error: "Evento no encontrado" });
    }

    const eventData = { id: eventDoc.id, ...eventDoc.data() };
    return response.status(200).json(eventData);
  } catch (error) {
    console.error("Error al obtener el evento:", error);
    return response.status(500).json({ error: "Error interno del servidor" });
  }
});

//EDIT SINGLE EVENT
app.put("/api/edit-event/:id", async (request, response) => {
  const eventId = request.params.id;
  const updatedData = request.body;

  if (!eventId) {
    return response
      .status(400)
      .json({ error: "El ID del evento es obligatorio" });
  }

  try {
    const docRef = db.collection("events").doc(eventId);
    await docRef.update(updatedData);
    return response
      .status(200)
      .json({ message: "Evento actualizado correctamente" });
  } catch (error) {
    console.error("Error al actualizar el evento:", error);
    return response.status(500).json({ error: "Error interno del servidor" });
  }
});

//DELETE SINGLE EVENT
app.delete("/api/delete-event/:id", async (request, response) => {
  const eventId = request.params.id;

  if (!eventId) {
    return response
      .status(400)
      .json({ error: "El ID del evento es obligatorio" });
  }

  try {
    const docRef = db.collection("events").doc(eventId);
    await docRef.delete();
    return response
      .status(200)
      .json({ message: "Evento eliminado correctamente" });
  } catch (error) {
    console.error("Error al eliminar el evento:", error);
    return response.status(500).json({ error: "Error interno del servidor" });
  }
});

//REGISTER TO AN EVENT
app.post("/api/register-to-event/:id", async (request, response) => {
  const userId = request.body.userId;
  const eventId = request.params.id;

  if (!userId || !eventId) {
    return response
      .status(400)
      .json({ error: "userId y eventId son obligatorios" });
  }

  try {
    const eventRef = db.collection("events").doc(eventId);
    const userRef = db.collection("users").doc(userId);

    const eventDoc = await eventRef.get();
    const userDoc = await userRef.get();

    if (!eventDoc.exists) {
      return response.status(404).json({ error: "Evento no encontrado" });
    }

    if (!userDoc.exists) {
      return response.status(404).json({ error: "Usuario no encontrado" });
    }

    const eventData = eventDoc.data();
    const registeredUsers = eventData.registeredUsers || [];
    const capacity = eventData.capacity || null;

    // Verify if it's already registerd
    if (registeredUsers.includes(userId)) {
      return response
        .status(400)
        .json({ error: "Ya estás inscrito en este evento." });
    }

    // Validate limited capacity
    if (capacity && registeredUsers.length >= capacity) {
      return response.status(400).json({ error: "El evento ya está lleno." });
    }

    // Register the user to the event
    await eventRef.update({
      registeredUsers: admin.firestore.FieldValue.arrayUnion(userId),
    });

    // Add the event to the user's myEvents list
    await userRef.update({
      [`myEvents.${eventId}`]: {
        type: eventData.evaluationType,
        ...(eventData.evaluationType === "Aprovechamiento" && {
          grade: null,
        }),
      },
    });

    return response.status(200).json({ message: "Inscripción exitosa" });
  } catch (error) {
    console.error("Error al registrar al usuario en el evento:", error);
    return response.status(500).json({ error: "Error interno del servidor" });
  }
});

//UNREGISTER TO AN EVENT
app.post("/api/unregister-from-event/:id", async (request, response) => {
  const eventId = request.params.id;
  const uids = request.body.uids;

  if (!uids || !Array.isArray(uids) || uids.length === 0) {
    return response
      .status(400)
      .json({ error: "Lista de usuarios vacía o inválida." });
  }

  const eventRef = db.collection("events").doc(eventId);
  const eventDoc = await eventRef.get();

  if (!eventDoc.exists) {
    return response.status(404).json({ error: "Evento no encontrado" });
  }

  try {
    const batch = db.batch();

    for (const uid of uids) {
      // Remove each UID from the event's registeredUsers array
      batch.update(eventRef, {
        registeredUsers: admin.firestore.FieldValue.arrayRemove(uid),
      });

      // Remove each UID from the user's event history
      const userRef = db.collection("users").doc(uid);
      batch.update(userRef, {
        myEvents: admin.firestore.FieldValue.arrayRemove(eventId),
      });
    }

    await batch.commit();

    return response
      .status(200)
      .json({ message: "Usuarios desmatriculados correctamente" });
  } catch (error) {
    console.error("Error al desmatricular usuarios:", error);
    return response.status(500).json({ error: "Error interno del servidor" });
  }

  /////////////////////////////////////////////////
  // if (!userId || !eventId) {
  //   return response
  //     .status(400)
  //     .json({ error: "userId y eventId son obligatorios" });
  // }

  // try {
  //   const eventRef = db.collection("events").doc(eventId);
  //   const userRef = db.collection("users").doc(userId);

  //   const eventDoc = await eventRef.get();
  //   const userDoc = await userRef.get();

  //   if (!eventDoc.exists) {
  //     return response.status(404).json({ error: "Evento no encontrado" });
  //   }
  //   if (!userDoc.exists) {
  //     return response.status(404).json({ error: "Usuario no encontrado" });
  //   }

  //   const eventData = eventDoc.data();
  //   const eventStartDate = eventData.startDate;
  //   const now = new Date();
  //   // Check that start date is in the future
  //   if (new Date(eventStartDate) <= now) {
  //     return response.status(400).json({
  //       error:
  //         "No puedes desinscribirte después de que el evento haya iniciado.",
  //     });
  //   }

  //   // Verify the user is already registered.
  //   const registeredUsers = eventData.registeredUsers || [];
  //   if (!registeredUsers.includes(userId)) {
  //     return response
  //       .status(400)
  //       .json({ error: "No estás inscrito en este evento." });
  //   }

  //   // Quitar usuario del evento
  //   await eventRef.update({
  //     registeredUsers: admin.firestore.FieldValue.arrayRemove(userId),
  //   });

  //   // Quitar evento del usuario
  //   await userRef.update({
  //     myEvents: admin.firestore.FieldValue.arrayRemove(eventId),
  //   });

  //   return response.status(200).json({ message: "Desinscripción exitosa" });
  // } catch (error) {
  //   console.error("Error al desinscribirse:", error);
  //   return response.status(500).json({ error: "Error interno del servidor" });
  // }
});

//REQUEST REGISTRATION (FOR RESTRICTED EVENTS)
app.post("/api/request-registration/:id", async (request, response) => {
  const userId = request.body.userId;
  const eventId = request.params.id;

  if (!userId || !eventId) {
    return response
      .status(400)
      .json({ error: "userId y eventId son obligatorios" });
  }

  try {
    const eventRef = db.collection("events").doc(eventId);
    const userRef = db.collection("users").doc(userId);

    const eventDoc = await eventRef.get();
    const userDoc = await userRef.get();

    if (!eventDoc.exists) {
      return response.status(404).json({ error: "Evento no encontrado" });
    }

    if (!userDoc.exists) {
      return response.status(404).json({ error: "Usuario no encontrado" });
    }

    const eventData = eventDoc.data();
    const registeredUsers = eventData.registeredUsers || [];
    const pendingRequests = eventData.pendingRequests || [];

    // Alredy registered
    if (registeredUsers.includes(userId)) {
      return response
        .status(400)
        .json({ error: "Ya estás inscrito en este evento." });
    }

    // Already requested to register
    if (pendingRequests.includes(userId)) {
      return response
        .status(400)
        .json({ error: "Ya has solicitado inscripción a este evento." });
    }

    const userData = userDoc.data();
    const userName = `${userData.name} ${userData.lastName1 || ""} ${
      userData.lastName2 || ""
    }`.trim();

    // Add to the pending request list
    await eventRef.update({
      pendingRequests: admin.firestore.FieldValue.arrayUnion({
        uid: userId,
        name: userName,
        // email: userData.email,
        // institution: userData.institution,
      }),
    });

    return response
      .status(200)
      .json({ message: "Solicitud enviada con éxito." });
  } catch (error) {
    console.error("Error al solicitar inscripción:", error);
    return response.status(500).json({ error: "Error interno del servidor" });
  }
});

//PROCESS REGISTRATION REQUEST
app.post(
  "/api/process-registration/:eventId/:userId",
  async (request, response) => {
    const { eventId, userId } = request.params;
    const action = request.body.action; // "approve" or "reject"

    if (!userId || !eventId || !action) {
      return response
        .status(400)
        .json({ error: "eventId, userId y action son obligatorios" });
    }

    if (!["approve", "reject"].includes(action)) {
      return response.status(400).json({ error: "Acción inválida" });
    }

    try {
      const eventRef = db.collection("events").doc(eventId);
      const userRef = db.collection("users").doc(userId);

      const eventDoc = await eventRef.get();
      const userDoc = await userRef.get();

      if (!eventDoc.exists) {
        return response.status(404).json({ error: "Evento no encontrado" });
      }
      if (!userDoc.exists) {
        return response.status(404).json({ error: "Usuario no encontrado" });
      }

      const eventData = eventDoc.data();
      const updatedPending = eventData.pendingRequests.filter(
        (req) => req.uid !== userId
      );
      const registeredUsers = eventData.registeredUsers || [];
      const capacity = eventData.capacity || null;

      const hasRequest = eventData.pendingRequests.some(
        (req) => req.uid === userId
      );

      if (!hasRequest) {
        return response
          .status(400)
          .json({ error: "El usuario no tiene una solicitud pendiente." });
      }

      if (action === "approve") {
        // Validate if the event has limited capacity
        if (capacity && registeredUsers.length >= capacity) {
          return response
            .status(400)
            .json({ error: "El evento ya está lleno." });
        }

        // Aprove
        await eventRef.update({
          registeredUsers: admin.firestore.FieldValue.arrayUnion(userId),
          pendingRequests: updatedPending,
        });

        // Add event to the user's event history
        // await userRef.update({
        //   myEvents: admin.firestore.FieldValue.arrayUnion(eventId),
        // });

        await userRef.update({
          [`myEvents.${eventId}`]: {
            type: eventData.evaluationType,
            ...(eventData.evaluationType === "Aprovechamiento" && {
              grade: null,
            }),
          },
        });

        return response
          .status(200)
          .json({ message: "Solicitud aprobada exitosamente." });
      } else if (action === "reject") {
        // Reject
        await eventRef.update({
          pendingRequests: updatedPending,
        });

        return response
          .status(200)
          .json({ message: "Solicitud rechazada exitosamente." });
      }
    } catch (error) {
      console.error("Error al procesar inscripción:", error);
      return response.status(500).json({ error: "Error interno del servidor" });
    }
  }
);

//UPDATE A SINGLE USER GRADE (FOR EVENTS WITH evaluationType='Aprovechamiento')
app.post("/api/update-user-grade", async (request, response) => {
  const { uid, eventID, grade } = request.body;

  if (!uid || !eventID || (grade !== null && typeof grade !== "number")) {
    return response.status(400).json({ error: "Datos inválidos" });
  }

  try {
    const userRef = db.collection("users").doc(uid);
    const userDoc = await userRef.get();

    // Verify that an user with the provided ID exists
    if (!userDoc.exists) {
      return response.status(404).json({ error: "Usuario no encontrado" });
    }

    // Verify that an event with the provided ID exists
    const userData = userDoc.data();
    const myEvents = userData.myEvents || {};

    if (!myEvents[eventID]) {
      return response.status(400).json({
        error: `El evento '${eventID}' no está registrado para este usuario`,
      });
    }

    // Update the grade
    await userRef.update({
      [`myEvents.${eventID}.grade`]: grade,
    });

    return response.status(200).json({ success: true });
  } catch (err) {
    console.error("Error al actualizar la nota:", err);
    response.status(500).send({ error: "Error al actualizar nota" });
  }
});

//UPDATE ALL GRADES OF AN EVENT (FOR EVENTS WITH evaluationType='Aprovechamiento')
app.post("/api/update-multiple-grades", async (request, response) => {
  const { eventID, updates } = request.body;

  if (!eventID || !Array.isArray(updates)) {
    return response.status(400).json({ error: "Datos inválidos" });
  }

  try {
    const batch = db.batch();

    for (const { uid, grade } of updates) {
      if (!uid) continue;

      const userRef = db.collection("users").doc(uid);
      const fieldPath = `myEvents.${eventID}.grade`;
      const updateData = {};

      updateData[fieldPath] = grade;
      batch.update(userRef, updateData);
    }

    await batch.commit();

    return response.status(200).json({ success: true });
  } catch (error) {
    console.error("Error al actualizar múltiples notas:", error);
    return res.status(500).json({ error: "Error al guardar las notas" });
  }
});

//ADD USER TO WAITING LIST
app.post(
  "/api/add-user-to-waiting-list/:eventId",
  async (request, response) => {
    const eventId = request.params.eventId;
    const userId = request.body.userId;

    if (!eventId || !userId) {
      return response
        .status(400)
        .json({ error: "eventId y userId son obligatorios." });
    }

    try {
      const eventRef = db.collection("events").doc(eventId);
      const userRef = db.collection("users").doc(userId);

      const eventDoc = await eventRef.get();
      const userDoc = await userRef.get();

      if (!eventDoc.exists) {
        return response.status(404).json({ error: "Evento no encontrado." });
      }
      if (!userDoc.exists) {
        return response.status(404).json({ error: "Usuario no encontrado." });
      }

      const eventData = eventDoc.data();
      const registeredUsers = eventData.registeredUsers || [];
      const pendingRequests = eventData.pendingRequests || [];
      const waitingList = eventData.waitingList || [];

      // Verify is it's already registered or pending
      if (registeredUsers.includes(userId)) {
        return response
          .status(400)
          .json({ error: "Ya estás inscrito en este evento." });
      }
      if (pendingRequests.some((req) => req.uid === userId)) {
        return response
          .status(400)
          .json({ error: "Ya has enviado una solicitud para este evento." });
      }

      if (waitingList.some((user) => user.uid === userId)) {
        return response
          .status(400)
          .json({ error: "Ya estás en la lista de espera." });
      }

      const userData = userDoc.data();
      const userName = `${userData.name} ${userData.lastName1 || ""} ${
        userData.lastName2 || ""
      }`.trim();

      // Add to the waiting list
      await eventRef.update({
        waitingList: admin.firestore.FieldValue.arrayUnion({
          uid: userId,
          name: userName,
        }),
      });

      return response
        .status(200)
        .json({ message: "Te has unido a la lista de espera." });
    } catch (error) {
      console.error("Error al unirse a la lista de espera:", error);
      return response
        .status(500)
        .json({ error: "Error interno del servidor." });
    }
  }
);

// PROCESS WAITING LIST REQUEST
app.post(
  "/api/process-waiting-list/:eventId/:userId",
  async (request, response) => {
    const { eventId, userId } = request.params;
    const action = request.body.action; // "approve" or "reject"

    if (!userId || !eventId || !action) {
      return response
        .status(400)
        .json({ error: "eventId, userId y action son obligatorios" });
    }

    if (!["approve", "reject"].includes(action)) {
      return response.status(400).json({ error: "Acción inválida" });
    }

    try {
      const eventRef = db.collection("events").doc(eventId);
      const userRef = db.collection("users").doc(userId);

      const eventDoc = await eventRef.get();
      const userDoc = await userRef.get();

      if (!eventDoc.exists) {
        return response.status(404).json({ error: "Evento no encontrado" });
      }
      if (!userDoc.exists) {
        return response.status(404).json({ error: "Usuario no encontrado" });
      }

      const eventData = eventDoc.data();
      const updatedWaitingList = eventData.waitingList.filter(
        (req) => req.uid !== userId
      );
      const registeredUsers = eventData.registeredUsers || [];
      const capacity = eventData.capacity || null;

      const isUserInWaitingList = eventData.waitingList.some(
        (req) => req.uid === userId
      );

      if (!isUserInWaitingList) {
        return response
          .status(400)
          .json({ error: "El usuario no está en la lista de espera." });
      }

      if (action === "approve") {
        // Verificar si hay cupo en el evento
        if (capacity && registeredUsers.length >= capacity) {
          return response.status(400).json({
            error:
              "El evento ya está lleno, no se puede aprobar la inscripción.",
          });
        }

        // Aprobar y mover a la lista de registrados
        await eventRef.update({
          registeredUsers: admin.firestore.FieldValue.arrayUnion(userId),
          waitingList: updatedWaitingList, // Eliminar de la lista de espera
        });

        // Añadir el evento al historial de eventos del usuario
        await userRef.update({
          myEvents: admin.firestore.FieldValue.arrayUnion(eventId),
        });

        return response.status(200).json({
          message:
            "Solicitud de lista de espera aprobada. Usuario registrado al evento.",
        });
      } else if (action === "reject") {
        // Rechazar y eliminar de la lista de espera
        await eventRef.update({
          waitingList: updatedWaitingList,
        });

        return response.status(200).json({
          message: "Solicitud de lista de espera rechazada exitosamente.",
        });
      }
    } catch (error) {
      console.error("Error al procesar la lista de espera:", error);
      return response.status(500).json({ error: "Error interno del servidor" });
    }
  }
);

//GET ALL USERS
app.get("/api/users", async (request, response) => {
  try {
    const usersSnapshot = await db.collection("users").get();
    const users = usersSnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));
    response.status(200).json(users);
  } catch (error) {
    console.error("Error al obtener los usuarios:", error);
    response.status(500).json({ message: "Error al obtener los usuarios" });
  }
});

//GET USERS FROM GIVEN LIST OF UIDs
app.get("/api/users-from-list", async (request, response) => {
  const raw = request.query.uids;
  const uids = Array.isArray(raw) ? raw : [raw];

  if (!uids || !Array.isArray(uids)) {
    return response.status(400).json({ message: "Parámetro uids inválido" });
  }

  try {
    const promises = uids.map((uid) => db.collection("users").doc(uid).get());
    const snapshots = await Promise.all(promises);

    const users = snapshots
      .filter((snap) => snap.exists)
      .map((snap) => ({ uid: snap.id, ...snap.data() }));

    response.status(200).json(users);
  } catch (error) {
    console.error("Error al obtener usuarios:", error);
    response.status(500).json({ message: "Error interno" });
  }
});

//CHANGE USER ROL
app.put("/api/update-user-role/:id", async (request, response) => {
  const userID = request.params.id;
  const roleSent = request.body;

  if (!userID) {
    return response
      .status(400)
      .json({ error: "El ID del usuario es obligatorio" });
  }

  const validRoles = ["admin", "user"];
  if (!validRoles.includes(roleSent.role)) {
    return response.status(400).json({ error: "¡Rol inválido!" });
  }

  try {
    const userRef = db.collection("users").doc(userID);
    await userRef.update({ role: roleSent.role });
    return response
      .status(200)
      .json({ message: "Rol actualizado correctamente." });
  } catch (error) {
    console.error("Error al actualizar el rol del usuario:", error);
    return response.status(500).json({ error: "Error interno del servidor" });
  }
});

//DELETE USER
app.delete("/api/delete-user/:id", async (request, response) => {
  const userId = request.params.id;

  if (!userId) {
    return response
      .status(400)
      .json({ error: "El ID del usuario es obligatorio" });
  }

  console.log(userId);
  try {
    //Delete from the users collection
    const docRef = db.collection("users").doc(userId);
    await docRef.delete();

    // Delete user from Firebase Authentication
    await admin.auth().deleteUser(userId);
    console.log(
      `Usuario con UID ${userId} eliminado de Firebase Authentication`
    );

    // Get events to search for the user
    const eventsRef = db.collection("events");
    const querySnapshot = await eventsRef.get();

    const promises = querySnapshot.docs.map(async (doc) => {
      const eventData = doc.data();

      // Delete the user's UID from 'registeredUsers', 'pendingRequests' and 'waitingList' if it exists.
      let updateData = {};

      // Delete from 'registeredUsers'
      if (
        eventData.registeredUsers &&
        eventData.registeredUsers.includes(userId)
      ) {
        console.log("Esta registrado en", eventData.title);
        updateData.registeredUsers =
          admin.firestore.FieldValue.arrayRemove(userId);
      }

      // Delete from 'pendingRequests'
      const pendingToRemove = eventData.pendingRequests?.find(
        (request) => request.uid === userId
      );
      if (pendingToRemove) {
        updateData.pendingRequests =
          admin.firestore.FieldValue.arrayRemove(pendingToRemove);
      }

      // Delete from 'waitingList'
      const waitingToRemove = eventData.waitingList?.find(
        (request) => request.uid === userId
      );
      if (waitingToRemove) {
        updateData.waitingList =
          admin.firestore.FieldValue.arrayRemove(waitingToRemove);
      }

      if (Object.keys(updateData).length > 0) {
        await doc.ref.update(updateData);
      }
    });

    // Wait for all Promises to be done
    await Promise.all(promises);

    return response.status(200).json({
      message:
        "Usuario eliminado correctamente. Referencias en eventos actualizadas.",
    });
  } catch (error) {
    console.error("Error al eliminar el usuario:", error);
    return response.status(500).json({ error: "Error interno del servidor" });
  }
});

//UPDATE USER INFORMATION
app.post(
  "/api/update-profile/:id",
  upload.single("photo"),
  async (request, response) => {
    const uid = request.params.id;

    if (!uid) {
      return response.status(400).json({ error: "UID requerido" });
    }

    const {
      name,
      lastName1,
      lastName2,
      phone,
      birthDate,
      institution,
      teachingLevel,
      specializations,
    } = request.body;

    try {
      let photoURL = null;
      if (request.file) {
        photoURL = await compressProfilePicture(request.file, uid);
      }

      const parsedSpecializations = specializations
        ? JSON.parse(specializations)
        : [];

      const updateData = {
        name,
        lastName1,
        lastName2,
        phone,
        birthDate,
        institution,
        teachingLevel,
        specializations: parsedSpecializations,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        ...(photoURL !== null && { photoURL }), // Update the profile picture only if it's been uploaded.
      };

      // Remove undefined fields
      Object.keys(updateData).forEach((key) => {
        if (updateData[key] === undefined) {
          delete updateData[key];
        }
      });

      await db.collection("users").doc(uid).set(updateData, { merge: true });
      response.status(200).json({
        message: "Perfil actualizado correctamente ",
        uid: uid,
      });
    } catch (error) {
      console.error("Error actualizando perfil:", error);
      return response.status(400).json({ error: error.message });
    }
  }
);

//CREATE SURVEY
app.post("/api/create-survey", async (request, response) => {
  try {
    const survey = request.body;

    if (!survey?.title || !survey?.pages?.[0]?.questions?.length) {
      return response.status(400).json({ message: "Datos incompletos" });
    }

    const docRef = await db.collection("surveys").add({
      ...survey,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    response.status(201).json({ id: docRef.id });
  } catch (error) {
    console.error("Error al guardar encuesta:", error);
    response.status(500).json({ message: "Error interno del servidor" });
  }
});

//SAVE SURVEY ANSWERS
app.post("/api/surveys/:id/responses", async (request, response) => {
  const { id } = request.params;
  const { uid, answers } = request.body;

  try {
    const docRef = await db
      .collection("surveys")
      .doc(id)
      .collection("responses")
      .doc(uid)
      .set({
        answers,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    response.status(201).json({ responseId: docRef.id });
  } catch (error) {
    console.error("Error al guardar respuesta:", error);
    response.status(500).json({ message: "Error al guardar la respuesta" });
  }
});

//GET SURVEYS
app.get("/api/surveys", async (request, response) => {
  try {
    const surveysSnapshot = await db.collection("surveys").get();
    const surveys = surveysSnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));
    response.status(200).json(surveys);
  } catch (error) {
    console.error("Error al obtener las encuestas:", error);
    response
      .status(500)
      .json({ message: "Error interno al obtener las encuestas" });
  }
});

app.get("/api/surveys/:id", async (request, response) => {
  const { id } = request.params;

  try {
    const doc = await db.collection("surveys").doc(id).get();

    if (!doc.exists) {
      return response.status(404).json({ message: "Encuesta no encontrada" });
    }

    return response.status(200).json(doc.data());
  } catch (error) {
    console.error("Error al obtener la encuesta:", error);
    response.status(500).json({ message: "Error interno del servidor" });
  }
});

//GET SURVEY'S RESPONSES
app.get("/api/surveys/:id/responses", async (request, response) => {
  const { id } = request.params;

  try {
    const snapshot = await db
      .collection("surveys")
      .doc(id)
      .collection("responses")
      .orderBy("createdAt", "desc")
      .get();

    const responses = snapshot.docs.map((doc) => ({
      uid: doc.id,
      ...doc.data(),
    }));

    response.status(200).json(responses);
  } catch (error) {
    console.error("Error al obtener respuestas:", error);
    response.status(500).json({ message: "Error al obtener respuestas" });
  }
});

//GET SURVEY'S RESPONSES TO GENERATE A .CSV FILE
app.get("/api/surveys/:id/download-responses", async (request, response) => {
  const surveyId = request.params.id;

  if (surveyId?.trim() === "") {
    return response
      .status(400)
      .json({ error: "Debe proporcionarse un ID de encuesta válido." });
  }

  try {
    const surveyDoc = await db.collection("surveys").doc(surveyId).get();
    if (!surveyDoc.exists) {
      return response
        .status(404)
        .json({ error: "No existe la encuesta consultada." });
    }

    const responsesSnap = await surveyDoc.ref.collection("responses").get();
    if (responsesSnap.empty) {
      return response
        .status(404)
        .json({ error: "No hay respuestas para esta encuesta." });
    }

    const result = [];

    for (const doc of responsesSnap.docs) {
      const uid = doc.id;
      const data = doc.data();
      const answers = data.answers || {};
      const createdAt = data.createdAt?._seconds
        ? DateTime.fromSeconds(data.createdAt._seconds).toISODate()
        : "Fecha desconocida";

      let userName = "Usuario eliminado";
      const userSnap = await db.collection("users").doc(uid).get();
      if (userSnap.exists) {
        const u = userSnap.data();
        userName = `${u.name || ""} ${u.lastName1 || ""} ${
          u.lastName2 || ""
        }`.trim();
      }

      result.push({
        encuestado: userName,
        ...answers,
        createdAt,
      });
    }

    response.status(200).json(result);
  } catch (error) {
    console.error("Error obteniendo respuestas:", error);
    response
      .status(500)
      .json({ error: "No se pudo obtener la información de la encuesta" });
  }
});

//DELETE SURVEY AND ITS REFERENCES IN EVENTS
app.delete("/api/delete-survey/:id", async (request, response) => {
  const surveyId = request.params.id;

  if (!surveyId) {
    return response
      .status(400)
      .json({ error: "El ID de la encuesta es obligatorio" });
  }

  try {
    const docRef = db.collection("surveys").doc(surveyId);

    // Delete all answers on the "responses" subcolection
    const responsesRef = docRef.collection("responses");
    await deleteCollectionInBatchesIterative(responsesRef);

    await docRef.delete();

    // Look for the events that have the survey
    const eventsSnapshot = await db
      .collection("events")
      .where("survey", "==", surveyId)
      .get();

    // Update the value to NULL
    const batch = db.batch();
    eventsSnapshot.forEach((doc) => {
      batch.update(doc.ref, { survey: null });
    });
    await batch.commit();

    return response
      .status(200)
      .json({ message: "Encuesta eliminada correctamente" });
  } catch (error) {
    console.error("Error al eliminar el la encuesta:", error);
    return response.status(500).json({ error: "Error interno del servidor" });
  }
});

//STATISTICS
//GENERAL STATS
app.get("/api/stats", async (request, response) => {
  try {
    const [usersSnap, eventsSnap, surveysSnap] = await Promise.all([
      db.collection("users").get(),
      db.collection("events").get(),
      db.collection("surveys").get(),
    ]);

    const now = DateTime.now();
    const monthsBack = parseInt(request.query.months) || 6;
    const monthlyRegistrations = {};
    const educationSplit = { primaria: 0, secundaria: 0 };

    // Initialize the structure with the months empty
    for (let i = monthsBack - 1; i >= 0; i--) {
      const date = now.minus({ months: i });
      const key = date.toFormat("MMM").toLowerCase(); // "feb", "mar"
      monthlyRegistrations[key] = 0;
    }

    usersSnap.forEach((doc) => {
      const data = doc.data();
      const createdAt = data.createdAt?._seconds
        ? DateTime.fromSeconds(data.createdAt._seconds)
        : null;

      if (createdAt) {
        const diff = now.diff(createdAt, "months").months;
        if (diff <= monthsBack) {
          const key = createdAt.toFormat("MMM").toLowerCase();
          if (monthlyRegistrations[key] !== undefined) {
            monthlyRegistrations[key]++;
          }
        }
      }

      const teachingLevel = (data.teachingLevel || "").toLowerCase();
      if (teachingLevel.includes("primaria")) educationSplit.primaria++;
      else if (teachingLevel.includes("secundaria"))
        educationSplit.secundaria++;
    });

    response.json({
      totalUsers: usersSnap.size,
      totalCourses: eventsSnap.size,
      totalSurveys: surveysSnap.size,
      monthlyRegistrations,
      educationSplit,
    });
  } catch (error) {
    console.error("Error fetching statitics:", error);
    response.status(500).json({ error: "Error al obtener estadísticas" });
  }
});

//USERS STATS
app.get("/api/stats/users", async (request, response) => {
  try {
    const usersSnap = await db.collection("users").get();

    const roles = {};
    const institutions = {};
    const ages = [];
    const specCount = {};
    const participation = { 0: 0, "1-2": 0, "3-5": 0, "6+": 0 };

    const today = DateTime.now();

    usersSnap.forEach((doc) => {
      const user = doc.data();

      // Role count
      roles[user.role] = (roles[user.role] || 0) + 1;

      // Institution (case sensitive for now)
      const inst = user.institution?.trim();
      if (inst) institutions[inst] = (institutions[inst] || 0) + 1;

      // Age
      const birthDate = user.birthDate;
      if (birthDate) {
        const parsed = DateTime.fromISO(birthDate);
        if (parsed.isValid) {
          const age = today.diff(parsed, "years").years;
          ages.push(Math.floor(age));
        }
      }

      // Specializations
      if (Array.isArray(user.specializations)) {
        user.specializations.forEach((spec) => {
          if (spec) {
            specCount[spec] = (specCount[spec] || 0) + 1;
          }
        });
      }

      // Event participation
      const myEvents = user.myEvents || {};
      const eventCount = Object.keys(myEvents).length;
      if (eventCount === 0) participation["0"]++;
      else if (eventCount <= 2) participation["1-2"]++;
      else if (eventCount <= 5) participation["3-5"]++;
      else participation["6+"]++;
    });

    const averageAge = ages.reduce((a, b) => a + b, 0) / (ages.length || 1);
    const ageStats = {
      average: Math.round(averageAge),
      min: Math.min(...ages),
      max: Math.max(...ages),
    };

    // Top 3 specializations
    const topSpecializations = Object.entries(specCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name, count]) => ({ name, count }));

    response.json({
      roles,
      institutions,
      ageStats,
      topSpecializations,
      eventsParticipation: participation,
    });
  } catch (error) {
    console.error("Error al obtener estadísticas de usuarios:", error);
    response
      .status(500)
      .json({ error: "Error al obtener estadísticas de usuarios" });
  }
});

//EVENTS STATS
app.get("/api/stats/activities", async (request, response) => {
  try {
    const eventsSnap = await db.collection("events").get();

    const enrollmentType = { open: 0, restricted: 0 };
    const evaluationType = { leveraging: 0, participation: 0 };
    const modality = { virtual: 0, presencial: 0 };
    const categories = {};
    const withSurvey = { count: 0 };
    const withoutSurvey = { count: 0 };
    const capacity = { total: 0, used: 0 };
    const topEvents = [];
    const specialtyCount = {};
    const monthlyDistribution = {};

    const now = DateTime.now();

    eventsSnap.forEach((doc) => {
      const e = doc.data();

      // Enrollment type
      if (e.enrollmentType === "Abierta") enrollmentType.open++;
      else if (e.enrollmentType === "Restringida") enrollmentType.restricted++;

      // Enrollment type
      if (e.evaluationType === "Aprovechamiento") evaluationType.leveraging++;
      else if (e.evaluationType === "Participación")
        evaluationType.participation++;

      // Modality
      if (e.virtualEvent === true) modality.virtual++;
      else modality.presencial++;

      // Event category
      if (e.eventCategory) {
        categories[e.eventCategory] = (categories[e.eventCategory] || 0) + 1;
      }

      // Surveys
      if (e.survey) withSurvey.count++;
      else withoutSurvey.count++;

      // Capacity
      capacity.total += e.capacity || 0;
      capacity.used += Array.isArray(e.registeredUsers)
        ? e.registeredUsers.length
        : 0;

      // Events with the highest participation
      const registeredCount = Array.isArray(e.registeredUsers)
        ? e.registeredUsers.length
        : 0;
      topEvents.push({
        title: e.title || "Sin título",
        count: registeredCount,
      });

      // Specialties
      if (Array.isArray(e.specialties)) {
        e.specialties.forEach((s) => {
          if (s) {
            specialtyCount[s] = (specialtyCount[s] || 0) + 1;
          }
        });
      }

      // Month distribution by (startDate)
      if (e.startDate) {
        const date = DateTime.fromISO(e.startDate);
        if (date.isValid) {
          const month = date.toFormat("MMM").toLowerCase(); // ej: feb, mar
          monthlyDistribution[month] = (monthlyDistribution[month] || 0) + 1;
        }
      }
    });

    // Order the top 5 events
    const top5 = topEvents.sort((a, b) => b.count - a.count).slice(0, 5);

    response.json({
      enrollmentType,
      evaluationType,
      modality,
      categories,
      withSurvey: withSurvey.count,
      withoutSurvey: withoutSurvey.count,
      capacity,
      topEvents: top5,
      specialties: specialtyCount,
      monthlyDistribution,
    });
  } catch (error) {
    console.error("Error al obtener estadísticas de los eventos:", error);
    response
      .status(500)
      .json({ error: "Error al obtener estadísticas de los eventos." });
  }
});

// CONTACT US
app.post("/api/contact-us", async (request, response) => {
  const { recipient, subject, phone, comment } = request.body;

  if (!recipient || !subject || !comment) {
    return response.status(400).json({ error: "Faltan campos obligatorios." });
  }

  try {
    const transporter = nodemailer.createTransport({
      service: "gmail", // o el servicio que uses
      auth: {
        user: process.env.CONTACT_EMAIL,
        pass: process.env.CONTACT_PASSWORD,
      },
    });

    const mailOptions = {
      from: `"Usuario de la app ProSTEM" <${process.env.CONTACT_EMAIL}>`,
      to: process.env.CONTACT_EMAIL,
      subject: `Mensaje desde Contáctanos: ${subject}`,
      text: `Remitente '${recipient}'\n\n Comentario:\n${comment}\n\n Teléfono de contacto del usuario: ${
        phone || "No proporcionado"
      }`,
    };

    await transporter.sendMail(mailOptions);
    response.json({ success: true });
  } catch (error) {
    console.error("Error al enviar correo:", error);
    response.status(500).json({ error: "Error al enviar el correo." });
  }
});

//#################################################################################################

// Endpoints JVR:

//variable for conferences collection in database
const conferencesDB = db.collection("conferences")

//variable for presentations collection in database
const presentationsDB = db.collection("presentations")

//Endpoint to create a new conference
app.post("/api/conferences", async (req, res) =>{

  try{
    const data = req.body
    const newConference = await conferencesDB.add(data)
    res.status(201).json({"id": newConference.id, ...data})
    
  }catch(error){
    res.status(500).json({"error": error.message})
  }
})

// Endpoint to create a new conference for a specific user
app.post("/api/conferences/:id", async (req, res) => {
  try {
    const managerId = req.params.id;
    const data = req.body;

    // Fetch the user's document
    const userRef = db.collection("users").doc(managerId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: "User not found" });
    }

    // Get the list of conference IDs managed by the user
    const conferencesManager = userDoc.get("conferencesManager") || [];
    let highestCreationId = 0;

    // Iterate through the conferences to find the highest creationId
    for (const conferenceId of conferencesManager) {
      const conferenceDoc = await db.collection("conferences").doc(conferenceId).get();
      if (conferenceDoc.exists) {
        const creationId = conferenceDoc.get("creationId") || 0; // Default to 0 if creationId is missing
        if (creationId > highestCreationId) {
          highestCreationId = creationId; // Keep track of the highest creationId
        }
      }
    }

    // Increment the highest creationId by 1
    const newCreationId = highestCreationId + 1; // If highest is 4, newCreationId will be 5

    // Add the new conference data
    const newConferenceData = {
      ...data,
      managerId: managerId,
      creationId: newCreationId, // Assign the calculated creationId
    };

    const newConference = await conferencesDB.add(newConferenceData);

    // Create a folder in the uploads directory with the ID of the new conference
    const uploadPath = path.join(__dirname, "uploads", newConference.id);
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }

    // Update the user's conferencesManager field
    await userRef.update({
      conferencesManager: admin.firestore.FieldValue.arrayUnion(newConference.id),
    });

    res.status(201).json({ id: newConference.id, ...newConferenceData });
  } catch (error) {
    console.error("Error creating conference:", error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to get all conferences for a specific user, ordered by creationId
app.get("/api/conferences/:id", async (req, res) => {
  try {
    const userId = req.params.id;
    const data = await conferencesDB.get();
    const conferences = data.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    const userConferences = [];

    // Filter conferences managed by the user
    for (const conference of conferences) {
      if (conference.managerId == userId) {
        userConferences.push(conference);
      }
    }

    // Sort the conferences by creationId in ascending order
    userConferences.sort((a, b) => (a.creationId || 0) - (b.creationId || 0));

    res.status(201).json(userConferences);
  } catch (error) {
    res.status(500).json({ "error": error.message });
  }
});

//Endpoint to modify a conference
app.put("/api/conferences/:id", async (req, res) => {
  try{
    const data = req.body
    await conferencesDB.doc(req.params.id).update(data)
    res.status(201).json({"result": "conference updated"}) 
  }catch(error){
    res.status(500).json({"error": error.message})
  }
})


//Endpoint to get all conferences 
app.get("/api/conferences", async (req, res) =>{
  try{
    const data = await conferencesDB.get()
    const conferences = data.docs.map(doc => ({id: doc.id, ...doc.data()})) 
    res.status(201).json(conferences)
  }catch(error){
    res.status(500).json({"error": error.message})
  }
})



//Endpoint to get all presentations in general
app.get("/api/conferences/presentations", async (req, res) =>{
  try{
    const data = await db.collection("presentations").get()
    const presentations = data.docs.map(doc => ({id: doc.id, ...doc.data()})) 
    res.status(201).json(presentations)
  }catch(error){
    res.status(500).json({"error": error.message})
  }
})



//Endpoint to get all presentations from a certain conference
app.get("/api/conferences/presentations/:id", async (req, res) => {
  try{
    const docId = req.params.id
    const conference = await db.collection("conferences").doc(docId).get()
    const presentationsIds = conference.get("presentations" || [])

    if(!conference.exists){
      return res.status(404).json({error: "conference not found"})
    }

    const presentationsData = []

    for(const presId of presentationsIds){
      const presSnap = await db.collection("presentations").doc(presId).get();
      if (presSnap.exists){
        presentationsData.push({
          id: presSnap.id,
          ...presSnap.data()
        })
      }
    }

    res.status(201).json(presentationsData)
  }catch(error){
    res.status(500).json({"error": error.message})
  }
})

// Endpoint to download a document by conferenceId and creationId
app.get('/api/presentations/:conferenceId/:creationId/download', async (req, res) => {
  try {
    const { conferenceId, creationId } = req.params;

    // Construct the file path
    const documentFolderPath = path.join(__dirname, 'uploads', conferenceId, creationId);
    const files = fs.readdirSync(documentFolderPath);

    // Find the general document in the folder
    const generalDocument = files.find(file => file.startsWith('general-'));
    if (!generalDocument) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const filePath = path.join(documentFolderPath, generalDocument);

    // Send the file to the client
    res.download(filePath, generalDocument); // This triggers a file download
  } catch (error) {
    console.error('Error downloading document:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Endpoint to view a document by conferenceId and creationId
app.get('/api/presentations/:conferenceId/:creationId/view', async (req, res) => {
  try {
    const { conferenceId, creationId } = req.params;

    // Construct the file path
    const documentFolderPath = path.join(__dirname, 'uploads', conferenceId, creationId);
    const files = fs.readdirSync(documentFolderPath);

    // Find the general document in the folder
    const generalDocument = files.find(file => file.startsWith('general-'));
    if (!generalDocument) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const filePath = path.join(documentFolderPath, generalDocument);

    // Send the file to the client for viewing
    res.sendFile(filePath);
  } catch (error) {
    console.error('Error viewing document:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});


//Endpoint to get a specific conference
app.get("/api/conferences/getConference/:id", async (req, res) => {
  try {
    const id = req.params.id;

    // Log the requested ID
    console.log("Requested Conference ID:", id);

    const doc = await db.collection("conferences").doc(id).get();

    // Log the document snapshot and its data
    console.log("Document Exists:", doc.exists);
    console.log("Document Data:", doc.data());

    if (!doc.exists) {
      return res.status(404).json({ error: "Conference not found" });
    }

    const data = doc.data();
    if (!data) {
      return res.status(404).json({ error: "Conference data is empty" });
    }

    res.status(200).json({ id: doc.id, ...data });
  } catch (error) {
    console.error("Error fetching conference:", error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to create a new presentation
app.post("/api/conferences/presentations", async (req, res) => {
  try {
    const data = req.body;

    // Extract the area from the request body
    const { area, ...presentationData } = data; // Exclude "area" from the rest of the data

    if (!area) {
      return res.status(400).json({ Error: "The 'area' field is required." });
    }

    // Format the area: First letter uppercase, rest lowercase
    const originalWord = area.charAt(0).toUpperCase() + area.slice(1).toLowerCase();

    // Normalize the area: Remove special characters (e.g., tildes) for comparison
    const normalizedWord = originalWord
      .normalize("NFD") // Normalize to decompose special characters
      .replace(/[\u0300-\u036f]/g, ""); // Remove diacritical marks (e.g., tildes)

    let areaId;

    // Check if the normalized area exists in the "areas" collection
    const areasSnapshot = await db.collection("areas").where("name", "==", normalizedWord).get();

    if (!areasSnapshot.empty) {
      // If the area exists, take the ID of the matching document
      areaId = areasSnapshot.docs[0].id;
    } else {
      // If the area does not exist, create a new document in the "areas" collection
      const newArea = await db.collection("areas").add({
        name: normalizedWord, // Save the normalized word without special characters
        originalWord: originalWord, // Save the original word with the tilde
      });
      areaId = newArea.id;
    }

    // Add the area ID to the "areas" field in the presentations collection
    const presentationWithAreas = {
      ...presentationData,
      areas: [areaId], // Add the area ID to the "areas" field as an array
    };

    // Create the new presentation in the "presentations" collection
    await presentationsDB.add(presentationWithAreas);

    // Respond with a success message
    res.status(201).json({ result: "presentation created successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

//Endpoint to modify a presentation
app.put("/api/conferences/presentations/:id", async (req, res) =>{
  try{
    const data = req.body
    await presentationsDB.doc(req.params.id).update(data)
    res.status(201).json({"result": "Presentation updated successfully"})
  }catch{
    res.status(500).json({"error": error.message})
  }
})

//Endpoint to delete a presentation
app.delete("/api/conferences/presentations/:id", async (req, res) => {
  try{
    await db.collection("presentations").doc(req.params.id).delete()
    res.status(201).json({"Result": "Presentation deleted successfully"})
  }catch(error){
    res.status(500).json({"Error": error.message})
  }
})

// Endpoint to assign a user as a reviewer
app.post("/api/reviewers", async (req, res) => {
  try {
    const { email } = req.body; // Extract the email from the request body

    if (!email) {
      return res.status(400).json({ error: "The 'email' field is required." });
    }

    // Check if a user with the given email exists in the "users" collection
    const userQuery = await db.collection("users").where("email", "==", email).get();

    if (userQuery.empty) {
      // If no user is found with the given email
      return res.status(404).json({ error: "No user found with the provided email." });
    }

    // Get the first matching user document
    const userDoc = userQuery.docs[0];
    const userData = userDoc.data();

    if (userData.reviewer) {
      // If the "reviewer" field is already true
      return res.status(200).json({ message: "A reviewer already exists with this email." });
    }

    // If the "reviewer" field is false, update it to true
    await db.collection("users").doc(userDoc.id).update({ reviewer: true });

    return res.status(200).json({ message: "User successfully updated as a reviewer." });
  } catch (error) {
    console.error("Error assigning reviewer:", error);
    res.status(500).json({ error: error.message });
  }
});

//Endpoint to update a specific reviewer
app.put("/api/reviewers/:id", async (req, res) => {
  try{
    const data = req.body
    const reviewer = await db.collection("reviewers").doc(req.params.id).update(data);
    
    res.status(201).json({"Reviewer upadted": reviewer.id, ...data})
  }catch(error){
    res.status(500).json({"Error ": error.message})
  }

})

//endpoint to delete a reviewer
app.delete("/api/reviewers/:id", async (req, res) =>{
  try{
    await db.collection("reviewers").doc(req.params.id).delete();
    res.status(201).json({"Result": "Reviewer deleted successfully"})
  }catch(error){
    res.status(501).json({"Error": error.message})
  }
  
})

//Endpoint to get all reviewers in general
app.get("/api/reviewers", async (req, res) => {
  try {
    const reviewersSnapshot = await db.collection("reviewers").get();
    const reviewers = reviewersSnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));
    res.status(200).json(reviewers);
  } catch (error) {
    console.error("Error fetching reviewers:", error);
    res.status(500).json({ error: error.message });
  }
});

//Endpoint to assign a presentation to a reviewer
app.post("/api/reviewers/assignReviewer", async (req, res) => {
  const { reviewerId, presentationId } = req.body;

  if (!reviewerId || !presentationId) {
    return res.status(400).json({ error: "Reviewer ID and Presentation ID are required" });
  }

  try {
    const reviewerRef = db.collection("reviewers").doc(reviewerId);
    const presentationRef = db.collection("presentations").doc(presentationId);

    // Update the reviewer's presentationsAssigned field
    await reviewerRef.update({
      presentationsAssigned: admin.firestore.FieldValue.arrayUnion(presentationId),
    });

    // Update the presentation's reviewersAssigned field
    await presentationRef.update({
      reviewersAssigned: admin.firestore.FieldValue.arrayUnion(reviewerId),
    });

    res.status(200).json({ message: "Assignment successful" });
  } catch (error) {
    console.error("Error assigning presentation to reviewer:", error);
    res.status(500).json({ error: error.message });
  }
});

//Endpoint to toggle the "active" field of a conference
app.patch("/api/conferences/:id/toggleActive", async (req, res) => {
  try {
    const id = req.params.id;

    // Get the conference document
    const docRef = db.collection("conferences").doc(id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Conference not found" });
    }

    // Get the current value of the "active" field
    const currentActiveState = doc.data().active;

    // Toggle the "active" field
    await docRef.update({
      active: !currentActiveState,
    });

    res.status(200).json({ message: "Conference state updated successfully", active: !currentActiveState });
  } catch (error) {
    console.error("Error toggling conference state:", error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to toggle the assignment of a reviewer for a presentation
app.patch("/api/toggleAssignment", async (req, res) => {
  try {
    const { reviewerId, presentationId } = req.body;

    if (!reviewerId || !presentationId) {
      return res.status(400).json({ error: "Reviewer ID and Presentation ID are required" });
    }

    const userRef = db.collection("users").doc(reviewerId); // Query the users collection
    const presentationRef = db.collection("presentations").doc(presentationId);

    // Get the current data for both user and presentation
    const userDoc = await userRef.get();
    const presentationDoc = await presentationRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: "Reviewer not found" });
    }

    if (!presentationDoc.exists) {
      return res.status(404).json({ error: "Presentation not found" });
    }

    const userData = userDoc.data();
    const presentationData = presentationDoc.data();

    // Check if the reviewer is already assigned to the presentation
    const isAssigned = userData.presentationsAssigned?.some(
      (assignment) => assignment.presentationId === presentationId
    );

    if (isAssigned) {
      // If already assigned, remove the assignment
      await userRef.update({
        presentationsAssigned: admin.firestore.FieldValue.arrayRemove({
          presentationId: presentationId,
          reviewed: false, // Match the structure to remove
        }),
      });

      await presentationRef.update({
        reviewersAssigned: admin.firestore.FieldValue.arrayRemove({
          reviewerId: reviewerId,
          reviewed: false, // Match the structure to remove
        }),
      });

      res.status(200).json({ message: "Assignment removed successfully" });
    } else {
      // If not assigned, add the assignment
      await userRef.update({
        presentationsAssigned: admin.firestore.FieldValue.arrayUnion({
          presentationId: presentationId,
          reviewed: false, // Default value
        }),
      });

      await presentationRef.update({
        reviewersAssigned: admin.firestore.FieldValue.arrayUnion({
          reviewerId: reviewerId,
          reviewed: false, // Default value
        }),
      });

      res.status(200).json({ message: "Assignment added successfully" });
    }
  } catch (error) {
    console.error("Error toggling assignment:", error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to create a new area
app.post("/api/areas", async (req, res) => {
  try {
    const { area } = req.body;

    if (!area) {
      return res.status(400).json({ Error: "The 'area' field is required." });
    }

    // Format the area: First letter uppercase, rest lowercase
    const originalWord = area.charAt(0).toUpperCase() + area.slice(1).toLowerCase();

    // Normalize the area: Remove special characters (e.g., tildes) for comparison
    const normalizedWord = originalWord
      .normalize("NFD") // Normalize to decompose special characters
      .replace(/[\u0300-\u036f]/g, ""); // Remove diacritical marks (e.g., tildes)

    // Check if the normalized area exists in the "areas" collection
    const areasSnapshot = await db.collection("areas").where("name", "==", normalizedWord).get();

    if (!areasSnapshot.empty) {
      // If the area exists, return a message indicating it already exists
      return res.status(409).json({ message: "Area already exists", area: areasSnapshot.docs[0].data() });
    }

    // If the area does not exist, create a new document in the "areas" collection
    const newArea = await db.collection("areas").add({
      name: normalizedWord, // Save the normalized word without special characters
      originalWord: originalWord, // Save the original word with the tilde
    });

    // Respond with the new area ID and data
    res.status(201).json({ message: "Area created successfully", id: newArea.id, name: normalizedWord, originalWord });
  } catch (error) {
    console.error("Error creating area:", error);
    res.status(500).json({ Error: error.message });
  }
});

// Endpoint to get the list of areas
app.get('/api/areas', async (req, res) => {
  try {
    // Fetch all documents from the "areas" collection
    const areasSnapshot = await db.collection('areas').get();

    // Map the results to return only the "originalWord" field
    const areas = areasSnapshot.docs.map(doc => doc.data().originalWord);

    res.status(200).json({ areas });
  } catch (error) {
    console.error('Error fetching areas:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Endpoint to check if a reviewer is assigned to a presentation
app.get("/api/isAssigned", async (req, res) => {
  const { reviewerId, presentationId } = req.query;

  if (!reviewerId || !presentationId) {
    return res.status(400).json({ error: "Reviewer ID and Presentation ID are required" });
  }

  try {
    // Get the reviewer document from the "users" collection
    const reviewerDoc = await db.collection("users").doc(reviewerId).get();

    if (!reviewerDoc.exists) {
      return res.status(404).json({ error: "Reviewer not found" });
    }

    const reviewerData = reviewerDoc.data();

    // Check if the presentationId exists in the "presentationsAssigned" array
    const isAssigned = reviewerData.presentationsAssigned?.includes(presentationId) || false;

    res.status(200).json({ isAssigned });
  } catch (error) {
    console.error("Error checking if reviewer is assigned:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});



// Endpoint to get all conferences in which the current user has presentations
app.get('/api/user-conferences/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    // Get the user's document
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userData = userDoc.data();
    const presentationsAuthor = userData['presentations-author'] || [];

    // Get all unique conference IDs from the user's presentations
    const conferenceIds = new Set();
    for (const presentationId of presentationsAuthor) {
      const presentationRef = db.collection('presentations').doc(presentationId);
      const presentationDoc = await presentationRef.get();

      if (presentationDoc.exists) {
        const presentationData = presentationDoc.data();
        if (presentationData['conference-id']) {
          conferenceIds.add(presentationData['conference-id']);
        }
      }
    }

    // Fetch all conference details
    const conferences = [];
    for (const conferenceId of conferenceIds) {
      const conferenceRef = db.collection('conferences').doc(conferenceId);
      const conferenceDoc = await conferenceRef.get();

      if (conferenceDoc.exists) {
        conferences.push({ id: conferenceDoc.id, ...conferenceDoc.data() });
      }
    }

    res.status(200).json(conferences);
  } catch (error) {
    console.error('Error fetching user conferences:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Endpoint to get all presentations for a specific user and conference
app.get('/api/user-conference-presentations', async (req, res) => {
  try {
    const { userId, conferenceId } = req.query;

    if (!userId || !conferenceId) {
      return res.status(400).json({ error: 'User ID and Conference ID are required' });
    }

    // Get the user's document
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userData = userDoc.data();
    const presentationsAuthor = userData['presentations-author'] || [];

    // Fetch all presentations that match the conference ID
    const presentations = [];
    for (const presentationId of presentationsAuthor) {
      const presentationRef = db.collection('presentations').doc(presentationId);
      const presentationDoc = await presentationRef.get();

      if (presentationDoc.exists) {
        const presentationData = presentationDoc.data();
        if (presentationData['conference-id'] === conferenceId) {
          presentations.push({ id: presentationDoc.id, ...presentationData });
        }
      }
    }

    res.status(200).json(presentations);
  } catch (error) {
    console.error('Error fetching user conference presentations:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});



// Endpoint to create a new revision form
app.post('/api/revision-forms', async (req, res) => {
  try {
    const { title, questions } = req.body;

    if (!title || !questions || !Array.isArray(questions)) {
      return res.status(400).json({ error: 'El título y las preguntas son obligatorios.' });
    }

    // Crear un nuevo documento en la colección "revision-forms"
    const revisionFormRef = db.collection('revision-forms').doc();
    const revisionFormData = {
      title,
      questions,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await revisionFormRef.set(revisionFormData);

    res.status(201).json({ message: 'Formulario de revisión creado exitosamente', id: revisionFormRef.id });
  } catch (error) {
    console.error('Error al crear el formulario de revisión:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Endpoint to find reviewers by presentation area (from the users collection)
app.get('/api/reviewers-by-presentation/:presentationId', async (req, res) => {
  const { presentationId } = req.params;

  if (!presentationId) {
    return res.status(400).json({ error: 'Presentation ID is required' });
  }

  try {
    // Get the presentation data
    const presentationDoc = await db.collection('presentations').doc(presentationId).get();

    if (!presentationDoc.exists) {
      console.log(`Presentation with ID ${presentationId} not found.`);
      return res.status(404).json({ error: 'Presentation not found' });
    }

    const presentationData = presentationDoc.data();
    const presentationArea = presentationData.area; // Get the area of the presentation

    if (!presentationArea) {
      console.log(`Presentation with ID ${presentationId} does not have an area.`);
      return res.status(400).json({ error: 'Presentation area is missing' });
    }


    // Query the users collection for reviewers with matching specializations
    const usersQuery = await db.collection('users')
      .where('reviewer', '==', true) // Only fetch users with reviewer set to true
      .get();

    if (usersQuery.empty) {
      console.log('No reviewers found with reviewer field set to true.');
      return res.status(404).json({ error: 'No reviewers found' });
    }

    const reviewers = [];

    usersQuery.forEach((doc) => {
      const userData = doc.data();

      // Check if the user's specializations include the presentation area
      if (userData.specializations && userData.specializations.includes(presentationArea)) {
        reviewers.push({
          id: doc.id,
          name: `${userData.name} ${userData.lastName1} ${userData.lastName2}`, // Combine name fields
          email: userData.email,
          institution: userData.institution,
          presentationsAssigned: userData.presentationsAssigned?.length || 0, // Count of assigned presentations
          isAssigned: userData.conferencesAssigned?.includes(presentationData['conference-id']) || false, // Check if the user is assigned to the conference
        });
      }
    });

    res.status(200).json({ reviewers });
  } catch (error) {
    console.error('Error fetching reviewers:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Endpoint to get all conferences in which the current user has presentations assigned as a reviewer
app.get('/api/reviewer-conferences/:userId', async (req, res) => {
  const { userId } = req.params;

  if (!userId) {
    return res.status(400).json({ error: 'User ID is required' });
  }

  try {
    // Get the user document from the "users" collection
    const userDoc = await db.collection('users').doc(userId).get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userData = userDoc.data();

    // Check if the user is a reviewer
    if (!userData.reviewer) {
      return res.status(200).json({
        message: 'Usted no ha sido asignado como revisor de ninguna conferencia hasta el momento',
        conferences: []
      });
    }

    // Get the presentations assigned to the user
    const presentationsAssigned = userData.presentationsAssigned || [];

    if (presentationsAssigned.length === 0) {
      return res.status(200).json({
        message: 'Usted no ha sido asignado como revisor de ninguna conferencia hasta el momento',
        conferences: []
      });
    }

    // Fetch the conferences for the assigned presentations
    const conferenceIds = new Set();
    for (const presentationId of presentationsAssigned) {
      const presentationDoc = await db.collection('presentations').doc(presentationId).get();

      if (presentationDoc.exists) {
        const presentationData = presentationDoc.data();
        if (presentationData['conference-id']) {
          conferenceIds.add(presentationData['conference-id']);
        }
      }
    }

    // Fetch the conference details
    const conferences = [];
    for (const conferenceId of conferenceIds) {
      const conferenceDoc = await db.collection('conferences').doc(conferenceId).get();

      if (conferenceDoc.exists) {
        conferences.push({ id: conferenceDoc.id, ...conferenceDoc.data() });
      }
    }

    res.status(200).json({ conferences });
  } catch (error) {
    console.error('Error fetching reviewer conferences:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Endpoint to get all presentations assigned to a reviewer for a specific conference
app.get('/api/reviewer-presentations', async (req, res) => {
  const { userId, conferenceId } = req.query;

  if (!userId || !conferenceId) {
    return res.status(400).json({ error: 'User ID and Conference ID are required' });
  }

  try {
    // Get the user document from the "users" collection
    const userDoc = await db.collection('users').doc(userId).get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userData = userDoc.data();
    const presentationsAssigned = userData.presentationsAssigned || [];

    if (presentationsAssigned.length === 0) {
      return res.status(200).json({ presentations: [] });
    }

    // Fetch presentations that match the assigned IDs and the conference ID
    const presentations = [];
    for (const presentationId of presentationsAssigned) {
      const presentationDoc = await db.collection('presentations').doc(presentationId).get();

      if (presentationDoc.exists) {
        const presentationData = presentationDoc.data();
        if (presentationData['conference-id'] === conferenceId) {
          presentations.push({ id: presentationDoc.id, ...presentationData });
        }
      }
    }

    res.status(200).json({ presentations });
  } catch (error) {
    console.error('Error fetching reviewer presentations:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Endpoint to get the form assigned to the conference of a presentation
app.get('/api/presentations/:presentationId/form', async (req, res) => {
  const { presentationId } = req.params;

  if (!presentationId) {
    return res.status(400).json({ error: 'Presentation ID is required' });
  }

  try {
    // Get the presentation document
    const presentationDoc = await db.collection('presentations').doc(presentationId).get();

    if (!presentationDoc.exists) {
      return res.status(404).json({ error: 'Presentation not found' });
    }

    const presentationData = presentationDoc.data();
    const conferenceId = presentationData['conference-id'];

    if (!conferenceId) {
      return res.status(400).json({ error: 'Conference ID is missing in the presentation' });
    }

    // Get the conference document
    const conferenceDoc = await db.collection('conferences').doc(conferenceId).get();

    if (!conferenceDoc.exists) {
      return res.status(404).json({ error: 'Conference not found' });
    }

    const conferenceData = conferenceDoc.data();
    const formId = conferenceData.formAssigned;

    if (!formId) {
      return res.status(404).json({ error: 'No form assigned to this conference' });
    }

    // Get the form document
    const formDoc = await db.collection('forms').doc(formId).get();

    if (!formDoc.exists) {
      return res.status(404).json({ error: 'Form not found' });
    }

    const formData = formDoc.data();

    // Include the formId in the response
    res.status(200).json({ formId, ...formData });
  } catch (error) {
    console.error('Error fetching form for presentation:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
//########################################################################
//Reminder email section

//Transporter to prepare the emails

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: "prostem.itcr@gmail.com",
    pass: "zevnywbizdymsuee"
  }
})

//endpoint to send reminder email
app.post("/api/send-reminder-email", async (req, res) =>{
  const {to, subject, text} = req.body
  try{
    const info = await transporter.sendMail({
      from: "prostem.itcr@gmail.com",
      to,
      subject,
      text
    })
    console.log("Email sent: ", info.response),
    res.status(200).json({message: "Email sent", info})
  }catch(error){
    console.log("error: ", error)
    res.status(500).json({error: error.message})
  }
})

cron.schedule("16 14 * * *", async () => {
  const eventsSnapshot = await db.collection("events").get();
  const now = new Date();

  for(const eventDoc of eventsSnapshot.docs){
    const event = eventDoc.data();

    const eventDateTime = new Date(`${event.startDate}T${event.startTime}:00`);

    const oneDayBefore = new Date(eventDateTime);
    oneDayBefore.setDate(eventDateTime.getDate() - 1);

    const formatDate = (d) => d.toISOString().split("T")[0];

    if(formatDate(now) === formatDate(oneDayBefore)){
      const registeredUsers = event.registeredUsers || [];

      for (const userId of registeredUsers){
        const userDoc = await db.collection("users").doc(userId).get();
        if(!userDoc.exists) continue;

        const user = userDoc.data();

        await transporter.sendMail({
          from: "prostem.itcr@gmail.com",
          to: user.email,
          subject: `Recordatorio evento próximo: ${event.title}`,
          text: `Hola, estimado/a ${user.name || ""}, ProSTEM le recuerda el evento ${event.title}, para el día de mañana a las ${event.startTime}` 
        });
        console.log(`Remider sent to ${user.email} for the event ${event.title}`)
      }
    }
  }

})

// Endpoint to get all "name" fields from the "areas" collection
app.get('/api/areas/names', async (req, res) => {
  try {
    // Fetch all documents from the "areas" collection
    const areasSnapshot = await db.collection('areas').get();

    // Extract the "name" field from each document
    const areaNames = areasSnapshot.docs.map(doc => doc.data().name);

    // Return the array of names
    res.status(200).json({ names: areaNames });
  } catch (error) {
    console.error('Error fetching areas:', error);
    res.status(500).json({ error: 'Failed to fetch areas' });
  }
});


// Endpoint to get the area and title of a presentation by its ID
app.get('/api/presentations/area-title/:presentationId', async (req, res) => {
  try {
    const { presentationId } = req.params;

    // Fetch the presentation document
    const presentationDoc = await db.collection('presentations').doc(presentationId).get();

    if (!presentationDoc.exists) {
      return res.status(404).json({ error: 'Presentation not found.' });
    }

    const presentationData = presentationDoc.data();

    // Check if the area field exists
    if (!presentationData.area) {
      return res.status(400).json({ error: 'The presentation does not have an area defined.' });
    }

    // Check if the title field exists
    if (!presentationData.title) {
      return res.status(400).json({ error: 'The presentation does not have a title defined.' });
    }

    // Return the area and title fields
    res.status(200).json({ 
      area: presentationData.area,
      title: presentationData.title
    });
  } catch (error) {
    console.error('Error fetching presentation area and title:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Endpoint to save a new revision form
app.post('/api/forms', async (req, res) => {
  try {
    const { questions } = req.body;

    if (!questions || !Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ error: 'Questions are required and must be an array.' });
    }

    // Prepare the form data
    const formData = {
      creationDate: new Date().toISOString(), // Save the creation date
      conferenceUsed: [], // Initialize as an empty array
    };

    // Add questions to the form data
    questions.forEach((question, index) => {
      const questionNumber = (index + 1).toString(); // Incremental number for the question
      const questionData = {
        type: question.type,
        question: question.text,
      };

      // Add options for single/multiple choice questions
      if (question.type === 'single' || question.type === 'multiple') {
        questionData.options = {};
        question.options.forEach((option, optionIndex) => {
          const optionNumber = (optionIndex + 1).toString(); // Incremental number for the option
          questionData.options[optionNumber] = option;
        });
      }

      formData[questionNumber] = questionData;
    });

    // Save the form in the database
    const formRef = db.collection('forms').doc();
    await formRef.set(formData);

    res.status(201).json({ message: 'Form created successfully', formId: formRef.id });
  } catch (error) {
    console.error('Error creating form:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Endpoint to fetch all forms with conference titles
app.get('/api/forms', async (req, res) => {
  try {
    const formsSnapshot = await db.collection('forms').get();
    const forms = [];

    for (const formDoc of formsSnapshot.docs) {
      const formData = formDoc.data();
      const formId = formDoc.id;

      // Fetch conference titles for the conferenceUsed field
      const conferenceTitles = [];
      for (const conferenceId of formData.conferenceUsed || []) {
        const conferenceDoc = await db.collection('conferences').doc(conferenceId).get();
        if (conferenceDoc.exists) {
          const conferenceData = conferenceDoc.data();
          conferenceTitles.push(conferenceData.title || 'Unknown Title');
        }
      }

      forms.push({
        id: formId,
        creationDate: formData.creationDate,
        conferenceUsed: conferenceTitles,
        questionCount: Object.keys(formData).filter(key => !isNaN(Number(key))).length, // Count numeric keys (questions)
      });
    }

    res.status(200).json(forms);
  } catch (error) {
    console.error('Error fetching forms:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Endpoint to fetch a single form by ID
app.get('/api/forms/:id', async (req, res) => {
  const formId = req.params.id;

  if (!formId) {
    return res.status(400).json({ error: 'Form ID is required' });
  }

  try {
    const formDoc = await db.collection('forms').doc(formId).get();

    if (!formDoc.exists) {
      return res.status(404).json({ error: 'Form not found' });
    }

    const formData = formDoc.data();
    res.status(200).json({ id: formId, ...formData });
  } catch (error) {
    console.error('Error fetching form:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Endpoint to check if a form is assigned to a conference
app.get('/api/conferences/:conferenceId/forms/:formId/assigned', async (req, res) => {
  const { conferenceId, formId } = req.params;

  if (!conferenceId || !formId) {
    return res.status(400).json({ error: 'Conference ID and Form ID are required' });
  }

  try {
    const conferenceDoc = await db.collection('conferences').doc(conferenceId).get();

    if (!conferenceDoc.exists) {
      return res.status(404).json({ error: 'Conference not found' });
    }

    const conferenceData = conferenceDoc.data();
    const formAssigned = conferenceData.formAssigned || []; // Default to an empty array if the field doesn't exist

    const isAssigned = formAssigned.includes(formId); // Check if the form ID is in the array

    res.status(200).json({ isAssigned });
  } catch (error) {
    console.error('Error checking form assignment:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Endpoint to check if a form is assigned to a conference
app.get('/api/conferences/:conferenceId/forms/:formId/assigned', async (req, res) => {
  const { conferenceId, formId } = req.params;

  if (!conferenceId || !formId) {
    return res.status(400).json({ error: 'Conference ID and Form ID are required' });
  }

  try {
    const conferenceDoc = await db.collection('conferences').doc(conferenceId).get();

    if (!conferenceDoc.exists) {
      return res.status(404).json({ error: 'Conference not found' });
    }

    const conferenceData = conferenceDoc.data();
    const formAssigned = conferenceData.formAssigned || []; // Default to an empty array if the field doesn't exist

    const isAssigned = formAssigned.includes(formId); // Check if the form ID is in the array

    res.status(200).json({ isAssigned });
  } catch (error) {
    console.error('Error checking form assignment:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Endpoint to toggle the assignment of a form to a conference
app.patch('/api/conferences/:conferenceId/forms/:formId/toggle-assignment', async (req, res) => {
  const { conferenceId, formId } = req.params;

  if (!conferenceId || !formId) {
    return res.status(400).json({ error: 'Conference ID and Form ID are required' });
  }

  try {
    const conferenceRef = db.collection('conferences').doc(conferenceId);
    const conferenceDoc = await conferenceRef.get();

    if (!conferenceDoc.exists) {
      return res.status(404).json({ error: 'Conference not found' });
    }

    const conferenceData = conferenceDoc.data();
    const currentFormAssigned = conferenceData.formAssigned || null; // Get the currently assigned form

    let message = '';
    if (currentFormAssigned === formId) {
      // If the form is already assigned, unassign it
      await conferenceRef.update({ formAssigned: '' });
      message = 'Form unassigned successfully';
    } else {
      // Assign the new form
      await conferenceRef.update({ formAssigned: formId });

      // Add the conferenceId to the "conferenceUsed" array in the forms collection
      const formRef = db.collection('forms').doc(formId);
      const formDoc = await formRef.get();

      if (!formDoc.exists) {
        return res.status(404).json({ error: 'Form not found' });
      }

      const formData = formDoc.data();
      const conferenceUsed = formData.conferenceUsed || []; // Default to an empty array if the field doesn't exist

      if (!conferenceUsed.includes(conferenceId)) {
        conferenceUsed.push(conferenceId);
        await formRef.update({ conferenceUsed });
      }

      message = 'Form assigned successfully';
    }

    res.status(200).json({ message, formAssigned: formId });
  } catch (error) {
    console.error('Error toggling form assignment:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// Endpoint to save filled form
app.post('/api/filled-forms', async (req, res) => {
  try {
    const { formId, userId, answers } = req.body;

    if (!formId || !userId || !answers) {
      return res.status(400).json({ error: 'Form ID, User ID, and answers are required' });
    }

    // Prepare the document structure
    const filledForm = {
      creationDate: admin.firestore.FieldValue.serverTimestamp(),
      formId,
      userId,
      answers, // The answers will be sent from the frontend
    };

    // Save the filled form in the "filled-forms" collection
    const filledFormRef = await db.collection('filled-forms').add(filledForm);

    res.status(201).json({ message: 'Form saved successfully', id: filledFormRef.id });
  } catch (error) {
    console.error('Error saving filled form:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

//################################################################################################


// Configuración de Multer para manejar la subida de archivos
const fileUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const uploadPath = path.join(__dirname, 'uploads');
      if (!fs.existsSync(uploadPath)) {
        fs.mkdirSync(uploadPath, { recursive: true });
      }
      cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
      cb(null, `${uniqueSuffix}-${file.originalname}`);
    }
  }),
  fileFilter: (req, file, cb) => {
    const allowedExtensions = ['.pdf', '.doc', '.docx', '.ppt', '.pptx'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowedExtensions.includes(ext)) {
      return cb(new Error('Only PDF, Word, and PowerPoint files are allowed'));
    }
    cb(null, true);
  }
});

// Endpoint para crear una presentación con documentos
app.post('/api/presentations', fileUpload.fields([
  { name: 'generalDocument', maxCount: 1 }
]), async (req, res) => {
  try {
    const { userId, conferenceId, title, summary, area, ...otherFields } = req.body;

    if (!userId || !conferenceId || !title || !summary || !area) {
      return res.status(400).json({ error: 'userId, conferenceId, title, description, and area are required' });
    }

    // Paso 1: Obtener el highest creationId de las presentaciones de la conferencia
    const conferenceRef = db.collection('conferences').doc(conferenceId);
    const conferenceDoc = await conferenceRef.get();

    if (!conferenceDoc.exists) {
      return res.status(404).json({ error: 'Conference not found' });
    }

    const conferenceData = conferenceDoc.data();
    const presentations = conferenceData.presentations || [];
    let highestCreationId = 0;

    // Iterar sobre las presentaciones para encontrar el highest creationId
    for (const presentationId of presentations) {
      const presentationDoc = await db.collection('presentations').doc(presentationId).get();
      if (presentationDoc.exists) {
        const creationId = presentationDoc.get('creationId') || 0; // Default to 0 if creationId is missing
        if (creationId > highestCreationId) {
          highestCreationId = creationId;
        }
      }
    }

    // Incrementar el highest creationId en 1
    const newCreationId = highestCreationId + 1;

    // Paso 2: Crear la ponencia sin los documentos
    const presentationRef = db.collection('presentations').doc();
    const presentationId = presentationRef.id;

    const currentDate = new Date().toISOString();

    const presentationData = {
      'creator-id': userId,
      'conference-id': conferenceId,
      title,
      summary,
      area, // Add the area directly as it comes
      creationId: newCreationId, // Asignar el nuevo creationId
      paid: false, // Initialize as false
      reviewed: false, // Initialize as false
      createdAt: currentDate, // Set creation date
      lastModified: currentDate, // Set lastModified to the same as createdAt
      ...otherFields, // Incluir otros campos adicionales
    };

    await presentationRef.set(presentationData);

    // Paso 3: Verificar si existe la carpeta de la conferencia
    const conferenceFolderPath = path.join(__dirname, 'uploads', conferenceId);
    if (!fs.existsSync(conferenceFolderPath)) {
      return res.status(400).json({ error: `The folder for conference ${conferenceId} does not exist.` });
    }

    // Crear una subcarpeta con el creationId dentro de la carpeta de la conferencia
    const presentationFolderPath = path.join(conferenceFolderPath, `${newCreationId}`);
    if (!fs.existsSync(presentationFolderPath)) {
      fs.mkdirSync(presentationFolderPath, { recursive: true });
    }

    // Paso 4: Guardar el documento general en la subcarpeta
    const generalDocument = req.files['generalDocument'] ? req.files['generalDocument'][0] : null;

    if (!generalDocument) {
      return res.status(400).json({ error: 'The generalDocument is required' });
    }

    // Generar la ruta del archivo dentro de la subcarpeta
    const generalDocumentPath = path.join(presentationFolderPath, `general-${generalDocument.originalname}`);

    // Renombrar y mover el archivo al directorio de uploads/conferenceId/creationId
    fs.renameSync(
      path.join(__dirname, 'uploads', generalDocument.filename),
      generalDocumentPath
    );

    // Guardar la ruta relativa en la base de datos
    await presentationRef.update({
      generalDocumentPath: `/uploads/${conferenceId}/${newCreationId}/general-${generalDocument.originalname}`
    });

    // Paso 5: Actualizar el documento del usuario
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userData = userDoc.data();
    const updatedPresentations = userData['presentations-author'] || [];
    const updatedConferences = userData['conferences-author'] || [];

    updatedPresentations.push(presentationId);
    if (!updatedConferences.includes(conferenceId)) {
      updatedConferences.push(conferenceId);
    }

    await userRef.update({
      'presentations-author': updatedPresentations,
      'conferences-author': updatedConferences,
    });

    // Paso 6: Actualizar el documento de la conferencia
    const updatedConferencePresentations = conferenceData.presentations || [];
    updatedConferencePresentations.push(presentationId);

    await conferenceRef.update({
      presentations: updatedConferencePresentations,
    });

    res.status(201).json({
      message: 'Presentation created successfully',
      presentationId,
      creationId: newCreationId, // Devolver el nuevo creationId
      paid: false, // Return the initial value of paid
      reviewed: false, // Return the initial value of reviewed
      lastModified: currentDate, // Return the lastModified date
      generalDocumentPath: `/uploads/${conferenceId}/${newCreationId}/general-${generalDocument.originalname}`
    });
  } catch (error) {
    console.error('Error creating presentation:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

//#################################################################################################

app.listen(PORT, (error) => {
  if (error) console.log("There was an error:", error);
  console.log(`App available on http://localhost:${PORT} `);
});
