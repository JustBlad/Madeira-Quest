# Madeira Quest 🗺️📸

Mobile Web-App (Persuasive Computing Gruppenprojekt): Erasmus-Studis in Funchal entdecken lokale Orte,
laden ein Foto hoch, schalten damit die geteilte Galerie frei und bewerten den Ort.

## Features
- **Karte von Funchal** (Leaflet + OpenStreetMap/CARTO) mit Pins nach Kategorie und **Bewertung direkt auf der Karte**
- **GPS**: fragt nach dem Standort, zeigt Entfernung + Gehzeit, markiert Besuche als „vor Ort verifiziert“
- **Ortsseite** (wie Skizze): Name + Stern (merken), Bilder, Bewertung, Beschreibung, „Foto hochladen“
- **Foto hochladen → Galerie freischalten** (vorher verschwommen + Schloss), danach bewerten
- **Level 1 / Level 2**: Level 2 wird nach 4 besuchten Level-1-Orten freigeschaltet
- **Gamification**: Punkte (**5 pro besuchtem Ort, 1 pro Bewertung**), Rangliste nach Punkten, **Wochen-Streak** (jede Woche mind. 1 Ort) mit Countdown bis Sonntag

### Persuasive-Prinzipien
| Prinzip | Umsetzung |
|---|---|
| Fogg (Motivation/Ability/Trigger) | Entfernung + „Route“-Button senken die Hürde, Streak-Hinweis als Trigger |
| Social Proof | „X Studis aus deiner Gruppe waren schon hier“, Avatare, Rangliste |
| Consistency | Fortschrittsbalken, Level-System, Serie |
| Scarcity | gesperrte Galerie bis zum eigenen Foto, Wochen-Countdown |
| Loss Aversion | „Besuche heute einen Ort, sonst ist deine Serie weg!“ |
| Default Effect | Teilen in der Galerie ist standardmäßig an, Standort-Abfrage beim Start |
| Ethik | Bewerten nur nach Foto-Upload, echte Fristen, Standort bleibt auf dem Gerät |

## Starten
Einfach `index.html` über einen Webserver öffnen, z. B.:
```bash
cd madeira-quest
python3 -m http.server 8000
```
→ http://localhost:8000

**Live-Version:** https://justblad.github.io/Madeira-Quest/
(GitHub Pages: Settings → Pages → Branch `main`, Ordner `/ (root)`). Jede Änderung auf `main` ist nach ca. 1 Minute live.
GPS funktioniert auf dem Handy nur über HTTPS – also über diesen Link.

## Anpassen
- Orte, Texte, Koordinaten: `data.js` (Koordinaten sind noch ungefähr – in Google Maps lange drücken, Zahlen kopieren)
- Sprache der App: Englisch (für alle Erasmus-Studis)

## Google Maps einrichten (schönste Karte)
Ohne Key nutzt die App MapTiler/Esri. Mit Key wird die echte Google-Maps-Karte (Satellit + Straßen) angezeigt.

1. https://console.cloud.google.com → oben **Projekt auswählen → Neues Projekt** (z. B. „Madeira Quest“).
2. **Abrechnung aktivieren** (Menü → *Abrechnung*). Google verlangt eine Karte, aber Kartenaufrufe sind bis zu
   einem monatlichen Gratis-Kontingent kostenlos – für eine Erasmus-Gruppe reicht das locker.
   Tipp: unter *Abrechnung → Budgets & Benachrichtigungen* ein Budget von 1 € mit E-Mail-Warnung anlegen.
3. Menü → **APIs & Dienste → Bibliothek** → „**Maps JavaScript API**“ → **Aktivieren**.
4. Menü → **APIs & Dienste → Anmeldedaten → Anmeldedaten erstellen → API-Schlüssel**.
5. Den Schlüssel **einschränken** (wichtig, er steht öffentlich im Code):
   - *Anwendungseinschränkungen*: **Websites** → `https://DEINNAME.github.io/*` und `http://localhost:8000/*`
   - *API-Einschränkungen*: nur **Maps JavaScript API**
6. Schlüssel in `data.js` bei `googleMapsKey: ""` eintragen.

**Kostenlose Fotos (Wikimedia Commons, Standard):** Ohne Key und ohne Konto sucht die App automatisch frei lizenzierte Fotos,
die direkt an den Koordinaten eines Orts aufgenommen wurden (Strände: 300 m Umkreis, sonst 90 m), und zeigt Fotograf + Lizenz an.
Für Strände/Fort gibt es meist gute Bilder, für einzelne Bars/Cafés oft keine – dann bleiben die Illustrationen.
Eigene Fotos im `img/`-Ordner haben immer Vorrang. Ausschalten: `commonsPhotos: false` in `data.js`.

**Echte Fotos der Orte (Google Places):** Mit demselben Schlüssel zeigt die App automatisch die Google-Maps-Fotos jedes Orts
(mit Namen des Fotografen, wie Google es vorschreibt). Dafür zusätzlich unter *APIs & Dienste → Bibliothek* die
**„Places API (New)“** aktivieren und sie beim Schlüssel unter *API-Einschränkungen* mit erlauben.
Fotos werden erst geladen, wenn man einen Ort öffnet, und pro Browser-Sitzung zwischengespeichert. Ausschalten: `googlePlacePhotos: false`.
Foto-Abrufe kosten nach einem Gratis-Kontingent Geld – Budget-Warnung in der Cloud Console setzen.

Wird der Schlüssel abgelehnt (falsch, Abrechnung aus, falsche Domain), schaltet die App automatisch auf die Ersatzkarte.

## Echtes Teilen mit Firebase (kostenlos)
Ohne Config läuft die App im **Demo-Modus** (Beispiel-Studis, alles nur auf dem eigenen Handy).
Mit Firebase sehen alle die Fotos, Bewertungen und Punkte der anderen – live.

1. https://console.firebase.google.com → **Projekt hinzufügen** (Google Analytics kannst du ausschalten).
2. Links **Build → Authentication → Jetzt starten → Sign-in method → Anonym → aktivieren**.
3. Links **Build → Firestore Database → Datenbank erstellen** → Standort `eur3 (europe-west)` → *Produktionsmodus*.
4. In Firestore auf den Tab **Regeln**, alles löschen, den Inhalt von [`firestore.rules`](firestore.rules) einfügen → **Veröffentlichen**.
5. Zahnrad ⚙️ → **Projekteinstellungen** → unten **Web-App hinzufügen** (`</>`) → Namen eingeben → die angezeigten
   Werte (`apiKey`, `authDomain`, `projectId`, …) in [`firebase-config.js`](firebase-config.js) eintragen.
6. Fertig. Oben im Profil steht jetzt „🟢 live“ statt „demo“.

Hinweise:
- Der `apiKey` von Firebase ist **kein Geheimnis** und darf öffentlich im Code stehen; geschützt wird alles durch die Regeln.
- Es wird nur Firestore benutzt (kein Firebase Storage) – Fotos werden auf ~800 px verkleinert und passen in den kostenlosen Spark-Plan.
- Jedes Handy bekommt eine anonyme ID. Jede:r kann alles lesen, aber nur die eigenen Einträge schreiben/löschen.
  Bewerten geht laut Regeln nur, wenn man an dem Ort schon ein Foto hochgeladen hat.
- Der Standort wird **nie** hochgeladen, nur Name, Farbe, Punkte, Besuche, Bewertungen und geteilte Fotos.

## Sicherheit
**Was die App absichert**
- **GPS-Fälschung (best effort):** Beim Upload wird eine frische Position abgefragt. „Vor Ort verifiziert“ gibt es nur, wenn
  der Ort ≤ 200 m entfernt ist, die Genauigkeit ≤ 100 m beträgt, die Position höchstens 60 s alt ist, das Foto höchstens 24 h alt ist
  und der Standort nicht unrealistisch „gesprungen“ ist (> 250 km/h) oder eine perfekte Genauigkeit (< 1 m) meldet – beides typisch für Fake-GPS-Apps.
- **Punkte:** Die Rangliste glaubt keiner Punktzahl vom Handy, sondern rechnet sie aus den Besuchen und Bewertungen neu aus
  (max. 1 Besuch + 1 Bewertung pro Ort und Person, nur echte Orte).
- **Firestore-Regeln** (`firestore.rules`): jeder schreibt nur eigene Dokumente, nur bekannte Felder, nur echte Orte,
  Zeitstempel nicht in der Zukunft, Bewertungen nur nach eigenem Besuch, Fotos nur als JPEG < 900 KB, Bildtext ≤ 40 Zeichen.
- **XSS:** alle Nutzertexte werden escaped, Farben/Bilder geprüft, dazu eine Content-Security-Policy im `index.html`.
- **Datenschutz:** Fotos werden neu kodiert → **EXIF-Daten inkl. GPS-Ort des Fotos werden entfernt**. Der Standort wird nie hochgeladen.

**Grenzen (ehrlich):** Alles läuft im Browser. Wer sich auskennt, kann GPS trotzdem fälschen oder selbst „verified: true“ an Firebase schicken.
Echte Prüfung bräuchte einen Server (z. B. Firebase Cloud Functions). Gegen Spam mit vielen anonymen Konten hilft **Firebase App Check**.
Für eine Erasmus-Gruppe reicht der aktuelle Schutz.

⚠️ Nach Änderungen an `firestore.rules`: in der Firebase-Konsole unter Firestore → Regeln neu einfügen und veröffentlichen.
Neue Orte in `data.js` müssen auch in `placeIds()` in den Regeln ergänzt werden.
