// multiplayer.js

// ---------------------------
// Debugging
// ---------------------------
// Aktiviert oder deaktiviert Konsolen-Logs für Fehlersuche
const DEBUG = true;

// ---------------------------
// Netzwerk-Konfiguration
// ---------------------------
// WebSocket-Server-Adresse und Raum-Name
const serverAddr = 'wss://nosch.uber.space/web-rooms/';
const roomName   = 'minecraft-vr-room';

// ---------------------------
// Lokaler Zustand
// ---------------------------
// Eindeutige Client-ID, vom Server zugewiesen
let clientId = null;
// Anzahl aktuell verbundener Clients
let clientCount = 0;
// Map von Peer-ID zu den A-Frame-Entity-Rigs anderer Spieler
let peers = {};
// Aktueller Zustand der Skybox (Tag oder Nacht)
//let currentSkyboxIsNight = false;
// Scoreboard-Daten: Map von Spieler-ID zu Punkten
let scores = {};
// Set, um bereits besiegte Gegner zu merken
const defeatedEnemies = new Set();
// Map von Spieler-ID zu eingegebenem Namen
const names = {};

// ---------------------------
// Web Audio API für Treffer-Soundeffekt
// ---------------------------
// AudioContext initialisieren
const audioContext = new (window.AudioContext || window.webkitAudioContext)();
// Funktion, die bei Treffer einen kurzen Piepton abspielt
function playHitSound() {
  const osc = audioContext.createOscillator(); // Oszillator erzeugen
  const gainNode = audioContext.createGain();   // Lautstärkesteuerung
  osc.type = 'square';                          // Rechteck-Signal
  osc.frequency.value = 440;                    // Frequenz A4 (440 Hz)
  osc.connect(gainNode);
  gainNode.connect(audioContext.destination);
  gainNode.gain.setValueAtTime(0.1, audioContext.currentTime); // Lautstärke
  osc.start();
  osc.stop(audioContext.currentTime + 0.1); // Ton für 0.1 Sekunden
}

// ---------------------------
// WebSocket-Verbindung
// ---------------------------
// Verbindung zum Server aufbauen
const socket = new WebSocket(serverAddr);

// Letzten gesendeten Kamerazustand merken, um nur bei Änderungen zu senden
let lastPose = { position: null, rotation: null };

// ---------------------------
// Hilfsfunktionen
// ---------------------------

/**
 * sendRequest: Sendet eine JSON-codierte Nachricht zum Server.
 * @param  {...any} message - Beliebige Nachrichtenparameter
 */
function sendRequest(...message) {
  if (socket.readyState !== WebSocket.OPEN) {
    console.warn('[sendRequest] WebSocket nicht offen:', message);
    return;
  }
  socket.send(JSON.stringify(message));
}

/**
 * updateScoreboard: Aktualisiert das HTML-Scoreboard:
 * - Leert die Liste
 * - Sortiert nach absteigendem Punktestand
 * - Fügt jeden Spieler mit Name und Punkten ein
 */
function updateScoreboard() {
  const list = document.getElementById('scores');
  list.innerHTML = '';
  Object.entries(scores)
    .sort(([, a], [, b]) => b - a) // Absteigend sortieren
    .forEach(([id, score]) => {
      const displayName = names[id] || `Spieler ${id}`;
      const li = document.createElement('li');
      li.textContent = `${displayName}: ${score} Punkte`;
      list.appendChild(li);
    });
}

/**
 * broadcastPose: Liest die Kameraposition und -rotation aus und sendet sie,
 * wenn sich mehr als eine minimale Schwelle geändert hat.
 */
function broadcastPose() {
  const head = document.getElementById('head');
  if (!head || !head.object3D) return;

  // Weltpos und -rotation ermitteln
  const worldPos  = new THREE.Vector3();
  const worldQuat = new THREE.Quaternion();
  head.object3D.getWorldPosition(worldPos);
  head.object3D.getWorldQuaternion(worldQuat);
  const worldRot = new THREE.Euler().setFromQuaternion(worldQuat, 'YXZ');

  const position = { x: worldPos.x, y: worldPos.y, z: worldPos.z };
  const rotation = {
    x: THREE.MathUtils.radToDeg(worldRot.x),
    y: THREE.MathUtils.radToDeg(worldRot.y),
    z: THREE.MathUtils.radToDeg(worldRot.z)
  };

  // Abbruch, falls ungültige Werte
  if (!isFinite(position.x)) return;

  // Änderung prüfen
  const hasChanged = !lastPose.position ||
    Math.abs(position.x - lastPose.position.x) > 0.01 ||
    Math.abs(position.y - lastPose.position.y) > 0.01 ||
    Math.abs(position.z - lastPose.position.z) > 0.01 ||
    Math.abs(rotation.x - lastPose.rotation.x) > 1 ||
    Math.abs(rotation.y - lastPose.rotation.y) > 1;

  if (!hasChanged) return;

  lastPose = { position, rotation };
  sendRequest(
    '*broadcast-message*',
    ['pose', clientId, [position.x, position.y, position.z], [rotation.x, rotation.y, rotation.z]]
  );
}

// ---------------------------
// WebSocket-Event-Handler
// ---------------------------

// Bei Verbindungsaufbau Raum betreten und Events abonnieren
socket.addEventListener('open', () => {
  sendRequest('*enter-room*', roomName);
  sendRequest('*subscribe-client-count*');
  sendRequest('*subscribe-client-enter-exit*');
  setInterval(() => sendRequest('*ping*'), 30000); // Ping alle 30s
});

// Nachricht vom Server oder Peers erhalten
socket.addEventListener('message', (event) => {
  if (!event.data) return;
  let incoming;
  try {
    incoming = JSON.parse(event.data);
    if (!Array.isArray(incoming)) return;
  } catch {
    console.warn('Fehler beim Parsen:', event.data);
    return;
  }
  if (DEBUG) console.log('[WebSocket]', incoming);

  const type = incoming[0];
  switch (type) {
    case '*client-id*':
      // Server gibt uns eine eindeutige ID
      clientId = incoming[1];
      setInterval(broadcastPose, 100); // Pose alle 100ms senden

      // Namen abfragen und initial setzen
      const playerName = prompt("Bitte gib deinen Namen ein:");
      names[clientId] = playerName;
      scores[clientId] = scores[clientId] || 0;
      updateScoreboard();
      sendRequest('*broadcast-message*', ['set-name', clientId, playerName]);

      // Host-Initialisierung (gibt das ws-connected-Event)
      document.querySelector('a-scene')?.emit('ws-connected');
      break;

    case '*client-count*':
      // Anzahl Clients aktualisieren
      clientCount = incoming[1];
      break;

    case '*client-enter*':
      // Neuer Client ist beigetreten -> Weltzustand synchronisieren
      const enteringId = incoming[1];
      if (enteringId !== clientId) {
        // Skybox und aktuelle Würfel teilen
        sendRequest('*broadcast-message*', ['skybox-change', currentSkyboxIsNight]);
        document.querySelectorAll('.enemy').forEach(enemy => {
          const pos = enemy.getAttribute('position');
          sendRequest('*broadcast-message*', ['enemy-spawn', enemy.id, pos.x, pos.y, pos.z]);
        });
        // Eigene Namen und Pose an neuen Client senden
        if (names[clientId]) {
          sendRequest('*broadcast-message*', ['set-name', clientId, names[clientId]]);
          broadcastPose();
        }
      }
      break;

    case '*client-exit*':
      // Client hat verlassen -> Rig entfernen
      const exitEl = document.getElementById(`user-${incoming[1]}`);
      exitEl?.remove();
      delete peers[incoming[1]];
      break;

    case 'pose': {
      // Pose eines Peers erhalten -> Rig erstellen oder aktualisieren
      const [peerId, posArr, rotArr] = incoming.slice(1);
      let rig = peers[peerId];
      if (!rig) {
        // Neues Rig anlegen
        rig = document.createElement('a-entity');
        rig.setAttribute('id', `user-${peerId}`);
        rig.setAttribute('position', `${posArr[0]} ${posArr[1]} ${posArr[2]}`);
        // Kopf-Box erstellen
        const headEnt = document.createElement('a-entity');
        headEnt.setAttribute('id', `user-head-${peerId}`);
        headEnt.setAttribute('geometry', 'primitive: box; height:1.6; width:0.4; depth:0.2');
        headEnt.setAttribute('material', 'color: blue');
        rig.appendChild(headEnt);
        // Namensschild über Kopf
        const nameEnt = document.createElement('a-entity');
        nameEnt.setAttribute('id', `name-${peerId}`);
        nameEnt.setAttribute(
          'text',
          'value: ' + (names[peerId] || `Spieler ${peerId}`) +
          '; align: center; width: 4; color: white;'
        );
        nameEnt.setAttribute('position', '0 2 0');
        rig.appendChild(nameEnt);

        document.querySelector('a-scene').appendChild(rig);
        peers[peerId] = rig;
      } else {
        // Bestehendes Rig updaten
        rig.setAttribute('position', `${posArr[0]} ${posArr[1]} ${posArr[2]}`);
        rig.querySelector(`#user-head-${peerId}`)?.setAttribute(
          'rotation',
          `${rotArr[0]} ${rotArr[1]} ${rotArr[2]}`
        );
      }
      break;
    }

    case 'skybox-change':
      // Tag/Nacht-Skybox umschalten
      currentSkyboxIsNight = incoming[1];
      const nightSky = document.querySelector('#skyNight');
      nightSky.removeAttribute('animation__fadein');
      nightSky.removeAttribute('animation__fadeout');
      nightSky.setAttribute(
        currentSkyboxIsNight ? 'animation__fadein' : 'animation__fadeout',
        { property: 'material.opacity', to: currentSkyboxIsNight ? 1 : 0, dur: 2000 }
      );
      break;

    case 'set-name': {
      // Name-Mapping und Namensschild aktualisieren
      const [nid, newName] = incoming.slice(1);
      names[nid] = newName;
      scores[nid] = scores[nid] || 0;
      updateScoreboard();
      const label = document.querySelector(`#user-${nid} #name-${nid}`);
      if (label) label.setAttribute('text', 'value: ' + newName + '; align: center; width: 4; color: white;');
      break;
    }

    case 'score-add': {
      // Punkte hinzufügen und Scoreboard aktualisieren
      const [id, pts] = incoming.slice(1);
      scores[id] = (scores[id] || 0) + pts;
      updateScoreboard();
      break;
    }

    case 'enemy-spawn': {
      // Gegner-Spawning empfangen -> falls nicht besiegt, Würfel erzeugen
      const [eid, ex, ey, ez] = incoming.slice(1);
      if (defeatedEnemies.has(eid)) return;
      if (!document.getElementById(eid)) {
        const cube = document.createElement('a-box');
        cube.setAttribute('id', eid);
        cube.setAttribute('position', `${ex} ${ey} ${ez}`);
        cube.setAttribute('geometry', 'primitive: box; height:2; width:2; depth:2');
        cube.setAttribute('scale', '0.5 0.5 0.5');
        cube.setAttribute('material', 'color: red; shader: standard');
        cube.setAttribute('class', 'enemy');
        document.querySelector('a-scene').appendChild(cube);
        this.moveEnemy?.call(this, cube);
      }
      break;
    }

    case 'enemy-hit':
      // Treffer-Ereignis empfangen -> Würfel entfernen
      removeEnemyById(incoming[1]);
      break;

    case 'enemy-move': {
      // Positions-Update für Gegner
      const [mid, mx, my, mz] = incoming.slice(1);
      const moveEnt = document.getElementById(mid);
      if (moveEnt) moveEnt.setAttribute('position', `${mx} ${my} ${mz}`);
      break;
    }
  }
});

// Bei Verbindungsende oder Fehler aufräumen
socket.addEventListener('close', () => console.warn('[WebSocket] Verbindung geschlossen'));
socket.addEventListener('error', err => console.error('[WebSocket] Fehler:', err));

// ---------------------------
// A-Frame-Komponenten
// ---------------------------

/**
 * vertical-move:
 * Erlaubt Höhenverstellung mit Tasten E (hoch) und Q (runter).
 */
AFRAME.registerComponent('vertical-move', {
  schema: { speed: { type: 'number', default: 0.2 } },
  tick: function () {
    const pos = this.el.getAttribute('position');
    if (document.activeElement !== document.body) return;
    if (keys['e']) pos.y += this.data.speed;
    if (keys['q']) pos.y -= this.data.speed;
    this.el.setAttribute('position', pos);
  }
});

/**
 * change-sky-on-gaze:
 * Wechselt die Skybox, wenn der Spieler die Sonne drei Sekunden lang anblickt.
 */
AFRAME.registerComponent('change-sky-on-gaze', {
  init: function () {
    this.sunVisible = false;
    this.timer = null;
    this.isNight = false;
    this.el.addEventListener('raycaster-intersection', evt => {
      if (evt.detail.els.includes(document.querySelector('#sun')) && !this.sunVisible) {
        this.sunVisible = true;
        this.timer = setTimeout(() => {
          const nightSky = document.querySelector('#skyNight');
          nightSky.removeAttribute('animation__fadein');
          nightSky.removeAttribute('animation__fadeout');
          this.isNight = !this.isNight;
          sendRequest('*broadcast-message*', ['skybox-change', this.isNight]);
          // Direkte Aktualisierung der lokalen Skybox
          currentSkyboxIsNight = this.isNight;
          nightSky.setAttribute(
            this.isNight ? 'animation__fadein' : 'animation__fadeout',
            { property: 'material.opacity', to: this.isNight ? 1 : 0, dur: 2000 }
          );
        }, 3000);
      }
    });
    this.el.addEventListener('raycaster-intersection-cleared', () => {
      if (this.sunVisible) {
        this.sunVisible = false;
        clearTimeout(this.timer);
      }
    });
  }
});

/**
 * game-manager:
 * Verantwortlich für Gegner-Spawning, Schuss-Logik und Gegner-Bewegung.
 */
AFRAME.registerComponent('game-manager', {
  init: function () {
    // Host (clientId=0) übernimmt das Spawnen der Gegner
    this.el.sceneEl.addEventListener('ws-connected', () => {
      if (parseInt(clientId, 10) === 0) {
        this.spawnEnemies();
        setInterval(() => this.spawnEnemies(), 5000);
      }
    });
    // Schießen per Klick oder VR-Controller-Trigger
    const sceneEl = this.el.sceneEl;
    sceneEl.addEventListener('click', () => this.handleShoot());
    sceneEl.querySelectorAll('[laser-controls]').forEach(ctrl => {
      ctrl.addEventListener('triggerdown', () => this.handleShoot());
    });
  },

  /**
   * spawnEnemies:
   * Erzeugt zufällig platzierte Gegner-Würfel und broadcastet sie.
   */
  spawnEnemies: function () {
    const scene = document.querySelector('a-scene');
    for (let i = 0; i < 5; i++) {
      const cube = document.createElement('a-box');
      const id   = `enemy-${Date.now()}-${Math.random()}`;
      const x    = (Math.random() - 0.5) * 100;
      const z    = (Math.random() - 0.5) * 100;
      // Y-Koordinate mit leichter Variation, nie unter 130
      const baseY  = 140;
      const deltaY = (Math.random() - 0.5) * 20;
      const y      = Math.max(baseY + deltaY, 130);
      cube.setAttribute('geometry', 'primitive: box; height:2; width:2; depth:2');
      cube.setAttribute('scale', '0.5 0.5 0.5');
      cube.setAttribute('material', 'color: red; shader: standard');
      cube.setAttribute('position', `${x} ${y} ${z}`);
      cube.setAttribute('class', 'enemy');
      cube.setAttribute('id', id);
      scene.appendChild(cube);
      // Deaktiviert Frustum Culling, damit Würfel immer sichtbar sind
      cube.object3D.traverse(o => {
        if (o.isMesh) {
          o.geometry.computeBoundingBox();
          o.geometry.computeBoundingSphere();
          o.frustumCulled = false;
        }
      });
      this.moveEnemy(cube);
      sendRequest('*broadcast-message*', ['enemy-spawn', id, x, y, z]);
    }
  },

  /**
   * moveEnemy:
   * Bewegt jeden Gegner periodisch zufällig um wenige Einheiten.
   */
  moveEnemy: function (cube) {
    const intervalId = setInterval(() => {
      const pos = cube.getAttribute('position');
      const newPos = {
        x: pos.x + (Math.random() - 0.5) * 4,
        y: pos.y,
        z: pos.z + (Math.random() - 0.5) * 4
      };
      cube.setAttribute('position', newPos);
      sendRequest('*broadcast-message*', ['enemy-move', cube.id, newPos.x, newPos.y, newPos.z]);
    }, 500);
    cube.setAttribute('data-move-interval', intervalId);
  },

  /**
   * handleShoot:
   * Erzeugt einen Raycast aus der Kamera, prüft Treffer und entfernt Gegner.
   */
  handleShoot: function () {
    const cameraEl = document.querySelector('[camera]');
    const threeCam = cameraEl.getObject3D('camera');
    const dir      = new THREE.Vector3();
    threeCam.getWorldDirection(dir);
    const origin   = new THREE.Vector3();
    threeCam.getWorldPosition(origin);

    // Ray erstellen und mit allen Gegner-Meshes prüfen
    const ray = new THREE.Raycaster(origin, dir);
    const enemies = [];
    document.querySelectorAll('.enemy').forEach(el => {
      el.object3D.traverse(o => {
        if (o.isMesh) {
          o.el = el;
          enemies.push(o);
        }
      });
    });

    const intersects = ray.intersectObjects(enemies, true);
    if (intersects.length > 0) {
      const el = intersects[0].object.el;
      if (el.classList.contains('enemy') && !defeatedEnemies.has(el.id)) {
        // Treffer verarbeiten
        defeatedEnemies.add(el.id);
        playHitSound(); // Soundeffekt bei Treffer abspielen
        el.setAttribute('color', 'white');
        setTimeout(() => el.setAttribute('color', 'red'), 100);
        sendRequest('*broadcast-message*', ['enemy-hit', el.id]);
        sendRequest('*broadcast-message*', ['score-add', clientId, 100]);
        scores[clientId] = (scores[clientId] || 0) + 100;
        updateScoreboard();
        removeEnemyById(el.id);
      }
    }
  }
});

/**
 * removeEnemyById:
 * Entfernt einen Gegner aus der Szene und stoppt seine Bewegung.
 * @param {string} id - ID des Gegners
 */
function removeEnemyById(id) {
  const tgt = document.getElementById(id);
  if (!tgt) return console.warn('[Enemy Remove] nicht gefunden:', id);
  clearInterval(Number(tgt.getAttribute('data-move-interval')) || 0);
  tgt.setAttribute('visible', 'false');
  setTimeout(() => tgt.remove(), 50);
}
window.removeEnemyById = removeEnemyById;

// ---------------------------
// Tastatur-Eingaben
// ---------------------------
const keys = {};
window.addEventListener('keydown', e => keys[e.key.toLowerCase()] = true);
window.addEventListener('keyup', e => keys[e.key.toLowerCase()] = false);

// Globale Funktionen und Variablen für Debugging und Zugriff
window.sendRequest = sendRequest;
Object.defineProperty(window, 'clientId', { get: () => clientId });
