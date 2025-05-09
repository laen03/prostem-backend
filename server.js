const express = require("express");
const admin = require("./firebase-admin");
const cors = require("cors");
const app = express();
const multer = require("multer");
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
        const fileName = `profilePictures/${userRecord.uid}`;
        const file = bucket.file(fileName);

        await file.save(request.file.buffer, {
          metadata: {
            contentType: request.file.mimetype,
          },
        });
        // This makes the file public
        //TODO: use signed tokens if privacy is needed
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
      //return response.status(400).send({ error: error.message });
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
      myEvents: admin.firestore.FieldValue.arrayUnion(eventId),
    });

    return response.status(200).json({ message: "Inscripción exitosa" });
  } catch (error) {
    console.error("Error al registrar al usuario en el evento:", error);
    return response.status(500).json({ error: "Error interno del servidor" });
  }
});

//REGISTER TO AN EVENT
app.post("/api/unregister-from-event/:id", async (request, response) => {
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
    const eventStartDate = eventData.startDate;
    const now = new Date();
    // Check that start date is in the future
    if (new Date(eventStartDate) <= now) {
      return response.status(400).json({
        error:
          "No puedes desinscribirte después de que el evento haya iniciado.",
      });
    }

    // Verify the user is already registered.
    const registeredUsers = eventData.registeredUsers || [];
    if (!registeredUsers.includes(userId)) {
      return response
        .status(400)
        .json({ error: "No estás inscrito en este evento." });
    }

    // Quitar usuario del evento
    await eventRef.update({
      registeredUsers: admin.firestore.FieldValue.arrayRemove(userId),
    });

    // Quitar evento del usuario
    await userRef.update({
      myEvents: admin.firestore.FieldValue.arrayRemove(eventId),
    });

    return response.status(200).json({ message: "Desinscripción exitosa" });
  } catch (error) {
    console.error("Error al desinscribirse:", error);
    return response.status(500).json({ error: "Error interno del servidor" });
  }
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
        await userRef.update({
          myEvents: admin.firestore.FieldValue.arrayUnion(eventId),
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

//#################################################################################################

app.listen(PORT, (error) => {
  if (error) console.log("There was an error:", error);
  console.log(`App available on http://localhost:${PORT} `);
});
