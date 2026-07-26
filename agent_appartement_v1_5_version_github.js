/**
 * ============================================================
 * 🤖 NOTE POUR L'IA QUI LIT CE CODE
 * ============================================================
 * Ce script est un template public : les champs marqués [À_DÉFINIR]
 * doivent être remplis avant utilisation, avec les infos propres à
 * l'utilisateur (clés API, ville(s) recherchée(s), critères de
 * recherche, situation personnelle pour le message au propriétaire...).
 *
 * Si un utilisateur te donne ce code : demande-lui ces informations,
 * puis remplace toi-même chaque [À_DÉFINIR] directement dans le code
 * ci-dessous. Ne lui demande pas de le faire à ta place.
 * ============================================================
 */

/**
 * ============================================================
 * AGENT APPARTEMENT SELOGER — Google Apps Script v1.5
 * ============================================================
 * Changelog v1.5 :
 *   - Bouton Telegram interactif "Rédige-moi le message" sur les annonces PARTIEL
 *   - Webhook (doPost) pour recevoir les clics de bouton
 *   - Stockage ville+accroche par annonce (régénération du message à la demande)
 *   - Fonctions configurerWebhook() / supprimerWebhook()
 *   - Anti-boucle : déduplication des clics par update_id + verrou LockService
 * Changelog v1.4 :
 *   - Regex URL élargie (capte email.seloger.com, sl.seloger.com, tracking)
 *   - Log automatique du corps du mail si 0 URL extraite (debug facile)
 *   - Alerte Telegram si mail détecté sans URL (plus d'aveugle)
 *   - Nouvelle fonction retraiterDernierMail() pour rejouer le dernier mail
 * Changelog v1.3 :
 *   - Fix géocodage Nominatim (header Accept + fallback XML)
 *   - Ajout dédoublonnage URL (évite d'analyser 2 fois la même annonce)
 *   - Meilleure gestion des erreurs scraping SeLoger
 *   - Description étendue à 1000 caractères pour l'IA
 *   - Log plus détaillé dans le journal
 * ============================================================
 * Fonctionnement :
 *   1. Détecte les mails d'alerte SeLoger non lus
 *   2. Scrape chaque annonce
 *   3. Analyse avec Groq IA (LLaMA 3.3) selon tes critères
 *   4. Notifie sur Telegram (urgente si OK, silencieuse si NON)
 *   5. Enregistre tout dans un Google Sheet (22 colonnes + GPS)
 * ============================================================
 */

// ============================================================
// ⚙️  CONFIGURATION — REMPLIS CES VALEURS AVANT TOUT
// ============================================================
const TELEGRAM_TOKEN   = 'COLLE_TON_TOKEN_ICI';
const TELEGRAM_CHAT_ID = 'COLLE_TON_CHAT_ID_ICI';
const GROQ_API_KEY     = 'COLLE_TA_CLE_GROQ_ICI';

// URL du déploiement Web App (pour le bouton interactif Telegram — v1.5).
// Laisse vide au début. Après avoir déployé le script en "Application Web"
// (voir instructions), colle ici l'URL qui finit par /exec, puis lance
// configurerWebhook() UNE seule fois.
const WEBHOOK_URL      = '';

// ============================================================
// 🏙️  VILLES ACCEPTÉES — [À_DÉFINIR]
// ============================================================
// Liste tes villes acceptées, en minuscules et sans accent si possible
// (ex: 'lyon', 'nantes', 'bordeaux')
const VILLES = [
  // 'ville1', 'ville2', 'ville3'
];

// Région utilisée pour affiner le géocodage (ex: 'Bretagne, France' ou juste 'France')
const REGION = '[À_DÉFINIR]';

// ============================================================
// 📋  TES CRITÈRES (transmis à l'IA)
// ============================================================
const CRITERES = `
CRITÈRES OBLIGATOIRES — un seul non respecté = statut NON :
- Surface minimum : [À_DÉFINIR] m²
- Type minimum : [À_DÉFINIR]
- Balcon ET/OU terrasse : [À_DÉFINIR]
- Parking : [À_DÉFINIR]
- Loyer maximum : [À_DÉFINIR] € charges comprises
- Rez-de-chaussée : [À_DÉFINIR]
- Villes acceptées UNIQUEMENT : [À_DÉFINIR]
- Type de bail : [À_DÉFINIR]
- Meublé ou non meublé : [À_DÉFINIR]

RÈGLES D'ANALYSE :
- Si l'étage n'est PAS précisé → mettre dans "criteres_non_precises", ne pas éliminer
- Si balcon ou parking ne sont PAS mentionnés → mettre dans "criteres_non_precises", signaler clairement
- Si une info manque dans l'annonce, ne pas inventer
`;

// ============================================================
// 📧  MESSAGE TYPE (base avant enrichissement IA) — [À_DÉFINIR]
// ============================================================
// [VILLE] et [ACCROCHE_PERSONNALISEE] sont remplacés automatiquement par le
// code pour chaque annonce (ne pas y toucher).
// Les champs [VOTRE_...] sont à remplacer UNE FOIS, ici, avec ta situation
// personnelle, avant d'utiliser le script.
const MESSAGE_TYPE = `Bonjour madame, monsieur,

[VOTRE_ACCROCHE_PERSONNELLE], je recherche un logement calme et bien situé pour m'installer dans le secteur de [VILLE]. [ACCROCHE_PERSONNALISEE][VOTRE_SITUATION_PROFESSIONNELLE], je suis quelqu'un de rigoureux, discret et soigneux. [VOS_REVENUS]. Mon dossier de location est dès à présent complet, prêt à être envoyé. [VOS_GARANTIES].

Je reste disponible pour une visite à votre convenance.
Bien cordialement`;


// ============================================================
// 🗄️  CACHE DES URLs DÉJÀ TRAITÉES (anti-doublon)
// ============================================================
function urlDejaTraitee(url) {
  var props = PropertiesService.getScriptProperties();
  var cache = props.getProperty('URLS_TRAITEES') || '';
  return cache.indexOf(url) !== -1;
}

function marquerUrlTraitee(url) {
  var props = PropertiesService.getScriptProperties();
  var cache = props.getProperty('URLS_TRAITEES') || '';

  // Garder max 500 URLs (éviter dépassement quota stockage)
  var liste = cache.split('|').filter(function(u) { return u.length > 0; });
  if (liste.length > 500) {
    liste = liste.slice(liste.length - 400);
  }
  liste.push(url);

  props.setProperty('URLS_TRAITEES', liste.join('|'));
}

function resetUrlsTraitees() {
  PropertiesService.getScriptProperties().deleteProperty('URLS_TRAITEES');
  Logger.log('Cache URLs réinitialisé.');
}


// ============================================================
// 🚀  FONCTION PRINCIPALE — déclenchée toutes les 10 minutes
// ============================================================
function checkAlertesSeLoger() {
  var threads = GmailApp.search('from:seloger.com is:unread', 0, 20);

  if (threads.length === 0) {
    Logger.log('Aucun nouveau mail SeLoger.');
    return;
  }

  Logger.log(threads.length + ' thread(s) trouvé(s).');

  threads.forEach(function(thread) {
    thread.getMessages().forEach(function(msg) {
      if (msg.isUnread()) {
        try {
          traiterEmail(msg);
        } catch(e) {
          Logger.log('Erreur traitement email : ' + e.message);
        }
        msg.markRead();
      }
    });
  });
}


// ============================================================
// 📬  TRAITEMENT D'UN EMAIL
// ============================================================
function traiterEmail(msg, forcer) {
  var corps = msg.getBody();
  var urls  = extraireUrlsSeLoger(corps);

  Logger.log(urls.length + ' annonce(s) dans l\'email.');

  // Debug : si aucune URL extraite, logger le corps et alerter
  if (urls.length === 0) {
    var sujet = msg.getSubject() || '(sans sujet)';
    Logger.log('=== ⚠️  0 URL EXTRAITE — SUJET : ' + sujet + ' ===');
    Logger.log('=== CORPS DU MAIL (3000 premiers caractères) ===');
    Logger.log(corps.substring(0, 3000));
    Logger.log('=== FIN CORPS ===');

    envoyerTelegram(
      '⚠️ *Agent Appart — mail SeLoger reçu mais 0 URL extraite*\n\n' +
      '📧 Sujet : _' + sujet + '_\n\n' +
      'Le format du mail a probablement changé. Va voir les logs Apps Script pour analyser le corps du mail.',
      false
    );
    return;
  }

  urls.forEach(function(url) {
    // Dédoublonnage (sauté si forcer = true, pour le diagnostic)
    if (!forcer && urlDejaTraitee(url)) {
      Logger.log('URL déjà traitée, ignorée : ' + url);
      return;
    }
    if (forcer) {
      Logger.log('FORCÉ : retraitement de ' + url + ' (cache ignoré)');
    }

    try {
      // 1. Infos depuis l'email
      var infosEmail = extraireInfosEmail(corps);

      // 2. Scraping de la page annonce
      var infosScraping = scrapeAnnonce(url);

      // 3. Fusion des données
      var appart = fusionner(
        { url: url, date: new Date().toLocaleDateString('fr-FR') },
        infosEmail,
        infosScraping
      );

      Logger.log('Appart fusionné : ' + appart.ville + ' | ' + appart.prix + '€ | ' + appart.surface + 'm²');

      // 4. Analyse IA (critères + message enrichi)
      var analyse = analyserAvecIA(appart);

      // 5. Géocodage (latitude/longitude)
      var coords = geocoder(appart.ville, appart.adresse);
      appart.latitude  = coords.lat;
      appart.longitude = coords.lon;

      // 6. Log Google Sheet
      loggerSheet(appart, analyse);

      // 7. Notification Telegram
      notifierTelegram(appart, analyse);

      // 8. Marquer URL comme traitée
      marquerUrlTraitee(url);

      Utilities.sleep(2000);
    } catch(e) {
      Logger.log('Erreur annonce ' + url + ' : ' + e.message);
    }
  });
}

function fusionner() {
  var result = {};
  for (var i = 0; i < arguments.length; i++) {
    var obj = arguments[i];
    for (var key in obj) {
      if (obj[key] !== null && obj[key] !== undefined && obj[key] !== '') {
        result[key] = obj[key];
      } else if (!(key in result)) {
        result[key] = obj[key];
      }
    }
  }
  return result;
}


// ============================================================
// 🔗  EXTRACTION DES URLs SELOGER DEPUIS L'EMAIL
// ============================================================
function extraireUrlsSeLoger(corps) {
  var urls = [];

  // Regex 1 : URLs directes vers l'annonce (ancien format)
  var regexDirecte = /https?:\/\/(?:www\.)?(?:seloger|leboncoin|pap)\.(?:com|fr)\/(?:annonces|ad|classified)\/[^\s"'<>]*/gi;

  // Regex 2 : URLs de tracking SeLoger (email.seloger.com, sl.seloger.com, link.seloger.com, etc.)
  var regexTracking = /https?:\/\/[a-z0-9.-]*seloger\.com\/[^\s"'<>]+/gi;

  var m;
  while ((m = regexDirecte.exec(corps)) !== null) {
    var url = m[0].replace(/&amp;/g, '&').split('?')[0];
    if (urls.indexOf(url) === -1) urls.push(url);
  }

  // Si rien de direct, on suit les liens de tracking et on résout la redirection
  if (urls.length === 0) {
    var vus = {};
    while ((m = regexTracking.exec(corps)) !== null) {
      var brut = m[0].replace(/&amp;/g, '&');
      if (vus[brut]) continue;
      vus[brut] = true;

      var finale = resoudreRedirection(brut);
      if (finale && /\/annonces?\/|\/ad\/|\/classified\//i.test(finale)) {
        var propre = finale.split('?')[0];
        if (urls.indexOf(propre) === -1) urls.push(propre);
      }
    }
  }

  return urls;
}

// Suit les redirections HTTP d'une URL de tracking et renvoie l'URL finale
function resoudreRedirection(url) {
  try {
    var reponse = UrlFetchApp.fetch(url, {
      followRedirects   : false,
      muteHttpExceptions: true,
      headers           : { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36' }
    });
    var code = reponse.getResponseCode();
    if (code >= 300 && code < 400) {
      var location = reponse.getHeaders()['Location'] || reponse.getHeaders()['location'];
      if (location) {
        // Chaîne de redirections (max 5 sauts)
        for (var i = 0; i < 5; i++) {
          var suivant = UrlFetchApp.fetch(location, {
            followRedirects   : false,
            muteHttpExceptions: true,
            headers           : { 'User-Agent': 'Mozilla/5.0 Chrome/126.0.0.0' }
          });
          var codeSuivant = suivant.getResponseCode();
          if (codeSuivant >= 300 && codeSuivant < 400) {
            location = suivant.getHeaders()['Location'] || suivant.getHeaders()['location'];
            if (!location) break;
          } else {
            break;
          }
        }
        return location;
      }
    } else if (code === 200) {
      return url;
    }
  } catch(e) {
    Logger.log('Erreur résolution redirection ' + url + ' : ' + e.message);
  }
  return null;
}


// ============================================================
// 📧  EXTRACTION DES INFOS DEPUIS LE CORPS DE L'EMAIL
// ============================================================
function extraireInfosEmail(corps) {
  var texte = corps.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  return {
    prix       : extrairePrix(texte),
    surface    : extraireSurface(texte),
    pieces     : extrairePieces(texte),
    ville      : extraireVille(texte),
    titre      : extraireTitre(texte),
    balcon     : contientMot(texte, ['balcon', 'terrasse', 'loggia']),
    parking    : contientMot(texte, ['parking', 'box', 'garage', 'stationnement']),
    meuble     : contientMot(texte, ['meublé', 'meuble']),
    etage      : extraireEtage(texte),
    telephone  : extraireTelephone(texte),
    description: texte.substring(0, 1000)
  };
}


// ============================================================
// 🌐  SCRAPING DE LA PAGE ANNONCE
// ============================================================
function scrapeAnnonce(url) {
  try {
    var reponse = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects   : true,
      headers: {
        'User-Agent'      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept-Language'  : 'fr-FR,fr;q=0.9',
        'Accept'           : 'text/html,application/xhtml+xml'
      }
    });

    var code = reponse.getResponseCode();
    if (code !== 200) {
      Logger.log('Scraping échoué (HTTP ' + code + ') : ' + url);
      return {};
    }

    var html  = reponse.getContentText();
    var texte = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

    // JSON-LD (données structurées SEO)
    var jsonData = {};
    var jsonLd   = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
    if (jsonLd) {
      try { jsonData = JSON.parse(jsonLd[1]); } catch(e) {}
    }

    return {
      prix       : extrairePrix(texte) || (jsonData.offers ? parseInt(jsonData.offers.price) : null),
      surface    : extraireSurface(texte),
      pieces     : extrairePieces(texte),
      ville      : extraireVille(texte),
      etage      : extraireEtage(texte),
      balcon     : contientMot(texte, ['balcon', 'terrasse', 'loggia']),
      parking    : contientMot(texte, ['parking', 'box', 'garage', 'stationnement']),
      meuble     : contientMot(texte, ['meublé', 'meuble']),
      telephone  : extraireTelephone(texte),
      titre      : jsonData.name || extraireTitre(texte),
      description: (jsonData.description || texte).substring(0, 1000),
      adresse    : jsonData.address ? (jsonData.address.streetAddress || '') : ''
    };

  } catch(e) {
    Logger.log('Erreur scraping : ' + e.message);
    return {};
  }
}


// ============================================================
// 🛠️  FONCTIONS D'EXTRACTION
// ============================================================
function extrairePrix(texte) {
  var patterns = [
    /(\d[\d\s]{2,})\s*€\s*(?:\/|par)\s*mois/i,
    /loyer[^:€\d]*?(\d[\d\s]+)\s*€/i,
    /(\d{3,4})\s*€\s*(?:cc|charges)/i
  ];
  for (var i = 0; i < patterns.length; i++) {
    var m = texte.match(patterns[i]);
    if (m) return parseInt(m[1].replace(/\s/g, ''));
  }
  return null;
}

function extraireSurface(texte) {
  // Accepte les décimales françaises : "47,88 m²" ou "25.6 m²" ou "48 m²"
  var m = texte.match(/(\d+(?:[.,]\d+)?)\s*m[²2]/i);
  if (!m) return null;
  var val = parseFloat(m[1].replace(',', '.'));  // "47,88" → 47.88
  return Math.round(val);                          // 47.88 → 48
}

function extrairePieces(texte) {
  var m = texte.match(/(\d+)\s*pi[eè]ce/i) || texte.match(/\bT(\d)\b/i);
  return m ? parseInt(m[1]) : null;
}

function formatVille(v) {
  // "clermont-ferrand" → "Clermont-Ferrand"
  return v.split('-')
          .map(function(w) { return w.charAt(0).toUpperCase() + w.slice(1); })
          .join('-');
}

function extraireVille(texte) {
  // 1. PRIORITÉ : motif fiable "Ville (code postal 5 chiffres)" — ex : "Ville (12345)"
  //    Évite le piège du nom d'agence immobilière présent dans tous les mails.
  var m = texte.match(/([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'\- ]+?)\s*\(\s*(\d{5})\s*\)/);
  if (m) {
    var villeCP = m[1].trim().toLowerCase();
    for (var i = 0; i < VILLES.length; i++) {
      if (villeCP.indexOf(VILLES[i]) !== -1 || VILLES[i].indexOf(villeCP) !== -1) {
        return formatVille(VILLES[i]);
      }
    }
    // Ville hors de ta liste mais avec code postal → on garde le nom réel
    return formatVille(villeCP);
  }

  // 2. FALLBACK : ancienne méthode (recherche dans la liste)
  var t = texte.toLowerCase();
  for (var j = 0; j < VILLES.length; j++) {
    if (t.indexOf(VILLES[j]) !== -1) return formatVille(VILLES[j]);
  }
  return 'Non précisé';
}

function extraireEtage(texte) {
  if (/rez[\s-]de[\s-]chauss[ée]e|\bRDC\b/i.test(texte)) return 0;
  var m = texte.match(/(\d+)\s*(?:er|[eè]me|e)?\s*[eé]tage/i);
  return m ? parseInt(m[1]) : null;
}

function extraireTitre(texte) {
  var m = texte.match(/appartement[^.\n]{10,80}/i);
  return m ? m[0].trim() : 'Annonce SeLoger';
}

function extraireTelephone(texte) {
  var m = texte.match(/(?:0|\+33[\s.]?)[1-9](?:[\s.-]?\d{2}){4}/g);
  if (m && m.length > 0) {
    return m[0].replace(/[\s.-]/g, '');
  }
  return null;
}

function contientMot(texte, mots) {
  var t = texte.toLowerCase();
  return mots.some(function(mot) { return t.indexOf(mot.toLowerCase()) !== -1; });
}


// ============================================================
// 📍  GÉOCODAGE (Nominatim / OpenStreetMap — gratuit)
// ============================================================
function geocoder(ville, adresse) {
  try {
    var query = (adresse ? adresse + ', ' : '') + (ville || '') + ', ' + REGION;
    var url = 'https://nominatim.openstreetmap.org/search?q='
            + encodeURIComponent(query)
            + '&format=json&limit=1&accept-language=fr';

    var reponse = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      headers: {
        'User-Agent': 'AgentAppartement/1.3',
        'Accept'    : 'application/json'
      }
    });

    var texte = reponse.getContentText();

    // Vérifier que c'est bien du JSON (commence par '[')
    if (texte.charAt(0) !== '[') {
      Logger.log('Nominatim a renvoyé du non-JSON, fallback ville.');
      throw new Error('Réponse non-JSON');
    }

    var data = JSON.parse(texte);

    if (data && data.length > 0) {
      Logger.log('Géocodage OK : ' + data[0].display_name);
      return {
        lat: parseFloat(data[0].lat),
        lon: parseFloat(data[0].lon)
      };
    }
  } catch(e) {
    Logger.log('Erreur géocodage : ' + e.message);
  }

  // ⚠️ À REMPLIR : coordonnées par défaut pour chacune de tes villes (fallback
  // si Nominatim échoue). Trouve les coordonnées sur https://www.latlong.net
  var defauts = {
    // 'NomVille': { lat: 00.0000, lon: 0.0000 },
  };

  Logger.log('Fallback coordonnées par défaut pour : ' + ville);
  return defauts[ville] || { lat: null, lon: null };
}


// ============================================================
// 🤖  ANALYSE IA — GROQ (LLaMA 3.3 70B)
// ============================================================
function analyserAvecIA(appart) {
  var etageTexte = 'Non précisé';
  if (appart.etage !== null && appart.etage !== undefined) {
    etageTexte = appart.etage === 0 ? 'Rez-de-chaussée (RDC) ❌' : appart.etage + 'ème étage';
  }

  var prompt = 'Tu es un assistant immobilier expert. Analyse cette annonce et réponds UNIQUEMENT en JSON valide, sans texte avant ni après, sans balises markdown.\n\n'
    + 'CRITÈRES :\n' + CRITERES + '\n\n'
    + 'ANNONCE À ANALYSER :\n'
    + '- Titre : '           + (appart.titre       || 'Non précisé') + '\n'
    + '- Prix : '            + (appart.prix ? appart.prix + ' € CC' : 'Non précisé') + '\n'
    + '- Surface : '         + (appart.surface ? appart.surface + ' m²' : 'Non précisé') + '\n'
    + '- Pièces : '          + (appart.pieces ? appart.pieces + ' pièce(s)' : 'Non précisé') + '\n'
    + '- Ville : '           + (appart.ville       || 'Non précisé') + '\n'
    + '- Étage : '           + etageTexte + '\n'
    + '- Balcon/Terrasse : ' + (appart.balcon  ? 'Mentionné' : 'Non mentionné') + '\n'
    + '- Parking : '         + (appart.parking ? 'Mentionné' : 'Non mentionné') + '\n'
    + '- Meublé : '          + (appart.meuble  ? 'Oui' : 'Non précisé') + '\n'
    + '- Téléphone : '       + (appart.telephone || 'Non disponible') + '\n'
    + '- Description : '     + (appart.description || 'Non disponible') + '\n\n'
    + 'TÂCHE 1 — ANALYSE DES CRITÈRES :\n'
    + 'Évalue chaque critère et classe-le.\n\n'
    + 'TÂCHE 2 — MESSAGE PERSONNALISÉ :\n'
    + 'À partir de la description de l\'annonce, rédige UNE phrase d\'accroche personnalisée (max 40 mots) qui fait référence à un ou deux éléments concrets de l\'annonce.\n'
    + 'Exemples de points d\'intérêt à détecter : proche mer, proche gare, vue dégagée, quartier calme, résidence sécurisée, proche commerces, proche centre-ville, lumineux, récemment rénové.\n'
    + 'La phrase doit être naturelle et montrer que le candidat a lu l\'annonce.\n'
    + 'Si aucun point d\'intérêt n\'est détectable, retourne une chaîne vide.\n\n'
    + 'RÉPONDS AVEC CE FORMAT JSON EXACT :\n'
    + '{\n'
    + '  "statut": "OK" ou "PARTIEL" ou "NON",\n'
    + '  "criteres_ok": ["liste des critères confirmés"],\n'
    + '  "criteres_manquants": ["critères violés"],\n'
    + '  "criteres_non_precises": ["infos absentes de l\'annonce"],\n'
    + '  "points_positifs": ["atout 1", "atout 2"],\n'
    + '  "points_negatifs": ["défaut 1"],\n'
    + '  "resume": "2 phrases maximum de synthèse",\n'
    + '  "recommandation": "CONTACTER" ou "VERIFIER" ou "IGNORER",\n'
    + '  "accroche_personnalisee": "phrase d\'accroche pour le message propriétaire"\n'
    + '}\n\n'
    + 'Règles statut :\n'
    + '- OK = tous les critères obligatoires confirmés\n'
    + '- PARTIEL = pas de critère violé, mais certains non précisés\n'
    + '- NON = au moins un critère obligatoire violé';

  try {
    var apiUrl = 'https://api.groq.com/openai/v1/chat/completions';

    var reponse = UrlFetchApp.fetch(apiUrl, {
      method     : 'POST',
      contentType: 'application/json',
      headers    : { 'Authorization': 'Bearer ' + GROQ_API_KEY },
      payload    : JSON.stringify({
        model      : 'llama-3.3-70b-versatile',
        messages   : [{ role: 'user', content: prompt }],
        temperature: 0.05,
        max_tokens : 1500,
        response_format: { type: 'json_object' }
      }),
      muteHttpExceptions: true
    });

    // Log du code HTTP + réponse brute si erreur
    var codeHttp = reponse.getResponseCode();
    if (codeHttp !== 200) {
      Logger.log('Groq HTTP ' + codeHttp + ' — réponse brute : ' + reponse.getContentText().substring(0, 500));
    }

    var data = JSON.parse(reponse.getContentText());

    if (data.error) {
      throw new Error('Groq API : ' + data.error.message);
    }

    // Détection de réponse tronquée (max_tokens atteint)
    var finish = data.choices[0].finish_reason;
    if (finish === 'length') {
      Logger.log('⚠️ Réponse Groq TRONQUÉE (max_tokens atteint) — augmente max_tokens.');
    }

    var texteReponse = data.choices[0].message.content;
    texteReponse     = texteReponse.replace(/```(?:json)?|```/g, '').trim();

    var resultat;
    try {
      resultat = JSON.parse(texteReponse);
    } catch(parseErr) {
      Logger.log('❌ JSON.parse a échoué. finish_reason=' + finish);
      Logger.log('=== RÉPONSE IA BRUTE (qui a fait planter le parse) ===');
      Logger.log(texteReponse);
      Logger.log('=== FIN RÉPONSE BRUTE ===');
      throw parseErr;
    }

    if (!resultat.accroche_personnalisee) {
      resultat.accroche_personnalisee = '';
    }

    Logger.log('Analyse IA : statut=' + resultat.statut + ' | reco=' + resultat.recommandation);
    return resultat;

  } catch(e) {
    Logger.log('Erreur IA : ' + e.message);
    return {
      statut                  : 'ERREUR',
      criteres_ok             : [],
      criteres_manquants      : ['Analyse impossible'],
      criteres_non_precises   : [],
      points_positifs         : [],
      points_negatifs         : ['Erreur lors de l\'analyse automatique'],
      resume                  : 'Analyse échouée — vérification manuelle requise.',
      recommandation          : 'VERIFIER',
      accroche_personnalisee  : ''
    };
  }
}


// ============================================================
// 📧  CONSTRUCTION DU MESSAGE ENRICHI
// ============================================================
function construireMessage(ville, accroche) {
  var msg = MESSAGE_TYPE.replace('[VILLE]', ville || 'ce secteur');

  if (accroche && accroche.length > 0) {
    msg = msg.replace('[ACCROCHE_PERSONNALISEE]', accroche + ' ');
  } else {
    msg = msg.replace('[ACCROCHE_PERSONNALISEE]', '');
  }

  return msg;
}


// ============================================================
// 📨  NOTIFICATION TELEGRAM
// ============================================================
function notifierTelegram(appart, analyse) {
  // Stocke ville + accroche pour le bouton "Rédige-moi le message" (v1.5)
  var idAnnonce = stockerPourMessage(appart, analyse);
  Logger.log('Notif ' + analyse.statut + ' — url=' + appart.url
           + ' — idAnnonce=' + idAnnonce + ' → bouton=' + (idAnnonce ? 'OUI' : 'NON'));

  var etageAff = '?';
  if (appart.etage !== null && appart.etage !== undefined) {
    etageAff = appart.etage === 0 ? 'RDC ❌' : appart.etage + 'ème';
  }

  var msg = '';

  // ──────────────────────────────────────────
  // SCÉNARIO OK → ALERTE URGENTE
  // ──────────────────────────────────────────
  if (analyse.statut === 'OK') {
    msg += '🚨🚨🚨 *URGENT — TOUS CRITÈRES OK !* 🚨🚨🚨\n\n'
        +  '📍 *' + (appart.ville || '?') + '*\n'
        +  '💶 ' + (appart.prix ? appart.prix + '€ CC' : '?')
        +  ' | 📐 ' + (appart.surface ? appart.surface + 'm²' : '?')
        +  ' | 🚪 ' + (appart.pieces ? appart.pieces + ' pièce(s)' : '?') + '\n'
        +  '🏢 Étage : ' + etageAff + '\n'
        +  '🌿 Balcon/Terrasse : ✅  |  🅿️ Parking : ✅\n\n'
        +  '💬 _' + (analyse.resume || '') + '_\n\n';

    if (analyse.criteres_ok && analyse.criteres_ok.length > 0) {
      msg += '✅ *Tous les critères validés :*\n';
      analyse.criteres_ok.forEach(function(c) { msg += '• ' + c + '\n'; });
      msg += '\n';
    }

    if (analyse.points_positifs && analyse.points_positifs.length > 0) {
      msg += '👍 *Points positifs :*\n';
      analyse.points_positifs.forEach(function(p) { msg += '• ' + p + '\n'; });
      msg += '\n';
    }

    if (appart.telephone) {
      msg += '📞 *APPELLE MAINTENANT :* ' + appart.telephone + '\n\n';
    } else {
      msg += '📞 _Téléphone non trouvé — contacte via SeLoger_\n\n';
    }

    msg += '🔗 [Voir l\'annonce](' + appart.url + ')\n\n';

    var msgProp = construireMessage(appart.ville, analyse.accroche_personnalisee);
    msg += '📧 *MESSAGE PERSONNALISÉ PRÊT :*\n'
        +  '```\n' + msgProp + '\n```';

    envoyerTelegram(msg, false);
    return;
  }

  // ──────────────────────────────────────────
  // SCÉNARIO PARTIEL → ALERTE NORMALE
  // ──────────────────────────────────────────
  if (analyse.statut === 'PARTIEL') {
    msg += '⚠️ *AGENT APPART — PARTIEL*\n\n'
        +  '📍 *' + (appart.ville || '?') + '*\n'
        +  '💶 ' + (appart.prix ? appart.prix + '€ CC' : '?')
        +  ' | 📐 ' + (appart.surface ? appart.surface + 'm²' : '?')
        +  ' | 🚪 ' + (appart.pieces ? appart.pieces + ' pièce(s)' : '?') + '\n'
        +  '🏢 Étage : ' + etageAff + '\n'
        +  '🌿 Balcon/Terrasse : ' + (appart.balcon ? '✅' : '❓')
        +  '  |  🅿️ Parking : '   + (appart.parking ? '✅' : '❓') + '\n\n'
        +  '💬 _' + (analyse.resume || '') + '_\n\n';

    if (analyse.criteres_ok && analyse.criteres_ok.length > 0) {
      msg += '✅ *Critères validés :*\n';
      analyse.criteres_ok.forEach(function(c) { msg += '• ' + c + '\n'; });
      msg += '\n';
    }

    if (analyse.criteres_non_precises && analyse.criteres_non_precises.length > 0) {
      msg += '❓ *Non précisés — à vérifier :*\n';
      analyse.criteres_non_precises.forEach(function(c) { msg += '• ' + c + '\n'; });
      msg += '\n';
    }

    if (analyse.points_positifs && analyse.points_positifs.length > 0) {
      msg += '👍 *Points positifs :*\n';
      analyse.points_positifs.forEach(function(p) { msg += '• ' + p + '\n'; });
      msg += '\n';
    }

    if (appart.telephone) {
      msg += '📞 Téléphone : ' + appart.telephone + '\n\n';
    }

    msg += '🔗 [Voir l\'annonce](' + appart.url + ')\n\n';
    msg += '👉 _Clique le bouton ci-dessous si tu veux que je te rédige le message._';

    // Bouton interactif : génère le message à la demande (v1.5)
    var boutonMsg = idAnnonce
      ? { inline_keyboard: [[ { text: '✍️ Rédige-moi le message', callback_data: 'msg_' + idAnnonce } ]] }
      : null;

    envoyerTelegram(msg, false, boutonMsg);
    return;
  }

  // ──────────────────────────────────────────
  // SCÉNARIO NON → NOTIFICATION SILENCIEUSE
  // ──────────────────────────────────────────
  if (analyse.statut === 'NON') {
    msg += '❌ *AGENT APPART — NON*\n\n'
        +  '📍 *' + (appart.ville || '?') + '*\n'
        +  '💶 ' + (appart.prix ? appart.prix + '€ CC' : '?')
        +  ' | 📐 ' + (appart.surface ? appart.surface + 'm²' : '?') + '\n\n'
        +  '💬 _' + (analyse.resume || '') + '_\n\n';

    if (analyse.criteres_manquants && analyse.criteres_manquants.length > 0) {
      msg += '❌ *Motif(s) de refus :*\n';
      analyse.criteres_manquants.forEach(function(c) { msg += '• ' + c + '\n'; });
      msg += '\n';
    }

    msg += '🔗 [Voir l\'annonce](' + appart.url + ')';

    envoyerTelegram(msg, true);
    return;
  }

  // ──────────────────────────────────────────
  // SCÉNARIO ERREUR
  // ──────────────────────────────────────────
  msg = '🔴 *AGENT APPART — ERREUR*\n\n'
      + '💬 _' + (analyse.resume || 'Erreur inconnue') + '_\n'
      + '🔗 [Voir l\'annonce](' + appart.url + ')';
  envoyerTelegram(msg, false);
}

function envoyerTelegram(texte, silencieux, replyMarkup) {
  var url = 'https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/sendMessage';

  var payload = {
    chat_id                  : TELEGRAM_CHAT_ID,
    text                     : texte,
    parse_mode               : 'Markdown',
    disable_web_page_preview : false,
    disable_notification     : silencieux || false
  };

  // Ajoute le bouton interactif s'il est fourni (v1.5)
  if (replyMarkup) {
    payload.reply_markup = replyMarkup;
  }

  try {
    UrlFetchApp.fetch(url, {
      method            : 'POST',
      contentType       : 'application/json',
      payload           : JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch(e) {
    Logger.log('Erreur Telegram : ' + e.message);
  }
}


// ============================================================
// 🔘  BOUTON INTERACTIF — "Rédige-moi le message" (webhook v1.5)
// ============================================================

// Extrait l'identifiant d'une annonce depuis son URL.
// Priorité au numéro à 6+ chiffres ; sinon on fabrique un id à partir de l'URL
// (garantit un id non vide → le bouton apparaît toujours).
function extraireIdAnnonce(url) {
  if (!url) return null;
  var m = url.match(/(\d{6,})/);
  if (m) return m[1];
  return 'h' + hashCourt(url);   // fallback : pas de numéro dans l'URL
}

// Petit hachage d'une chaîne → identifiant court et stable (base 36)
function hashCourt(str) {
  var h = 0;
  for (var i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) & 0x7fffffff;  // reste dans les entiers positifs
  }
  return h.toString(36);
}

// Stocke ville + accroche d'une annonce, pour régénérer le message au clic du bouton
function stockerPourMessage(appart, analyse) {
  var id = extraireIdAnnonce(appart.url);
  if (!id) return null;
  try {
    PropertiesService.getScriptProperties().setProperty('MSG_' + id, JSON.stringify({
      ville   : appart.ville || '',
      accroche: analyse.accroche_personnalisee || '',
      url     : appart.url || ''
    }));
  } catch(e) {
    Logger.log('Erreur stockage message : ' + e.message);
  }
  return id;
}

// Point d'entrée du WEBHOOK : Telegram appelle cette fonction quand tu cliques un bouton.
// (Nécessite d'avoir déployé le script en "Application Web".)
function doPost(e) {
  // Verrou : empêche deux clics quasi-simultanés de se traiter en même temps
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch(err) {
    return ContentService.createTextOutput('busy');
  }

  try {
    var update = JSON.parse(e.postData.contents);

    // Anti-boucle : si Telegram rejoue le même clic, on l'ignore
    if (!dejaTraiteUpdate(update.update_id)) {
      if (update.callback_query) {
        gererClicBouton(update.callback_query);
      }
    } else {
      Logger.log('Update ' + update.update_id + ' déjà traité — ignoré (anti-boucle).');
    }
  } catch(err) {
    Logger.log('Erreur doPost : ' + err.message);
  } finally {
    lock.releaseLock();
  }

  return ContentService.createTextOutput('ok');
}

// Mémorise les 50 derniers update_id traités → évite de rejouer un clic en boucle
function dejaTraiteUpdate(updateId) {
  if (updateId === undefined || updateId === null) return false;

  var props = PropertiesService.getScriptProperties();
  var vus   = props.getProperty('UPDATES_VUS') || '';

  // Déjà vu ? (on encadre chaque id de '|' pour une correspondance exacte)
  if (vus.indexOf('|' + updateId + '|') !== -1) return true;

  // Sinon on l'ajoute et on garde les 50 derniers
  var liste = vus.split('|').filter(function(x) { return x.length > 0; });
  liste.push(String(updateId));
  if (liste.length > 50) liste = liste.slice(liste.length - 50);

  props.setProperty('UPDATES_VUS', '|' + liste.join('|') + '|');
  return false;
}

// Traite le clic sur le bouton "Rédige-moi le message"
function gererClicBouton(cq) {
  var data = cq.data || '';

  if (data.indexOf('msg_') !== 0) {
    repondreClic(cq.id, '');
    return;
  }

  var id     = data.substring(4);
  var stored = PropertiesService.getScriptProperties().getProperty('MSG_' + id);

  if (stored) {
    var info    = JSON.parse(stored);
    var message = construireMessage(info.ville, info.accroche);
    envoyerTelegram('📧 *Message prêt pour ' + (info.ville || 'cette annonce') + ' :*\n'
                  + '```\n' + message + '\n```', false);
    repondreClic(cq.id, 'Message généré ✍️');
  } else {
    envoyerTelegram('⚠️ Annonce trop ancienne — infos purgées du cache, message impossible à régénérer.', false);
    repondreClic(cq.id, 'Annonce introuvable');
  }
}

// Répond à Telegram pour stopper l'animation "chargement" sur le bouton cliqué
function repondreClic(callbackId, texte) {
  try {
    UrlFetchApp.fetch('https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/answerCallbackQuery', {
      method            : 'POST',
      contentType       : 'application/json',
      payload           : JSON.stringify({ callback_query_id: callbackId, text: texte || '' }),
      muteHttpExceptions: true
    });
  } catch(e) {
    Logger.log('Erreur answerCallbackQuery : ' + e.message);
  }
}

// À LANCER UNE FOIS après avoir déployé le script en Application Web :
// 1) colle l'URL de déploiement (…/exec) dans WEBHOOK_URL en haut du script
// 2) exécute cette fonction → Telegram saura où envoyer les clics
function configurerWebhook() {
  if (!WEBHOOK_URL || WEBHOOK_URL.indexOf('http') !== 0) {
    Logger.log('❌ WEBHOOK_URL vide ou invalide. Déploie en Application Web, puis colle l\'URL /exec en haut du script.');
    return;
  }
  var url = 'https://api.telegram.org/bot' + TELEGRAM_TOKEN
          + '/setWebhook?url=' + encodeURIComponent(WEBHOOK_URL);
  var r = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  Logger.log('Réponse setWebhook : ' + r.getContentText());
}

// Utilitaire : désactive le webhook (pour revenir en arrière si besoin)
function supprimerWebhook() {
  var r = UrlFetchApp.fetch('https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/deleteWebhook',
                            { muteHttpExceptions: true });
  Logger.log('Réponse deleteWebhook : ' + r.getContentText());
}


// ============================================================
// 📊  GOOGLE SHEETS — ENREGISTREMENT (22 colonnes)
// ============================================================
function getOuCreerSheet() {
  var props   = PropertiesService.getScriptProperties();
  var sheetId = props.getProperty('AGENT_SHEET_ID_V13');

  if (sheetId) {
    try {
      var ss    = SpreadsheetApp.openById(sheetId);
      var sheet = ss.getSheetByName('Suivi');
      return sheet || initFeuille(ss);
    } catch(e) {
      Logger.log('Sheet introuvable, recréation...');
    }
  }

  var nouveau = SpreadsheetApp.create('🏠 Agent Appartement — Suivi v1.3');
  props.setProperty('AGENT_SHEET_ID_V13', nouveau.getId());
  envoyerTelegram('📊 *Fichier de suivi v1.3 créé !*\nOuvre-le ici : ' + nouveau.getUrl(), false);
  return initFeuille(nouveau);
}

function initFeuille(ss) {
  var sheet = ss.insertSheet('Suivi');

  var headers = [
    'Date',                  // A
    'Ville',                 // B
    'Titre',                 // C
    'Surface',               // D
    'Loyer CC',              // E
    'Pièces',                // F
    'Étage',                 // G
    'Balcon/Terrasse',       // H
    'Parking',               // I
    'Meublé',                // J
    'Statut IA',             // K
    'Recommandation',        // L
    'Critères manquants',    // M
    'Résumé IA',             // N
    'Message envoyé',        // O
    'Lien annonce',          // P
    'Téléphone',             // Q
    'Réponse reçue',         // R  ← MANUEL
    'Statut final',          // S  ← MANUEL
    'Date visite',           // T  ← MANUEL
    'Latitude',              // U
    'Longitude',             // V
    'Notes'                  // W  ← MANUEL
  ];

  var row1 = sheet.getRange(1, 1, 1, headers.length);
  row1.setValues([headers]);
  row1.setBackground('#1565C0');
  row1.setFontColor('#FFFFFF');
  row1.setFontWeight('bold');
  sheet.setFrozenRows(1);

  // Largeurs colonnes
  var largeurs = [
    90, 130, 200, 80, 90, 70, 70, 110, 90, 80,
    90, 110, 260, 280, 100, 200,
    120, 110, 120, 100, 90, 90, 200
  ];
  largeurs.forEach(function(l, i) { sheet.setColumnWidth(i + 1, l); });

  // Listes déroulantes pour les colonnes manuelles
  var derniereLigne = 500;

  // Colonne R : Réponse reçue
  var regleR = SpreadsheetApp.newDataValidation()
    .requireValueInList(['EN ATTENTE', 'OUI', 'NON'], true)
    .build();
  sheet.getRange(2, 18, derniereLigne).setDataValidation(regleR);

  // Colonne S : Statut final
  var regleS = SpreadsheetApp.newDataValidation()
    .requireValueInList(['EN COURS', 'VISITE PRÉVUE', 'VISITÉ', 'REFUSÉ', 'ACCEPTÉ', 'ANNULÉ'], true)
    .build();
  sheet.getRange(2, 19, derniereLigne).setDataValidation(regleS);

  // Colonne T : Date visite (format date)
  sheet.getRange(2, 20, derniereLigne).setNumberFormat('dd/MM/yyyy');

  // Supprimer feuille vide par défaut
  ['Feuille 1', 'Sheet1'].forEach(function(nom) {
    var d = ss.getSheetByName(nom);
    try { if (d) ss.deleteSheet(d); } catch(e) {}
  });

  return sheet;
}

function loggerSheet(appart, analyse) {
  try {
    var sheet    = getOuCreerSheet();
    var couleurs = { OK: '#C8E6C9', PARTIEL: '#FFF9C4', NON: '#FFCDD2', ERREUR: '#F5F5F5' };
    var couleur  = couleurs[analyse.statut] || '#FFFFFF';

    var etageAff = '?';
    if (appart.etage !== null && appart.etage !== undefined) {
      etageAff = appart.etage === 0 ? 'RDC' : appart.etage + 'ème';
    }

    var ligne = [
      appart.date,                                                                           // A
      appart.ville           || '?',                                                          // B
      appart.titre           || '?',                                                          // C
      appart.surface  ? appart.surface  + ' m²' : '?',                                       // D
      appart.prix     ? appart.prix     + ' €'  : '?',                                       // E
      appart.pieces   ? appart.pieces   + ' p.' : '?',                                       // F
      etageAff,                                                                               // G
      appart.balcon   ? 'OUI' : 'Non précisé',                                               // H
      appart.parking  ? 'OUI' : 'Non précisé',                                               // I
      appart.meuble   ? 'OUI' : 'Non précisé',                                               // J
      analyse.statut         || '?',                                                          // K
      analyse.recommandation || '?',                                                          // L
      (analyse.criteres_manquants || []).concat(analyse.criteres_non_precises || []).join(' | '), // M
      analyse.resume         || '',                                                           // N
      analyse.statut === 'OK' ? 'AUTO' : 'NON',                                              // O
      appart.url,                                                                             // P
      appart.telephone       || '',                                                           // Q
      'EN ATTENTE',                                                                           // R
      'EN COURS',                                                                             // S
      '',                                                                                     // T
      appart.latitude        || '',                                                           // U
      appart.longitude       || '',                                                           // V
      ''                                                                                      // W
    ];

    var numLigne = sheet.getLastRow() + 1;
    var range    = sheet.getRange(numLigne, 1, 1, ligne.length);
    range.setValues([ligne]);
    range.setBackground(couleur);

    // Lien cliquable
    sheet.getRange(numLigne, 16).setFormula('=HYPERLINK("' + appart.url + '","Voir annonce")');

    Logger.log('Sheet : ligne ' + numLigne + ' ajoutée (' + analyse.statut + ')');

  } catch(e) {
    Logger.log('Erreur Sheet : ' + e.message);
  }
}


// ============================================================
// 🧪  FONCTIONS DE TEST
// ============================================================

/**
 * TEST 1 — Vérifie que Telegram fonctionne
 */
function testerTelegram() {
  envoyerTelegram('✅ *Agent Appartement v1.3 actif !*\nNouvelles fonctions : dédoublonnage, fix géocodage, logs détaillés.', false);
  Logger.log('Message de test envoyé sur Telegram.');
}

/**
 * TEST 2 — Simule un appartement OK (alerte urgente)
 */
function testerAppartOK() {
  var appartOK = {
    url        : 'https://www.seloger.com/annonces/test-ok-v13',
    date       : new Date().toLocaleDateString('fr-FR'),
    titre      : 'T2 lumineux avec terrasse — Centre-ville',
    prix       : 690,
    surface    : 48,
    pieces     : 2,
    ville      : 'Ville Test',
    etage      : 3,
    balcon     : true,
    parking    : true,
    meuble     : true,
    telephone  : '0612345678',
    description: 'Bel appartement T2 meublé au 3ème étage avec terrasse plein sud et place de parking en sous-sol. Proche gare et commerces. Vue dégagée. Loyer 690 € CC. Location annuelle. Cuisine équipée, double vitrage, interphone.'
  };

  Logger.log('Test appartement OK (alerte urgente)...');
  var analyse = analyserAvecIA(appartOK);
  Logger.log('Résultat : ' + JSON.stringify(analyse, null, 2));

  var coords = geocoder(appartOK.ville, '');
  appartOK.latitude  = coords.lat;
  appartOK.longitude = coords.lon;

  loggerSheet(appartOK, analyse);
  notifierTelegram(appartOK, analyse);
  Logger.log('Test OK terminé.');
}

/**
 * TEST 3 — Simule un appartement PARTIEL
 */
function testerAppartPartiel() {
  var appartPartiel = {
    url        : 'https://www.seloger.com/annonces/test-partiel-v13',
    date       : new Date().toLocaleDateString('fr-FR'),
    titre      : 'Appartement T2 centre-ville',
    prix       : 720,
    surface    : 42,
    pieces     : 2,
    ville      : 'Ville Test 2',
    etage      : null,
    balcon     : true,
    parking    : false,
    meuble     : false,
    telephone  : null,
    description: 'T2 avec balcon, proche centre-ville et accès direct à la plage. Quartier calme et résidentiel. Loyer 720 € CC. Location annuelle.'
  };

  Logger.log('Test appartement PARTIEL...');
  var analyse = analyserAvecIA(appartPartiel);
  Logger.log('Résultat : ' + JSON.stringify(analyse, null, 2));

  var coords = geocoder(appartPartiel.ville, '');
  appartPartiel.latitude  = coords.lat;
  appartPartiel.longitude = coords.lon;

  loggerSheet(appartPartiel, analyse);
  notifierTelegram(appartPartiel, analyse);
  Logger.log('Test PARTIEL terminé.');
}

/**
 * TEST 4 — Simule un appartement NON (refusé)
 */
function testerAppartNon() {
  var appartNon = {
    url        : 'https://www.seloger.com/annonces/test-non-v13',
    date       : new Date().toLocaleDateString('fr-FR'),
    titre      : 'Studio RDC',
    prix       : 850,
    surface    : 22,
    pieces     : 1,
    ville      : 'Ville Test 3',
    etage      : 0,
    balcon     : false,
    parking    : false,
    meuble     : false,
    telephone  : null,
    description: 'Studio en rez-de-chaussée. Location saisonnière juillet-août. 850€/mois.'
  };

  Logger.log('Test appartement NON...');
  var analyse = analyserAvecIA(appartNon);
  Logger.log('Résultat : ' + JSON.stringify(analyse, null, 2));

  loggerSheet(appartNon, analyse);
  notifierTelegram(appartNon, analyse);
  Logger.log('Test NON terminé.');
}

/**
 * TEST 5 — Rejoue le dernier mail SeLoger reçu (lu ou non)
 * Utile pour diagnostiquer sans attendre un nouveau mail.
 */
function retraiterDernierMail() {
  var threads = GmailApp.search('from:seloger.com', 0, 1);
  if (threads.length === 0) {
    Logger.log('Aucun mail SeLoger trouvé dans la boîte.');
    return;
  }
  var msg = threads[0].getMessages()[0];
  Logger.log('Retraitement FORCÉ du mail : ' + msg.getSubject() + ' (' + msg.getDate() + ')');
  try {
    traiterEmail(msg, true); // true = ignore le cache anti-doublon
  } catch(e) {
    Logger.log('Erreur : ' + e.message);
  }
}

/**
 * TEST 6 — DIAGNOSTIC : affiche la structure réelle du dernier mail SeLoger
 * Sert à voir comment les annonces sont agencées, pour bâtir un parseur fiable.
 */
function dumpDernierMail() {
  var threads = GmailApp.search('from:seloger.com', 0, 1);
  if (threads.length === 0) {
    Logger.log('Aucun mail SeLoger trouvé.');
    return;
  }
  var msg   = threads[0].getMessages()[0];
  var corps = msg.getBody();
  var urls  = extraireUrlsSeLoger(corps);

  Logger.log('Sujet : ' + msg.getSubject());
  Logger.log('Longueur HTML : ' + corps.length + ' caractères');
  Logger.log('URLs SeLoger trouvées : ' + urls.length + ' → ' + urls.join(' | '));

  // Texte visible (tags HTML retirés) — c'est ce qu'un humain lit
  var texte = corps.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  Logger.log('=== TEXTE VISIBLE DU MAIL (6000 premiers caractères) ===');
  Logger.log(texte.substring(0, 6000));
  Logger.log('=== FIN ===');
}

/**
 * TEST 7 — Vérifie l'affichage du bouton "Rédige-moi le message" (v1.5)
 * Envoie une fausse annonce PARTIEL. Le bouton DOIT apparaître sous le message.
 */
function testerBouton() {
  var appart = {
    url        : 'https://www.seloger.com/annonces/locations/appartement/ville-test/999888777.htm',
    date       : new Date().toLocaleDateString('fr-FR'),
    titre      : 'T2 test bouton — Ville Test',
    prix       : 600,
    surface    : 31,
    pieces     : 2,
    ville      : 'Ville Test',
    etage      : null,
    balcon     : false,
    parking    : false,
    meuble     : false,
    telephone  : null
  };
  var analyse = {
    statut                 : 'PARTIEL',
    criteres_ok            : ['Loyer maximum', 'Ville acceptée'],
    criteres_manquants     : [],
    criteres_non_precises  : ['Étage', 'Balcon/Terrasse', 'Parking'],
    points_positifs        : [],
    points_negatifs        : [],
    resume                 : 'Test du bouton interactif.',
    recommandation         : 'VERIFIER',
    accroche_personnalisee : 'La proximité de la mer correspond à mon mode de vie sportif.'
  };

  notifierTelegram(appart, analyse);
  Logger.log('testerBouton : notif envoyée. Le bouton doit apparaître dans Telegram.');
}

/**
 * INSTALLER LE DÉCLENCHEUR AUTOMATIQUE
 * Lance UNE SEULE FOIS après les tests
 */
function installerDeclencheur() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    ScriptApp.deleteTrigger(t);
  });

  ScriptApp.newTrigger('checkAlertesSeLoger')
    .timeBased()
    .everyMinutes(10)
    .create();

  Logger.log('Déclencheur installé — vérification toutes les 10 minutes.');
  envoyerTelegram('⏰ *Déclencheur v1.3 activé !*\nSurveillance SeLoger toutes les 10 min avec dédoublonnage et alertes urgentes.', false);
}
