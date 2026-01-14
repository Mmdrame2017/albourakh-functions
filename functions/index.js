const admin = require('firebase-admin');
const { onDocumentCreated, onDocumentUpdated, onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onCall } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');

// ✅ INITIALISATION
admin.initializeApp();
const db = admin.firestore();

// ✅ CONFIGURATION RÉGION
const REGION = 'us-central1';

// ==========================================
// CONFIGURATION SYSTÈME
// ==========================================
const TRACKING_CONFIG = {
    maxInactivityMinutes: 10,
    geofenceRadius: 100,
    speedThreshold: 120,
    accuracyThreshold: 50,
    batchUpdateInterval: 5,
    minSoldeRequis: 1000
};

const PAYMENT_CONFIG = {
    driverRate: 0.70,
    platformRate: 0.30,
    minCourseAmount: 500,
    maxCourseAmount: 50000
};

async function getSystemParams() {
    try {
        const doc = await db.collection('parametres').doc('config').get();
        if (doc.exists) {
            return doc.data();
        }
        return {
            assignationAutomatique: true,
            delaiReassignation: 10,
            rayonRecherche: 10,
            notificationsActives: true
        };
    } catch (error) {
        console.error('Erreur récupération paramètres:', error);
        return {
            assignationAutomatique: true,
            delaiReassignation: 10,
            rayonRecherche: 10,
            notificationsActives: true
        };
    }
}

function parseMoney(value) {
    if (value === undefined || value === null) return 0;
    const cleanStr = String(value).replace(/[^0-9.-]+/g, "");
    const num = parseFloat(cleanStr);
    return isNaN(num) ? 0 : num;
}

// ==========================================
// SECTION 1: ASSIGNATION AUTOMATIQUE
// ==========================================

exports.assignerChauffeurAutomatique = onDocumentCreated(
    {
        document: 'reservations/{reservationId}',
        region: REGION
    },
    async (event) => {
        const snap = event.data;
        const reservation = snap.data();
        const reservationId = event.params.reservationId;

        console.log(`🚕 [${new Date().toISOString()}] Nouvelle réservation: ${reservationId}`);

        if (reservation.statut !== 'en_attente') {
            console.log('⚠️ Réservation déjà traitée');
            return null;
        }

        const params = await getSystemParams();

        if (!params.assignationAutomatique) {
            console.log('🔴 MODE MANUEL activé');

            await db.collection('notifications_admin').add({
                type: 'nouvelle_reservation_manuelle',
                reservationId: reservationId,
                message: `Nouvelle réservation en attente - Mode manuel activé`,
                clientNom: reservation.clientNom,
                depart: reservation.depart,
                destination: reservation.destination,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                lu: false
            });

            return null;
        }

        console.log('🟢 MODE AUTO activé');

        try {
            const chauffeursSnapshot = await db.collection('drivers')
                .where('statut', '==', 'disponible')
                .get();

            if (chauffeursSnapshot.empty) {
                console.log('❌ Aucun chauffeur disponible');

                await db.collection('notifications_admin').add({
                    type: 'aucun_chauffeur',
                    reservationId: reservationId,
                    message: `Aucun chauffeur disponible`,
                    clientNom: reservation.clientNom,
                    timestamp: admin.firestore.FieldValue.serverTimestamp(),
                    lu: false
                });

                return null;
            }

            let departCoords = null;
            let coordonneesApproximatives = false;

            if (reservation.departCoords && reservation.departCoords.lat && reservation.departCoords.lng) {
                departCoords = reservation.departCoords;
            } else {
                console.log(`⚠️ Coordonnées manquantes pour: ${reservation.depart}`);
                departCoords = getDefaultCoordsForAddress(reservation.depart);
                coordonneesApproximatives = true;

                await snap.ref.update({
                    departCoords: departCoords,
                    coordonneesApproximatives: true
                });
            }

            const chauffeurs = [];

            chauffeursSnapshot.forEach(doc => {
                const chauffeur = doc.data();

                if (!chauffeur.position || !chauffeur.position.latitude) {
                    console.log(`⚠️ ${doc.id}: pas de GPS`);
                    return;
                }

                if (chauffeur.reservationEnCours || chauffeur.currentBookingId) {
                    console.log(`⚠️ ${doc.id}: déjà en course`);
                    return;
                }

                let rawSolde = chauffeur.SoldeDisponible !== undefined 
                    ? chauffeur.SoldeDisponible 
                    : chauffeur.soldeDisponible;

                const soldeActuel = parseMoney(rawSolde);

                console.log(`🔍 Check Solde ${doc.id} (${chauffeur.prenom}): Brut="${rawSolde}" -> Nettoyé=${soldeActuel}`);

                if (soldeActuel < TRACKING_CONFIG.minSoldeRequis) {
                    console.log(`⛔ ${doc.id}: IGNORÉ - Solde insuffisant (${soldeActuel} < ${TRACKING_CONFIG.minSoldeRequis})`);
                    return;
                }

                const distance = calculerDistance(
                    departCoords.lat,
                    departCoords.lng,
                    chauffeur.position.latitude,
                    chauffeur.position.longitude
                );

                console.log(`📍 ${chauffeur.prenom} ${chauffeur.nom}: ${distance.toFixed(2)} km (Solde OK: ${soldeActuel})`);

                if (distance <= params.rayonRecherche) {
                    chauffeurs.push({
                        id: doc.id,
                        ...chauffeur,
                        distance: distance
                    });
                }
            });

            if (chauffeurs.length === 0) {
                console.log(`❌ Aucun chauffeur éligible (Solde > 1000F & Zone ${params.rayonRecherche}km)`);

                await db.collection('notifications_admin').add({
                    type: 'aucun_chauffeur_proximite',
                    reservationId: reservationId,
                    message: `Aucun chauffeur éligible (Solde ou Distance) dans le secteur`,
                    timestamp: admin.firestore.FieldValue.serverTimestamp(),
                    lu: false
                });

                return null;
            }

            chauffeurs.sort((a, b) => a.distance - b.distance);
            const chauffeurChoisi = chauffeurs[0];

            console.log(`✅ Sélectionné : ${chauffeurChoisi.prenom} ${chauffeurChoisi.nom} (${chauffeurChoisi.distance.toFixed(2)} km)`);

            await db.runTransaction(async (transaction) => {
                const chauffeurRef = db.collection('drivers').doc(chauffeurChoisi.id);
                const chauffeurDoc = await transaction.get(chauffeurRef);

                if (!chauffeurDoc.exists) throw new Error("Chauffeur introuvable !");

                const chauffeurData = chauffeurDoc.data();

                if (chauffeurData.statut !== 'disponible' ||
                    chauffeurData.currentBookingId ||
                    chauffeurData.reservationEnCours) {
                    throw new Error('Chauffeur plus disponible');
                }

                let rawSoldeTrans = chauffeurData.SoldeDisponible !== undefined
                    ? chauffeurData.SoldeDisponible
                    : chauffeurData.soldeDisponible;

                const soldeTransaction = parseMoney(rawSoldeTrans);

                if (soldeTransaction < TRACKING_CONFIG.minSoldeRequis) {
                    throw new Error(`ABORT TRANSACTION: Solde insuffisant détecté (${soldeTransaction} FCFA < 1000)`);
                }

                transaction.update(snap.ref, {
                    chauffeurAssigne: chauffeurChoisi.id,
                    nomChauffeur: `${chauffeurChoisi.prenom} ${chauffeurChoisi.nom}`,
                    telephoneChauffeur: chauffeurChoisi.telephone,
                    statut: 'assignee',
                    dateAssignation: admin.firestore.FieldValue.serverTimestamp(),
                    distanceChauffeur: Math.round(chauffeurChoisi.distance * 1000),
                    tempsArriveeChauffeur: Math.round(chauffeurChoisi.distance * 3),
                    modeAssignation: 'automatique'
                });

                transaction.update(chauffeurRef, {
                    statut: 'en_course',
                    currentBookingId: reservationId,
                    reservationEnCours: reservationId,
                    derniereAssignation: admin.firestore.FieldValue.serverTimestamp()
                });
            });

            console.log('✅ TRANSACTION RÉUSSIE');

            await db.collection('notifications').add({
                destinataire: chauffeurChoisi.telephone,
                chauffeurId: chauffeurChoisi.id,
                type: 'nouvelle_course',
                reservationId: reservationId,
                depart: reservation.depart,
                destination: reservation.destination,
                clientNom: reservation.clientNom,
                clientTelephone: reservation.clientTelephone,
                prixEstime: reservation.prixEstime,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                lu: false
            });

            await db.collection('notifications_admin').add({
                type: 'assignation_reussie',
                reservationId: reservationId,
                message: `✅ ${chauffeurChoisi.prenom} ${chauffeurChoisi.nom} assigné (${chauffeurChoisi.distance.toFixed(1)} km)${coordonneesApproximatives ? ' - Coords approx.' : ''}`,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                lu: false
            });

            console.log('✅ Assignation automatique réussie!');
            return null;

        } catch (error) {
            console.error('❌ Erreur assignation:', error);

            await db.collection('erreurs_systeme').add({
                type: 'erreur_assignation_auto',
                reservationId: reservationId,
                message: error.message,
                stack: error.stack,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });

            return null;
        }
    });

// ==========================================
// ASSIGNATION MANUELLE
// ==========================================

exports.assignerChauffeurManuel = onCall({ region: REGION }, async (request) => {
    const { reservationId, chauffeurId, adminToken } = request.data;

    if (!request.auth && !adminToken) {
        throw new Error('Non authentifié');
    }

    if (!reservationId || !chauffeurId) {
        throw new Error('Paramètres manquants');
    }

    try {
        const reservationDoc = await db.collection('reservations').doc(reservationId).get();

        if (!reservationDoc.exists) {
            throw new Error('Réservation non trouvée');
        }

        const reservation = reservationDoc.data();

        if (reservation.chauffeurAssigne && reservation.chauffeurAssigne !== chauffeurId) {
            console.log('🔄 Libération ancien chauffeur');

            try {
                await db.collection('drivers').doc(reservation.chauffeurAssigne).update({
                    statut: 'disponible',
                    currentBookingId: null,
                    reservationEnCours: null
                });
            } catch (err) {
                console.warn('⚠️ Impossible de libérer:', err.message);
            }
        }

        const chauffeurDoc = await db.collection('drivers').doc(chauffeurId).get();

        if (!chauffeurDoc.exists) {
            throw new Error('Chauffeur non trouvé');
        }

        const chauffeur = chauffeurDoc.data();

        if (chauffeur.reservationEnCours || chauffeur.currentBookingId) {
            throw new Error('Chauffeur déjà en course');
        }

        let rawSolde = chauffeur.SoldeDisponible !== undefined
            ? chauffeur.SoldeDisponible
            : chauffeur.soldeDisponible;

        const soldeActuel = parseMoney(rawSolde);

        console.log(`🔍 [MANUEL] Check Solde ${chauffeurId}: Brut="${rawSolde}" -> Converti=${soldeActuel}`);

        if (soldeActuel < TRACKING_CONFIG.minSoldeRequis) {
            console.warn(`Tentative assignation manuelle rejetée. Solde: ${soldeActuel}`);
            throw new Error(`Solde insuffisant (${soldeActuel} FCFA). Le chauffeur doit avoir au moins ${TRACKING_CONFIG.minSoldeRequis} FCFA.`);
        }

        let distance = 5;
        if (chauffeur.position && chauffeur.position.latitude && reservation.departCoords) {
            distance = calculerDistance(
                reservation.departCoords.lat,
                reservation.departCoords.lng,
                chauffeur.position.latitude,
                chauffeur.position.longitude
            );
        }

        await db.runTransaction(async (transaction) => {
            const chauffeurRef = db.collection('drivers').doc(chauffeurId);
            const chauffeurCheck = await transaction.get(chauffeurRef);
            const chauffeurCheckData = chauffeurCheck.data();

            if (chauffeurCheckData.currentBookingId || chauffeurCheckData.reservationEnCours) {
                throw new Error('Chauffeur plus disponible');
            }

            let rawSoldeTrans = chauffeurCheckData.SoldeDisponible !== undefined
                ? chauffeurCheckData.SoldeDisponible
                : chauffeurCheckData.soldeDisponible;

            const soldeTrans = parseMoney(rawSoldeTrans);

            if (soldeTrans < TRACKING_CONFIG.minSoldeRequis) {
                throw new Error(`Solde insuffisant au moment de la transaction (${soldeTrans} FCFA)`);
            }

            transaction.update(reservationDoc.ref, {
                chauffeurAssigne: chauffeurId,
                nomChauffeur: `${chauffeur.prenom} ${chauffeur.nom}`,
                telephoneChauffeur: chauffeur.telephone,
                statut: 'assignee',
                dateAssignation: admin.firestore.FieldValue.serverTimestamp(),
                distanceChauffeur: Math.round(distance * 1000),
                tempsArriveeChauffeur: Math.round(distance * 3),
                modeAssignation: 'manuel',
                assignePar: request.auth ? request.auth.email : 'admin'
            });

            transaction.update(chauffeurRef, {
                statut: 'en_course',
                currentBookingId: reservationId,
                reservationEnCours: reservationId,
                derniereAssignation: admin.firestore.FieldValue.serverTimestamp()
            });
        });

        console.log('✅ Assignation manuelle réussie');

        await db.collection('notifications').add({
            chauffeurId: chauffeurId,
            destinataire: chauffeur.telephone,
            type: 'nouvelle_course',
            reservationId: reservationId,
            depart: reservation.depart,
            destination: reservation.destination,
            clientNom: reservation.clientNom,
            clientTelephone: reservation.clientTelephone,
            prixEstime: reservation.prixEstime,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            lu: false
        });

        return {
            success: true,
            message: `${chauffeur.prenom} ${chauffeur.nom} assigné`,
            chauffeur: {
                nom: `${chauffeur.prenom} ${chauffeur.nom}`,
                telephone: chauffeur.telephone,
                distance: distance.toFixed(2)
            }
        };

    } catch (error) {
        console.error('❌ Erreur:', error);
        throw new Error(error.message);
    }
});

// ==========================================
// TERMINER COURSE
// ==========================================

exports.terminerCourse = onCall({ region: REGION }, async (request) => {
    const { reservationId, chauffeurId, adminToken } = request.data;

    if (!request.auth && !adminToken) {
        throw new Error('Non authentifié');
    }

    try {
        await db.collection('reservations').doc(reservationId).update({
            statut: 'terminee',
            dateTerminaison: admin.firestore.FieldValue.serverTimestamp()
        });

        await db.collection('drivers').doc(chauffeurId).update({
            statut: 'disponible',
            currentBookingId: null,
            reservationEnCours: null,
            coursesCompletees: admin.firestore.FieldValue.increment(1)
        });

        return { success: true, message: 'Course terminée' };
    } catch (error) {
        throw new Error(error.message);
    }
});

// ==========================================
// ANNULER RÉSERVATION
// ==========================================

exports.annulerReservation = onCall({ region: REGION }, async (request) => {
    const { reservationId, raison, adminToken } = request.data;

    if (!request.auth && !adminToken) {
        throw new Error('Non authentifié');
    }

    try {
        const reservationDoc = await db.collection('reservations').doc(reservationId).get();
        const reservation = reservationDoc.data();

        if (reservation.chauffeurAssigne) {
            await db.collection('drivers').doc(reservation.chauffeurAssigne).update({
                statut: 'disponible',
                currentBookingId: null,
                reservationEnCours: null
            });
        }

        await db.collection('reservations').doc(reservationId).update({
            statut: 'annulee',
            raisonAnnulation: raison || 'Non spécifiée',
            dateAnnulation: admin.firestore.FieldValue.serverTimestamp(),
            annuleePar: request.auth ? request.auth.email : 'admin'
        });

        return { success: true, message: 'Réservation annulée' };
    } catch (error) {
        throw new Error(error.message);
    }
});

// ==========================================
// VÉRIFICATION TIMEOUT ASSIGNATIONS
// ==========================================

exports.verifierAssignationTimeout = onSchedule(
    {
        schedule: 'every 5 minutes',
        region: REGION,
        timeoutSeconds: 120
    },
    async (event) => {
        console.log('🔍 Vérification timeouts...');
        const params = await getSystemParams();
        const maintenant = Date.now();
        const timeout = params.delaiReassignation * 60 * 1000;

        try {
            const snapshot = await db.collection('reservations')
                .where('statut', '==', 'assignee')
                .get();

            const promesses = [];

            snapshot.forEach(doc => {
                const reservation = doc.data();

                if (reservation.dateAssignation) {
                    const tempsEcoule = maintenant - reservation.dateAssignation.toMillis();

                    if (tempsEcoule > timeout) {
                        console.log(`⚠️ Timeout: ${doc.id}`);
                        promesses.push(reassignerChauffeur(doc.id, reservation));
                    }
                }
            });

            await Promise.all(promesses);

            if (promesses.length > 0) {
                console.log(`✅ ${promesses.length} réassignations`);
            }

        } catch (error) {
            console.error('❌ Erreur timeout:', error);
        }
        return null;
    });

async function reassignerChauffeur(reservationId, reservation) {
    try {
        if (reservation.chauffeurAssigne) {
            await db.collection('drivers').doc(reservation.chauffeurAssigne).update({
                statut: 'disponible',
                currentBookingId: null,
                reservationEnCours: null
            });

            await db.collection('notifications').add({
                chauffeurId: reservation.chauffeurAssigne,
                type: 'course_retiree',
                reservationId: reservationId,
                message: 'Course retirée (timeout)',
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                lu: false
            });
        }

        await db.collection('reservations').doc(reservationId).update({
            statut: 'en_attente',
            chauffeurAssigne: null,
            nomChauffeur: null,
            telephoneChauffeur: null,
            dateAssignation: null,
            chauffeursRefuses: admin.firestore.FieldValue.arrayUnion(reservation.chauffeurAssigne || ''),
            tentativesAssignation: admin.firestore.FieldValue.increment(1)
        });

        console.log(`✅ Réservation ${reservationId} réinitialisée`);
    } catch (error) {
        console.error(`❌ Erreur réassignation ${reservationId}:`, error);
    }
}

// ==========================================
// VÉRIFICATION COHÉRENCE CHAUFFEURS
// ==========================================

exports.verifierCoherenceChauffeurs = onSchedule(
    {
        schedule: 'every 1 hours',
        region: REGION,
        timeoutSeconds: 120
    },
    async (event) => {
        console.log('🔍 Vérification cohérence...');

        try {
            const snapshot = await db.collection('drivers').get();
            const corrections = [];

            snapshot.forEach(doc => {
                const data = doc.data();

                if (data.currentBookingId !== data.reservationEnCours) {
                    let valeurCorrecte = null;

                    if (data.currentBookingId && !data.reservationEnCours) {
                        valeurCorrecte = data.currentBookingId;
                    } else if (data.reservationEnCours && !data.currentBookingId) {
                        valeurCorrecte = data.reservationEnCours;
                    } else if (data.currentBookingId && data.reservationEnCours) {
                        valeurCorrecte = data.currentBookingId;
                    } else {
                        return;
                    }

                    console.log(`🔧 Correction: ${doc.id}`);

                    corrections.push(
                        db.collection('drivers').doc(doc.id).update({
                            currentBookingId: valeurCorrecte,
                            reservationEnCours: valeurCorrecte
                        })
                    );
                }
            });

            if (corrections.length > 0) {
                await Promise.all(corrections);
                console.log(`✅ ${corrections.length} corrections`);
            }

        } catch (error) {
            console.error('❌ Erreur cohérence:', error);
        }
        return null;
    });

// ==========================================
// SECTION 2: TRACKING GPS EN TEMPS RÉEL
// ==========================================

exports.onDriverPositionUpdate = onDocumentUpdated(
    {
        document: 'drivers/{driverId}',
        region: REGION
    },
    async (event) => {
        const before = event.data.before.data();
        const after = event.data.after.data();
        const driverId = event.params.driverId;

        if (!after.position || !before.position) return null;

        const oldPos = before.position;
        const newPos = after.position;

        if (oldPos.latitude === newPos.latitude &&
            oldPos.longitude === newPos.longitude) {
            return null;
        }

        console.log(`📍 Position mise à jour: ${driverId}`);

        try {
            const distance = calculerDistance(
                oldPos.latitude,
                oldPos.longitude,
                newPos.latitude,
                newPos.longitude
            );

            const timeDiff = (newPos.timestamp?.toMillis() || Date.now()) -
                (oldPos.timestamp?.toMillis() || Date.now() - 3000);
            const vitesse = (distance / (timeDiff / 1000)) * 3.6;

            const anomalies = [];

            if (vitesse > TRACKING_CONFIG.speedThreshold) {
                anomalies.push(`Vitesse excessive: ${vitesse.toFixed(0)} km/h`);
            }

            if (newPos.accuracy > TRACKING_CONFIG.accuracyThreshold) {
                anomalies.push(`Précision GPS faible: ${newPos.accuracy}m`);
            }

            if (anomalies.length > 0) {
                await db.collection('tracking_anomalies').add({
                    driverId: driverId,
                    timestamp: admin.firestore.FieldValue.serverTimestamp(),
                    anomalies: anomalies,
                    position: newPos,
                    calculatedSpeed: vitesse
                });
            }

            await db.collection('driver_stats').doc(driverId).set({
                lastPosition: newPos,
                lastUpdate: admin.firestore.FieldValue.serverTimestamp(),
                calculatedSpeed: vitesse,
                totalDistanceToday: admin.firestore.FieldValue.increment(distance)
            }, { merge: true });

            if (after.currentBookingId) {
                await updateCourseTracking(after.currentBookingId, newPos, distance);
            }

        } catch (error) {
            console.error('❌ Erreur traitement position:', error);
        }
        return null;
    });

async function updateCourseTracking(courseId, position, distanceIncrement) {
    try {
        const courseRef = db.collection('reservations').doc(courseId);
        const courseDoc = await courseRef.get();

        if (!courseDoc.exists) return;

        const course = courseDoc.data();

        let eta = null;
        if (course.destinationCoords && position) {
            const distanceRestante = calculerDistance(
                position.latitude,
                position.longitude,
                course.destinationCoords.lat,
                course.destinationCoords.lng
            );
            const vitesseMoyenne = position.speed ? position.speed * 3.6 : 40;
            const tempsRestant = (distanceRestante / vitesseMoyenne) * 60;
            eta = new Date(Date.now() + tempsRestant * 60000);
        }

        await courseRef.update({
            chauffeurPosition: position,
            lastTrackingUpdate: admin.firestore.FieldValue.serverTimestamp(),
            distanceReelleParcourue: admin.firestore.FieldValue.increment(distanceIncrement * 1000),
            estimatedArrival: eta
        });

        console.log(`✅ Course ${courseId} trackée`);
    } catch (error) {
        console.error('❌ Erreur update course tracking:', error);
    }
}

// ==========================================
// DÉTECTION CHAUFFEURS INACTIFS
// ==========================================

exports.detectInactiveDrivers = onSchedule(
    {
        schedule: 'every 5 minutes',
        region: REGION,
        timeoutSeconds: 120
    },
    async (event) => {
        console.log('🔍 Vérification chauffeurs inactifs...');
        const cutoffTime = new Date(Date.now() - TRACKING_CONFIG.maxInactivityMinutes * 60000);

        try {
            const snapshot = await db.collection('drivers')
                .where('statut', 'in', ['disponible', 'en_course'])
                .get();

            const inactiveDrivers = [];

            snapshot.forEach(doc => {
                const data = doc.data();
                const lastUpdate = data.derniereActivite?.toDate() ||
                    data.position?.timestamp?.toDate();

                if (lastUpdate && lastUpdate < cutoffTime) {
                    inactiveDrivers.push({
                        id: doc.id,
                        nom: `${data.prenom} ${data.nom}`,
                        lastUpdate: lastUpdate,
                        statut: data.statut
                    });
                }
            });

            if (inactiveDrivers.length > 0) {
                console.log(`⚠️ ${inactiveDrivers.length} chauffeurs inactifs détectés`);

                await db.collection('notifications_admin').add({
                    type: 'chauffeurs_inactifs',
                    count: inactiveDrivers.length,
                    drivers: inactiveDrivers,
                    timestamp: admin.firestore.FieldValue.serverTimestamp(),
                    lu: false
                });

                const batch = db.batch();
                inactiveDrivers.forEach(driver => {
                    batch.update(db.collection('drivers').doc(driver.id), {
                        statut: 'hors_ligne',
                        inactivityDetected: true,
                        lastInactivityCheck: admin.firestore.FieldValue.serverTimestamp()
                    });
                });
                await batch.commit();
            }

        } catch (error) {
            console.error('❌ Erreur détection inactivité:', error);
        }
        return null;
    });

// ==========================================
// GÉOFENCING
// ==========================================

exports.checkGeofences = onDocumentCreated(
    {
        document: 'position_history/{positionId}',
        region: REGION
    },
    async (event) => {
        const position = event.data.data();
        const driverId = position.driverId;

        try {
            const geofencesSnapshot = await db.collection('geofences')
                .where('active', '==', true)
                .get();

            if (geofencesSnapshot.empty) return null;

            const alerts = [];

            geofencesSnapshot.forEach(doc => {
                const zone = doc.data();
                const distance = calculerDistance(
                    position.position.latitude,
                    position.position.longitude,
                    zone.center.latitude,
                    zone.center.longitude
                );

                if (distance <= zone.radius / 1000) {
                    alerts.push({
                        zoneId: doc.id,
                        zoneName: zone.name,
                        type: zone.type,
                        distance: distance
                    });
                }
            });

            if (alerts.length > 0) {
                await db.collection('geofence_events').add({
                    driverId: driverId,
                    position: position.position,
                    alerts: alerts,
                    timestamp: admin.firestore.FieldValue.serverTimestamp()
                });
                console.log(`🚨 ${alerts.length} alertes géofence pour ${driverId}`);
            }

        } catch (error) {
            console.error('❌ Erreur géofencing:', error);
        }
        return null;
    });

// ==========================================
// STATISTIQUES QUOTIDIENNES
// ==========================================

exports.calculateDailyTrackingStats = onSchedule(
    {
        schedule: 'every day 00:01',
        timeZone: 'Africa/Dakar',
        region: REGION,
        timeoutSeconds: 300
    },
    async (event) => {
        console.log('📊 Calcul stats tracking quotidiennes...');

        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        yesterday.setHours(0, 0, 0, 0);

        const today = new Date(yesterday);
        today.setDate(today.getDate() + 1);

        try {
            const driversSnapshot = await db.collection('drivers').get();

            const statsPromises = driversSnapshot.docs.map(async (driverDoc) => {
                const driverId = driverDoc.id;

                const positionsSnapshot = await db.collection('position_history')
                    .where('driverId', '==', driverId)
                    .where('timestamp', '>=', yesterday)
                    .where('timestamp', '<', today)
                    .orderBy('timestamp', 'asc')
                    .get();

                if (positionsSnapshot.empty) return null;

                let totalDistance = 0;
                let totalTime = 0;
                let maxSpeed = 0;
                let positionsCount = positionsSnapshot.size;

                const positions = [];
                positionsSnapshot.forEach(doc => positions.push(doc.data()));

                for (let i = 1; i < positions.length; i++) {
                    const prev = positions[i - 1];
                    const curr = positions[i];

                    const distance = calculerDistance(
                        prev.position.latitude,
                        prev.position.longitude,
                        curr.position.latitude,
                        curr.position.longitude
                    );

                    totalDistance += distance;

                    const speed = curr.speed || 0;
                    if (speed > maxSpeed) maxSpeed = speed;

                    const timeDiff = (curr.timestamp?.toMillis() || 0) -
                        (prev.timestamp?.toMillis() || 0);
                    totalTime += timeDiff;
                }

                await db.collection('daily_tracking_stats').add({
                    driverId: driverId,
                    date: yesterday,
                    totalDistance: totalDistance,
                    totalTime: totalTime / 1000 / 60,
                    averageSpeed: totalDistance / (totalTime / 1000 / 3600),
                    maxSpeed: maxSpeed * 3.6,
                    positionsCount: positionsCount,
                    createdAt: admin.firestore.FieldValue.serverTimestamp()
                });

                console.log(`✅ Stats calculées pour ${driverId}: ${totalDistance.toFixed(2)} km`);

                return { driverId: driverId, distance: totalDistance };
            });

            const results = await Promise.all(statsPromises);
            const validResults = results.filter(r => r !== null);
            console.log(`✅ Stats calculées pour ${validResults.length} chauffeurs`);

        } catch (error) {
            console.error('❌ Erreur calcul stats:', error);
        }
        return null;
    });

// ==========================================
// NETTOYAGE HISTORIQUE POSITIONS
// ==========================================

exports.cleanupOldPositionHistory = onSchedule(
    {
        schedule: 'every day 02:00',
        timeZone: 'Africa/Dakar',
        region: REGION,
        timeoutSeconds: 300
    },
    async (event) => {
        console.log('🧹 Nettoyage historique positions...');

        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - 7);

        try {
            let deletedCount = 0;
            let hasMore = true;

            while (hasMore) {
                const snapshot = await db.collection('position_history')
                    .where('timestamp', '<', cutoffDate)
                    .limit(500)
                    .get();

                if (snapshot.empty) {
                    hasMore = false;
                    break;
                }

                const batch = db.batch();
                snapshot.docs.forEach(doc => {
                    batch.delete(doc.ref);
                });
                await batch.commit();

                deletedCount += snapshot.size;
                console.log(`🗑️ ${deletedCount} positions supprimées...`);
            }

            console.log(`✅ Nettoyage terminé: ${deletedCount} positions supprimées`);

            await db.collection('system_logs').add({
                type: 'cleanup_position_history',
                deletedCount: deletedCount,
                cutoffDate: cutoffDate,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });

        } catch (error) {
            console.error('❌ Erreur nettoyage:', error);
        }
        return null;
    });

// ==========================================
// SECTION 3: CRÉDITS AUTOMATIQUES (SÉCURISÉ)
// ==========================================

exports.crediterChauffeurAutomatique = onDocumentUpdated(
    {
        document: 'reservations/{reservationId}',
        region: REGION
    },
    async (event) => {
        const before = event.data.before.data();
        const after = event.data.after.data();
        const reservationId = event.params.reservationId;

        // Vérifier que paiementValide vient de passer à true
        if (before.paiementValide === true || after.paiementValide !== true) {
            return null;
        }

        console.log(`💰 [CRÉDIT AUTO] Paiement détecté: ${reservationId}`);

        if (after.statut !== 'terminee') {
            console.log(`⏭️ Statut non terminé: ${after.statut}`);
            return null;
        }

        // PROTECTION 1: Vérification préliminaire du flag
        if (after.chauffeurCredite === true) {
            console.log(`⏭️ Déjà marqué comme crédité`);
            return null;
        }

        if (!after.chauffeurAssigne) {
            console.log(`❌ Pas de chauffeur assigné`);
            return null;
        }

        const driverId = after.chauffeurAssigne;
        const prixEstime = parseMoney(after.prixEstime);

        if (prixEstime <= 0) {
            console.log(`❌ Prix invalide: ${prixEstime}`);
            return null;
        }

        const creditOperationId = `credit_${reservationId}_${Date.now()}`;
        const netAmount = Math.round(prixEstime * PAYMENT_CONFIG.driverRate);
        const platformAmount = prixEstime - netAmount;

        console.log(`💵 Montant à créditer: ${netAmount} FCFA`);

        try {
            const result = await db.runTransaction(async (transaction) => {
                const reservationRef = db.collection('reservations').doc(reservationId);
                const reservationDoc = await transaction.get(reservationRef);

                if (!reservationDoc.exists) {
                    throw new Error('RESERVATION_NOT_FOUND');
                }

                const reservationData = reservationDoc.data();

                // PROTECTION 2: Double vérification DANS la transaction
                if (reservationData.chauffeurCredite === true) {
                    console.log(`🛑 PROTECTION: Déjà crédité (détecté dans transaction)`);
                    return { alreadyCredited: true };
                }

                // PROTECTION 3: Vérifier que le statut n'a pas changé
                if (reservationData.statut !== 'terminee') {
                    throw new Error('STATUS_CHANGED');
                }

                // PROTECTION 4: Vérifier que le paiement est toujours validé
                if (reservationData.paiementValide !== true) {
                    throw new Error('PAYMENT_NOT_VALIDATED');
                }

                // PROTECTION 5: Vérifier que c'est le bon chauffeur
                if (reservationData.chauffeurAssigne !== driverId) {
                    throw new Error('DRIVER_MISMATCH');
                }

                // PROTECTION 6: Vérifier qu'il n'y a pas déjà un crédit en cours
                if (reservationData.creditEnCours === true) {
                    console.log(`🛑 PROTECTION: Crédit déjà en cours`);
                    return { creditInProgress: true };
                }

                const driverRef = db.collection('drivers').doc(driverId);
                const driverDoc = await transaction.get(driverRef);

                if (!driverDoc.exists) {
                    throw new Error('DRIVER_NOT_FOUND');
                }

                const driverData = driverDoc.data();

                const oldSolde = parseMoney(driverData.soldeDisponible || driverData.SoldeDisponible);
                const newSolde = oldSolde + netAmount;

                const oldRevenusJour = parseMoney(driverData.revenusJour);
                const oldRevenusSemaine = parseMoney(driverData.revenusSemaine);
                const oldRevenusMois = parseMoney(driverData.revenusMois);
                const oldRevenusTotal = parseMoney(driverData.revenusTotal);
                const oldCoursesCompletees = driverData.coursesCompletees || 0;

                console.log(`📊 Solde: ${oldSolde} → ${newSolde} FCFA`);

                // Mise à jour du chauffeur
                transaction.update(driverRef, {
                    soldeDisponible: newSolde,
                    revenusJour: oldRevenusJour + netAmount,
                    revenusSemaine: oldRevenusSemaine + netAmount,
                    revenusMois: oldRevenusMois + netAmount,
                    revenusTotal: oldRevenusTotal + netAmount,
                    coursesCompletees: oldCoursesCompletees + 1,
                    dernierCredit: admin.firestore.FieldValue.serverTimestamp(),
                    dernierCreditMontant: netAmount,
                    dernierCreditReservation: reservationId
                });

                // Mise à jour de la réservation avec FLAG DE PROTECTION
                transaction.update(reservationRef, {
                    chauffeurCredite: true,
                    creditEnCours: false,
                    dateCreditChauffeur: admin.firestore.FieldValue.serverTimestamp(),
                    montantCrediteChauffeur: netAmount,
                    montantPlateforme: platformAmount,
                    creditOperationId: creditOperationId,
                    creditVersion: 'cloud-function-v2.0-secure',
                    ancienSoldeChauffeur: oldSolde,
                    nouveauSoldeChauffeur: newSolde
                });

                return {
                    success: true,
                    oldSolde: oldSolde,
                    newSolde: newSolde,
                    netAmount: netAmount
                };
            });

            if (result.alreadyCredited || result.creditInProgress) {
                console.log(`⏭️ Opération ignorée (protection activée)`);
                return null;
            }

            console.log(`✅ CRÉDIT RÉUSSI: ${result.netAmount} FCFA pour ${driverId}`);

            await db.collection('notifications').add({
                chauffeurId: driverId,
                type: 'credit_recu',
                reservationId: reservationId,
                montant: result.netAmount,
                message: `Vous avez reçu ${result.netAmount} FCFA`,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                lu: false
            });

            await db.collection('credit_logs').add({
                reservationId: reservationId,
                chauffeurId: driverId,
                operationId: creditOperationId,
                montantCourse: prixEstime,
                montantChauffeur: result.netAmount,
                montantPlateforme: platformAmount,
                ancienSolde: result.oldSolde,
                nouveauSolde: result.newSolde,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                success: true,
                version: 'v2.0-secure'
            });

            return null;

        } catch (error) {
            console.error(`❌ ERREUR CRÉDIT ${reservationId}:`, error.message);

            await db.collection('credit_errors').add({
                reservationId: reservationId,
                chauffeurId: driverId,
                operationId: creditOperationId,
                errorMessage: error.message,
                errorCode: error.code || 'UNKNOWN',
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });

            return null;
        }
    });

// ==========================================
// RÉCUPÉRATION CRÉDITS MANQUÉS
// ==========================================

exports.recupererCreditsManques = onCall({ region: REGION }, async (request) => {
    const { adminToken } = request.data;

    if (!request.auth && !adminToken) {
        throw new Error('Non authentifié');
    }

    console.log('🔧 [RÉCUP] Recherche des crédits manqués...');

    try {
        const snapshot = await db.collection('reservations')
            .where('statut', '==', 'terminee')
            .where('paiementValide', '==', true)
            .where('chauffeurCredite', '==', false)
            .get();

        if (snapshot.empty) {
            return {
                success: true,
                message: 'Aucun crédit manqué trouvé',
                count: 0
            };
        }

        console.log(`🔍 [RÉCUP] ${snapshot.size} crédits manqués trouvés`);

        const results = [];

        for (const doc of snapshot.docs) {
            const reservationId = doc.id;
            const reservation = doc.data();

            try {
                const driverId = reservation.chauffeurAssigne;
                const prixEstime = parseMoney(reservation.prixEstime);
                const netAmount = Math.round(prixEstime * PAYMENT_CONFIG.driverRate);
                const platformAmount = prixEstime - netAmount;

                await db.runTransaction(async (transaction) => {
                    const driverRef = db.collection('drivers').doc(driverId);
                    const driverDoc = await transaction.get(driverRef);

                    if (!driverDoc.exists) {
                        throw new Error('Driver not found');
                    }

                    const driverData = driverDoc.data();
                    const oldSolde = parseMoney(driverData.soldeDisponible || driverData.SoldeDisponible);
                    const newSolde = oldSolde + netAmount;

                    transaction.update(driverRef, {
                        soldeDisponible: newSolde,
                        revenusTotal: admin.firestore.FieldValue.increment(netAmount)
                    });

                    transaction.update(doc.ref, {
                        chauffeurCredite: true,
                        dateCreditChauffeur: admin.firestore.FieldValue.serverTimestamp(),
                        montantCrediteChauffeur: netAmount,
                        montantPlateforme: platformAmount,
                        creditVersion: 'recovery-manual'
                    });
                });

                results.push({
                    reservationId: reservationId,
                    success: true,
                    montant: netAmount
                });

                console.log(`✅ [RÉCUP] ${reservationId}: ${netAmount} FCFA`);

            } catch (error) {
                results.push({
                    reservationId: reservationId,
                    success: false,
                    error: error.message
                });

                console.error(`❌ [RÉCUP] ${reservationId}:`, error.message);
            }
        }

        const successCount = results.filter(r => r.success).length;

        return {
            success: true,
            message: `${successCount}/${results.length} crédits récupérés`,
            count: successCount,
            details: results
        };

    } catch (error) {
        console.error('❌ [RÉCUP] Erreur:', error);
        throw new Error(error.message);
    }
});

// ==========================================
// VÉRIFICATION DOUBLONS CRÉDITS
// ==========================================

exports.verifierDoublonsCredits = onCall({ region: REGION }, async (request) => {
    const { adminToken } = request.data;

    if (!request.auth && !adminToken) {
        throw new Error('Non authentifié');
    }

    console.log('🔍 Recherche de doublons de crédits...');

    try {
        const logsSnapshot = await db.collection('credit_logs')
            .where('success', '==', true)
            .orderBy('timestamp', 'desc')
            .limit(1000)
            .get();

        const creditsByReservation = {};

        logsSnapshot.forEach(doc => {
            const data = doc.data();
            const resId = data.reservationId;

            if (!creditsByReservation[resId]) {
                creditsByReservation[resId] = [];
            }
            creditsByReservation[resId].push({
                logId: doc.id,
                montant: data.montantChauffeur,
                timestamp: data.timestamp?.toDate(),
                chauffeurId: data.chauffeurId
            });
        });

        const doublons = [];

        for (const [resId, credits] of Object.entries(creditsByReservation)) {
            if (credits.length > 1) {
                doublons.push({
                    reservationId: resId,
                    nombreCredits: credits.length,
                    totalCredite: credits.reduce((sum, c) => sum + c.montant, 0),
                    details: credits
                });
            }
        }

        if (doublons.length === 0) {
            return {
                success: true,
                message: '✅ Aucun doublon détecté',
                doublonsCount: 0
            };
        }

        console.warn(`⚠️ ${doublons.length} doublons détectés!`);

        return {
            success: true,
            message: `⚠️ ${doublons.length} doublons détectés`,
            doublonsCount: doublons.length,
            doublons: doublons
        };

    } catch (error) {
        console.error('❌ Erreur:', error);
        throw new Error(error.message);
    }
});

// ==========================================
// SECTION 4: APIs TRACKING
// ==========================================

exports.getDriverTrackingHistory = onCall({ region: REGION }, async (request) => {
    const { driverId, startDate, endDate, sessionId } = request.data;

    if (!driverId) {
        throw new Error('Driver ID requis');
    }

    try {
        let query = db.collection('position_history')
            .where('driverId', '==', driverId);

        if (sessionId) {
            query = query.where('sessionId', '==', sessionId);
        }

        if (startDate) {
            query = query.where('timestamp', '>=', new Date(startDate));
        }

        if (endDate) {
            query = query.where('timestamp', '<=', new Date(endDate));
        }

        query = query.orderBy('timestamp', 'asc').limit(1000);

        const snapshot = await query.get();
        const positions = [];

        snapshot.forEach(doc => {
            const data = doc.data();
            positions.push({
                lat: data.position.latitude,
                lng: data.position.longitude,
                speed: data.speed,
                accuracy: data.accuracy,
                timestamp: data.timestamp?.toDate()
            });
        });

        return {
            success: true,
            count: positions.length,
            positions: positions
        };

    } catch (error) {
        console.error('❌ Erreur:', error);
        throw new Error(error.message);
    }
});

exports.getDriverTrackingStats = onCall({ region: REGION }, async (request) => {
    const { driverId, period } = request.data;

    if (!driverId) {
        throw new Error('Driver ID requis');
    }

    try {
        const stats = {
            today: {},
            week: {},
            month: {},
            total: {}
        };

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const todaySnapshot = await db.collection('position_history')
            .where('driverId', '==', driverId)
            .where('timestamp', '>=', today)
            .get();

        stats.today = await calculateStatsFromPositions(todaySnapshot);

        const weekAgo = new Date();
        weekAgo.setDate(weekAgo.getDate() - 7);
        weekAgo.setHours(0, 0, 0, 0);

        const weekSnapshot = await db.collection('daily_tracking_stats')
            .where('driverId', '==', driverId)
            .where('date', '>=', weekAgo)
            .get();

        stats.week = aggregateDailyStats(weekSnapshot);

        const monthAgo = new Date();
        monthAgo.setDate(monthAgo.getDate() - 30);
        monthAgo.setHours(0, 0, 0, 0);

        const monthSnapshot = await db.collection('daily_tracking_stats')
            .where('driverId', '==', driverId)
            .where('date', '>=', monthAgo)
            .get();

        stats.month = aggregateDailyStats(monthSnapshot);

        return {
            success: true,
            stats: stats
        };

    } catch (error) {
        console.error('❌ Erreur:', error);
        throw new Error(error.message);
    }
});

// ==========================================
// FONCTIONS UTILITAIRES
// ==========================================

function calculerDistance(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function toRad(valeur) {
    return valeur * Math.PI / 180;
}

async function calculateStatsFromPositions(snapshot) {
    if (snapshot.empty) {
        return {
            totalDistance: 0,
            averageSpeed: 0,
            maxSpeed: 0,
            positionsCount: 0
        };
    }

    let totalDistance = 0;
    let maxSpeed = 0;
    const positions = [];

    snapshot.forEach(doc => positions.push(doc.data()));

    for (let i = 1; i < positions.length; i++) {
        const prev = positions[i - 1];
        const curr = positions[i];

        const distance = calculerDistance(
            prev.position.latitude,
            prev.position.longitude,
            curr.position.latitude,
            curr.position.longitude
        );

        totalDistance += distance;

        const speed = (curr.speed || 0) * 3.6;
        if (speed > maxSpeed) maxSpeed = speed;
    }

    return {
        totalDistance: totalDistance,
        averageSpeed: positions.length > 0 ?
            positions.reduce((sum, p) => sum + ((p.speed || 0) * 3.6), 0) / positions.length : 0,
        maxSpeed: maxSpeed,
        positionsCount: positions.length
    };
}

function aggregateDailyStats(snapshot) {
    if (snapshot.empty) {
        return {
            totalDistance: 0,
            averageSpeed: 0,
            maxSpeed: 0,
            totalTime: 0
        };
    }

    let totalDistance = 0;
    let totalTime = 0;
    let maxSpeed = 0;
    let speedSum = 0;
    let count = 0;

    snapshot.forEach(doc => {
        const data = doc.data();
        totalDistance += data.totalDistance || 0;
        totalTime += data.totalTime || 0;
        if ((data.maxSpeed || 0) > maxSpeed) maxSpeed = data.maxSpeed;
        speedSum += data.averageSpeed || 0;
        count++;
    });

    return {
        totalDistance: totalDistance,
        averageSpeed: count > 0 ? speedSum / count : 0,
        maxSpeed: maxSpeed,
        totalTime: totalTime
    };
}

// ==========================================
// COORDONNÉES - 174 QUARTIERS DE DAKAR
// ==========================================

function getDefaultCoordsForAddress(address) {
    const coords = {
        // ZONE 1: DAKAR PLATEAU
        'plateau': { lat: 14.6928, lng: -17.4467 },
        'place de l\'indépendance': { lat: 14.6928, lng: -17.4467 },
        'rebeuss': { lat: 14.6850, lng: -17.4450 },
        'port': { lat: 14.6800, lng: -17.4150 },
        'petersen': { lat: 14.6890, lng: -17.4380 },
        'sandaga': { lat: 14.6750, lng: -17.4300 },
        'tilene': { lat: 14.6800, lng: -17.4200 },
        'kermel': { lat: 14.6700, lng: -17.4350 },
        'marché sandaga': { lat: 14.6750, lng: -17.4300 },
        'marché kermel': { lat: 14.6700, lng: -17.4350 },
        'gare routière': { lat: 14.6780, lng: -17.4400 },
        'dieuppeul': { lat: 14.6900, lng: -17.4600 },
        'medina': { lat: 14.6738, lng: -17.4387 },
        'gueule tapée': { lat: 14.6800, lng: -17.4350 },
        'gueule tapee': { lat: 14.6800, lng: -17.4350 },

        // ZONE 2: MEDINA / FASS
        'fass': { lat: 14.6820, lng: -17.4500 },
        'fass delorme': { lat: 14.6850, lng: -17.4520 },
        'colobane': { lat: 14.6870, lng: -17.4550 },
        'gueule tapée fass colobane': { lat: 14.6830, lng: -17.4480 },
        'ndiolofene': { lat: 14.6760, lng: -17.4420 },
        'derklé': { lat: 14.6790, lng: -17.4460 },
        'derkle': { lat: 14.6790, lng: -17.4460 },
        'reubeuss': { lat: 14.6850, lng: -17.4450 },
        'somba gueladio': { lat: 14.6880, lng: -17.4380 },
        'scat urbam': { lat: 14.6810, lng: -17.4490 },
        'nim': { lat: 14.6795, lng: -17.4365 },
        'dalifort': { lat: 14.7200, lng: -17.4100 },

        // ZONE 3: FANN / POINT E / MERMOZ
        'fann': { lat: 14.6872, lng: -17.4535 },
        'fann résidence': { lat: 14.6890, lng: -17.4550 },
        'fann residence': { lat: 14.6890, lng: -17.4550 },
        'point e': { lat: 14.6953, lng: -17.4614 },
        'point-e': { lat: 14.6953, lng: -17.4614 },
        'amitié': { lat: 14.7014, lng: -17.4647 },
        'amitie': { lat: 14.7014, lng: -17.4647 },
        'sacré-coeur': { lat: 14.6937, lng: -17.4441 },
        'sacre-coeur': { lat: 14.6937, lng: -17.4441 },
        'sacre coeur': { lat: 14.6937, lng: -17.4441 },
        'mermoz': { lat: 14.7108, lng: -17.4682 },
        'pyrotechnie': { lat: 14.6920, lng: -17.4580 },
        'cité asecna': { lat: 14.7050, lng: -17.4700 },
        'cite asecna': { lat: 14.7050, lng: -17.4700 },
        'sicap baobabs': { lat: 14.7100, lng: -17.4650 },
        'keur gorgui': { lat: 14.7020, lng: -17.4620 },
        'fann bel air': { lat: 14.6900, lng: -17.4560 },
        'fann bel-air': { lat: 14.6900, lng: -17.4560 },

        // ZONE 4: SICAP / HLM / GRAND YOFF
        'sicap': { lat: 14.7289, lng: -17.4594 },
        'hlm': { lat: 14.7306, lng: -17.4542 },
        'hlm grand yoff': { lat: 14.7350, lng: -17.4600 },
        'hlm grand-yoff': { lat: 14.7350, lng: -17.4600 },
        'grand yoff': { lat: 14.7400, lng: -17.4700 },
        'grand-yoff': { lat: 14.7400, lng: -17.4700 },
        'village grand yoff': { lat: 14.7450, lng: -17.4750 },
        'arafat': { lat: 14.7380, lng: -17.4650 },
        'cité millionnaire': { lat: 14.7320, lng: -17.4570 },
        'cite millionnaire': { lat: 14.7320, lng: -17.4570 },
        'sipres': { lat: 14.7340, lng: -17.4610 },
        'sicap rue 10': { lat: 14.7270, lng: -17.4580 },
        'sicap amitié': { lat: 14.7280, lng: -17.4600 },
        'sicap amitie': { lat: 14.7280, lng: -17.4600 },
        'sicap baobab': { lat: 14.7290, lng: -17.4620 },
        'sicap mbao': { lat: 14.7300, lng: -17.4560 },
        'sicap foire': { lat: 14.7250, lng: -17.4550 },
        'dieuppeul derklé': { lat: 14.7150, lng: -17.4650 },
        'dieuppeul derkle': { lat: 14.7150, lng: -17.4650 },
        'camp pénal': { lat: 14.7360, lng: -17.4580 },
        'camp penal': { lat: 14.7360, lng: -17.4580 },
        'castors': { lat: 14.7420, lng: -17.4720 },

        // ZONE 5: PARCELLES ASSAINIES
        'parcelles assainies': { lat: 14.7369, lng: -17.4731 },
        'parcelles': { lat: 14.7369, lng: -17.4731 },
        'unité 1': { lat: 14.7300, lng: -17.4650 },
        'unite 1': { lat: 14.7300, lng: -17.4650 },
        'unité 2': { lat: 14.7320, lng: -17.4680 },
        'unite 2': { lat: 14.7320, lng: -17.4680 },
        'unité 3': { lat: 14.7340, lng: -17.4710 },
        'unite 3': { lat: 14.7340, lng: -17.4710 },
        'unité 4': { lat: 14.7360, lng: -17.4740 },
        'unite 4': { lat: 14.7360, lng: -17.4740 },
        'unité 5': { lat: 14.7380, lng: -17.4770 },
        'unite 5': { lat: 14.7380, lng: -17.4770 },
        'unité 6': { lat: 14.7400, lng: -17.4800 },
        'unite 6': { lat: 14.7400, lng: -17.4800 },
        'unité 7': { lat: 14.7420, lng: -17.4830 },
        'unite 7': { lat: 14.7420, lng: -17.4830 },
        'unité 8': { lat: 14.7440, lng: -17.4860 },
        'unite 8': { lat: 14.7440, lng: -17.4860 },
        'unité 9': { lat: 14.7460, lng: -17.4890 },
        'unite 9': { lat: 14.7460, lng: -17.4890 },
        'unité 10': { lat: 14.7480, lng: -17.4920 },
        'unite 10': { lat: 14.7480, lng: -17.4920 },
        'cambérène': { lat: 14.7500, lng: -17.4950 },
        'camberene': { lat: 14.7500, lng: -17.4950 },
        'apecsy': { lat: 14.7350, lng: -17.4760 },
        'apix': { lat: 14.7370, lng: -17.4780 },

        // ZONE 6: OUEST (ALMADIES/NGOR/YOFF/OUAKAM)
        'almadies': { lat: 14.7247, lng: -17.5050 },
        'les almadies': { lat: 14.7247, lng: -17.5050 },
        'pointe des almadies': { lat: 14.7200, lng: -17.5300 },
        'ngor': { lat: 14.7517, lng: -17.5192 },
        'virage ngor': { lat: 14.7500, lng: -17.5150 },
        'village ngor': { lat: 14.7550, lng: -17.5250 },
        'ile de ngor': { lat: 14.7600, lng: -17.5350 },
        'yoff': { lat: 14.7500, lng: -17.4833 },
        'village yoff': { lat: 14.7550, lng: -17.4900 },
        'tonghor': { lat: 14.7530, lng: -17.4850 },
        'aeroport yoff': { lat: 14.7400, lng: -17.4900 },
        'aéroport yoff': { lat: 14.7400, lng: -17.4900 },
        'ouakam': { lat: 14.7200, lng: -17.4900 },
        'cité des eaux': { lat: 14.7150, lng: -17.4950 },
        'cite des eaux': { lat: 14.7150, lng: -17.4950 },
        'mamelles': { lat: 14.7100, lng: -17.5000 },
        'les mamelles': { lat: 14.7100, lng: -17.5000 },
        'virage': { lat: 14.7314, lng: -17.4636 },
        'cité sonatel': { lat: 14.7250, lng: -17.4850 },
        'cite sonatel': { lat: 14.7250, lng: -17.4850 },

        // ZONE 7: LIBERTÉ / GRAND DAKAR / HANN
        'liberté': { lat: 14.7186, lng: -17.4697 },
        'liberte': { lat: 14.7186, lng: -17.4697 },
        'liberté 1': { lat: 14.7150, lng: -17.4650 },
        'liberte 1': { lat: 14.7150, lng: -17.4650 },
        'liberté 2': { lat: 14.7170, lng: -17.4680 },
        'liberte 2': { lat: 14.7170, lng: -17.4680 },
        'liberté 3': { lat: 14.7190, lng: -17.4710 },
        'liberte 3': { lat: 14.7190, lng: -17.4710 },
        'liberté 4': { lat: 14.7210, lng: -17.4740 },
        'liberte 4': { lat: 14.7210, lng: -17.4740 },
        'liberté 5': { lat: 14.7230, lng: -17.4770 },
        'liberte 5': { lat: 14.7230, lng: -17.4770 },
        'liberté 6': { lat: 14.7250, lng: -17.4800 },
        'liberte 6': { lat: 14.7250, lng: -17.4800 },
        'grand dakar': { lat: 14.6928, lng: -17.4580 },
        'grand-dakar': { lat: 14.6928, lng: -17.4580 },
        'hann': { lat: 14.7150, lng: -17.4380 },
        'bel air': { lat: 14.7100, lng: -17.4400 },
        'bel-air': { lat: 14.7100, lng: -17.4400 },
        'halte de hann': { lat: 14.7150, lng: -17.4380 },
        'marché hann': { lat: 14.7130, lng: -17.4350 },
        'marche hann': { lat: 14.7130, lng: -17.4350 },
        'hann bel air': { lat: 14.7120, lng: -17.4390 },
        'hann bel-air': { lat: 14.7120, lng: -17.4390 },
        'hann maristes': { lat: 14.7140, lng: -17.4360 },
        'patte d\'oie': { lat: 14.7200, lng: -17.4500 },
        'patte d\'oie builders': { lat: 14.7220, lng: -17.4520 },

        // ZONE 8: PIKINE
        'pikine': { lat: 14.7549, lng: -17.3940 },
        'pikine nord': { lat: 14.7600, lng: -17.3950 },
        'pikine est': { lat: 14.7550, lng: -17.3850 },
        'pikine ouest': { lat: 14.7500, lng: -17.4000 },
        'pikine sud': { lat: 14.7480, lng: -17.3900 },
        'thiaroye': { lat: 14.7730, lng: -17.3610 },
        'thiaroye sur mer': { lat: 14.7750, lng: -17.3550 },
        'diamaguène': { lat: 14.7600, lng: -17.3800 },
        'diamaguene': { lat: 14.7600, lng: -17.3800 },
        'icotaf': { lat: 14.7650, lng: -17.3700 },
        'guinaw rail': { lat: 14.7520, lng: -17.3880 },

        // ZONE 9: GUÉDIAWAYE
        'guédiawaye': { lat: 14.7690, lng: -17.3990 },
        'guediawaye': { lat: 14.7690, lng: -17.3990 },
        'sam notaire': { lat: 14.7700, lng: -17.4100 },
        'sam': { lat: 14.7700, lng: -17.4100 },
        'ndiarème limamoulaye': { lat: 14.7720, lng: -17.4050 },
        'ndiarem limamoulaye': { lat: 14.7720, lng: -17.4050 },
        'golf sud': { lat: 14.7750, lng: -17.4200 },
        'hamo': { lat: 14.7770, lng: -17.4150 },
        'médina gounass': { lat: 14.7680, lng: -17.3950 },
        'medina gounass': { lat: 14.7680, lng: -17.3950 },
        'wakhinane': { lat: 14.7730, lng: -17.4000 },
        'golf': { lat: 14.7750, lng: -17.4200 },
        'ndiarème': { lat: 14.7720, lng: -17.4050 },
        'ndiarem': { lat: 14.7720, lng: -17.4050 },

        // ZONE 10: KEUR MASSAR
        'keur massar': { lat: 14.7833, lng: -17.3167 },
        'keurmassar': { lat: 14.7833, lng: -17.3167 },
        'keur massar centre': { lat: 14.7833, lng: -17.3167 },
        'keur massar ville': { lat: 14.7850, lng: -17.3150 },
        'keur massar marché': { lat: 14.7820, lng: -17.3180 },
        'keur massar marche': { lat: 14.7820, lng: -17.3180 },
        'boune': { lat: 14.7950, lng: -17.3250 },
        'boune 1': { lat: 14.7960, lng: -17.3240 },
        'boune 2': { lat: 14.7970, lng: -17.3260 },
        'boune 3': { lat: 14.7980, lng: -17.3280 },
        'tivaouane peulh': { lat: 14.8050, lng: -17.3300 },
        'tivaouane peul': { lat: 14.8050, lng: -17.3300 },
        'tivaoune peul': { lat: 14.8050, lng: -17.3300 },
        'tivaouane peulh niaga': { lat: 14.8070, lng: -17.3280 },
        'jaxaay': { lat: 14.7800, lng: -17.2950 },
        'djaxaay': { lat: 14.7800, lng: -17.2950 },
        'jaxaye': { lat: 14.7800, lng: -17.2950 },
        'jaxaay parcelles': { lat: 14.7820, lng: -17.2920 },
        'bambilor': { lat: 14.7780, lng: -17.2900 },
        'yeumbeul': { lat: 14.7720, lng: -17.3420 },
        'yembeul': { lat: 14.7720, lng: -17.3420 },
        'yeumbeul nord': { lat: 14.7750, lng: -17.3400 },
        'yeumbeul sud': { lat: 14.7700, lng: -17.3450 },
        'malika': { lat: 14.7800, lng: -17.3600 },
        'malika centre': { lat: 14.7800, lng: -17.3600 },
        'mbeubeuss': { lat: 14.7750, lng: -17.3000 },
        'mbeubeus': { lat: 14.7750, lng: -17.3000 },
        'ndiaganiao': { lat: 14.7900, lng: -17.3050 },
        'cité keur damel': { lat: 14.7860, lng: -17.3200 },
        'cite keur damel': { lat: 14.7860, lng: -17.3200 },
        'diamaguène sicap mbao': { lat: 14.7650, lng: -17.3100 },
        'diamaguene sicap mbao': { lat: 14.7650, lng: -17.3100 },
        'mbao': { lat: 14.7300, lng: -17.3200 },

        // ZONES PÉRIPHÉRIQUES
        'rufisque': { lat: 14.7167, lng: -17.2667 },
        'bargny': { lat: 14.7000, lng: -17.2167 },
        'sangalkam': { lat: 14.8000, lng: -17.2500 }
    };

    const addressLower = address.toLowerCase();

    for (const [quartier, coordonnees] of Object.entries(coords)) {
        if (addressLower.includes(quartier)) {
            console.log(`✅ Quartier: "${quartier}" → [${coordonnees.lat}, ${coordonnees.lng}]`);
            return coordonnees;
        }
    }

    console.warn(`⚠️ Adresse non reconnue: "${address}" - Utilisation Plateau par défaut`);
    return { lat: 14.6928, lng: -17.4467 };
}

module.exports = { getDefaultCoordsForAddress };
