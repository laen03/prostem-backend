const express = require("express");
const admin = require("./firebase-admin");
const cors = require("cors");
const app = express();
const multer = require("multer");
const { DateTime } = require("luxon");
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

      // const parsedSpecializations = JSON.parse(specializations || "[]");
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

//GET SURVEYS BY ID

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
app.get("/api/stats", async (request, response) => {
  try {
    const [eventsSnap, usersSnap] = await Promise.all([
      db.collection("events").get(),
      db.collection("users").get(),
    ]);

    const totalCourses = eventsSnap.size;
    const totalUsers = usersSnap.size;
    const participantsByCourse = {};
    let primary = 0,
      secondary = 0;

    usersSnap.forEach((doc) => {
      const data = doc.data();
      const teachingLevel = (data.teachingLevel || "").toLowerCase();
      if (teachingLevel.includes("primaria")) primary++;
      else if (teachingLevel.includes("secundaria")) secondary++;
    });

    eventsSnap.forEach((doc) => {
      const data = doc.data();
      const title = data.title || `Evento ${doc.id}`;
      const count = Array.isArray(data.registeredUsers)
        ? data.registeredUsers.length
        : 0;
      participantsByCourse[title] = count;
    });

    response.json({
      totalCourses,
      totalUsers,
      primary,
      secondary,
      participantsByCourse,
    });
  } catch (error) {
    console.error("Error fetching statitics:", error);
    response.status(500).json({ error: "Error al obtener estadísticas" });
  }
});

//#################################################################################################

app.listen(PORT, (error) => {
  if (error) console.log("There was an error:", error);
  console.log(`App available on http://localhost:${PORT} `);
});
