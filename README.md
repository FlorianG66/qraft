# qraft

qraft est une plateforme web de génération de QR codes avec comptes utilisateurs, bibliothèque personnelle et statistiques de scan.

Un QR code de lien peut utiliser une URL de suivi qraft (`/r/…`) : un scan est mesuré, puis l’utilisateur est redirigé vers la destination. En mode local, l’origine par défaut est `http://localhost:3000` : afin qu’un téléphone puisse lire le QR code, qraft encode directement la destination saisie tant qu’aucune origine publique ou réseau joignable n’est configurée. Un QR code de coordonnées ouvre une page de contact qraft (`/c/…`) qui permet de télécharger la vCard, ou encode directement la vCard en mode local. Les QR codes doivent être enregistrés dans un compte ; le suivi s’active lorsque l’origine qraft est joignable par le scanner.

## Prérequis

- Node.js **22.5 ou plus récent** (le projet utilise le module natif `node:sqlite`)
- PowerShell pour le script de lancement sous Windows

Il n’y a pas de dépendances npm à installer.

## Lancer la plateforme

```powershell
powershell -ExecutionPolicy Bypass -File .\start-server.ps1
```

Ouvrez ensuite [http://localhost:3000/](http://localhost:3000/).

Le port et l’arrêt automatique après inactivité sont configurables :

```powershell
.\start-server.ps1 -Port 3000 -IdleTimeoutMinutes 30
```

Le serveur s’arrête automatiquement après 30 minutes sans requête métier (les probes `/api/health` ne réactivent pas ce délai). `Ctrl+C` permet de l’arrêter manuellement. La base SQLite est créée dans `data/qraft.sqlite` et n’est jamais servie comme fichier statique.

## Fonctionnalités

- Création à partir d’une URL HTTP/HTTPS ou d’une vCard 3.0
- Aperçu en direct, personnalisation des deux couleurs
- Export PNG 1024 px et SVG vectoriel
- Copie du contenu encodé
- Inscription et connexion par e-mail/mot de passe
- Sessions serveur avec cookie `HttpOnly` et `SameSite=Strict`
- Bibliothèque personnelle accessible sur les autres navigateurs après connexion
- Statistiques : nombre de scans, évolution sur 30 jours, dernier scan, type d’appareil et domaine de provenance
- Agrégats quotidiens conservés pour garder les totaux ; événements de scan bruts limités et conservés 365 jours
- Réconciliation des agrégats à chaque démarrage : un événement brut absent d’un agrégat est réintégré une seule fois
- Au-delà de 100 domaines de provenance distincts pour un QR code, les nouveaux domaines sont regroupés sous « Autres sources »
- Suppression et modification des QR codes avec contrôle de propriété
- Migration automatique, isolée par compte et idempotente des QR codes précédemment stockés dans `localStorage` (50 par session, y compris les anciennes vCard). Une erreur réseau, de session ou de serveur n’est jamais comptée comme un échec : l’élément est repris à la session suivante

## Sécurité intégrée

- Mots de passe hachés avec `scrypt` et sel aléatoire ; aucun mot de passe en clair n’est stocké
- Jetons de session aléatoires ; seuls leurs hachages sont conservés en base
- Jetons CSRF et vérification de l’origine pour les requêtes modifiables
- Requêtes SQL préparées et validation stricte des données
- Limitation des tentatives de connexion, d’inscription, de création, de scan et de téléchargement public ; déduplication des scans rapprochés
- En-têtes CSP, HSTS en production, `X-Frame-Options`, `nosniff` et politique de référent
- Refus des URL contenant des identifiants, des URL javascript/data et des destinations réseau privées/local par défaut (adresses IP IPv4/IPv6, IPv4-mapped et suffixes locaux)
- Aucun stockage d’adresse IP : ni dans les statistiques (un `Referer` qui est une adresse IP est ignoré), ni dans les tables ; la clé de déduplication des scans est un hachage transitoire conservé uniquement en mémoire
- Limitation du nombre de domaines de provenance par QR code pour que les agrégats ne puissent pas croître sans borne
- Fichiers SQL et code serveur exclus du service de fichiers statiques

## Configuration

Les variables d’environnement sont utiles pour une installation derrière un proxy HTTPS :

```powershell
$env:QRAFT_PUBLIC_ORIGIN = "https://qr.example.com"
$env:QRAFT_HOST = "0.0.0.0"
$env:QRAFT_SECURE_COOKIES = "true"
$env:QRAFT_TRUST_PROXY = "true" # uniquement si le proxy est fiable
$env:NODE_ENV = "production"
powershell -ExecutionPolicy Bypass -File .\start-server.ps1
```

`QRAFT_PUBLIC_ORIGIN` doit être l’origine publique HTTPS réellement accessible par les scanners de QR codes. En production, le serveur refuse une origine HTTP ou des cookies non sécurisés. `QRAFT_TRUST_PROXY=true` n’est activable que si le reverse proxy **réécrit** `X-Forwarded-For` : un en-tête fourni par le client serait sinon accepté tel quel pour le rate limiting et la déduplication des scans.

Par défaut, l’interface reste en **mode direct local** : le QR code contient le lien saisi, car `localhost` désigne le téléphone qui scanne et non le PC qui héberge qraft. Pour activer le suivi depuis un téléphone, configurez une origine réellement joignable par ce téléphone (par exemple une adresse HTTPS publique, ou une adresse réseau locale avec `QRAFT_HOST=0.0.0.0` et les règles de pare-feu appropriées), puis redémarrez le serveur. Pour autoriser explicitement une destination locale ou privée (développement interne uniquement) :

```powershell
$env:QRAFT_ALLOW_PRIVATE_DESTINATIONS = "true"
```

### Limite connue : alias DNS privés

Le contrôle des destinations privée est purement lexical : il compare l’hôte à une liste de suffixes et examine l’adresse IP lorsqu’elle est écrite directement dans l’URL. Un nom public qui pointe vers une adresse privée (`interne.exemple.com` → `10.0.0.5`) n’est pas résolu par le serveur, qui ne ferait que transformer chaque scan en résolution DNS. Ces destinations doivent donc être modérées à la création du QR code (liste d’unités de travail autorisées, revue des signalements), ou le déploiement doit rester sur un réseau où lesQR codes ne sont pas lisibles par des visiteurs non autorisés.

## Tests

```powershell
npm test
```

Le test d’intégration démarre un serveur isolé sur un port libre et une base temporaire, puis vérifie :

- les comptes, les cookies `HttpOnly`/`SameSite=Strict`, le CSRF (y compris une déconnexion refusée sans jeton, qui ne doit pas tuer la session) ;
- l’isolation entre utilisateurs, y compris la réutilisation d’une clé d’import legacy par un autre compte ;
- le refus des destinations privées IPv4/IPv6, des URL `javascript:` et des identifiants dans les URL ;
- les redirections mesurées avant `Location`, les vCards pliées à 75 octets et le contraste des couleurs ;
- la déduplication des scans, l’absence d’adresse IP dans les statistiques, la réconciliation des agrégats au redémarrage, l’idempotence de cette réconciliation et la purge des événements bruts de plus de 365 jours.

## Passage en production

Avant une mise en ligne publique, ajouter au minimum :

1. HTTPS avec un certificat valide et un reverse proxy fiable.
2. Vérification des adresses e-mail et procédure de réinitialisation de mot de passe.
3. Sauvegardes chiffrées et politique de conservation des données.
4. Rate limiting partagé (Redis ou équivalent) si plusieurs instances Node.js sont utilisées.
5. Migration vers PostgreSQL et une gestion de clés/rotation si l’activité devient importante.
6. Une politique de modération des destinations et de suppression des comptes.

Le mode local fourni est sécurisé pour le développement et l’usage local, mais une exposition publique nécessite ces mesures d’exploitation supplémentaires.

## Licence

Code source publié pour consultation. **Tous droits réservés** — aucune licence
ouverte n’est accordée : la reproduction, la modification et la réutilisation du
code, en tout ou partie, sont interdites sans autorisation écrite préalable.

Projet en cours de développement, non achevé.
