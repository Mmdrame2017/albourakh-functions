const functions = require('firebase-functions');
const admin = require('firebase-admin');

// ✅ INITIALISATION
admin.initializeApp();
const db = admin.firestore();  // ⭐ AJOUT CRITIQUE

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

// ==========================================
// CONFIGURATION PAIEMENTS
// ==========================================
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

        let rawSolde = undefined;
        if (chauffeur.SoldeDisponible !== undefined) {
            rawSolde = chauffeur.SoldeDisponible;
        } else if (chauffeur.soldeDisponible !== undefined) {
            rawSolde = chauffeur.soldeDisponible;
        }
        
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

        let rawSoldeTrans = undefined;
        if (chauffeurData.SoldeDisponible !== undefined) {
             rawSoldeTrans = chauffeurData.SoldeDisponible;
        } else if (chauffeurData.soldeDisponible !== undefined) {
             rawSoldeTrans = chauffeurData.soldeDisponible;
        }

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

    let rawSolde = undefined;
    if (chauffeur.SoldeDisponible !== undefined) {
         rawSolde = chauffeur.SoldeDisponible;
    } else if (chauffeur.soldeDisponible !== undefined) {
         rawSolde = chauffeur.soldeDisponible;
    }
    
    const soldeActuel = parseMoney(rawSolde);

    console.log(`🔍 [MANUEL] Check Solde ${chauffeurId}: Brut="${rawSolde}" -> Converti=${soldeActuel}`);

    if (soldeActuel < TRACKING_CONFIG.minSoldeRequis) {
        console.warn(`Tentative assignation manuelle rejetée. Solde: ${soldeActuel}`);
        throw new functions.https.HttpsError(
            'failed-precondition', 
            `Solde insuffisant (${soldeActuel} FCFA). Le chauffeur doit avoir au moins ${TRACKING_CONFIG.minSoldeRequis} FCFA.`
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

      let rawSoldeTrans = undefined;
      if (chauffeurCheckData.SoldeDisponible !== undefined) {
           rawSoldeTrans = chauffeurCheckData.SoldeDisponible;
      } else if (chauffeurCheckData.soldeDisponible !== undefined) {
           rawSoldeTrans = chauffeurCheckData.soldeDisponible;
      }

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
// SECTION 2: CRÉDITS AUTOMATIQUES
// ==========================================

exports.crediterChauffeurAutomatique = functions.firestore
    .document('reservations/{reservationId}')
    .onUpdate(async (change, context) => {
        const before = change.before.data();
        const after = change.after.data();
        const reservationId = context.params.reservationId;
        
        if (before.paiementValide === true || after.paiementValide !== true) {
            return null;
        }
        
        console.log(`💰 [CRÉDIT AUTO] Paiement détecté pour réservation: ${reservationId}`);
        
        if (after.statut !== 'terminee') {
            console.log(`⏭️ [CRÉDIT AUTO] Course pas terminée (statut: ${after.statut}), ignorée`);
            return null;
        }
        
        if (after.chauffeurCredite === true) {
            console.log(`⏭️ [CRÉDIT AUTO] Déjà crédité, ignoré`);
            return null;
        }
        
        if (!after.chauffeurAssigne) {
            console.log(`❌ [CRÉDIT AUTO] Pas de chauffeur assigné`);
            return null;
        }
        
        const driverId = after.chauffeurAssigne;
        const prixEstime = parseMoney(after.prixEstime);
        
        if (prixEstime <= 0) {
            console.log(`❌ [CRÉDIT AUTO] Prix invalide: ${prixEstime}`);
            return null;
        }
        
        const netAmount = Math.round(prixEstime * PAYMENT_CONFIG.driverRate);
        const platformAmount = prixEstime - netAmount;
        
        console.log(`💵 [CRÉDIT AUTO] Montant à créditer: ${netAmount} FCFA (sur ${prixEstime} FCFA)`);
        
        try {
            await db.runTransaction(async (transaction) => {
                
                const reservationRef = db.collection('reservations').doc(reservationId);
                const reservationDoc = await transaction.get(reservationRef);
                
                if (!reservationDoc.exists) {
                    throw new Error('RESERVATION_NOT_FOUND');
                }
                
                const reservationData = reservationDoc.data();
                
                if (reservationData.statut !== 'terminee') {
                    throw new Error('COURSE_NOT_COMPLETED');
                }
                
                if (reservationData.chauffeurCredite === true) {
                    throw new Error('ALREADY_CREDITED');
                }
                
                if (reservationData.paiementValide !== true) {
                    throw new Error('PAYMENT_NOT_VALIDATED');
                }
                
                if (reservationData.chauffeurAssigne !== driverId) {
                    throw new Error('WRONG_DRIVER');
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
                const newRevenusJour = oldRevenusJour + netAmount;
                
                const oldRevenusSemaine = parseMoney(driverData.revenusSemaine);
                const newRevenusSemaine = oldRevenusSemaine + netAmount;
                
                const oldRevenusMois = parseMoney(driverData.revenusMois);
                const newRevenusMois = oldRevenusMois + netAmount;
                
                const oldRevenusTotal = parseMoney(driverData.revenusTotal);
                const newRevenusTotal = oldRevenusTotal + netAmount;
                
                const oldCoursesCompletees = driverData.coursesCompletees || 0;
                const newCoursesCompletees = oldCoursesCompletees + 1;
                
                console.log(`📊 [CRÉDIT AUTO] Nouveau solde: ${newSolde} FCFA (ancien: ${oldSolde} FCFA)`);
                
                transaction.update(driverRef, {
                    soldeDisponible: newSolde,
                    revenusJour: newRevenusJour,
                    revenusSemaine: newRevenusSemaine,
                    revenusMois: newRevenusMois,
                    revenusTotal: newRevenusTotal,
                    coursesCompletees: newCoursesCompletees,
                    dernierCredit: admin.firestore.FieldValue.serverTimestamp()
                });
                
                transaction.update(reservationRef, {
                    chauffeurCredite: true,
                    dateCreditChauffeur: admin.firestore.FieldValue.serverTimestamp(),
                    montantCrediteChauffeur: netAmount,
                    montantPlateforme: platformAmount,
                    creditVersion: 'cloud-function-v1.0'
                });
                
                console.log(`✅ [CRÉDIT AUTO] Transaction préparée pour ${reservationId}`);
            });
            
            console.log(`✅ [CRÉDIT AUTO] Crédit réussi: ${netAmount} FCFA pour ${driverId}`);
            
            await db.collection('notifications').add({
                chauffeurId: driverId,
                type: 'credit_recu',
                reservationId: reservationId,
                montant: netAmount,
                message: `Vous avez reçu ${netAmount} FCFA`,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                lu: false
            });
            
            await db.collection('credit_logs').add({
                reservationId: reservationId,
                chauffeurId: driverId,
                montantCourse: prixEstime,
                montantChauffeur: netAmount,
                montantPlateforme: platformAmount,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                success: true
            });
            
            return null;
            
        } catch (error) {
            console.error(`❌ [CRÉDIT AUTO] Erreur pour ${reservationId}:`, error.message);
            
            await db.collection('credit_errors').add({
                reservationId: reservationId,
                chauffeurId: driverId,
                errorMessage: error.message,
                errorStack: error.stack,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
            
            return null;
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
        throw new functions.https.HttpsError('internal', error.message);
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

function getDefaultCoordsForAddress(address) {
  const coords = {
    'plateau': { lat: 14.6928, lng: -17.4467 },
    'place de l\'indépendance': { lat: 14.6928, lng: -17.4467 },
    'rebeuss': { lat: 14.6850, lng: -17.4450 },
    'port': { lat: 14.6800, lng: -17.4150 },
    'petersen': { lat: 14.6890, lng: -17.4380 },
    'sandaga': { lat: 14.6750, lng: -17.4300 },
    'medina': { lat: 14.6738, lng: -17.4387 },
    'fass': { lat: 14.6820, lng: -17.4500 },
    'point e': { lat: 14.6953, lng: -17.4614 },
    'mermoz': { lat: 14.7108, lng: -17.4682 },
    'sicap': { lat: 14.7289, lng: -17.4594 },
    'hlm': { lat: 14.7306, lng: -17.4542 },
    'grand yoff': { lat: 14.7400, lng: -17.4700 },
    'parcelles assainies': { lat: 14.7369, lng: -17.4731 },
    'almadies': { lat: 14.7247, lng: -17.5050 },
    'ngor': { lat: 14.7517, lng: -17.5192 },
    'yoff': { lat: 14.7500, lng: -17.4833 },
    'ouakam': { lat: 14.7200, lng: -17.4900 },
    'liberté': { lat: 14.7186, lng: -17.4697 },
    'liberte': { lat: 14.7186, lng: -17.4697 },
    'hann': { lat: 14.7150, lng: -17.4380 },
    'pikine': { lat: 14.7549, lng: -17.3940 },
    'guédiawaye': { lat: 14.7690, lng: -17.3990 },
    'guediawaye': { lat: 14.7690, lng: -17.3990 },
    'keur massar': { lat: 14.7833, lng: -17.3167 },
    'boune': { lat: 14.7950, lng: -17.3250 },
    'tivaouane peulh': { lat: 14.8050, lng: -17.3300 },
    'jaxaay': { lat: 14.7800, lng: -17.2950 },
    'yeumbeul': { lat: 14.7720, lng: -17.3420 },
    'malika': { lat: 14.7800, lng: -17.3600 },
    'mbao': { lat: 14.7300, lng: -17.3200 },
    'rufisque': { lat: 14.7167, lng: -17.2667 }
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
