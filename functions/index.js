const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore();

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

// ⭐ CONFIGURATION PAIEMENT - DÉFINIE AU DÉBUT ⭐
const PAYMENT_CONFIG = {
    driverRate: 0.70,      // 70% pour le chauffeur
    platformRate: 0.30     // 30% pour la plateforme
};

// ==========================================
// FONCTIONS UTILITAIRES
// ==========================================

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

// ==========================================
// SECTION 1: ASSIGNATION AUTOMATIQUE
// ==========================================

exports.assignerChauffeurAutomatique = functions.firestore
    .document('reservations/{reservationId}')
    .onCreate(async (snap, context) => {
        const reservation = snap.data();
        const reservationId = context.params.reservationId;

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
// SECTION 2: CRÉDIT AUTOMATIQUE CHAUFFEUR
// ⭐ VERSION CORRIGÉE AVEC PROTECTION ANTI-DOUBLON ⭐
// ==========================================

exports.crediterChauffeurAutomatique = functions.firestore
    .document('reservations/{reservationId}')
    .onUpdate(async (change, context) => {
        const before = change.before.data();
        const after = change.after.data();
        const reservationId = context.params.reservationId;

        // ==========================================
        // 🛡️ PROTECTION 1: Vérifier que c'est bien un changement de paiementValide
        // ==========================================
        const paiementAvant = before.paiementValide === true;
        const paiementApres = after.paiementValide === true;
        
        // Si le paiement était déjà validé AVANT, on ignore
        if (paiementAvant) {
            return null;
        }
        
        // Si le paiement n'est pas validé APRÈS, on ignore
        if (!paiementApres) {
            return null;
        }

        console.log(`💰 [CRÉDIT AUTO] Paiement détecté pour réservation: ${reservationId}`);

        // ==========================================
        // 🛡️ PROTECTION 2: Vérifier le statut terminee
        // ==========================================
        if (after.statut !== 'terminee') {
            console.log(`⏭️ [CRÉDIT AUTO] Course pas terminée (statut: ${after.statut}), ignorée`);
            return null;
        }

        // ==========================================
        // 🛡️ PROTECTION 3: Vérifier si déjà crédité (données trigger)
        // ==========================================
        if (after.chauffeurCredite === true) {
            console.log(`⏭️ [CRÉDIT AUTO] Déjà marqué comme crédité, ignoré`);
            return null;
        }

        // ==========================================
        // 🛡️ PROTECTION 4: Vérifier chauffeur assigné
        // ==========================================
        if (!after.chauffeurAssigne) {
            console.log(`❌ [CRÉDIT AUTO] Pas de chauffeur assigné`);
            return null;
        }

        const driverId = after.chauffeurAssigne;
        const prixCourse = parseMoney(after.prixEstime);

        if (prixCourse <= 0) {
            console.log(`❌ [CRÉDIT AUTO] Prix invalide: ${prixCourse}`);
            return null;
        }

        // Calcul des montants
        const montantChauffeur = Math.round(prixCourse * PAYMENT_CONFIG.driverRate);
        const montantPlateforme = prixCourse - montantChauffeur;

        console.log(`💵 [CRÉDIT AUTO] Prix: ${prixCourse} FCFA | Chauffeur: ${montantChauffeur} FCFA (${PAYMENT_CONFIG.driverRate * 100}%) | Plateforme: ${montantPlateforme} FCFA`);

        try {
            // ==========================================
            // 🔒 TRANSACTION ATOMIQUE AVEC DOUBLE VÉRIFICATION
            // ==========================================
            const resultat = await db.runTransaction(async (transaction) => {
                const reservationRef = db.collection('reservations').doc(reservationId);
                const reservationDoc = await transaction.get(reservationRef);

                if (!reservationDoc.exists) {
                    throw new Error('RESERVATION_NOT_FOUND');
                }

                const reservationData = reservationDoc.data();

                // ==========================================
                // 🛡️ PROTECTION 5: Double vérification EN TEMPS RÉEL
                // ==========================================
                if (reservationData.chauffeurCredite === true) {
                    console.log(`🛡️ [CRÉDIT AUTO] Double vérification: déjà crédité en base`);
                    return { alreadyCredited: true };
                }

                if (reservationData.statut !== 'terminee') {
                    console.log(`🛡️ [CRÉDIT AUTO] Double vérification: statut changé (${reservationData.statut})`);
                    return { statusChanged: true };
                }

                if (reservationData.paiementValide !== true) {
                    console.log(`🛡️ [CRÉDIT AUTO] Double vérification: paiement non validé`);
                    return { paymentNotValid: true };
                }

                // Récupérer le chauffeur
                const driverRef = db.collection('drivers').doc(driverId);
                const driverDoc = await transaction.get(driverRef);

                if (!driverDoc.exists) {
                    throw new Error('DRIVER_NOT_FOUND');
                }

                const driverData = driverDoc.data();

                // Calculer les nouveaux soldes
                const ancienSolde = parseMoney(driverData.soldeDisponible || driverData.SoldeDisponible || 0);
                const nouveauSolde = ancienSolde + montantChauffeur;

                console.log(`📊 [CRÉDIT AUTO] Solde: ${ancienSolde} + ${montantChauffeur} = ${nouveauSolde} FCFA`);

                // ==========================================
                // 📝 MISE À JOUR ATOMIQUE
                // ==========================================
                
                // 1. Marquer la réservation IMMÉDIATEMENT
                transaction.update(reservationRef, {
                    chauffeurCredite: true,
                    dateCreditChauffeur: admin.firestore.FieldValue.serverTimestamp(),
                    montantCrediteChauffeur: montantChauffeur,
                    montantPlateforme: montantPlateforme,
                    creditVersion: 'v2.0-protected'
                });

                // 2. Créditer le chauffeur
                transaction.update(driverRef, {
                    soldeDisponible: nouveauSolde,
                    SoldeDisponible: nouveauSolde, // Mise à jour des deux casses
                    revenusJour: admin.firestore.FieldValue.increment(montantChauffeur),
                    revenusSemaine: admin.firestore.FieldValue.increment(montantChauffeur),
                    revenusMois: admin.firestore.FieldValue.increment(montantChauffeur),
                    revenusTotal: admin.firestore.FieldValue.increment(montantChauffeur),
                    coursesCompletees: admin.firestore.FieldValue.increment(1),
                    dernierCredit: admin.firestore.FieldValue.serverTimestamp()
                });

                return {
                    success: true,
                    ancienSolde: ancienSolde,
                    nouveauSolde: nouveauSolde,
                    montantCredite: montantChauffeur
                };
            });

            // ==========================================
            // 📋 TRAITEMENT POST-TRANSACTION
            // ==========================================
            
            if (resultat.alreadyCredited || resultat.statusChanged || resultat.paymentNotValid) {
                console.log(`🛡️ [CRÉDIT AUTO] Opération annulée (protection anti-doublon)`);
                return null;
            }

            if (resultat.success) {
                console.log(`✅ [CRÉDIT AUTO] Crédit réussi: ${resultat.montantCredite} FCFA pour ${driverId}`);

                // Notification chauffeur
                await db.collection('notifications').add({
                    chauffeurId: driverId,
                    type: 'credit_recu',
                    reservationId: reservationId,
                    montant: resultat.montantCredite,
                    message: `Vous avez reçu ${resultat.montantCredite} FCFA pour la course`,
                    timestamp: admin.firestore.FieldValue.serverTimestamp(),
                    lu: false
                });

                // Log de crédit
                await db.collection('credit_logs').add({
                    reservationId: reservationId,
                    chauffeurId: driverId,
                    montantCourse: prixCourse,
                    montantChauffeur: resultat.montantCredite,
                    montantPlateforme: montantPlateforme,
                    ancienSolde: resultat.ancienSolde,
                    nouveauSolde: resultat.nouveauSolde,
                    timestamp: admin.firestore.FieldValue.serverTimestamp(),
                    success: true
                });
            }

            return null;

        } catch (error) {
            console.error(`❌ [CRÉDIT AUTO] Erreur pour ${reservationId}:`, error.message);

            // Log erreur (sans bloquer)
            try {
                await db.collection('credit_errors').add({
                    reservationId: reservationId,
                    chauffeurId: driverId,
                    montantTente: montantChauffeur,
                    errorMessage: error.message,
                    errorStack: error.stack,
                    timestamp: admin.firestore.FieldValue.serverTimestamp()
                });
            } catch (logError) {
                console.error('Erreur logging:', logError);
            }

            return null;
        }
    });

// ==========================================
// SECTION 3: AUTRES FONCTIONS
// ==========================================

exports.assignerChauffeurManuel = functions.https.onCall(async (data, context) => {
    if (!context.auth && !data.adminToken) {
        throw new functions.https.HttpsError('unauthenticated', 'Non authentifié');
    }

    const { reservationId, chauffeurId } = data;

    if (!reservationId || !chauffeurId) {
        throw new functions.https.HttpsError('invalid-argument', 'Paramètres manquants');
    }

    try {
        const reservationDoc = await db.collection('reservations').doc(reservationId).get();

        if (!reservationDoc.exists) {
            throw new functions.https.HttpsError('not-found', 'Réservation non trouvée');
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
            throw new functions.https.HttpsError('not-found', 'Chauffeur non trouvé');
        }

        const chauffeur = chauffeurDoc.data();

        if (chauffeur.reservationEnCours || chauffeur.currentBookingId) {
            throw new functions.https.HttpsError(
                'failed-precondition',
                `Chauffeur déjà en course`
            );
        }

        let rawSolde = chauffeur.SoldeDisponible !== undefined
            ? chauffeur.SoldeDisponible
            : chauffeur.soldeDisponible;

        const soldeActuel = parseMoney(rawSolde);

        console.log(`🔍 [MANUEL] Check Solde ${chauffeurId}: Brut="${rawSolde}" -> Converti=${soldeActuel}`);

        if (soldeActuel < TRACKING_CONFIG.minSoldeRequis) {
            throw new functions.https.HttpsError(
                'failed-precondition',
                `Solde insuffisant (${soldeActuel} FCFA). Minimum requis: ${TRACKING_CONFIG.minSoldeRequis} FCFA.`
            );
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
                assignePar: context.auth ? context.auth.email : 'admin'
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
        throw new functions.https.HttpsError('internal', error.message);
    }
});

exports.verifierAssignationTimeout = functions.pubsub
    .schedule('every 5 minutes')
    .onRun(async (context) => {
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

exports.terminerCourse = functions.https.onCall(async (data, context) => {
    if (!context.auth && !data.adminToken) {
        throw new functions.https.HttpsError('unauthenticated', 'Non authentifié');
    }

    const { reservationId, chauffeurId } = data;

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
        throw new functions.https.HttpsError('internal', error.message);
    }
});

exports.annulerReservation = functions.https.onCall(async (data, context) => {
    if (!context.auth && !data.adminToken) {
        throw new functions.https.HttpsError('unauthenticated', 'Non authentifié');
    }

    const { reservationId, raison } = data;

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
            annuleePar: context.auth ? context.auth.email : 'admin'
        });

        return { success: true, message: 'Réservation annulée' };
    } catch (error) {
        throw new functions.https.HttpsError('internal', error.message);
    }
});

exports.verifierCoherenceChauffeurs = functions.pubsub
    .schedule('every 1 hours')
    .onRun(async (context) => {
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
// SECTION 4: TRACKING GPS
// ==========================================

exports.onDriverPositionUpdate = functions.firestore
    .document('drivers/{driverId}')
    .onUpdate(async (change, context) => {
        const before = change.before.data();
        const after = change.after.data();
        const driverId = context.params.driverId;

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

exports.detectInactiveDrivers = functions.pubsub
    .schedule('every 5 minutes')
    .onRun(async (context) => {
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

exports.checkGeofences = functions.firestore
    .document('position_history/{positionId}')
    .onCreate(async (snap, context) => {
        const position = snap.data();
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

exports.calculateDailyTrackingStats = functions.pubsub
    .schedule('every day 00:01')
    .timeZone('Africa/Dakar')
    .onRun(async (context) => {
        console.log('📊 Calcul stats tracking quotidiennes...');
        // Implémentation simplifiée
        return null;
    });

exports.cleanupOldPositionHistory = functions.pubsub
    .schedule('every day 02:00')
    .timeZone('Africa/Dakar')
    .onRun(async (context) => {
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
        } catch (error) {
            console.error('❌ Erreur nettoyage:', error);
        }
        return null;
    });

// ==========================================
// SECTION 5: APIs
// ==========================================

exports.getDriverTrackingHistory = functions.https.onCall(async (data, context) => {
    const { driverId, startDate, endDate, sessionId } = data;

    if (!driverId) {
        throw new functions.https.HttpsError('invalid-argument', 'Driver ID requis');
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
        throw new functions.https.HttpsError('internal', error.message);
    }
});

exports.getDriverTrackingStats = functions.https.onCall(async (data, context) => {
    const { driverId } = data;

    if (!driverId) {
        throw new functions.https.HttpsError('invalid-argument', 'Driver ID requis');
    }

    try {
        return {
            success: true,
            stats: {
                today: { totalDistance: 0, averageSpeed: 0 },
                week: { totalDistance: 0, averageSpeed: 0 },
                month: { totalDistance: 0, averageSpeed: 0 }
            }
        };
    } catch (error) {
        console.error('❌ Erreur:', error);
        throw new functions.https.HttpsError('internal', error.message);
    }
});

exports.recupererCreditsManques = functions.https.onCall(async (data, context) => {
    if (!context.auth && !data.adminToken) {
        throw new functions.https.HttpsError('unauthenticated', 'Non authentifié');
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
                const prixCourse = parseMoney(reservation.prixEstime);
                const montantChauffeur = Math.round(prixCourse * PAYMENT_CONFIG.driverRate);
                const montantPlateforme = prixCourse - montantChauffeur;

                await db.runTransaction(async (transaction) => {
                    const driverRef = db.collection('drivers').doc(driverId);
                    const driverDoc = await transaction.get(driverRef);

                    if (!driverDoc.exists) {
                        throw new Error('Driver not found');
                    }

                    const driverData = driverDoc.data();
                    const oldSolde = parseMoney(driverData.soldeDisponible || driverData.SoldeDisponible);
                    const newSolde = oldSolde + montantChauffeur;

                    transaction.update(driverRef, {
                        soldeDisponible: newSolde,
                        SoldeDisponible: newSolde,
                        revenusTotal: admin.firestore.FieldValue.increment(montantChauffeur)
                    });

                    transaction.update(doc.ref, {
                        chauffeurCredite: true,
                        dateCreditChauffeur: admin.firestore.FieldValue.serverTimestamp(),
                        montantCrediteChauffeur: montantChauffeur,
                        montantPlateforme: montantPlateforme,
                        creditVersion: 'recovery-manual'
                    });
                });

                results.push({
                    reservationId: reservationId,
                    success: true,
                    montant: montantChauffeur
                });

                console.log(`✅ [RÉCUP] ${reservationId}: ${montantChauffeur} FCFA`);

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
        throw new functions.https.HttpsError('internal', error.message);
    }
});

// ==========================================
// COORDONNÉES QUARTIERS DAKAR
// ==========================================

function getDefaultCoordsForAddress(address) {
    const coords = {
        'plateau': { lat: 14.6928, lng: -17.4467 },
        'medina': { lat: 14.6738, lng: -17.4387 },
        'fann': { lat: 14.6872, lng: -17.4535 },
        'point e': { lat: 14.6953, lng: -17.4614 },
        'mermoz': { lat: 14.7108, lng: -17.4682 },
        'sacre coeur': { lat: 14.6937, lng: -17.4441 },
        'almadies': { lat: 14.7247, lng: -17.5050 },
        'ngor': { lat: 14.7517, lng: -17.5192 },
        'yoff': { lat: 14.7500, lng: -17.4833 },
        'ouakam': { lat: 14.7200, lng: -17.4900 },
        'parcelles assainies': { lat: 14.7369, lng: -17.4731 },
        'grand yoff': { lat: 14.7400, lng: -17.4700 },
        'hlm': { lat: 14.7306, lng: -17.4542 },
        'sicap': { lat: 14.7289, lng: -17.4594 },
        'liberte': { lat: 14.7186, lng: -17.4697 },
        'pikine': { lat: 14.7549, lng: -17.3940 },
        'guediawaye': { lat: 14.7690, lng: -17.3990 },
        'keur massar': { lat: 14.7833, lng: -17.3167 },
        'rufisque': { lat: 14.7167, lng: -17.2667 },
        'thiaroye': { lat: 14.7730, lng: -17.3610 },
        'yeumbeul': { lat: 14.7720, lng: -17.3420 },
        'malika': { lat: 14.7800, lng: -17.3600 },
        'dakar': { lat: 14.6928, lng: -17.4467 }
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

// ==========================================
// ⭐ EXPORT CORRECT - NE PAS UTILISER module.exports = {...}
// ==========================================
exports.getDefaultCoordsForAddress = getDefaultCoordsForAddress;
