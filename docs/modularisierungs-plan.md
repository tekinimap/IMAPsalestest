# Vorschlag zur Modularisierung von `public/js/app.js`

Die Datei `public/js/app.js` (ca. 4.000+ Zeilen) bündelt aktuell sehr unterschiedliche Aufgaben: Navigation, Session-/Personenverwaltung, Erfassung, Dock-Board-Logik, Berechnungen, Modals, Admin-Ansichten, ERP-Import und Auswertungen. Dadurch ist die Wartbarkeit erschwert. Im Folgenden steht ein konkret umsetzbarer Aufteilungsplan auf Basis der vorhandenen Abschnittskommentare in der Datei.

## Grundprinzipien
- **Feature-orientierte Module:** Jede bestehende Abschnittsüberschrift wird zu einem eigenen ES-Modul unter `public/js/features/`. Das erleichtert gezielten Import und Testing.
- **Klare Verantwortung:** Trenne View-Initialisierung, API-Zugriffe und Berechnungslogik. Gemeinsame Helfer bleiben in `utils/`, Zustandsverwaltung in `state/` bzw. `entries-state`.
- **Schmale Einstiegspunkte:** Ein neuer `public/js/main.js` importiert die Feature-Module, übernimmt globale Event-Wiring und delegiert an die spezialisierten Dateien.

## Zielstruktur (Neu anzulegen)
- `public/js/main.js` – Einstiegspunkt, Navigation zwischen Views, orchestriert Initial-Loads.
- `public/js/features/navigation.js` – Menü-Links, `showView` und View-spezifische Initialisierungen.
- `public/js/features/dock-board.js` – Dock-Spalten, Filter, Auto-Advance/Auto-Check, Selektion, Batch-Aktionen, Gewichtung.
- `public/js/features/people.js` – Session-Laden, People-Liste (`/session`, `/people`), Erkennen der eingeloggten Person.
- `public/js/features/erfassung.js` – Formularzeilen (Delegation an `ui/forms.js`), Metadaten-Kurzedit, Gewichtungsauswahl, Validierungen und Autosave.
- `public/js/features/calculations.js` – Berechnungslogik für Sales-Shares, Kapitalisierung der Gewichte, Ableitung von Summen/Chips.
- `public/js/features/overview-rahmen.js` – Übersicht, Rahmenverträge, Abrufzuordnung, Dock-Zuordnung per Modal/Buttons.
- `public/js/features/modals.js` – Move-Fix-Order-Modal, generische Edit-Dialogs, gemeinsame Dialog-Helfer.
- `public/js/features/admin.js` – Admin-Ansicht, Team-Optionen, People-Rendering.
- `public/js/features/erp-import.js` – ERP-Import-Flow inkl. Vorschau/Override, Logbook-Interceptor-Hooks.
- `public/js/features/analytics.js` – Auswertungs-Tab, Charts/Tabellen, Filter.
- `public/js/features/common-events.js` – Globale Listener wie `window`-Events, Dialog-Schließen, `beforeunload`-Warnungen (optional – falls diese aktuell über alle Abschnitte verteilt sind).

## Umsetzungsreihenfolge und Status
1. **Einstiegspunkt aufbrechen:** ✅ erledigt
   - `public/js/main.js` lädt die App, `index.html` bindet es als neues Entry-Module ein.
2. **People & Session isolieren:** ✅ erledigt
   - `loadSession`, `loadPeople`, `findPersonByName/Email` und Abgleiche leben in `features/people.js`.
3. **Erfassung modularisieren:** ✅ erledigt
   - Formular-spezifische DOM-Referenzen und Handler (`btnAddRow`, `btnSave`, Validierungen, Autosave) nach `features/erfassung.js` verlagert.
   - Abhängigkeiten zu `entries-state.js` und `ui/forms.js` klar importiert.
   - `initializeApp` bindet das Modul als Abhängigkeit ein.
4. **Admin isolieren:** ✅ erledigt
   - Admin-spezifische DOM-Elemente, Team-Auswahllogik und Klick-Handler wohnen in `features/admin.js`.
   - `app.js` importiert nur noch `handleAdminClick` und initialisiert das Modul.
5. **Dock-Board & Berechnungen trennen:** ⚙️ teilweise
   - ✅ Reine Berechnungsfunktionen (Gewichtungs-Clamps, Reward-Factor, Summen) liegen jetzt in `features/calculations.js`.
   - ⏳ Filter-, Selektion- und Auto-Advance-Logik folgen in `features/dock-board.js`.
6. **Spezialbereiche ausgliedern:** ⏳ geplant
   - `overview-rahmen.js` für Rahmenvertrags-Ansicht und Abrufe.
   - `modals.js` für Move-Fix-Order-Modal + generische Dialogsteuerung.
   - `erp-import.js` und `analytics.js` analog zu den Abschnittskommentaren.
7. **Gemeinsame Hilfen konsolidieren:** ⏳ geplant
   - Prüfe, welche globale Variablen nur innerhalb eines Features benötigt werden und kapsle sie. Nur notwendige APIs exportieren.
   - Event-Registration pro Modul in einer `init()`-Funktion bündeln.

## Zusätzliche Quick-Wins
- **Dateigröße senken:** Schon das Verschieben der People- und Dock-Logik reduziert `app.js` um ~1.000+ Zeilen.
- **Testbarkeit erhöhen:** Einzelne Module können leichter per Jest/Vitest (falls eingeführt) oder per Storybook/DOM-Mocks getestet werden.
- **Lesbarkeit:** Beibehaltung der vorhandenen Abschnittskommentare als Modulnamen erleichtert Reviewer:innen die Orientierung.

## Abhängigkeiten & Risiken
- `app.js` nutzt bereits viele Hilfs-Module (`utils/format`, `ui/forms`, `entries-state`, `state`, `api`). Diese Imports können unverändert bleiben und je Feature-File gezielt eingebunden werden.
- Vorsicht bei gemeinsam genutzten Mutables (`currentSession`, `people`, `dockSelection`). Diese sollten entweder zentral exportiert oder durch Getter/Setter gekapselt werden, um Seiteneffekte beim Lazy-Import zu vermeiden.
- Achte auf die Reihenfolge der Initialisierungen: Navigation sollte erst nach Laden der Session/People initialisiert werden, falls Labels oder Berechtigungen davon abhängen.

## Definition von Done
- `public/js/app.js` existiert höchstens als dünne Weiterleitung zu `main.js` oder entfällt ganz.
- Jeder frühere Abschnitt hat ein eigenes Modul mit klar benannten Exports (`init*`, `render*`, `handle*`).
- `index.html` lädt nur noch `public/js/main.js`, das wiederum die Feature-Initialisierung orchestriert.
- Es gibt keine verbleibenden globalen Variablen ohne klaren Besitzer.

## Nächste Schritte (Minimum Slice)
1. `main.js` + `features/people.js` + `features/erfassung.js` erstellen und in `index.html` einbinden.
2. Smoke-Test (manuell) für Navigation, Session-Erkennung und Erfassungsformular.
3. Danach iterativ Dock-/Berechnungslogik und Spezial-Views auslagern.
