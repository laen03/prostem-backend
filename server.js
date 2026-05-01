
const { admin, db, bucket } = require("./config/firebase");

const app = require("./app");

const {
  upload,
  fileUpload,
  paymentUpload,
  zipUpload,
  newsImageUpload,
} = require('./middlewares/multer.middleware');

const { deleteCollectionInBatchesIterative } = require("./utils/batchDelete");

const { getFullNameFromToken } = require("./utils/nameParser");

const { DateTime } = require("luxon");

const transporter = require("./config/mailer");

const cron = require("node-cron")
require("dotenv").config(); // carga las variables de .env
const path = require('path');
const fs = require('fs');

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');


require("dotenv").config();


//Initialize firebase admin
const PORT = process.env.PORT || 3000;


//File middleware
const sharp = require("sharp");
const resizeValue = 100; // This is to help save space on Firebase Storage.
const qualityValue = 65; // From 0 to 100



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
    await deleteCollectionInBatchesIterative(db, responsesRef);

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

    // Get ALL conferences in the system to find the highest creationId globally
    const allConferencesSnapshot = await db.collection("conferences").get();
    let highestNumericId = 0;

    // Iterate through ALL conferences to find the highest numeric ID
    allConferencesSnapshot.forEach((doc) => {
      if (doc.exists) {
        const creationId = doc.get("creationId") || "C000";
        // Extract numeric part from format like "C001", "C002"
        if (typeof creationId === 'string' && creationId.startsWith('C')) {
          const numericPart = parseInt(creationId.substring(1));
          if (numericPart > highestNumericId) {
            highestNumericId = numericPart;
          }
        } else if (typeof creationId === 'number') {
          // Handle legacy numeric creationIds
          if (creationId > highestNumericId) {
            highestNumericId = creationId;
          }
        }
      }
    });

    // Increment the highest numeric ID by 1
    const newNumericId = highestNumericId + 1;

    // Generate formatted conference code (C001, C002, etc.)
    const newCreationId = `C${newNumericId.toString().padStart(3, '0')}`;

    // Add the new conference data
    const newConferenceData = {
      ...data,
      managerId: managerId,
      creationId: newCreationId,     // Formatted ID stored in creationId field (C001, C002, etc.)
      resultsSent: 0,
      finalResults: false,
      presentations: [],
      active: true
    };

    const newConference = await conferencesDB.add(newConferenceData);

    // Create a folder in the uploads/conferences directory with the creationId of the new conference
    const uploadPath = path.join(__dirname, "uploads", "conferences", newCreationId);
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

// Endpoint to update the resultsSent field for a specific conference
app.patch("/api/conferences/:id/update-results", async (req, res) => {
  try {
    const conferenceId = req.params.id;
    console.log(`Updating resultsSent for conference: ${conferenceId}`);

    // Fetch the conference document
    const conferenceRef = db.collection("conferences").doc(conferenceId);
    const conferenceDoc = await conferenceRef.get();

    if (!conferenceDoc.exists) {
      console.error(`Conference ${conferenceId} not found`);
      return res.status(404).json({ error: "Conference not found" });
    }

    const conferenceData = conferenceDoc.data();
    const conferenceTitle = conferenceData.title; // Get the conference title
    console.log(`Conference title: ${conferenceTitle}`);

    const currentResultsSent = conferenceData.resultsSent || 0;
    console.log(`Current resultsSent: ${currentResultsSent}`);

    // Increment the resultsSent field, but cap it at 3
    const updatedResultsSent = Math.min(currentResultsSent + 1, 3);

    // Update the resultsSent field in the database
    await conferenceRef.update({ resultsSent: updatedResultsSent });
    console.log(`Updated resultsSent to: ${updatedResultsSent}`);

    // Process presentations and send emails
    const presentations = conferenceData.presentations || [];
    console.log(`Processing ${presentations.length} presentations`);

    for (const presentationId of presentations) {
      console.log(`Processing presentation: ${presentationId}`);
      const presentationRef = db.collection("presentations").doc(presentationId);
      const presentationDoc = await presentationRef.get();

      if (!presentationDoc.exists) {
        console.error(`Presentation ${presentationId} not found`);
        continue;
      }

      const presentationData = presentationDoc.data();
      const presentationTitle = presentationData.title; // Get the presentation title
      console.log(`Presentation title: ${presentationTitle}`);

      const reviewersAssigned = presentationData.reviewersAssigned || [];
      const creatorId = presentationData["creator-id"];
      console.log(`Creator ID: ${creatorId}`);

      // Count the states
      const stateCounts = { Aceptada: 0, "Aceptada con cambios requeridos": 0, "No Aceptada": 0 };
      
      //console.log(`=== DEBUG REVIEWER STATES ===`);
      for (const reviewer of reviewersAssigned) {
        //console.log(`Reviewer ${reviewer.reviewerId}: state = "${reviewer.state}"`);
        //console.log(`State type: ${typeof reviewer.state}`);
        //console.log(`State length: ${reviewer.state?.length}`);
        const state = reviewer.state;
        if (stateCounts[state] !== undefined) {
          stateCounts[state]++;
        }
      }

      //console.log(`Final state counts: ${JSON.stringify(stateCounts)}`);
      //console.log(`=== END DEBUG ===`);

      console.log(`State counts: ${JSON.stringify(stateCounts)}`);

      // Determine the majority state
      const acceptedCombined = stateCounts.Aceptada + stateCounts["Aceptada con cambios requeridos"];
      const noAccepted = stateCounts["No Aceptada"];
      let resultState;

      if (acceptedCombined > noAccepted) {
        // If there is at least one "Aceptada con cambios requeridos," the result is "Aceptada con cambios requeridos"
        if (stateCounts["Aceptada con cambios requeridos"] > 0) {
          resultState = "Aceptada con cambios requeridos";
        } else {
          resultState = "Aceptada";
        }
      } else {
        resultState = "No Aceptada";
      }

      console.log(`Result state: ${resultState}`);

      // Handle results based on resultsSent
      if (currentResultsSent === 0) {
        // Add the overallResult field to the presentation
        await presentationRef.update({ overallResult: resultState });
        console.log(`Added overallResult: ${resultState} to presentation: ${presentationId}`);

        // If the overallResult is "Aceptada con cambios requeridos", add the correctedDocumentSent field
        if (resultState === "Aceptada con cambios requeridos") {
          await presentationRef.update({ correctedDocumentSent: false });
          console.log(`Added correctedDocumentSent: false to presentation: ${presentationId}`);
        }

        // Send email to the user
        await sendResultEmail(resultState, creatorId, presentationTitle, conferenceTitle, reviewersAssigned);
      }  else if (currentResultsSent === 1) {
        // Check the overallResult field
        const overallResult = presentationData.overallResult;
        console.log(`Overall result: ${overallResult}`);

        if (overallResult === "Aceptada con cambios requeridos") {
          // Check manager approval instead of recalculating from reviewers
          const managerDocApproval = presentationData.managerDocApproval;
          let newOverallResult;
          
          if (managerDocApproval === true) {
            newOverallResult = "Aceptada";
          } else {
            newOverallResult = "No aceptada";
          }
          
          // Update the overallResult field
          await presentationRef.update({ overallResult: newOverallResult });
          console.log(`Updated overallResult to: ${newOverallResult} for presentation: ${presentationId}`);

          // Send an email with the updated result
          await sendResultEmail(newOverallResult, creatorId, presentationTitle, conferenceTitle, reviewersAssigned);
        }
      } else if (currentResultsSent === 2) {
        // NEW: Final validation for presentation acceptance
        console.log(`Final validation for presentation: ${presentationId}`);
        
        // First check: overallResult must be "Aceptada"
        const overallResult = presentationData.overallResult;
        console.log(`Overall result check: ${overallResult}`);
        
        if (overallResult === "Aceptada") {
          // Only proceed with validation if overallResult is "Aceptada"
          console.log(`Presentation ${presentationId} is "Aceptada", proceeding with final validation`);
          
          // Check the three required conditions
          const paidCondition = presentationData.paid === true;
          const finalVersionCondition = presentationData.finalVersionUploaded === true;
          const presentationDocCondition = presentationData.presentationDocumentPath && 
                                         presentationData.presentationDocumentPath.trim() !== '';
          
          console.log(`Conditions check - Paid: ${paidCondition}, Final Version: ${finalVersionCondition}, Presentation Doc: ${presentationDocCondition}`);
          
          // Check if all conditions are met
          if (paidCondition && finalVersionCondition && presentationDocCondition) {
            // All conditions met - set DefinitiveState to true
            await presentationRef.update({ DefinitiveState: true });
            console.log(`Set DefinitiveState: true for presentation: ${presentationId}`);
            
            // Send success email
            await sendFinalAcceptanceEmail(creatorId, presentationTitle, conferenceTitle);
          } else {
            // Some conditions not met - set DefinitiveState to false
            await presentationRef.update({ DefinitiveState: false });
            console.log(`Set DefinitiveState: false for presentation: ${presentationId}`);
            
            // Determine which conditions weren't met
            const missingConditions = [];
            if (!paidCondition) {
              missingConditions.push("pago no completado o no aceptado");
            }
            if (!finalVersionCondition) {
              missingConditions.push("versión final con autores no subida");
            }
            if (!presentationDocCondition) {
              missingConditions.push("documento de presentación no subido");
            }
            
            // Send rejection email with specific reasons
            await sendFinalRejectionEmail(creatorId, presentationTitle, conferenceTitle, missingConditions);
          }
        } else {
          // overallResult is not "Aceptada" - skip this presentation entirely
          console.log(`Presentation ${presentationId} has overallResult: "${overallResult}" - skipping final validation`);
          // No emails sent, no DefinitiveState set
        }
      }
    }

    res.status(200).json({ message: "Results updated successfully", resultsSent: updatedResultsSent });
  } catch (error) {
    console.error("Error updating resultsSent:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// NEW: Function to send final acceptance email
async function sendFinalAcceptanceEmail(creatorId, presentationTitle, conferenceTitle) {
  try {
    // Get user email from database
    const userRef = db.collection('users').doc(creatorId);
    const userDoc = await userRef.get();
    
    if (!userDoc.exists) {
      console.error(`User ${creatorId} not found`);
      return;
    }
    
    const userData = userDoc.data();
    const userEmail = userData.email;
    const userName = userData.name || 'Estimado/a participante';
    
    const mailOptions = {
      from: process.env.EMAIL_FROM,
      to: userEmail,
      subject: `🎉 Presentación Aceptada - ${conferenceTitle}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #4CAF50;">¡Felicitaciones! Su presentación ha sido aceptada</h2>
          
          <p>Estimado/a ${userName},</p>
          
          <p>Nos complace informarle que su presentación <strong>"${presentationTitle}"</strong> para el ${conferenceTitle} ha sido <strong>definitivamente aceptada</strong>.</p>
          
          <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <h3 style="color: #28a745; margin-top: 0;">✅ Todo está en orden</h3>
            <p>Hemos verificado que:</p>
            <ul>
              <li>Su pago ha sido procesado correctamente</li>
              <li>La versión final con autores ha sido recibida</li>
              <li>Su documento de presentación está listo</li>
            </ul>
          </div>
          
          <p><strong>Está completamente preparado/a para su presentación en la conferencia.</strong></p>
          
          <p>La fecha y hora específica de su presentación le será enviada próximamente.</p>
          
          <p>¡Esperamos verle en el evento!</p>
          
          <hr style="margin: 30px 0;">
          <p style="color: #666; font-size: 12px;">Este es un mensaje automático. Por favor, no responder a este correo.</p>
        </div>
      `
    };
    
    await transporter.sendMail(mailOptions);
    console.log(`Final acceptance email sent successfully to ${userEmail}`);
  } catch (error) {
    console.error('Error sending final acceptance email:', error);
  }
}

// NEW: Function to send final rejection email
async function sendFinalRejectionEmail(creatorId, presentationTitle, conferenceTitle, missingConditions) {
  try {
    // Get user email from database
    const userRef = db.collection('users').doc(creatorId);
    const userDoc = await userRef.get();
    
    if (!userDoc.exists) {
      console.error(`User ${creatorId} not found`);
      return;
    }
    
    const userData = userDoc.data();
    const userEmail = userData.email;
    const userName = userData.name || 'Estimado/a participante';
    
    const conditionsText = missingConditions.join(', ');
    
    const mailOptions = {
      from: process.env.EMAIL_FROM,
      to: userEmail,
      subject: `❌ Presentación No Aceptada - ${conferenceTitle}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #DC3545;">Presentación No Aceptada</h2>
          
          <p>Estimado/a ${userName},</p>
          
          <p>Lamentablemente, su presentación <strong>"${presentationTitle}"</strong> para el ${conferenceTitle} <strong>no ha sido aceptada definitivamente</strong>.</p>
          
          <div style="background-color: #fff3cd; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #ffc107;">
            <h3 style="color: #856404; margin-top: 0;">Motivo(s) de no aceptación:</h3>
            <p style="color: #856404; margin-bottom: 0;">${conditionsText}</p>
          </div>
          
          <p>Para que su presentación sea considerada en futuras conferencias, asegúrese de cumplir con todos los requisitos establecidos.</p>
          
          <p>Si tiene alguna consulta, no dude en contactarnos.</p>
          
          <p>Gracias por su participación.</p>
          
          <hr style="margin: 30px 0;">
          <p style="color: #666; font-size: 12px;">Este es un mensaje automático. Por favor, no responder a este correo.</p>
        </div>
      `
    };
    
    await transporter.sendMail(mailOptions);
    console.log(`Final rejection email sent successfully to ${userEmail}`);
  } catch (error) {
    console.error('Error sending final rejection email:', error);
  }
}

// Helper function to send result emails
async function sendResultEmail(resultState, creatorId, presentationTitle, conferenceTitle, reviewersAssigned) {
  try {
    // Fetch the creator's email
    const creatorRef = db.collection("users").doc(creatorId);
    const creatorDoc = await creatorRef.get();

    if (!creatorDoc.exists) {
      console.error(`Creator ${creatorId} not found`);
      return;
    }

    const creatorEmail = creatorDoc.get("email");
    const creatorName = creatorDoc.get("name") || "Estimado/a participante";

    // Send email based on the result
    let emailSubject = "";
    let emailBody = "";

    if (resultState === "Aceptada") {
      emailSubject = `✅ Ponencia Aceptada - ${conferenceTitle}`;
      emailBody = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background-color: #28a745; color: white; padding: 20px; text-align: center; border-radius: 5px 5px 0 0; }
                .content { background-color: #f8f9fa; padding: 30px; border-radius: 0 0 5px 5px; }
                .highlight { background-color: #d1ecf1; padding: 15px; border-left: 4px solid #28a745; margin: 20px 0; }
                .footer { text-align: center; margin-top: 20px; font-size: 14px; color: #666; }
                .action-required { background-color: #fff3cd; padding: 15px; border-left: 4px solid #ffc107; margin: 20px 0; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h2>🎉 ¡Felicitaciones! Su ponencia ha sido aceptada</h2>
                </div>
                
                <div class="content">
                    <p><strong>${creatorName},</strong></p>
                    
                    <div class="highlight">
                        <p><strong>📄 Ponencia:</strong> "${presentationTitle}"</p>
                        <p><strong>🎯 Conferencia:</strong> "${conferenceTitle}"</p>
                        <p><strong>✅ Estado:</strong> Aceptada</p>
                    </div>
                    
                    <p>Nos complace informarle que su ponencia ha sido <strong>aceptada</strong> para presentación en la conferencia.</p>
                    
                    <div class="action-required">
                        <p><strong>📋 Próximos pasos:</strong></p>
                        <p>Por favor, regrese al sitio web para subir el documento completo, incluyendo los autores.</p>
                    </div>
                    
                    <p>¡Esperamos su presentación en el evento!</p>
                </div>
                
                <div class="footer">
                    <p>📧 Este es un mensaje automático del sistema de gestión de conferencias</p>
                    <p><strong>Equipo ProSTEM</strong></p>
                </div>
            </div>
        </body>
        </html>
      `;
    } else if (resultState === "No Aceptada") {
      emailSubject = `❌ Resultado de revisión - ${conferenceTitle}`;
      emailBody = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background-color: #dc3545; color: white; padding: 20px; text-align: center; border-radius: 5px 5px 0 0; }
                .content { background-color: #f8f9fa; padding: 30px; border-radius: 0 0 5px 5px; }
                .highlight { background-color: #f8d7da; padding: 15px; border-left: 4px solid #dc3545; margin: 20px 0; }
                .footer { text-align: center; margin-top: 20px; font-size: 14px; color: #666; }
                .encouragement { background-color: #e2e3e5; padding: 15px; border-left: 4px solid #6c757d; margin: 20px 0; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h2>📋 Resultado de la revisión de su ponencia</h2>
                </div>
                
                <div class="content">
                    <p><strong>${creatorName},</strong></p>
                    
                    <div class="highlight">
                        <p><strong>📄 Ponencia:</strong> "${presentationTitle}"</p>
                        <p><strong>🎯 Conferencia:</strong> "${conferenceTitle}"</p>
                        <p><strong>❌ Estado:</strong> No Aceptada</p>
                    </div>
                    
                    <p>Lamentamos informarle que su ponencia no fue aceptada para presentación en esta conferencia.</p>
                    
                    <div class="encouragement">
                        <p><strong>💪 No se desanime:</strong></p>
                        <p>Le animamos a seguir desarrollando su investigación y considerar futuras oportunidades de presentación.</p>
                    </div>
                    
                    <p>Agradecemos su interés y participación en nuestra conferencia.</p>
                </div>
                
                <div class="footer">
                    <p>📧 Este es un mensaje automático del sistema de gestión de conferencias</p>
                    <p><strong>Equipo ProSTEM</strong></p>
                </div>
            </div>
        </body>
        </html>
      `;
    } else if (resultState === "Aceptada con cambios requeridos") {
      // Collect required changes from reviewers
      let requiredChangesList = [];
      for (const reviewer of reviewersAssigned) {
        if (reviewer.state === "Aceptada con cambios requeridos") {
          const filledFormId = reviewer["filled-form-id"];
          const filledFormRef = db.collection("filled-forms").doc(filledFormId);
          const filledFormDoc = await filledFormRef.get();

          if (filledFormDoc.exists) {
            const filledFormData = filledFormDoc.data();
            const answers = filledFormData.answers || [];
            const lastAnswer = answers[answers.length - 1]; // Get the last question
            if (lastAnswer && lastAnswer.requiredChanges) {
              requiredChangesList.push(lastAnswer.requiredChanges);
            }
          }
        }
      }

      // Format required changes for HTML
      const requiredChangesHtml = requiredChangesList.length > 0
        ? requiredChangesList.map(change => `<li>${change}</li>`).join('')
        : '<li>No se especificaron cambios requeridos.</li>';

      emailSubject = `📝 Ponencia Aceptada con Cambios - ${conferenceTitle}`;
      emailBody = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background-color: #ffc107; color: #212529; padding: 20px; text-align: center; border-radius: 5px 5px 0 0; }
                .content { background-color: #f8f9fa; padding: 30px; border-radius: 0 0 5px 5px; }
                .highlight { background-color: #fff3cd; padding: 15px; border-left: 4px solid #ffc107; margin: 20px 0; }
                .footer { text-align: center; margin-top: 20px; font-size: 14px; color: #666; }
                .changes-box { background-color: #e7f1ff; padding: 15px; border-left: 4px solid #0066cc; margin: 20px 0; }
                .changes-box ul { margin: 10px 0; padding-left: 20px; }
                .changes-box li { margin: 8px 0; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h2>📝 Ponencia aceptada con cambios requeridos</h2>
                </div>
                
                <div class="content">
                    <p><strong>${creatorName},</strong></p>
                    
                    <div class="highlight">
                        <p><strong>📄 Ponencia:</strong> "${presentationTitle}"</p>
                        <p><strong>🎯 Conferencia:</strong> "${conferenceTitle}"</p>
                        <p><strong>📝 Estado:</strong> Aceptada con cambios requeridos</p>
                    </div>
                    
                    <p>Su ponencia ha sido <strong>aceptada condicionalmente</strong>. Para que sea definitivamente aceptada, es necesario realizar algunos cambios.</p>
                    
                    <div class="changes-box">
                        <p><strong>📋 Cambios requeridos por los revisores:</strong></p>
                        <ul>
                            ${requiredChangesHtml}
                        </ul>
                    </div>
                    
                    <p><strong>📌 Próximos pasos:</strong></p>
                    <p>Por favor, regrese al sitio web para revisar los comentarios detallados y realizar los cambios necesarios. Una vez implementados los cambios, podrá reenviar su documento corregido.</p>
                    
                    <p>¡Estamos seguros de que con estos ajustes su ponencia será excelente!</p>
                </div>
                
                <div class="footer">
                    <p>📧 Este es un mensaje automático del sistema de gestión de conferencias</p>
                    <p><strong>Equipo ProSTEM</strong></p>
                </div>
            </div>
        </body>
        </html>
      `;
    }

    const mailOptions = {
      from: process.env.EMAIL_FROM,
      to: creatorEmail,
      subject: emailSubject,
      html: emailBody
    };

    await transporter.sendMail(mailOptions);
    console.log(`Result email sent successfully to ${creatorEmail}: ${resultState}`);
  } catch (error) {
    console.error('Error sending result email:', error);
  }
}



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


app.get("/api/conferences", async (req, res) => {
  const userId = req.query.userId;
  console.log('Received userId:', userId);

  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  try {
    const conferencesSnapshot = await db.collection('conferences').get();

    const conferences = [];
    conferencesSnapshot.forEach(doc => {
      const data = doc.data();
      
      // FIXED: Use 'userId' field instead of 'creator-id'
      console.log(`Conference ${doc.id}: userId=${data.userId}, currentUser=${userId}, resultsSent=${data.resultsSent}`);
      
      // Apply filters: exclude user's own conferences AND only show conferences with resultsSent = 0
      if (data.userId !== userId && data.resultsSent === 0) {
        conferences.push({
          id: doc.id,
          ...data
        });
      }
    });

    console.log(`Filtered conferences: ${conferences.length}`);
    res.status(200).json(conferences);
  } catch (error) {
    console.error('Error fetching conferences:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});


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
app.get('/api/presentations/:conferenceCreationId/:presentationCreationId/download', async (req, res) => {
  try {
    const { conferenceCreationId, presentationCreationId } = req.params;

    // Construct the file path using the new structure: uploads/conferences/conferenceCreationId/presentationCreationId
    const documentFolderPath = path.join(__dirname, 'uploads', 'conferences', conferenceCreationId, presentationCreationId);
    
    // Check if the folder exists
    if (!fs.existsSync(documentFolderPath)) {
      return res.status(404).json({ error: 'Document folder not found' });
    }

    const files = fs.readdirSync(documentFolderPath);

    // Find the general document in the folder
    const generalDocument = files.find(file => file.startsWith('general-'));
    if (!generalDocument) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const filePath = path.join(documentFolderPath, generalDocument);

    // Send the file to the client for download
    res.download(filePath);
  } catch (error) {
    console.error('Error downloading document:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Endpoint to view a document by conferenceId and creationId
app.get('/api/presentations/:conferenceCreationId/:presentationCreationId/view', async (req, res) => {
  try {
    const { conferenceCreationId, presentationCreationId } = req.params;

    console.log('=== DEBUG VIEW DOCUMENT ===');
    console.log('conferenceCreationId:', conferenceCreationId);
    console.log('presentationCreationId:', presentationCreationId);

    // Construct the file path using the new structure: uploads/conferences/conferenceCreationId/presentationCreationId
    const documentFolderPath = path.join(__dirname, 'uploads', 'conferences', conferenceCreationId, presentationCreationId);
    
    console.log('Looking for folder at:', documentFolderPath);
    console.log('Folder exists:', fs.existsSync(documentFolderPath));

    // Let's also check what's actually in the uploads/conferences folder
    const conferencesPath = path.join(__dirname, 'uploads', 'conferences');
    if (fs.existsSync(conferencesPath)) {
      console.log('Conferences folder contents:', fs.readdirSync(conferencesPath));
      
      // Check if the conference folder exists
      const confFolderPath = path.join(conferencesPath, conferenceCreationId);
      if (fs.existsSync(confFolderPath)) {
        console.log(`Conference ${conferenceCreationId} folder contents:`, fs.readdirSync(confFolderPath));
      } else {
        console.log(`Conference folder ${conferenceCreationId} does NOT exist`);
      }
    } else {
      console.log('Conferences folder does NOT exist');
    }
    
    // Check if the folder exists
    if (!fs.existsSync(documentFolderPath)) {
      return res.status(404).json({ error: 'Document folder not found' });
    }

    const files = fs.readdirSync(documentFolderPath);
    console.log('Files in folder:', files);

    // Find the general document in the folder
    const generalDocument = files.find(file => file.startsWith('general-'));
    if (!generalDocument) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const filePath = path.join(documentFolderPath, generalDocument);
    console.log('Final file path:', filePath);

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

// Endpoint to check if a reviewer is assigned to a specific presentation
app.get('/api/isAssigned', async (req, res) => {
  const { reviewerId, presentationId } = req.query;

  if (!reviewerId || !presentationId) {
    return res.status(400).json({ error: 'ReviewerId and presentationId are required' });
  }

  try {
    // Get the reviewer (user) document
    const reviewerDoc = await db.collection('users').doc(reviewerId).get();
    
    if (!reviewerDoc.exists) {
      return res.status(404).json({ error: 'Reviewer not found' });
    }

    const reviewerData = reviewerDoc.data();
    const presentationsAssigned = reviewerData.presentationsAssigned || [];
    
    // Check if the presentation ID is in the reviewer's assigned presentations
    const isAssigned = presentationsAssigned.some((item) =>
      typeof item === 'string'
        ? item === presentationId
        : item?.presentationId === presentationId
    );
    
    res.status(200).json({ isAssigned });
  } catch (error) {
    console.error('Error checking reviewer assignment:', error);
    res.status(500).json({ error: 'Internal server error' });
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

    if (presentationsAuthor.length === 0) {
      return res.status(200).json([]); // No presentations, return an empty array
    }

    // Fetch all presentations in parallel
    const presentationDocs = await Promise.all(
      presentationsAuthor.map((presentationId) =>
        db.collection('presentations').doc(presentationId).get()
      )
    );

    // Extract unique conference IDs
    const conferenceIds = new Set();
    presentationDocs.forEach((doc) => {
      if (doc.exists) {
        const presentationData = doc.data();
        if (presentationData['conference-id']) {
          conferenceIds.add(presentationData['conference-id']);
        }
      }
    });

    if (conferenceIds.size === 0) {
      return res.status(200).json([]); // No conferences, return an empty array
    }

    // Fetch all conferences in parallel
    const conferenceDocs = await Promise.all(
      Array.from(conferenceIds).map((conferenceId) =>
        db.collection('conferences').doc(conferenceId).get()
      )
    );

    // Extract conference details
    const conferences = conferenceDocs
      .filter((doc) => doc.exists)
      .map((doc) => ({ id: doc.id, ...doc.data() }));

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

    if (presentationsAuthor.length === 0) {
      return res.status(200).json([]); // No presentations, return an empty array
    }

    // Fetch all presentations in parallel
    const presentationDocs = await Promise.all(
      presentationsAuthor.map((presentationId) =>
        db.collection('presentations').doc(presentationId).get()
      )
    );

    // Filter presentations that match the conference ID
    const presentations = presentationDocs
      .filter((doc) => doc.exists && doc.data()['conference-id'] === conferenceId)
      .map((doc) => ({ id: doc.id, ...doc.data() }));

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

// Endpoint to find reviewers by presentation area (optimized with batch query)
app.get('/api/reviewers-by-presentation/:presentationId', async (req, res) => {
  const { presentationId } = req.params;
  const { area } = req.query;

  if (!presentationId) {
    return res.status(400).json({ error: 'Presentation ID is required' });
  }

  try {
    // Get the presentation data
    const presentationDoc = await db.collection('presentations').doc(presentationId).get();

    if (!presentationDoc.exists) {
      return res.status(404).json({ error: 'Presentation not found' });
    }

    const presentationData = presentationDoc.data();
    const currentConferenceId = presentationData['conference-id'];
    const targetArea = area;
    
    // Get all reviewers
    const usersQuery = await db.collection('users')
      .where('reviewer', '==', true)
      .get();

    if (usersQuery.empty) {
      return res.status(404).json({ error: 'No reviewers found' });
    }

    // Collect all presentation IDs from all reviewers
    const allPresentationIds = new Set();
    const reviewerData = [];
    
    usersQuery.forEach((doc) => {
      const userData = doc.data();
      const assignedPresentations = userData.presentationsAssigned || [];
      
      // Collect presentation IDs for batch query
      assignedPresentations.forEach(assignment => {
        if (assignment.presentationId) {
          allPresentationIds.add(assignment.presentationId);
        }
      });
      
      reviewerData.push({
        id: doc.id,
        data: userData,
        assignedPresentations
      });
    });

    // Batch query all presentations at once
    const presentationPromises = Array.from(allPresentationIds).map(id => 
      db.collection('presentations').doc(id).get()
    );
    
    const presentationDocs = await Promise.all(presentationPromises);
    
    // Create a map of presentation ID to conference ID
    const presentationToConference = {};
    presentationDocs.forEach((doc, index) => {
      if (doc.exists) {
        const presentationId = Array.from(allPresentationIds)[index];
        presentationToConference[presentationId] = doc.data()['conference-id'];
      }
    });

    // Process reviewers with cached data
    const reviewers = [];
    
    reviewerData.forEach(reviewer => {
      const userData = reviewer.data;
      
      // Count conference-specific presentations using cached data
      let conferenceSpecificCount = 0;
      reviewer.assignedPresentations.forEach(assignment => {
        const confId = presentationToConference[assignment.presentationId];
        if (confId === currentConferenceId) {
          conferenceSpecificCount++;
        }
      });

      // Apply area filtering
      if (!targetArea || targetArea === 'Todas las áreas') {
        reviewers.push({
          id: reviewer.id,
          name: `${userData.name} ${userData.lastName1} ${userData.lastName2}`,
          email: userData.email,
          institution: userData.institution,
          presentationsAssigned: conferenceSpecificCount,
          isAssigned: userData.conferencesAssigned?.includes(currentConferenceId) || false,
          specializations: userData.specializations || [],
          matchingArea: presentationData.area,
        });
      } else {
        const userAreas = userData.specializations || userData.areas || [];
        if (Array.isArray(userAreas) && userAreas.includes(targetArea)) {
          const specializations = [...userAreas];
          const index = specializations.indexOf(targetArea);
          if (index > -1) {
            specializations.splice(index, 1);
            specializations.unshift(targetArea);
          }

          reviewers.push({
            id: reviewer.id,
            name: `${userData.name} ${userData.lastName1} ${userData.lastName2}`,
            email: userData.email,
            institution: userData.institution,
            presentationsAssigned: conferenceSpecificCount,
            isAssigned: userData.conferencesAssigned?.includes(currentConferenceId) || false,
            specializations,
            matchingArea: targetArea,
          });
        }
      }
    });

    res.status(200).json({ reviewers });
  } catch (error) {
    console.error('Error fetching reviewers:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Endpoint to get all users who are not reviewers (potential reviewer candidates)
app.get('/api/non-reviewers', async (req, res) => {
  try {
    // Query the users collection for users who are NOT reviewers
    const usersQuery = await db.collection('users').get();

    if (usersQuery.empty) {
      console.log('No users found.');
      return res.status(404).json({ error: 'No users found' });
    }

    const nonReviewers = [];

    usersQuery.forEach((doc) => {
      const userData = doc.data();

      // Include users where reviewer field is false OR reviewer field doesn't exist
      if (userData.reviewer === false || userData.reviewer === undefined) {
        nonReviewers.push({
          id: doc.id,
          name: `${userData.name} ${userData.lastName1} ${userData.lastName2}`, // Combine name fields
          email: userData.email,
          institution: userData.institution,
          areas: userData.specializations || [], // Include the areas array
        });
      }
    });

    res.status(200).json({ nonReviewers });
  } catch (error) {
    console.error('Error fetching non-reviewers:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Endpoint to make a user a reviewer
app.patch('/api/make-reviewer/:userId', async (req, res) => {
  const { userId } = req.params;

  if (!userId) {
    return res.status(400).json({ error: 'User ID is required' });
  }

  try {
    // Get the user document
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Update the reviewer field to true
    await userRef.update({
      reviewer: true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const userData = userDoc.data();
    const userName = `${userData.name} ${userData.lastName1} ${userData.lastName2}`;

    res.status(200).json({ 
      message: `${userName} has been made a reviewer successfully`,
      userId: userId 
    });
  } catch (error) {
    console.error('Error making user a reviewer:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Endpoint to get all reviewers from the users collection
app.get('/api/reviewers', async (req, res) => {
  try {
    // Query the users collection for reviewers with "reviewer" set to true
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

      reviewers.push({
        id: doc.id,
        name: `${userData.name} ${userData.lastName1} ${userData.lastName2}`, // Combine name fields
        email: userData.email,
        institution: userData.institution,
        presentationsAssigned: userData.presentationsAssigned?.length || 0, // Count of assigned presentations
        isAssigned: userData.conferencesAssigned?.length > 0 || false, // Check if the user is assigned to any conference
        specializations: userData.specializations || [], // Include the specializations array
      });
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
    for (const assignment of presentationsAssigned) {
      const { presentationId } = assignment; // Extract presentationId from the map

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
    for (const assignment of presentationsAssigned) {
      const { presentationId, reviewed } = assignment; // Extract presentationId and reviewed from the map

      const presentationDoc = await db.collection('presentations').doc(presentationId).get();

      if (presentationDoc.exists) {
        const presentationData = presentationDoc.data();
        if (presentationData['conference-id'] === conferenceId) {
          presentations.push({
            id: presentationDoc.id,
            ...presentationData,
            estado: reviewed ? 'Revisado' : 'Pendiente a revisar', // Add "Estado" based on the "reviewed" field
          });
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
    const overallResult = presentationData.overallResult || null; // Fetch the overallResult field

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

    // Include the formId and overallResult in the response
    res.status(200).json({ formId, overallResult, ...formData });
  } catch (error) {
    console.error('Error fetching form for presentation:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
//########################################################################
//Reminder email section





//endpoint to send reminder email
app.post("/api/send-reminder-email", async (req, res) =>{
  const {to, subject, text} = req.body
  try{
    const info = await transporter.sendMail({
      from: process.env.EMAIL_FROM || process.env.SMTP_USER,
      to,
      subject,
      text,
    });
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
          from: process.env.EMAIL_FROM || process.env.SMTP_USER,
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
    const areaNames = areasSnapshot.docs.map(doc => doc.data().originalWord);

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
    console.log(`Getting area and title for presentation ID: ${presentationId}`); // DEBUG

    // Fetch the presentation document
    const presentationDoc = await db.collection('presentations').doc(presentationId).get();

    if (!presentationDoc.exists) {
      console.log(`Presentation ${presentationId} not found`); // DEBUG
      return res.status(404).json({ error: 'Presentation not found.' });
    }

    const presentationData = presentationDoc.data();
    console.log(`Presentation data:`, presentationData); // DEBUG - This will show all fields
    console.log(`Area field value: "${presentationData.area}"`); // DEBUG - Specific area field
    console.log(`Title field value: "${presentationData.title}"`); // DEBUG - Specific title field

    // Check if the area field exists
    if (!presentationData.area) {
      console.log(`Area field is missing or empty`); // DEBUG
      return res.status(400).json({ error: 'The presentation does not have an area defined.' });
    }

    // Check if the title field exists
    if (!presentationData.title) {
      console.log(`Title field is missing or empty`); // DEBUG
      return res.status(400).json({ error: 'The presentation does not have a title defined.' });
    }

    // Return the area and title fields
    console.log(`Returning area: "${presentationData.area}", title: "${presentationData.title}"`); // DEBUG
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
    const { formId, presentationId, reviewerId, answers } = req.body;

    if (!formId || !presentationId || !reviewerId || !answers) {
      return res.status(400).json({ error: 'Form ID, Presentation ID, Reviewer ID, and answers are required' });
    }

    // Validate the structure of each answer
    const formattedAnswers = answers.map((answer) => {
      if (!answer.question || !answer.type || !answer.answer) {
        throw new Error('Invalid answer structure');
      }

      if (answer.type === 'text') {
        return {
          question: answer.question,
          type: answer.type,
          answer: answer.answer,
        };
      }

      if (answer.type === 'multiple' && !Array.isArray(answer.answer)) {
        throw new Error('Answer for multiple questions must be an array');
      }

      // Handle the final score question with required changes
      if (answer.question === '¿Cómo califica esta ponencia?' && answer.answer === 'Aceptada con cambios requeridos') {
        return {
          question: answer.question,
          type: answer.type,
          options: answer.options || {},
          answer: answer.answer,
          requiredChanges: answer.requiredChanges || '', // Include required changes if provided
        };
      }

      return {
        question: answer.question,
        type: answer.type,
        options: answer.options || {},
        answer: answer.answer,
      };
    });

    // Prepare the document structure
    const filledForm = {
      creationDate: admin.firestore.FieldValue.serverTimestamp(),
      formId,
      presentationId,
      reviewerId, // Save the reviewer ID
      answers: formattedAnswers,
    };

    // Save the filled form in the "filled-forms" collection
    const filledFormRef = await db.collection('filled-forms').add(filledForm);

    // Extract the final score from the answers
    const finalScoreAnswer = answers.find(
      (answer) => answer.question === '¿Cómo califica esta ponencia?'
    );
    const reviewerState = finalScoreAnswer ? finalScoreAnswer.answer : null;

    // Update the "reviewed" field, "state", and "filled-form-id" in the "reviewersAssigned" array of the presentation
    const presentationRef = db.collection('presentations').doc(presentationId);
    const presentationDoc = await presentationRef.get();

    if (!presentationDoc.exists) {
      return res.status(404).json({ error: 'Presentation not found' });
    }

    const presentationData = presentationDoc.data();
    const reviewersAssigned = presentationData.reviewersAssigned || [];

    const updatedReviewersAssigned = reviewersAssigned.map((reviewer) => {
      if (reviewer.reviewerId === reviewerId) {
        return { ...reviewer, reviewed: true, state: reviewerState, "filled-form-id": filledFormRef.id }; // Update "reviewed", "state", and "filled-form-id"
      }
      return reviewer;
    });

    // Update the presentation document
    await presentationRef.update({ reviewersAssigned: updatedReviewersAssigned });

    // Check if all reviewers have reviewed the presentation
    const allReviewed = updatedReviewersAssigned.every((reviewer) => reviewer.reviewed === true);

    if (allReviewed) {
      // Check for ties and send tie-breaker email if needed
      let acceptanceCount = 0;
      let rejectionCount = 0;

      updatedReviewersAssigned.forEach((reviewer) => {
        const state = reviewer.state;
        if (state === 'Aceptada' || state === 'Aceptada con cambios requeridos') {
          acceptanceCount++;
        } else if (state === 'No aceptada') {
          rejectionCount++;
        }
      });

      console.log(`Review results - Acceptance: ${acceptanceCount}, Rejection: ${rejectionCount}`);

      // Only send tie-breaker email if there's actually a tie
      if (acceptanceCount === rejectionCount) {
        // Send tie-breaker email to conference manager
        const conferenceId = presentationData['conference-id'];
        if (!conferenceId) {
          return res.status(404).json({ error: 'Conference ID not found in presentation' });
        }
      
        const conferenceRef = db.collection('conferences').doc(conferenceId);
        const conferenceDoc = await conferenceRef.get();
      
        if (!conferenceDoc.exists) {
          return res.status(404).json({ error: 'Conference not found' });
        }
      
        const conferenceData = conferenceDoc.data();
        const conferenceTitle = conferenceData.title;
        const managerId = conferenceData.managerId;
      
        const managerRef = db.collection('users').doc(managerId);
        const managerDoc = await managerRef.get();
      
        if (!managerDoc.exists) {
          return res.status(404).json({ error: 'Conference manager not found' });
        }
      
        const managerEmail = managerDoc.get('email');
        const managerName = managerDoc.get('name') || 'Estimado/a administrador/a de conferencia';
      
        // Use the same pattern as your working endpoint
        const mailOptions = {
          from: process.env.EMAIL_FROM,
          to: managerEmail,
          subject: 'Empate en los resultados de la revisión',
          html: `
          <!DOCTYPE html>
          <html>
          <head>
              <meta charset="UTF-8">
              <style>
                  body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                  .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                  .header { background-color: #007bff; color: white; padding: 20px; text-align: center; border-radius: 5px 5px 0 0; }
                  .content { background-color: #f9f9f9; padding: 30px; border-radius: 0 0 5px 5px; }
                  .highlight { background-color: #fff3cd; padding: 15px; border-left: 4px solid #ffc107; margin: 20px 0; }
                  .footer { text-align: center; margin-top: 20px; font-size: 14px; color: #666; }
              </style>
          </head>
          <body>
              <div class="container">
                  <div class="header">
                      <h2>🔄 Empate en Revisión de Ponencia</h2>
                  </div>
                  
                  <div class="content">
                      <p><strong>${managerName},</strong></p>
                      
                      <p>Le informamos que ha ocurrido un empate en los resultados de revisión de una ponencia:</p>
                      
                      <div class="highlight">
                          <p><strong>📄 Ponencia:</strong> "${presentationData.title}"</p>
                          <p><strong>🎯 Conferencia:</strong> "${conferenceTitle}"</p>
                          <p><strong>👥 Revisores:</strong> ${updatedReviewersAssigned.length} revisores asignados</p>
                          <p><strong>⚖️ Resultado:</strong> ${acceptanceCount} aceptación(es) vs ${rejectionCount} rechazo(s)</p>
                      </div>
                      
                      <p><strong>¿Qué necesita hacer?</strong></p>
                      <p>Para resolver este empate, es necesario que ingrese a la plataforma y asigne un revisor adicional que pueda desempatar el resultado.</p>
                      
                      <p>Este proceso garantiza una evaluación justa y equitativa de todas las ponencias presentadas.</p>
                      
                      <div style="text-align: center;">
                          <p><em>Gracias por su atención y gestión oportuna.</em></p>
                      </div>
                  </div>
                  
                  <div class="footer">
                      <p>📧 Este es un mensaje automático del sistema de gestión de conferencias</p>
                      <p><strong>Equipo ProSTEM</strong></p>
                  </div>
              </div>
          </body>
          </html>
          `
        };
      
        // Use transporter.sendMail instead of sendEmail function
        await transporter.sendMail(mailOptions);
        console.log(`Tie-breaker email sent successfully to ${managerEmail}`);
      }
    }

    // Update the "reviewed" field, "state", and "filled-form-id" in the "presentationsAssigned" array of the user
    const userRef = db.collection('users').doc(reviewerId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: 'Reviewer not found' });
    }

    const userData = userDoc.data();
    const presentationsAssigned = userData.presentationsAssigned || [];

    const updatedPresentationsAssigned = presentationsAssigned.map((assignment) => {
      if (assignment.presentationId === presentationId) {
        return { ...assignment, reviewed: true, state: reviewerState, "filled-form-id": filledFormRef.id }; // Update "reviewed", "state", and "filled-form-id"
      }
      return assignment;
    });

    // Update the user document
    await userRef.update({ presentationsAssigned: updatedPresentationsAssigned });

    res.status(201).json({ message: 'Form saved successfully, reviewer updated, and user updated', id: filledFormRef.id });
  } catch (error) {
    console.error('Error saving filled form:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Endpoint to create a new reviewer (user with reviewer: true)
app.post('/api/create-reviewer', async (req, res) => {
  console.log('Create reviewer endpoint called');
  console.log('Request body:', req.body);

  const {
    email,
    name,
    lastName1,
    lastName2,
    phone,
    birthDate,
    institution,
    teachingLevel,
    specializations,
    orcidDoi
  } = req.body;

  // Validate required fields
  if (!email || !name || !lastName1 || !lastName2 || !phone || !birthDate || !institution || !teachingLevel) {
    console.log('Missing required fields');
    return res.status(400).json({ error: 'Faltan campos requeridos' });
  }

  try {
    console.log('Checking for existing user with email:', email);
    
    // Check if user with this email already exists
    const existingUserQuery = await db.collection('users').where('email', '==', email).get();
    
    if (!existingUserQuery.empty) {
      console.log('User with this email already exists');
      return res.status(400).json({ error: 'Ya existe un usuario con este correo electrónico' });
    }

    console.log('Generating temporary password');
    // Generate random temporary password (16 characters)
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let tempPassword = '';
    for (let i = 0; i < 16; i++) {
      tempPassword += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    
    console.log('Creating Firebase Auth user');
    // Create user in Firebase Authentication
    const userRecord = await admin.auth().createUser({
      email,
      password: tempPassword,
      displayName: `${name} ${lastName1}`,
    });

    console.log('Firebase Auth user created with UID:', userRecord.uid);

    // Parse specializations if provided
    const parsedSpecializations = Array.isArray(specializations) ? specializations : (specializations ? [specializations] : []);

    console.log('Creating Firestore document');
    // Create user document in Firestore with reviewer: true
    const userData = {
      email,
      name,
      lastName1,
      lastName2,
      phone,
      birthDate,
      institution,
      teachingLevel,
      specializations: parsedSpecializations,
      areas: parsedSpecializations, // Also set areas field for compatibility
      orcidDoi: orcidDoi || '',
      reviewer: true, // Set as reviewer
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      active: true,
      myEvents: null,
      role: "user",
      photoURL: null,
      presentationsAssigned: []
    };

    await db.collection('users').doc(userRecord.uid).set(userData);

    console.log('User document created successfully');

    // Send email to the new reviewer
    console.log('Sending email to new reviewer:', email);
    const mailOptions = {
      from: 'prostemcr@gmail.com',
      to: email,
      subject: 'Bienvenido a ProSTEM - Tu cuenta de revisor ha sido creada',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 10px;">
          <div style="text-align: center; margin-bottom: 20px;">
            <h1 style="color: #007bff; margin: 0;">ProSTEM</h1>
            <p style="color: #666; margin: 5px 0;">Plataforma de Gestión de Eventos Académicos</p>
          </div>
          
          <div style="background-color: #f8f9fa; padding: 20px; border-radius: 5px; margin-bottom: 20px;">
            <h2 style="color: #333; margin-top: 0;">¡Bienvenido/a como revisor!</h2>
            <p style="color: #555; line-height: 1.6;">
              Estimado/a <strong>${name} ${lastName1} ${lastName2}</strong>,
            </p>
            <p style="color: #555; line-height: 1.6;">
              Se ha creado una cuenta para usted en la plataforma ProSTEM y ha sido designado/a como <strong>revisor</strong>. 
              Su participación es muy valiosa para el proceso de revisión de ponencias académicas.
            </p>
          </div>

          <div style="background-color: #e8f4fd; padding: 20px; border-radius: 5px; margin-bottom: 20px;">
            <h3 style="color: #007bff; margin-top: 0;">Credenciales de acceso temporal:</h3>
            <p style="margin: 10px 0;"><strong>Correo electrónico:</strong> ${email}</p>
            <p style="margin: 10px 0;"><strong>Contraseña temporal:</strong> <code style="background-color: #fff; padding: 5px 8px; border-radius: 3px; font-family: monospace; color: #d63384;">${tempPassword}</code></p>
            <p style="color: #856404; font-size: 14px; margin-top: 15px;">
              <strong>⚠️ Importante:</strong> Por favor, cambie esta contraseña temporal inmediatamente después de iniciar sesión por primera vez.
            </p>
          </div>

          <div style="background-color: #fff3cd; padding: 20px; border-radius: 5px; margin-bottom: 20px;">
            <h3 style="color: #856404; margin-top: 0;">Próximos pasos:</h3>
            <ol style="color: #555; line-height: 1.8;">
              <li>Ingrese a la plataforma ProSTEM con las credenciales proporcionadas</li>
              <li>Cambie su contraseña temporal por una segura</li>
              <li>Complete y actualice su información personal en el perfil</li>
              <li>Revise las ponencias asignadas para evaluación</li>
            </ol>
          </div>

          <div style="text-align: center; margin: 30px 0;">
            <a href="https://prostem-frontend.vercel.app/auth/login" 
               style="display: inline-block; padding: 12px 30px; background-color: #007bff; color: white; text-decoration: none; border-radius: 5px; font-weight: bold;">
              Acceder a ProSTEM
            </a>
          </div>

          <div style="border-top: 1px solid #ddd; padding-top: 20px; margin-top: 30px;">
            <p style="color: #888; font-size: 12px; text-align: center; margin: 0;">
              Este correo fue enviado automáticamente por la plataforma ProSTEM. 
              Si tiene alguna duda, contacte al administrador de la plataforma.
            </p>
          </div>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);
    console.log('Email sent successfully to new reviewer');

    res.status(201).json({ 
      message: 'Revisor creado exitosamente',
      uid: userRecord.uid,
      tempPassword: tempPassword // Return temp password for admin to share with user
    });

  } catch (error) {
    console.error('Detailed error creating reviewer:', error);
    
    // More specific error handling
    if (error.code === 'auth/email-already-exists') {
      return res.status(400).json({ error: 'Ya existe un usuario con este correo electrónico' });
    } else if (error.code === 'auth/invalid-email') {
      return res.status(400).json({ error: 'Correo electrónico inválido' });
    } else if (error.code === 'auth/weak-password') {
      return res.status(400).json({ error: 'Contraseña muy débil' });
    }
    
    res.status(500).json({ 
      error: 'Error interno del servidor',
      details: error.message // Include error details for debugging
    });
  }
});
//################################################################################################




// Endpoint para crear una presentación con documentos
app.post('/api/presentations', fileUpload.fields([
  { name: 'generalDocument', maxCount: 1 }
]), async (req, res) => {
  try {
    const { userId, conferenceId, title, summary, area, authors, ...otherFields } = req.body;

    if (!userId || !conferenceId || !title || !summary || !area) {
      return res.status(400).json({ error: 'userId, conferenceId, title, description, and area are required' });
    }

    // Parse authors from JSON string to array of objects
    let parsedAuthors = [];
    if (authors) {
      try {
        parsedAuthors = JSON.parse(authors);
      } catch (error) {
        console.error('Error parsing authors JSON:', error);
        return res.status(400).json({ error: 'Invalid authors format' });
      }
    }

    // Paso 1: Obtener la conferencia y su creationId
    const conferenceRef = db.collection('conferences').doc(conferenceId);
    const conferenceDoc = await conferenceRef.get();

    if (!conferenceDoc.exists) {
      return res.status(404).json({ error: 'Conference not found' });
    }

    const conferenceData = conferenceDoc.data();
    const conferenceCreationId = conferenceData.creationId; // Get conference creationId
    const presentations = conferenceData.presentations || [];
    let highestCreationId = 0;

    // Iterar sobre las presentaciones para encontrar el highest creationId
    for (const presentationId of presentations) {
      const presentationDoc = await db.collection('presentations').doc(presentationId).get();
      if (presentationDoc.exists) {
        const creationId = presentationDoc.get('creationId') || 0;
        if (creationId > highestCreationId) {
          highestCreationId = creationId;
        }
      }
    }

    // Incrementar el highest creationId en 1
    const newCreationId = highestCreationId + 1;

    // Generate formatted presentation code (C001-P001, C001-P002, etc.)
    const presentationCode = `${conferenceCreationId}-P${newCreationId.toString().padStart(3, '0')}`;

    // Paso 2: Crear la ponencia sin los documentos
    const presentationRef = db.collection('presentations').doc();
    const presentationId = presentationRef.id;

    const currentDate = new Date().toISOString();

    const presentationData = {
      'creator-id': userId,
      'conference-id': conferenceId,
      title,
      summary,
      area, 
      authors: parsedAuthors, // Store as proper array of objects
      creationId: presentationCode, // Store formatted code (C001-P001, etc.)
      paid: false, 
      reviewed: false, 
      createdAt: currentDate, 
      lastModified: currentDate,
      overallResult: "Pendiente a revisión",
      ...otherFields, 
    };

    await presentationRef.set(presentationData);

    // Paso 3: Verificar si existe la carpeta de la conferencia
    const conferenceFolderPath = path.join(__dirname, 'uploads', 'conferences', conferenceCreationId);
    if (!fs.existsSync(conferenceFolderPath)) {
      return res.status(400).json({ error: `The folder for conference ${conferenceCreationId} does not exist.` });
    }

    // Crear una subcarpeta con el presentationCode dentro de la carpeta de la conferencia
    const presentationFolderPath = path.join(conferenceFolderPath, presentationCode);
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

    // Renombrar y mover el archivo al directorio de uploads/conferences/conferenceCreationId/presentationCode
    fs.renameSync(
      path.join(__dirname, 'uploads', generalDocument.filename),
      generalDocumentPath
    );

    // Guardar la ruta relativa en la base de datos
    await presentationRef.update({
      generalDocumentPath: `/uploads/conferences/${conferenceCreationId}/${presentationCode}/general-${generalDocument.originalname}`
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
      creationId: presentationCode,
      paid: false,
      reviewed: false,
      lastModified: currentDate,
      generalDocumentPath: `/uploads/conferences/${conferenceCreationId}/${presentationCode}/general-${generalDocument.originalname}`,
      authors: parsedAuthors // Return the parsed authors for confirmation
    });
  } catch (error) {
    console.error('Error creating presentation:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Endpoint to upload a corrected version of the document
app.post('/api/presentations/:conferenceCreationId/:presentationCreationId/upload-corrected', fileUpload.fields([
  { name: 'correctedDocument', maxCount: 1 }
]), async (req, res) => {
  try {
    const { conferenceCreationId, presentationCreationId } = req.params;
    const { presentationId } = req.body; // Firestore document id of the presentation (not creationId)

    // ADD MORE DEBUG LOGS
    console.log('=== BACKEND DEBUG UPLOAD CORRECTED ===');
    console.log('conferenceCreationId:', conferenceCreationId);
    console.log('presentationCreationId:', presentationCreationId);
    console.log('presentationId (from body):', presentationId);
    console.log('Files received:', req.files);

    if (!presentationId) {
      return res.status(400).json({ error: 'presentationId is required in form-data' });
    }

    // Validate the request
    const files = req.files['correctedDocument'];
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'The correctedDocument is required' });
    }
    const correctedDocument = files[0];

    // Fetch the presentation document by its Firestore document ID
    const presentationRef = db.collection('presentations').doc(presentationId);
    const presentationDoc = await presentationRef.get();

    if (!presentationDoc.exists) {
      return res.status(404).json({ error: 'Presentation not found' });
    }

    const presentationData = presentationDoc.data();
    const conferenceDocumentId = presentationData['conference-id']; // Get the conference document ID

    // Get presentation title
    const presentationTitle = presentationData.title || 'Sin título';

    // Fetch conference data using the document ID from presentation
    const conferenceRef = db.collection('conferences').doc(conferenceDocumentId);
    const conferenceDoc = await conferenceRef.get();
    
    if (!conferenceDoc.exists) {
      return res.status(404).json({ error: 'Conference not found' });
    }
    
    const conferenceData = conferenceDoc.data();
    const conferenceTitle = conferenceData.title || 'Sin título';
    const managerId = conferenceData.userId; // Get the manager ID from userId field

    if (!managerId) {
      return res.status(400).json({ error: 'Conference manager ID not found' });
    }

    // Define the folder path using the NEW structure: uploads/conferences/conferenceCreationId/presentationCreationId
    const presentationFolderPath = path.join(__dirname, 'uploads', 'conferences', conferenceCreationId, presentationCreationId);
    if (!fs.existsSync(presentationFolderPath)) {
      return res.status(400).json({ error: `The folder for presentation ${presentationCreationId} does not exist.` });
    }

    // Remove existing "general-*" file if present
    try {
      const folderFiles = fs.readdirSync(presentationFolderPath);
      const existingGeneral = folderFiles.find(f => f.toLowerCase().startsWith('general-'));
      if (existingGeneral) {
        fs.unlinkSync(path.join(presentationFolderPath, existingGeneral));
      }
    } catch (cleanErr) {
      console.warn(`Could not clean previous general file for ${conferenceCreationId}/${presentationCreationId}:`, cleanErr);
    }

    // Save the new file as "general-{originalname}"
    const generalFileName = `general-${correctedDocument.originalname}`;
    const destinationPath = path.join(presentationFolderPath, generalFileName);

    fs.renameSync(
      path.join(__dirname, 'uploads', correctedDocument.filename),
      destinationPath
    );

    // Update Firestore: point to the new general file and mark corrected sent
    await presentationDoc.ref.update({
      generalDocumentPath: `/uploads/conferences/${conferenceCreationId}/${presentationCreationId}/${generalFileName}`,
      correctedDocumentSent: true,
      lastModified: new Date().toISOString()
    });

    // Fetch manager's email from users collection
    const managerRef = db.collection('users').doc(managerId);
    const managerDoc = await managerRef.get();

    if (!managerDoc.exists) {
      return res.status(404).json({ error: 'Conference manager not found' });
    }

    const managerData = managerDoc.data();
    const managerEmail = managerData.email;
    const managerName = managerData.name || 'Administrador';

    if (!managerEmail) {
      return res.status(400).json({ error: 'Manager email not found' });
    }

    // Send email notification to conference manager (keeping same email logic)
    try {
      const mailOptions = {
        from: process.env.EMAIL_USER,
        to: managerEmail,
        subject: `Versión corregida subida - ${presentationTitle}`,
        html: `
          <!DOCTYPE html>
          <html>
          <head>
            <style>
              body {
                font-family: Arial, sans-serif;
                line-height: 1.6;
                color: #333;
                max-width: 600px;
                margin: 0 auto;
                padding: 20px;
              }
              .header {
                background-color: #f4f4f4;
                padding: 20px;
                text-align: center;
                border-radius: 10px;
                margin-bottom: 20px;
              }
              .content {
                padding: 20px;
                background-color: #fff;
                border-radius: 10px;
                border: 1px solid #ddd;
              }
              .highlight {
                background-color: #e7f3ff;
                padding: 15px;
                border-radius: 5px;
                margin: 15px 0;
              }
              .footer {
                text-align: center;
                margin-top: 20px;
                font-size: 12px;
                color: #666;
              }
            </style>
          </head>
          <body>
            <div class="header">
              <h2>📄 Nueva Versión Corregida Subida</h2>
            </div>
            
            <div class="content">
              <p>Estimado/a <strong>${managerName}</strong>,</p>
              
              <p>Le informamos que se ha subido una nueva versión corregida del documento para la siguiente presentación:</p>
              
              <div class="highlight">
                <p><strong>📋 Presentación:</strong> ${presentationTitle}</p>
                <p><strong>🏛️ Conferencia:</strong> ${conferenceTitle}</p>
              </div>
              
              <p>El ponente ha realizado las correcciones solicitadas y ha enviado una nueva versión del documento.</p>
              
              <p>Puede acceder a la plataforma ProSTEM para revisar la nueva versión del documento y gestionar el proceso de revisión correspondiente.</p>
              
              <p>Saludos cordiales,<br>
              <strong>Equipo ProSTEM</strong></p>
            </div>
            
            <div class="footer">
              <p>Este es un mensaje automático. Por favor, no responda a este correo.</p>
            </div>
          </body>
          </html>
        `
      };

      await transporter.sendMail(mailOptions);
      console.log(`Email sent successfully to conference manager: ${managerEmail}`);
    } catch (emailError) {
      console.error(`Failed to send email to manager ${managerEmail}:`, emailError);
      return res.status(500).json({ error: 'Failed to send notification email' });
    }

    res.status(200).json({
      message: 'Corrected document uploaded and conference manager notified successfully',
      generalDocumentPath: `/uploads/conferences/${conferenceCreationId}/${presentationCreationId}/${generalFileName}`,
      presentationIdReceived: presentationId,
      managerNotified: true
    });
  } catch (error) {
    console.error('Error uploading corrected document:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});




// Endpoint to upload a presentation file
app.post('/api/presentations/:conferenceCreationId/:presentationCreationId/upload-presentation', fileUpload.fields([
  { name: 'presentationDocument', maxCount: 1 }
]), async (req, res) => {
  try {
    const { conferenceCreationId, presentationCreationId } = req.params;
    const { presentationId } = req.body; // Firestore document id of the presentation (not creationId)

    console.log('=== BACKEND UPLOAD PRESENTATION DEBUG ===');
    console.log('conferenceCreationId:', conferenceCreationId);
    console.log('presentationCreationId:', presentationCreationId);
    console.log('presentationId (from body):', presentationId);

    if (!presentationId) {
      return res.status(400).json({ error: 'presentationId is required in form-data' });
    }

    // Validate the request
    const files = req.files['presentationDocument'];
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'The presentationDocument is required' });
    }
    const presentationDocument = files[0];

    // Fetch the presentation document by its Firestore document ID
    const presentationRef = db.collection('presentations').doc(presentationId);
    const presentationDoc = await presentationRef.get();

    if (!presentationDoc.exists) {
      return res.status(404).json({ error: 'Presentation not found' });
    }

    const presentationData = presentationDoc.data();

    // Define the folder path using the NEW structure: uploads/conferences/conferenceCreationId/presentationCreationId
    const presentationFolderPath = path.join(__dirname, 'uploads', 'conferences', conferenceCreationId, presentationCreationId);
    if (!fs.existsSync(presentationFolderPath)) {
      return res.status(400).json({ error: `The folder for presentation ${presentationCreationId} does not exist.` });
    }

    // Remove existing "presentation-*" file if present
    try {
      const folderFiles = fs.readdirSync(presentationFolderPath);
      const existingPresentation = folderFiles.find(f => f.toLowerCase().startsWith('presentation-'));
      if (existingPresentation) {
        fs.unlinkSync(path.join(presentationFolderPath, existingPresentation));
        console.log(`Removed existing presentation file: ${existingPresentation}`);
      }
    } catch (cleanErr) {
      console.warn(`Could not clean previous presentation file for ${conferenceCreationId}/${presentationCreationId}:`, cleanErr);
    }

    // Save the new file as "presentation-{originalname}"
    const presentationFileName = `presentation-${presentationDocument.originalname}`;
    const destinationPath = path.join(presentationFolderPath, presentationFileName);

    fs.renameSync(
      path.join(__dirname, 'uploads', presentationDocument.filename),
      destinationPath
    );

    // Update Firestore: add the presentation file path
    await presentationDoc.ref.update({
      presentationDocumentPath: `/uploads/conferences/${conferenceCreationId}/${presentationCreationId}/${presentationFileName}`,
      presentationDocumentSent: true,
      lastModified: new Date().toISOString()
    });

    res.status(200).json({
      message: 'Presentation document uploaded successfully',
      presentationDocumentPath: `/uploads/conferences/${conferenceCreationId}/${presentationCreationId}/${presentationFileName}`,
      presentationIdReceived: presentationId
    });
  } catch (error) {
    console.error('Error uploading presentation document:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Endpoint to update presentation overall result
app.patch('/api/presentations/:presentationId/overall-result', async (req, res) => {
  try {
    const { presentationId } = req.params;
    const { overallResult } = req.body;

    if (!presentationId) {
      return res.status(400).json({ error: 'Presentation ID is required' });
    }

    if (!overallResult) {
      return res.status(400).json({ error: 'Overall result is required' });
    }

    // Validate that the result is one of the allowed values
    const allowedResults = ['Aceptada', 'No aceptada'];
    if (!allowedResults.includes(overallResult)) {
      return res.status(400).json({ error: 'Invalid overall result value' });
    }

    // Find and update the presentation
    const presentationRef = db.collection('presentations').doc(presentationId);
    const presentationDoc = await presentationRef.get();

    if (!presentationDoc.exists) {
      return res.status(404).json({ error: 'Presentation not found' });
    }

    // Convert result to boolean value for managerDocApproval
    const managerDocApproval = overallResult === 'Aceptada';

    // Update the managerDocApproval field (NOT overallResult)
    await presentationRef.update({ 
      managerDocApproval: managerDocApproval,
      lastModified: new Date().toISOString()
    });

    res.status(200).json({ 
      message: 'Manager document approval updated successfully',
      managerDocApproval: managerDocApproval
    });
  } catch (error) {
    console.error('Error updating manager document approval:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Endpoint to upload final document with authors
app.post('/api/presentations/:conferenceCreationId/:presentationCreationId/upload-final', fileUpload.fields([
  { name: 'finalDocument', maxCount: 1 }
]), async (req, res) => {
  try {
    const { conferenceCreationId, presentationCreationId } = req.params;
    const { presentationId } = req.body; // Firestore document id of the presentation (not creationId)

    console.log('=== BACKEND UPLOAD FINAL DEBUG ===');
    console.log('conferenceCreationId:', conferenceCreationId);
    console.log('presentationCreationId:', presentationCreationId);
    console.log('presentationId (from body):', presentationId);

    if (!presentationId) {
      return res.status(400).json({ error: 'presentationId is required in form-data' });
    }

    // Validate the request
    const files = req.files['finalDocument'];
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'The finalDocument is required' });
    }
    const finalDocument = files[0];

    // Fetch the presentation document by its Firestore document ID
    const presentationRef = db.collection('presentations').doc(presentationId);
    const presentationDoc = await presentationRef.get();

    if (!presentationDoc.exists) {
      return res.status(404).json({ error: 'Presentation not found' });
    }

    const presentationData = presentationDoc.data();

    // Define the folder path using the NEW structure: uploads/conferences/conferenceCreationId/presentationCreationId
    const finalFolderPath = path.join(__dirname, 'uploads', 'conferences', conferenceCreationId, presentationCreationId);
    if (!fs.existsSync(finalFolderPath)) {
      return res.status(400).json({ error: `The folder for presentation ${presentationCreationId} does not exist.` });
    }

    // Remove existing "final-*" file if present
    try {
      const folderFiles = fs.readdirSync(finalFolderPath);
      const existingFinal = folderFiles.find(f => f.toLowerCase().startsWith('final-'));
      if (existingFinal) {
        fs.unlinkSync(path.join(finalFolderPath, existingFinal));
        console.log(`Removed existing final document file: ${existingFinal}`);
      }
    } catch (cleanErr) {
      console.warn(`Could not clean previous final document file for ${conferenceCreationId}/${presentationCreationId}:`, cleanErr);
    }

    // Save the new file as "final-{originalname}"
    const finalFileName = `final-${finalDocument.originalname}`;
    const destinationPath = path.join(finalFolderPath, finalFileName);

    fs.renameSync(
      path.join(__dirname, 'uploads', finalDocument.filename),
      destinationPath
    );

    // Update Firestore: add the final document file path and set finalVersionUploaded to true
    await presentationDoc.ref.update({
      finalDocumentPath: `/uploads/conferences/${conferenceCreationId}/${presentationCreationId}/${finalFileName}`,
      finalVersionUploaded: true,
      lastModified: new Date().toISOString()
    });

    res.status(200).json({
      message: 'Final document uploaded successfully',
      finalDocumentPath: `/uploads/conferences/${conferenceCreationId}/${presentationCreationId}/${finalFileName}`,
      finalVersionUploaded: true,
      presentationIdReceived: presentationId
    });
  } catch (error) {
    console.error('Error uploading final document:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// Endpoint to upload a payment receipt file
app.post('/api/presentations/:conferenceCreationId/:presentationCreationId/upload-payment', paymentUpload.fields([
  { name: 'paymentDocument', maxCount: 1 }
]), async (req, res) => {
  try {
    const { conferenceCreationId, presentationCreationId } = req.params;
    const { presentationId } = req.body; // Firestore document id of the presentation (not creationId)

    console.log('=== BACKEND UPLOAD PAYMENT DEBUG ===');
    console.log('conferenceCreationId:', conferenceCreationId);
    console.log('presentationCreationId:', presentationCreationId);
    console.log('presentationId (from body):', presentationId);

    if (!presentationId) {
      return res.status(400).json({ error: 'presentationId is required in form-data' });
    }

    // Validate the request
    const files = req.files['paymentDocument'];
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'The paymentDocument is required' });
    }
    const paymentDocument = files[0];

    // Validate file type (only jpg, jpeg, png, pdf)
    const allowedExtensions = ['.jpg', '.jpeg', '.png', '.pdf'];
    const ext = path.extname(paymentDocument.originalname).toLowerCase();
    if (!allowedExtensions.includes(ext)) {
      return res.status(400).json({ error: 'Only JPG, JPEG, PNG, and PDF files are allowed for payment receipts' });
    }

    // Fetch the presentation document by its Firestore document ID
    const presentationRef = db.collection('presentations').doc(presentationId);
    const presentationDoc = await presentationRef.get();

    if (!presentationDoc.exists) {
      return res.status(404).json({ error: 'Presentation not found' });
    }

    const presentationData = presentationDoc.data();

    // Define the folder path using the NEW structure: uploads/conferences/conferenceCreationId/presentationCreationId
    const presentationFolderPath = path.join(__dirname, 'uploads', 'conferences', conferenceCreationId, presentationCreationId);
    if (!fs.existsSync(presentationFolderPath)) {
      return res.status(400).json({ error: `The folder for presentation ${presentationCreationId} does not exist.` });
    }

    // Remove existing "payment-*" file if present
    try {
      const folderFiles = fs.readdirSync(presentationFolderPath);
      const existingPayment = folderFiles.find(f => f.toLowerCase().startsWith('payment-'));
      if (existingPayment) {
        fs.unlinkSync(path.join(presentationFolderPath, existingPayment));
        console.log(`Removed existing payment receipt file: ${existingPayment}`);
      }
    } catch (cleanErr) {
      console.warn(`Could not clean previous payment receipt file for ${conferenceCreationId}/${presentationCreationId}:`, cleanErr);
    }

    // Save the new file as "payment-{originalname}"
    const paymentFileName = `payment-${paymentDocument.originalname}`;
    const destinationPath = path.join(presentationFolderPath, paymentFileName);

    fs.renameSync(
      path.join(__dirname, 'uploads', paymentDocument.filename),
      destinationPath
    );

    // Update Firestore: add the payment receipt file path
    await presentationDoc.ref.update({
      paymentReceiptPath: `/uploads/conferences/${conferenceCreationId}/${presentationCreationId}/${paymentFileName}`,
      paymentReceiptSent: true,
      lastModified: new Date().toISOString()
    });

    res.status(200).json({
      message: 'Payment receipt uploaded successfully',
      paymentReceiptPath: `/uploads/conferences/${conferenceCreationId}/${presentationCreationId}/${paymentFileName}`,
      presentationIdReceived: presentationId
    });
  } catch (error) {
    console.error('Error uploading payment receipt:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Endpoint to view a document by conferenceCreationId and presentationCreationId
app.get('/api/presentations/:conferenceCreationId/:presentationCreationId/view', async (req, res) => {
  try {
    const { conferenceCreationId, presentationCreationId } = req.params;

    // Construct the file path using the new structure: uploads/conferences/conferenceCreationId/presentationCreationId
    const documentFolderPath = path.join(__dirname, 'uploads', 'conferences', conferenceCreationId, presentationCreationId);
    
    // Check if the folder exists
    if (!fs.existsSync(documentFolderPath)) {
      return res.status(404).json({ error: 'Document folder not found' });
    }

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


// Endpoint to view a presentation document by conferenceCreationId and presentationCreationId
app.get('/api/presentations/:conferenceCreationId/:presentationCreationId/view-presentation', async (req, res) => {
  try {
    const { conferenceCreationId, presentationCreationId } = req.params;

    console.log('=== BACKEND VIEW PRESENTATION DEBUG ===');
    console.log('conferenceCreationId:', conferenceCreationId);
    console.log('presentationCreationId:', presentationCreationId);

    // Construct the file path using the new structure
    const documentFolderPath = path.join(__dirname, 'uploads', 'conferences', conferenceCreationId, presentationCreationId);
    
    console.log('Looking for folder at:', documentFolderPath);
    
    if (!fs.existsSync(documentFolderPath)) {
      return res.status(404).json({ error: 'Document folder not found' });
    }

    const files = fs.readdirSync(documentFolderPath);
    console.log('Files in folder:', files);

    // Find the presentation document in the folder
    const presentationDocument = files.find(file => file.startsWith('presentation-'));
    if (!presentationDocument) {
      return res.status(404).json({ error: 'Presentation document not found' });
    }

    const filePath = path.join(documentFolderPath, presentationDocument);
    console.log('Final file path:', filePath);

    // Determine content type based on file extension
    const ext = path.extname(filePath).toLowerCase();
    let contentType = 'application/octet-stream';
    
    if (ext === '.pdf') {
      contentType = 'application/pdf';
    } else if (['.doc', '.docx'].includes(ext)) {
      contentType = 'application/msword';
    } else if (['.ppt', '.pptx'].includes(ext)) {
      contentType = 'application/vnd.ms-powerpoint';
    }

    // Set appropriate headers and send the file
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', 'inline');
    res.sendFile(filePath);
  } catch (error) {
    console.error('Error viewing presentation document:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Endpoint to download a presentation document by conferenceCreationId and presentationCreationId
app.get('/api/presentations/:conferenceCreationId/:presentationCreationId/download-presentation', async (req, res) => {
  try {
    const { conferenceCreationId, presentationCreationId } = req.params;

    console.log('=== BACKEND DOWNLOAD PRESENTATION DEBUG ===');
    console.log('conferenceCreationId:', conferenceCreationId);
    console.log('presentationCreationId:', presentationCreationId);

    // Construct the file path using the new structure
    const documentFolderPath = path.join(__dirname, 'uploads', 'conferences', conferenceCreationId, presentationCreationId);
    
    if (!fs.existsSync(documentFolderPath)) {
      return res.status(404).json({ error: 'Document folder not found' });
    }

    const files = fs.readdirSync(documentFolderPath);

    // Find the presentation document in the folder
    const presentationDocument = files.find(file => file.startsWith('presentation-'));
    if (!presentationDocument) {
      return res.status(404).json({ error: 'Presentation document not found' });
    }

    const filePath = path.join(documentFolderPath, presentationDocument);

    // Extract filename for download
    const filename = path.basename(presentationDocument);
    
    // Set headers for download
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.sendFile(filePath);
  } catch (error) {
    console.error('Error downloading presentation document:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Endpoint to view a payment receipt by conferenceCreationId and presentationCreationId
app.get('/api/presentations/:conferenceCreationId/:presentationCreationId/view-payment', async (req, res) => {
  try {
    const { conferenceCreationId, presentationCreationId } = req.params;

    console.log('=== BACKEND VIEW PAYMENT DEBUG ===');
    console.log('conferenceCreationId:', conferenceCreationId);
    console.log('presentationCreationId:', presentationCreationId);

    // Construct the file path using the new structure
    const documentFolderPath = path.join(__dirname, 'uploads', 'conferences', conferenceCreationId, presentationCreationId);
    
    console.log('Looking for folder at:', documentFolderPath);
    
    if (!fs.existsSync(documentFolderPath)) {
      return res.status(404).json({ error: 'Document folder not found' });
    }

    const files = fs.readdirSync(documentFolderPath);
    console.log('Files in folder:', files);

    // Find the payment document in the folder
    const paymentDocument = files.find(file => file.startsWith('payment-'));
    if (!paymentDocument) {
      return res.status(404).json({ error: 'Payment receipt not found' });
    }

    const filePath = path.join(documentFolderPath, paymentDocument);
    console.log('Final file path:', filePath);

    // Determine content type based on file extension
    const ext = path.extname(filePath).toLowerCase();
    let contentType = 'application/octet-stream';
    
    if (ext === '.pdf') {
      contentType = 'application/pdf';
    } else if (['.jpg', '.jpeg'].includes(ext)) {
      contentType = 'image/jpeg';
    } else if (ext === '.png') {
      contentType = 'image/png';
    }

    // Set appropriate headers and send the file
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', 'inline');
    res.sendFile(filePath);
  } catch (error) {
    console.error('Error viewing payment receipt:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Endpoint to download a payment receipt by conferenceCreationId and presentationCreationId
app.get('/api/presentations/:conferenceCreationId/:presentationCreationId/download-payment', async (req, res) => {
  try {
    const { conferenceCreationId, presentationCreationId } = req.params;

    console.log('=== BACKEND DOWNLOAD PAYMENT DEBUG ===');
    console.log('conferenceCreationId:', conferenceCreationId);
    console.log('presentationCreationId:', presentationCreationId);

    // Construct the file path using the new structure
    const documentFolderPath = path.join(__dirname, 'uploads', 'conferences', conferenceCreationId, presentationCreationId);
    
    if (!fs.existsSync(documentFolderPath)) {
      return res.status(404).json({ error: 'Document folder not found' });
    }

    const files = fs.readdirSync(documentFolderPath);

    // Find the payment document in the folder
    const paymentDocument = files.find(file => file.startsWith('payment-'));
    if (!paymentDocument) {
      return res.status(404).json({ error: 'Payment receipt not found' });
    }

    const filePath = path.join(documentFolderPath, paymentDocument);

    // Extract filename for download
    const filename = path.basename(paymentDocument);
    
    // Set headers for download
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.sendFile(filePath);
  } catch (error) {
    console.error('Error downloading payment receipt:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Endpoint to update payment status (paid field) of a presentation
app.patch('/api/presentations/:presentationId/payment-status', async (req, res) => {
  try {
    const { presentationId } = req.params;
    const { paid } = req.body;

    if (typeof paid !== 'boolean') {
      return res.status(400).json({ error: 'paid field must be a boolean value' });
    }

    // Find the presentation by ID
    const presentationRef = db.collection('presentations').doc(presentationId);
    const presentationDoc = await presentationRef.get();

    if (!presentationDoc.exists) {
      return res.status(404).json({ error: 'Presentation not found' });
    }

    // Update the paid field AND set paymentReviewed to true
    await presentationRef.update({
      paid: paid,
      paymentReviewed: true,
      lastModified: new Date().toISOString()
    });

    res.status(200).json({
      message: `Payment status updated to ${paid ? 'accepted' : 'rejected'}`,
      presentationId: presentationId,
      paid: paid,
      paymentReviewed: true
    });
  } catch (error) {
    console.error('Error updating payment status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});//##########################################3



// Improved author name extraction function
function extractAuthorNameFromFilename(filename) {
  try {
    // Remove extension and "certificado_" prefix
    let namepart = filename.replace('.pdf', '').replace(/^certificado_/i, '');
    
    // Split by underscores
    let parts = namepart.split('_');
    
    // Strategy: Take parts until we hit what looks like a presentation title
    // Presentation titles often start with capital words like "Ponencia", "Desarrollo", etc.
    const titleIndicators = ['ponencia', 'desarrollo', 'aplicacion', 'sistema', 'proyecto', 'analisis', 'estudio'];
    
    let nameParts = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i].toLowerCase();
      
      // If we find a title indicator, stop collecting name parts
      if (titleIndicators.some(indicator => part.includes(indicator))) {
        break;
      }
      
      // If we have 4+ name parts already, likely we're into the title
      if (nameParts.length >= 4) {
        break;
      }
      
      nameParts.push(parts[i]);
    }
    
    // If we got no name parts or only one, fall back to first 3 parts
    if (nameParts.length === 0) {
      nameParts = parts.slice(0, Math.min(3, parts.length));
    } else if (nameParts.length === 1) {
      nameParts = parts.slice(0, Math.min(3, parts.length));
    }
    
    return nameParts.join(' ');
    
  } catch (error) {
    console.error('Error extracting author name from filename:', error);
    return null;
  }
}

function normalizeString(str) {
  return str.toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove accents
    .replace(/\s+/g, ' ')
    .trim();
}

// New flexible matching function
function findBestAuthorMatch(extractedName, expectedAuthors) {
  console.log(`Trying to match extracted name: "${extractedName}"`);
  console.log(`Available authors: ${expectedAuthors.map(a => `"${a.name}"`).join(', ')}`);
  
  // First try exact match
  let match = expectedAuthors.find(author => 
    normalizeString(author.name) === normalizeString(extractedName)
  );
  
  if (match) {
    console.log(`Found exact match: "${match.name}"`);
    return match;
  }
  
  // Try partial matching - check if extracted name is contained in any author name
  match = expectedAuthors.find(author => {
    const normalizedAuthor = normalizeString(author.name);
    const normalizedExtracted = normalizeString(extractedName);
    return normalizedAuthor.includes(normalizedExtracted);
  });
  
  if (match) {
    console.log(`Found partial match: "${match.name}" contains "${extractedName}"`);
    return match;
  }
  
  // Try reverse partial matching - check if any author name is contained in extracted name
  match = expectedAuthors.find(author => {
    const normalizedAuthor = normalizeString(author.name);
    const normalizedExtracted = normalizeString(extractedName);
    return normalizedExtracted.includes(normalizedAuthor);
  });
  
  if (match) {
    console.log(`Found reverse partial match: "${extractedName}" contains "${match.name}"`);
    return match;
  }
  
  console.log(`No match found for: "${extractedName}"`);
  return null;
}


// Endpoint to generate and download certificates for all speakers in a conference
app.post('/api/conferences/:id/generate-bulk-certificates', async (req, res) => {
  try {
    const conferenceId = req.params.id;
    
    // Get conference data
    const conferenceRef = db.collection('conferences').doc(conferenceId);
    const conferenceDoc = await conferenceRef.get();
    
    if (!conferenceDoc.exists) {
      return res.status(404).json({ error: 'Conference not found' });
    }
    
    const conferenceData = conferenceDoc.data();
    const conferenceTitle = conferenceData.title;
    
    // Get all presentations for this conference
    const presentations = conferenceData.presentations || [];
    
    if (presentations.length === 0) {
      return res.status(400).json({ error: 'No presentations found for this conference' });
    }
    
    console.log(`Processing ${presentations.length} presentations for certificates`);
    
    // Path to certificate template
    const templatePath = path.join(__dirname, 'assets', 'Certificate_template', 'Plantilla.pdf');
    
    // Check if template exists
    try {
      await require('fs').promises.access(templatePath);
    } catch (error) {
      return res.status(404).json({ error: 'Certificate template not found at: ' + templatePath });
    }
    
    // Format the Costa Rican date
    function formatCostaRicanDate(dateString) {
      const date = new Date(dateString);
      const months = [
        'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
        'julio', 'agosto', 'setiembre', 'octubre', 'noviembre', 'diciembre'
      ];
      const day = date.getDate();
      const month = months[date.getMonth()];
      const year = date.getFullYear();
      return `${day} de ${month} de ${year}`;
    }
    
    const formattedDate = formatCostaRicanDate(new Date());
    
    // Collect all certificates data
    const certificatesData = [];
    let totalCertificates = 0;
    
    for (const presentationId of presentations) {
      console.log(`Processing presentation: ${presentationId}`);
      const presentationRef = db.collection('presentations').doc(presentationId);
      const presentationDoc = await presentationRef.get();
      
      if (!presentationDoc.exists) {
        console.error(`Presentation ${presentationId} not found`);
        continue;
      }
      
      const presentationData = presentationDoc.data();

      // Only process presentations with DefinitiveState: true
      if (presentationData.DefinitiveState !== true) {
        console.log(`Skipping presentation "${presentationData.title}" - not accepted (DefinitiveState: ${presentationData.DefinitiveState})`);
        continue;
      }

      const presentationTitle = presentationData.title;
      const authors = presentationData.authors || [];
      
      console.log(`Presentation "${presentationTitle}" has ${authors.length} authors`);
      
      // Generate certificate for each author
      for (const author of authors) {
        try {
          // Extract author name from the author object
          const authorName = author.name;
          const authorEmail = author.email;
          
          if (!authorName) {
            console.error(`Author object missing name field:`, author);
            continue;
          }
          
          console.log(`Generating certificate for: ${authorName} (${authorEmail})`);
          
          // Load PDF template
          const templateBytes = await require('fs').promises.readFile(templatePath);
          const pdfDoc = await require('pdf-lib').PDFDocument.load(templateBytes);
          
          // Get the first page
          const pages = pdfDoc.getPages();
          const firstPage = pages[0];
          const { width, height } = firstPage.getSize();
          
          // Embed fonts
          const boldFont = await pdfDoc.embedFont(require('pdf-lib').StandardFonts.HelveticaBold);
          const regularFont = await pdfDoc.embedFont(require('pdf-lib').StandardFonts.Helvetica);
          const italicFont = await pdfDoc.embedFont(require('pdf-lib').StandardFonts.HelveticaOblique);
          
          // Add speaker name (CENTERED)
          const speakerFontSize = 25;
          const speakerNameWidth = boldFont.widthOfTextAtSize(authorName, speakerFontSize);
          firstPage.drawText(authorName, {
            x: (width - speakerNameWidth) / 2 + 15,
            y: height - 250,
            size: speakerFontSize,
            font: boldFont,
            color: require('pdf-lib').rgb(0, 0, 0),
          });
          
          // Add "por haber participado como ponente en el"
          const participationText = "por haber participado como ponente en el";
          firstPage.drawText(participationText, {
            x: width / 2 - (participationText.length * 2.5) + 1,
            y: height - 320,
            size: 12,
            font: regularFont,
            color: require('pdf-lib').rgb(0, 0, 0),
          });
          
          // Add conference title (UPPERCASE and BOLD)
          const conferenceUpper = conferenceTitle.toUpperCase();
          const conferenceFontSize = 16;
          const conferenceWidth = boldFont.widthOfTextAtSize(conferenceUpper, conferenceFontSize);
          firstPage.drawText(conferenceUpper, {
            x: (width - conferenceWidth) / 2,
            y: height - 360,
            size: conferenceFontSize,
            font: boldFont,
            color: require('pdf-lib').rgb(0, 0, 0),
          });
          
          // Add "con el proyecto"
          const projectText = "con el proyecto";
          firstPage.drawText(projectText, {
            x: width / 2 - (projectText.length * 2.5),
            y: height - 400,
            size: 10,
            font: regularFont,
            color: require('pdf-lib').rgb(0, 0, 0),
          });
          
          // Add presentation title (ITALIC)
          const presentationFontSize = 12;
          const presentationWidth = italicFont.widthOfTextAtSize(presentationTitle, presentationFontSize);
          firstPage.drawText(presentationTitle, {
            x: (width - presentationWidth) / 2,
            y: height - 430,
            size: presentationFontSize,
            font: italicFont,
            color: require('pdf-lib').rgb(0, 0, 0),
          });
          
          // Add location and date
          const locationDate = `San Carlos, ${formattedDate}`;
          const locationFontSize = 12;
          const locationWidth = regularFont.widthOfTextAtSize(locationDate, locationFontSize);
          firstPage.drawText(locationDate, {
            x: (width - locationWidth) / 2,
            y: height - 490,
            size: locationFontSize,
            font: regularFont,
            color: require('pdf-lib').rgb(0, 0, 0),
          });
          
          // Save the PDF
          const pdfBytes = await pdfDoc.save();
          
          certificatesData.push({
            authorName: authorName,
            authorEmail: authorEmail,
            presentationTitle: presentationTitle,
            pdfBytes: pdfBytes,
            filename: `certificado_${authorName.replace(/\s+/g, '_')}_${presentationTitle.replace(/\s+/g, '_').substring(0, 30)}.pdf`
          });
          
          totalCertificates++;
          console.log(`Certificate generated for ${authorName}`);
          
        } catch (error) {
          console.error(`Error generating certificate for author:`, author, error);
        }
      }
    }
    
    if (certificatesData.length === 0) {
      return res.status(400).json({ error: 'No certificates could be generated' });
    }
    
    // Create zip file with all certificates
    const JSZip = require('jszip');
    const zip = new JSZip();
    
    // Add each certificate to the zip
    for (const certData of certificatesData) {
      zip.file(certData.filename, certData.pdfBytes);
    }
    
    // Generate zip buffer
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
    
    // Update conference status to mark certificates as generated
    await conferenceRef.update({
      certificatesGenerated: true,
      certificatesGeneratedDate: new Date().toISOString(),
      certificatesCount: totalCertificates
    });

    // Send zip file for download
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="certificados_${conferenceTitle.replace(/\s+/g, '_')}.zip"`);
    res.send(zipBuffer);
    
    console.log(`Successfully generated ${totalCertificates} certificates for conference: ${conferenceTitle}`);
    
  } catch (error) {
    console.error('Error generating bulk certificates:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});


// Endpoint to upload signed certificates for a conference
app.post('/api/conferences/:id/upload-signed-certificates', zipUpload.single('signedCertificates'), async (req, res) => {
  try {
    const conferenceId = req.params.id;
    
    if (!req.file) {
      return res.status(400).json({ error: 'Signed certificates zip file is required' });
    }
    
    if (!req.file.originalname.toLowerCase().endsWith('.zip')) {
      return res.status(400).json({ error: 'File must be a ZIP archive' });
    }
    
    // Get conference data
    const conferenceRef = db.collection('conferences').doc(conferenceId);
    const conferenceDoc = await conferenceRef.get();
    
    if (!conferenceDoc.exists) {
      return res.status(404).json({ error: 'Conference not found' });
    }
    
    const conferenceData = conferenceDoc.data();
    const conferenceTitle = conferenceData.title;
    const conferenceCreationId = conferenceData.creationId; // Get conference creationId
    
    // Check if unsigned certificates were generated
    if (!conferenceData.certificatesGenerated) {
      return res.status(400).json({ error: 'Unsigned certificates must be generated first' });
    }
    
    console.log(`Processing signed certificates upload for conference: ${conferenceTitle}`);
    
    // Read and extract the uploaded zip
    const JSZip = require('jszip');
    const zipBuffer = await require('fs').promises.readFile(req.file.path);
    const zip = await JSZip.loadAsync(zipBuffer);
    
    // Clean up the temporary file
    require('fs').unlink(req.file.path, (err) => {
      if (err) console.error('Error deleting temp file:', err);
    });
    
    // Get all presentations and their authors for this conference
    const presentations = conferenceData.presentations || [];
    const expectedAuthors = [];
    
    for (const presentationId of presentations) {
      const presentationRef = db.collection('presentations').doc(presentationId);
      const presentationDoc = await presentationRef.get();
      
      if (presentationDoc.exists) {
        const presentationData = presentationDoc.data();
        // Only include presentations with DefinitiveState: true
        if (presentationData.DefinitiveState === true) {
          const authors = presentationData.authors || [];
          
          authors.forEach(author => {
            // Extract name and email from author object
            const authorName = author.name;
            const authorEmail = author.email;
            
            if (authorName) { // Only add if name exists
              expectedAuthors.push({
                name: authorName,
                email: authorEmail,
                presentationId: presentationId,
                presentationTitle: presentationData.title
              });
            } else {
              console.error(`Author object missing name field:`, author);
            }
          });
        }
      }
    }
    
    if (expectedAuthors.length === 0) {
      return res.status(400).json({ error: 'No accepted presentations with authors found' });
    }
    
    console.log(`Expected authors: ${expectedAuthors.length}`);
    expectedAuthors.forEach(author => {
      console.log(`  - ${author.name} (${author.email}) - ${author.presentationTitle}`);
    });
    
    // Process each file in the ZIP
    const processedCertificates = [];
    const errors = [];
    
    for (const [filename, fileData] of Object.entries(zip.files)) {
      if (fileData.dir || !filename.toLowerCase().endsWith('.pdf')) {
        continue; // Skip directories and non-PDF files
      }
      
      console.log(`Processing file: ${filename}`);
      
      // Extract author name from filename
      const authorName = extractAuthorNameFromFilename(filename);
      
      if (!authorName) {
        errors.push(`Could not extract author name from filename: ${filename}`);
        continue;
      }
      
      // Find matching author using improved matching
      const matchingAuthor = findBestAuthorMatch(authorName, expectedAuthors);
      
      if (!matchingAuthor) {
        errors.push(`No matching author found for: ${authorName} (from file: ${filename})`);
        continue;
      }
      
      try {
        // Save all certificates in simplified route: uploads/conferences/(conferenceCreationId)/certificates
        const certificatePath = path.join(
          __dirname, 
          'uploads', 
          'conferences',
          String(conferenceCreationId),
          'certificates'
        );
        
        // Ensure directory exists
        await require('fs').promises.mkdir(certificatePath, { recursive: true });
        
        // Save the file
        const fileBuffer = await fileData.async('nodebuffer');
        const savedFileName = `certificado_${matchingAuthor.name.replace(/\s+/g, '_')}_signed.pdf`;
        const savedFilePath = path.join(certificatePath, savedFileName);
        
        await require('fs').promises.writeFile(savedFilePath, fileBuffer);
        
        processedCertificates.push({
          authorName: matchingAuthor.name,
          authorEmail: matchingAuthor.email,
          presentationId: matchingAuthor.presentationId,
          presentationTitle: matchingAuthor.presentationTitle,
          originalFilename: filename,
          savedPath: savedFilePath,
          relativePath: `uploads/conferences/${conferenceCreationId}/certificates/${savedFileName}`
        });
        
        console.log(`Saved certificate for ${matchingAuthor.name} (${matchingAuthor.email}) - matched from ${authorName}`);
        
      } catch (saveError) {
        console.error(`Error saving certificate for ${authorName}:`, saveError);
        errors.push(`Failed to save certificate for ${authorName}: ${saveError.message}`);
      }
    }
    
    // Update database with certificate information
    for (const cert of processedCertificates) {
      try {
        const presentationRef = db.collection('presentations').doc(cert.presentationId);
        const presentationDoc = await presentationRef.get();
        
        if (presentationDoc.exists) {
          const presentationData = presentationDoc.data();
          const certificates = presentationData.certificates || {};
          const authorsWithCertificates = certificates.authorsWithCertificates || [];
          
          // Find and update the author's certificate info
          const authorIndex = authorsWithCertificates.findIndex(a => 
            normalizeString(a.authorName) === normalizeString(cert.authorName)
          );
          
          if (authorIndex !== -1) {
            authorsWithCertificates[authorIndex].signedFile = cert.relativePath;
            authorsWithCertificates[authorIndex].signedUploadDate = new Date().toISOString();
            authorsWithCertificates[authorIndex].authorEmail = cert.authorEmail;
          } else {
            // Add new author certificate record
            authorsWithCertificates.push({
              authorName: cert.authorName,
              authorEmail: cert.authorEmail,
              unsignedFile: null,
              signedFile: cert.relativePath,
              signedUploadDate: new Date().toISOString(),
              certificateSent: false
            });
          }
          
          // Update the presentation document
          await presentationRef.update({
            'certificates.authorsWithCertificates': authorsWithCertificates,
            'certificates.signedUploaded': true,
            'certificates.signedUploadDate': new Date().toISOString()
          });
        }
      } catch (updateError) {
        console.error(`Error updating database for ${cert.authorName}:`, updateError);
        errors.push(`Failed to update database for ${cert.authorName}`);
      }
    }
    
    // Update conference status
    await conferenceRef.update({
      signedCertificatesUploaded: true,
      signedCertificatesUploadDate: new Date().toISOString(),
      signedCertificatesCount: processedCertificates.length
    });
    
    res.status(200).json({
      message: `Signed certificates uploaded successfully`,
      processedCount: processedCertificates.length,
      expectedCount: expectedAuthors.length,
      processedCertificates: processedCertificates.map(c => ({
        authorName: c.authorName,
        authorEmail: c.authorEmail,
        presentationTitle: c.presentationTitle
      })),
      errors: errors.length > 0 ? errors : undefined
    });
    
  } catch (error) {
    console.error('Error uploading signed certificates:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// Endpoint to send certificates via email to speakers
app.post('/api/conferences/:id/send-certificates', async (req, res) => {
  try {
    const conferenceId = req.params.id;
    
    // Get conference data
    const conferenceRef = db.collection('conferences').doc(conferenceId);
    const conferenceDoc = await conferenceRef.get();
    
    if (!conferenceDoc.exists) {
      return res.status(404).json({ error: 'Conference not found' });
    }
    
    const conferenceData = conferenceDoc.data();
    const conferenceTitle = conferenceData.title;
    
    // Check if signed certificates were uploaded
    if (!conferenceData.signedCertificatesUploaded) {
      return res.status(400).json({ error: 'Signed certificates must be uploaded first' });
    }
    
    console.log(`Sending certificates via email for conference: ${conferenceTitle}`);
    
    // Get all presentations and their authors for this conference
    const presentations = conferenceData.presentations || [];
    const emailsToSend = [];
    const errors = [];
    
    for (const presentationId of presentations) {
      const presentationRef = db.collection('presentations').doc(presentationId);
      const presentationDoc = await presentationRef.get();
      
      if (presentationDoc.exists) {
        const presentationData = presentationDoc.data();
        
        // Only send to accepted presentations
        if (presentationData.DefinitiveState === true) {
          const authors = presentationData.authors || [];
          const creationId = String(presentationData.creationId);
          
          for (const author of authors) {
            const authorName = author.name;
            const authorEmail = author.email;
            
            if (authorName && authorEmail) {
              // Find the signed certificate path
              const certificates = presentationData.certificates || {};
              const authorsWithCertificates = certificates.authorsWithCertificates || [];
              
              const authorCert = authorsWithCertificates.find(a => 
                normalizeString(a.authorName) === normalizeString(authorName)
              );
              
              if (authorCert && authorCert.signedFile) {
                const certificatePath = path.join(__dirname, authorCert.signedFile);
                
                // Check if certificate file exists
                try {
                  await require('fs').promises.access(certificatePath);
                  
                  emailsToSend.push({
                    authorName: authorName,
                    authorEmail: authorEmail,
                    presentationTitle: presentationData.title,
                    certificatePath: certificatePath,
                    presentationId: presentationId
                  });
                } catch (fileError) {
                  errors.push(`Certificate file not found for ${authorName}: ${certificatePath}`);
                }
              } else {
                errors.push(`No signed certificate found for ${authorName}`);
              }
            } else {
              errors.push(`Missing name or email for author in presentation ${presentationData.title}`);
            }
          }
        }
      }
    }
    
    if (emailsToSend.length === 0) {
      return res.status(400).json({ error: 'No certificates available to send', details: errors });
    }
    
    console.log(`Preparing to send ${emailsToSend.length} certificates via email`);
    
    // Send emails
    let sentCount = 0;
    const emailErrors = [];
    
    for (const emailData of emailsToSend) {
      try {
        const emailSubject = `Certificado de Participación - ${conferenceTitle}`;
        const emailBody = `
        Estimado/a ${emailData.authorName},
        
        Nos complace enviarle su certificado de participación como ponente en la conferencia "${conferenceTitle}".
        
        Su ponencia "${emailData.presentationTitle}" fue aceptada y presentada exitosamente.
        
        Adjunto encontrará su certificado firmado digitalmente.
        
        ¡Felicitaciones por su participación!
        
        Saludos cordiales,
        Equipo Organizador
        ProSTEM - TEC
        `;
        
        // Send email with certificate attachment
        const mailOptions = {
          from: process.env.EMAIL_FROM || process.env.SMTP_USER,
          to: emailData.authorEmail,
          subject: emailSubject,
          text: emailBody,
          attachments: [
            {
              filename: `certificado_${emailData.authorName.replace(/\s+/g, '_')}.pdf`,
              path: emailData.certificatePath
            }
          ]
        };
        
        await transporter.sendMail(mailOptions);
        sentCount++;
        
        // Update database to mark certificate as sent
        const presentationRef = db.collection('presentations').doc(emailData.presentationId);
        const presentationDoc = await presentationRef.get();
        
        if (presentationDoc.exists) {
          const presentationData = presentationDoc.data();
          const certificates = presentationData.certificates || {};
          const authorsWithCertificates = certificates.authorsWithCertificates || [];
          
          const authorIndex = authorsWithCertificates.findIndex(a => 
            normalizeString(a.authorName) === normalizeString(emailData.authorName)
          );
          
          if (authorIndex !== -1) {
            authorsWithCertificates[authorIndex].certificateSent = true;
            authorsWithCertificates[authorIndex].sentDate = new Date().toISOString();
            
            await presentationRef.update({
              'certificates.authorsWithCertificates': authorsWithCertificates
            });
          }
        }
        
        console.log(`Certificate sent to ${emailData.authorName} (${emailData.authorEmail})`);
        
      } catch (emailError) {
        console.error(`Error sending certificate to ${emailData.authorName}:`, emailError);
        emailErrors.push(`Failed to send certificate to ${emailData.authorName} (${emailData.authorEmail}): ${emailError.message}`);
      }
    }
    
    // Update conference status
    await conferenceRef.update({
      certificatesSent: true,
      certificatesSentDate: new Date().toISOString(),
      certificatesSentCount: sentCount
    });
    
    res.status(200).json({
      message: `Certificates sent successfully`,
      sentCount: sentCount,
      totalCount: emailsToSend.length,
      sentCertificates: emailsToSend.slice(0, sentCount).map(e => ({
        authorName: e.authorName,
        authorEmail: e.authorEmail,
        presentationTitle: e.presentationTitle
      })),
      errors: [...errors, ...emailErrors]
    });
    
  } catch (error) {
    console.error('Error sending certificates:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// Endpoint to generate and download certificates for all registered users in an event
app.post('/api/events/:id/generate-certificates', async (req, res) => {
  try {
    const eventId = req.params.id;

    // Fetch the event data
    const eventRef = db.collection('events').doc(eventId);
    const eventDoc = await eventRef.get();

    if (!eventDoc.exists) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const eventData = eventDoc.data();
    const eventTitle = eventData.title;
    const registeredUsers = eventData.registeredUsers || [];

    if (registeredUsers.length === 0) {
      return res.status(400).json({ error: 'No registered users found for this event' });
    }

    console.log(`Generating certificates for ${registeredUsers.length} users in event: ${eventTitle}`);

    // Path to certificate template
    const templatePath = path.join(__dirname, 'assets', 'Certificate_template', 'Plantilla.pdf');

    // Check if the template exists
    try {
      await fs.promises.access(templatePath);
    } catch (error) {
      return res.status(404).json({ error: 'Certificate template not found at: ' + templatePath });
    }

    // Format the Costa Rican date
    function formatCostaRicanDate(dateString) {
      const date = new Date(dateString);
      const months = [
        'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
        'julio', 'agosto', 'setiembre', 'octubre', 'noviembre', 'diciembre'
      ];
      const day = date.getDate();
      const month = months[date.getMonth()];
      const year = date.getFullYear();
      return `${day} de ${month} de ${year}`;
    }

    const formattedDate = formatCostaRicanDate(new Date());

    // Collect all certificates data
    const certificatesData = [];
    const usersRef = db.collection('users');

    for (const userId of registeredUsers) {
      const userRef = usersRef.doc(userId);
      const userDoc = await userRef.get();

      if (!userDoc.exists) {
        console.error(`User ${userId} not found`);
        continue;
      }

      const userData = userDoc.data();
      const userFullName = `${userData.name} ${userData.lastName1} ${userData.lastName2}`;

      console.log(`Generating certificate for: ${userFullName}`);

      // Load the PDF template
      const templateBytes = await fs.promises.readFile(templatePath);
      const pdfDoc = await PDFDocument.load(templateBytes);

      // Get the first page
      const pages = pdfDoc.getPages();
      const firstPage = pages[0];
      const { width, height } = firstPage.getSize();

      // Embed fonts
      const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
      const regularFont = await pdfDoc.embedFont(StandardFonts.Helvetica);

      // Add user name (CENTERED)
      const userFontSize = 25;
      const userNameWidth = boldFont.widthOfTextAtSize(userFullName, userFontSize);
      firstPage.drawText(userFullName, {
        x: (width - userNameWidth) / 2,
        y: height - 250,
        size: userFontSize,
        font: boldFont,
        color: rgb(0, 0, 0),
      });

      // Add "por haber participado en el"
      const participationText = "por haber participado en el";
      firstPage.drawText(participationText, {
        x: width / 2 - (participationText.length * 2.5),
        y: height - 320,
        size: 12,
        font: regularFont,
        color: rgb(0, 0, 0),
      });

      // Add event title (UPPERCASE and BOLD)
      const eventUpper = eventTitle.toUpperCase();
      const eventFontSize = 16;
      const eventWidth = boldFont.widthOfTextAtSize(eventUpper, eventFontSize);
      firstPage.drawText(eventUpper, {
        x: (width - eventWidth) / 2,
        y: height - 360,
        size: eventFontSize,
        font: boldFont,
        color: rgb(0, 0, 0),
      });

      // Add location and date
      const locationDate = `San Carlos, ${formattedDate}`;
      const locationFontSize = 12;
      const locationWidth = regularFont.widthOfTextAtSize(locationDate, locationFontSize);
      firstPage.drawText(locationDate, {
        x: (width - locationWidth) / 2,
        y: height - 490,
        size: locationFontSize,
        font: regularFont,
        color: rgb(0, 0, 0),
      });

      // Save the PDF
      const pdfBytes = await pdfDoc.save();

      certificatesData.push({
        userFullName,
        pdfBytes,
        filename: `certificado_${userFullName.replace(/\s+/g, '_')}.pdf`
      });
    }

    if (certificatesData.length === 0) {
      return res.status(400).json({ error: 'No certificates could be generated' });
    }

    // Create a ZIP file with all certificates
    const JSZip = require('jszip');
    const zip = new JSZip();

    for (const certData of certificatesData) {
      zip.file(certData.filename, certData.pdfBytes);
    }

    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

    // Send the ZIP file for download
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="certificados_${eventTitle.replace(/\s+/g, '_')}.zip"`);
    res.send(zipBuffer);

    console.log(`Successfully generated ${certificatesData.length} certificates for event: ${eventTitle}`);
  } catch (error) {
    console.error('Error generating certificates:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// Endpoint to upload signed certificates for an event
app.post('/api/events/:id/upload-event-signed-certificates', zipUpload.single('signedCertificates'), async (req, res) => {
  try {
    const eventId = req.params.id;

    if (!req.file) {
      return res.status(400).json({ error: 'Signed certificates ZIP file is required' });
    }

    if (!req.file.originalname.toLowerCase().endsWith('.zip')) {
      return res.status(400).json({ error: 'File must be a ZIP archive' });
    }

    console.log(`Received ZIP file: ${req.file.originalname}`);

    // Get event data
    const eventRef = db.collection('events').doc(eventId);
    const eventDoc = await eventRef.get();

    if (!eventDoc.exists) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const eventData = eventDoc.data();
    const registeredUsers = eventData.registeredUsers || [];

    if (registeredUsers.length === 0) {
      return res.status(400).json({ error: 'No registered users found for this event' });
    }

    console.log(`Registered users for event ${eventId}:`, registeredUsers);

    // Fetch user data for all registered users
    const usersCollection = {};
    const usersRef = db.collection('users');

    for (const userId of registeredUsers) {
      const userDoc = await usersRef.doc(userId).get();
      if (userDoc.exists) {
        usersCollection[userId] = userDoc.data();
      }
    }

    console.log('Fetched user data for registered users:', usersCollection);

    // Read and extract the uploaded ZIP
    const JSZip = require('jszip');
    const zipBuffer = await fs.promises.readFile(req.file.path);
    const zip = await JSZip.loadAsync(zipBuffer);

    console.log(`Extracting files from ZIP...`);

    // Clean up the temporary file
    fs.unlink(req.file.path, (err) => {
      if (err) console.error('Error deleting temp file:', err);
    });

    // Process each file in the ZIP
    const processedCertificates = [];
    const errors = [];

    for (const [filename, fileData] of Object.entries(zip.files)) {
      if (fileData.dir || !filename.toLowerCase().endsWith('.pdf')) {
        console.log(`Skipping non-PDF file: ${filename}`);
        continue;
      }

      console.log(`Processing file: ${filename}`);

      // Match user ID from filename
      const userId = matchUserIdFromFilename(filename, registeredUsers, usersCollection);

      if (!userId) {
        console.error(`Could not match user ID for filename: ${filename}`);
        errors.push(`Could not match user ID for filename: ${filename}`);
        continue;
      }

      try {
        // Save the signed certificate to the user's folder
        const certificatePath = path.join(
          __dirname,
          'uploads',
          'generalEvents',
          'certificates',
          eventId,
          userId
        );

        console.log(`Creating directory: ${certificatePath}`);
        await fs.promises.mkdir(certificatePath, { recursive: true });

        const fileBuffer = await fileData.async('nodebuffer');
        const savedFilePath = path.join(certificatePath, filename);

        console.log(`Saving file to: ${savedFilePath}`);
        await fs.promises.writeFile(savedFilePath, fileBuffer);

        processedCertificates.push({
          userId,
          filename,
          savedPath: savedFilePath,
        });
      } catch (saveError) {
        console.error(`Error saving certificate for user ${userId}:`, saveError);
        errors.push(`Failed to save certificate for user ${userId}: ${saveError.message}`);
      }
    }

    res.status(200).json({
      message: `Signed certificates uploaded successfully`,
      processedCount: processedCertificates.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error('Error uploading signed certificates:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// Helper function to extract user ID from filename
function extractUserIdFromFilename(filename) {
  const match = filename.match(/user_(\w+)_signed\.pdf/i); // Example: user_12345_signed.pdf
  return match ? match[1] : null;
}

// Helper function to match filenames to registered users
function matchUserIdFromFilename(filename, registeredUsers, usersCollection) {
  // Extract the name from the filename (e.g., "Leandro_Vásquez_Vega" from "certificado_Leandro_Vásquez_Vega.pdf")
  const nameMatch = filename.match(/certificado_(.+)\.pdf/i);
  if (!nameMatch) return null;

  const extractedName = nameMatch[1].replace(/_/g, ' '); // Replace underscores with spaces
  console.log(`Extracted name from filename: ${extractedName}`);

  // Find the user in the registered users list by matching the name
  for (const userId of registeredUsers) {
    const userDoc = usersCollection[userId];
    if (!userDoc) continue;

    const fullName = `${userDoc.name} ${userDoc.lastName1} ${userDoc.lastName2}`;
    if (normalizeString(fullName) === normalizeString(extractedName)) {
      return userId; // Return the matched user ID
    }
  }

  return null; // No match found
}

// Helper function to normalize strings for comparison
function normalizeString(str) {
  return str
    .normalize('NFD') // Normalize accented characters
    .replace(/[\u0300-\u036f]/g, '') // Remove diacritics
    .toLowerCase()
    .trim();
}



// Endpoint to send certificates via email to event participants
app.post('/api/events/:id/send-certificates', async (req, res) => {
  try {
    const eventId = req.params.id;

    // Get event data
    const eventRef = db.collection('events').doc(eventId);
    const eventDoc = await eventRef.get();

    if (!eventDoc.exists) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const eventData = eventDoc.data();
    const eventTitle = eventData.title;
    const registeredUsers = eventData.registeredUsers || [];

    if (registeredUsers.length === 0) {
      return res.status(400).json({ error: 'No registered users found for this event' });
    }

    console.log(`Sending certificates via email for event: ${eventTitle}`);

    // Fetch user data for all registered users
    const usersCollection = {};
    const usersRef = db.collection('users');

    for (const userId of registeredUsers) {
      const userDoc = await usersRef.doc(userId).get();
      if (userDoc.exists) {
        usersCollection[userId] = userDoc.data();
      }
    }

    console.log('Fetched user data for registered users:', usersCollection);

    // Prepare emails
    const emailsToSend = [];
    const errors = [];

    for (const userId of registeredUsers) {
      const userDoc = usersCollection[userId];
      if (!userDoc) {
        errors.push(`User ID ${userId} not found in users collection`);
        continue;
      }

      const userEmail = userDoc.email;
      const userFullName = `${userDoc.name} ${userDoc.lastName1} ${userDoc.lastName2}`;
      const certificatePath = path.join(
        __dirname,
        'uploads',
        'generalEvents',
        'certificates',
        eventId,
        userId,
        `certificado_${userFullName.replace(/\s+/g, '_')}.pdf`
      );

      // Check if the certificate exists
      try {
        await fs.promises.access(certificatePath);
      } catch (error) {
        console.error(`Certificate not found for user ${userFullName}: ${certificatePath}`);
        errors.push(`Certificate not found for user ${userFullName}`);
        continue;
      }

      // Prepare the email
      emailsToSend.push({
        to: userEmail,
        subject: `Certificado de Participación - ${eventTitle}`,
        text: `
        Estimado/a ${userFullName},

        Nos complace enviarle su certificado de participación en el evento "${eventTitle}".

        Adjunto encontrará su certificado en formato PDF.

        ¡Gracias por participar!

        Saludos cordiales,
        Equipo Organizador
        `,
        attachments: [
          {
            filename: `certificado_${userFullName.replace(/\s+/g, '_')}.pdf`,
            path: certificatePath,
          },
        ],
      });
    }

    // Send emails

    let sentCount = 0;

    for (const emailData of emailsToSend) {
      try {
        await transporter.sendMail(emailData);
        console.log(`Certificate sent to ${emailData.to}`);
        sentCount++;
      } catch (error) {
        console.error(`Error sending certificate to ${emailData.to}:`, error);
        errors.push(`Failed to send certificate to ${emailData.to}`);
      }
    }

    res.status(200).json({
      message: `Certificates sent successfully`,
      sentCount,
      totalCount: emailsToSend.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error('Error sending certificates:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// Endpoint to create a new news item
app.post('/api/news', newsImageUpload.array('images', 10), async (req, res) => {
  try {
    const { title, content, creatorId } = req.body;
    
    if (!title || !content || !creatorId) {
      return res.status(400).json({ error: 'Title, content and creatorId are required' });
    }

    // Create the news document in Firestore first to get the ID
    const newsRef = db.collection('news').doc();
    const newsId = newsRef.id;

    // Create the directory for this news item
    const newsImagesDir = path.join(__dirname, 'uploads', 'newsModule', newsId, 'images');
    await require('fs').promises.mkdir(newsImagesDir, { recursive: true });

    // Process uploaded images
    const imageLinks = [];
    
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        // Move file from temp to news directory
        const fileName = `${Date.now()}-${file.originalname}`;
        const newPath = path.join(newsImagesDir, fileName);
        
        await require('fs').promises.rename(file.path, newPath);
        
        // Store relative path
        const relativePath = `uploads/newsModule/${newsId}/images/${fileName}`;
        imageLinks.push(relativePath);
      }
    }

    // Get current date and time
    const now = new Date();
    const creationDate = now.toISOString().split('T')[0]; // YYYY-MM-DD
    const creationTime = now.toTimeString().split(' ')[0]; // HH:MM:SS

    // Save news data to Firestore
    const newsData = {
      title,
      content,
      creatorId,
      creationDate,
      creationTime,
      imageLinks,
      createdAt: now.toISOString() // For sorting purposes
    };

    await newsRef.set(newsData);

    res.status(201).json({
      message: 'News created successfully',
      newsId: newsId,
      news: { id: newsId, ...newsData }
    });

  } catch (error) {
    console.error('Error creating news:', error);
    
    // Clean up temp files if error occurs
    if (req.files) {
      req.files.forEach(file => {
        require('fs').unlink(file.path, (err) => {
          if (err) console.error('Error deleting temp file:', err);
        });
      });
    }

    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// Endpoint to get all news items ordered by creation date (newest first)
app.get('/api/news', async (req, res) => {
  try {
    const newsSnapshot = await db.collection('news')
      .orderBy('createdAt', 'desc')
      .get();

    const newsList = [];
    newsSnapshot.forEach(doc => {
      newsList.push({
        id: doc.id,
        ...doc.data()
      });
    });

    res.status(200).json(newsList);

  } catch (error) {
    console.error('Error fetching news:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

app.get('/uploads/newsModule/:newsId/images/:imageName', (req, res) => {
  const { newsId, imageName } = req.params;
  const imagePath = path.join(__dirname, 'uploads', 'newsModule', newsId, 'images', imageName);
  
  console.log('Requested image path:', imagePath);
  
  // Check if file exists
  require('fs').access(imagePath, require('fs').constants.F_OK, (err) => {
    if (err) {
      console.log('Image not found:', imagePath);
      return res.status(404).json({ error: 'Image not found' });
    }
    
    // Detect MIME type based on file extension
    const ext = path.extname(imageName).toLowerCase();
    let contentType = 'image/jpeg'; // default
    
    switch (ext) {
      case '.png':
        contentType = 'image/png';
        break;
      case '.gif':
        contentType = 'image/gif';
        break;
      case '.jpg':
      case '.jpeg':
        contentType = 'image/jpeg';
        break;
    }
    
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Access-Control-Allow-Origin', '*'); // Allow CORS
    
    console.log('Serving image:', imagePath, 'with type:', contentType);
    res.sendFile(imagePath);
  });
});

// Endpoint to get a single news item by ID
app.get('/api/news/:id', async (req, res) => {
  try {
    const newsId = req.params.id;
    const newsDoc = await db.collection('news').doc(newsId).get();

    if (!newsDoc.exists) {
      return res.status(404).json({ error: 'News not found' });
    }

    res.status(200).json({
      id: newsDoc.id,
      ...newsDoc.data()
    });

  } catch (error) {
    console.error('Error fetching news by ID:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// Endpoint to delete a news item
app.delete('/api/news/:id', async (req, res) => {
  try {
    const newsId = req.params.id;
    
    // Get news document to check if it exists and get image paths
    const newsDoc = await db.collection('news').doc(newsId).get();
    
    if (!newsDoc.exists) {
      return res.status(404).json({ error: 'News not found' });
    }
    
    const newsData = newsDoc.data();
    
    // Delete associated images from file system
    if (newsData.imageLinks && newsData.imageLinks.length > 0) {
      for (const imagePath of newsData.imageLinks) {
        try {
          const fullPath = path.join(__dirname, imagePath);
          await require('fs').promises.unlink(fullPath);
          console.log(`Deleted image: ${fullPath}`);
        } catch (fileError) {
          console.warn(`Could not delete image: ${imagePath}`, fileError.message);
          // Continue even if image deletion fails
        }
      }
      
      // Try to delete the empty directory
      try {
        const newsDir = path.join(__dirname, 'uploads', 'newsModule', newsId);
        await require('fs').promises.rmdir(newsDir, { recursive: true });
        console.log(`Deleted news directory: ${newsDir}`);
      } catch (dirError) {
        console.warn(`Could not delete news directory for ${newsId}:`, dirError.message);
      }
    }
    
    // Delete the news document from Firestore
    await db.collection('news').doc(newsId).delete();
    
    res.status(200).json({
      message: 'News deleted successfully',
      newsId: newsId
    });
    
  } catch (error) {
    console.error('Error deleting news:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// Endpoint to update a news item
app.put('/api/news/:id', newsImageUpload.array('images', 10), async (req, res) => {
  try {
    const newsId = req.params.id;
    const { title, content, creatorId, existingImages } = req.body;
    
    // Get current news document
    const newsDoc = await db.collection('news').doc(newsId).get();
    
    if (!newsDoc.exists) {
      return res.status(404).json({ error: 'News not found' });
    }
    
    const currentNews = newsDoc.data();
    
    // Check ownership
    if (currentNews.creatorId !== creatorId) {
      return res.status(403).json({ error: 'You can only edit your own news' });
    }
    
    // Parse existing images to keep
    const imagesToKeep = existingImages ? JSON.parse(existingImages) : [];
    const currentImages = currentNews.imageLinks || [];
    
    // Delete removed images
    const imagesToDelete = currentImages.filter(img => !imagesToKeep.includes(img));
    for (const imagePath of imagesToDelete) {
      try {
        const fullPath = path.join(__dirname, imagePath);
        await require('fs').promises.unlink(fullPath);
        console.log(`Deleted removed image: ${fullPath}`);
      } catch (fileError) {
        console.warn(`Could not delete image: ${imagePath}`, fileError.message);
      }
    }
    
    // Process new uploaded images
    const newImageLinks = [];
    const newsImagesDir = path.join(__dirname, 'uploads', 'newsModule', newsId, 'images');
    await require('fs').promises.mkdir(newsImagesDir, { recursive: true });
    
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const fileName = `${Date.now()}-${file.originalname}`;
        const newPath = path.join(newsImagesDir, fileName);
        
        await require('fs').promises.rename(file.path, newPath);
        
        const relativePath = `uploads/newsModule/${newsId}/images/${fileName}`;
        newImageLinks.push(relativePath);
      }
    }
    
    // Combine kept images with new images
    const finalImageLinks = [...imagesToKeep, ...newImageLinks];
    
    // Update the news document
    const updatedData = {
      title,
      content,
      imageLinks: finalImageLinks,
      updatedAt: new Date().toISOString()
    };
    
    await db.collection('news').doc(newsId).update(updatedData);
    
    res.status(200).json({
      message: 'News updated successfully',
      newsId: newsId,
      news: { id: newsId, ...currentNews, ...updatedData }
    });
    
  } catch (error) {
    console.error('Error updating news:', error);
    
    // Clean up temp files if error occurs
    if (req.files) {
      req.files.forEach(file => {
        require('fs').unlink(file.path, (err) => {
          if (err) console.error('Error deleting temp file:', err);
        });
      });
    }
    
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

//Endpoint to get basic information from a user
app.get('/api/users/:id', async (req, res) => {
  const userId = req.params.id;

  if (!userId) {
    return res.status(400).json({ error: 'User ID is required' });
  }

  try {
    const userDoc = await db.collection('users').doc(userId).get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userData = userDoc.data();
    res.status(200).json(userData);
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Endpoint to get conferences for calendar
app.get('/api/conferences-for-calendar', async (req, res) => {
  try {
    const conferencesSnapshot = await db.collection('conferences').get();
    const conferences = conferencesSnapshot.docs.map(doc => ({
      id: doc.id,
      title: doc.data().title,
      startDate: doc.data().startDate,
      finishDate: doc.data().finishDate,
      startTime: doc.data().startTime,
      finishTime: doc.data().finishTime,
      description: doc.data().description,
      place: doc.data().place
    }));
    res.status(200).json(conferences);
  } catch (error) {
    console.error('Error fetching conferences for calendar:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});


//#################################################################################################

app.listen(PORT, (error) => {
  if (error) console.log("There was an error:", error);
  console.log(`App available on http://localhost:${PORT} `);
});
