// Debug-Logging aktivieren oder deaktivieren
const DEBUG = true;
// Adresse des WebSocket-Servers und Raum-Name
const serverAddr = 'wss://nosch.uber.space/web-rooms/';
const roomName   = 'minecraft-vr-room';

// Client-Zustand speichern
let clientId              = null;  // Eindeutige ID vom Server
let clientCount           = 0;     // Anzahl der verbundenen Clients
let peers                 = {};    // Andere Spieler-Rigs
let currentSkyboxIsNight  = false; // Aktueller Skybox-Zustand
let scores                = {};    // Scoreboard-Daten
const defeatedEnemies     = new Set(); // Entfernte Würfel merken
const names                = {};   // Spieler-ID → Username

// WebSocket-Verbindung aufbauen
const socket = new WebSocket(serverAddr);
// Letzten gesendeten Kamerazustand merken
let lastPose = { position: null, rotation: null };

/*
 sendRequest: Sendet beliebige Nachrichten als JSON-Array
 an den WebSocket-Server.
*/
function sendRequest(...message) {
  if (socket.readyState !== WebSocket.OPEN) {
    console.warn('[sendRequest] WebSocket nicht geöffnet:', message);
    return;
  }
  socket.send(JSON.stringify(message));
}

/*
 updateScoreboard: Listeneinträge löschen und neu aufbauen,
 sortiert nach absteigendem Punktestand.
*/
function updateScoreboard() {
  const list = document.getElementById('scores');
  list.innerHTML = '';
  Object.entries(scores)
    .sort(([, a], [, b]) => b - a)
    .forEach(([id, score]) => {
      const displayName = names[id] || `Spieler ${id}`;
      const li = document.createElement('li');
      li.textContent = `${displayName}: ${score} Punkte`;
      list.appendChild(li);
    });
}

/*
 broadcastPose: Liest Position und Rotation der Kamera in
 Weltkoordinaten und sendet sie, wenn sie sich geändert haben.
*/
function broadcastPose() {
  const head = document.getElementById('head');
  if (!head || !head.object3D) return;

  // Welt-Position und -Quaternion ermitteln
  const worldPos  = new THREE.Vector3();
  const worldQuat = new THREE.Quaternion();
  head.object3D.getWorldPosition(worldPos);
  head.object3D.getWorldQuaternion(worldQuat);
  // Quaternion in Euler-Winkel umwandeln
  const worldRot = new THREE.Euler().setFromQuaternion(worldQuat, 'YXZ');

  const position = { x: worldPos.x, y: worldPos.y, z: worldPos.z };
  const rotation = {
    x: THREE.MathUtils.radToDeg(worldRot.x),
    y: THREE.MathUtils.radToDeg(worldRot.y),
    z: THREE.MathUtils.radToDeg(worldRot.z)
  };

  // Nur senden, wenn Werte gültig sind
  if (!isFinite(position.x) || !isFinite(rotation.x)) return;

  // Prüfen, ob Änderung groß genug ist
  const hasChanged = !lastPose.position || !lastPose.rotation ||
    Math.abs(position.x - lastPose.position.x) > 0.01 ||
    Math.abs(position.y - lastPose.position.y) > 0.01 ||
    Math.abs(position.z - lastPose.position.z) > 0.01 ||
    Math.abs(rotation.x - lastPose.rotation.x) > 1 ||
    Math.abs(rotation.y - lastPose.rotation.y) > 1 ||
    Math.abs(rotation.z - lastPose.rotation.z) > 1;

  if (!hasChanged) return;

  lastPose = { position, rotation };
  sendRequest(
    '*broadcast-message*',
    ['pose', clientId, [position.x, position.y, position.z], [rotation.x, rotation.y, rotation.z]]
  );
}

// Beim Öffnen des Sockets Raum betreten und Events abonnieren
socket.addEventListener('open', () => {
  sendRequest('*enter-room*', roomName);
  sendRequest('*subscribe-client-count*');
  sendRequest('*subscribe-client-enter-exit*');
  // Ping zur Verbindungs-Aufrechterhaltung
  setInterval(() => sendRequest('*ping*'), 30000);
});

// Eingehende Nachrichten verarbeiten
socket.addEventListener('message', (event) => {
  if (!event.data) return;
  let incoming;
  try {
    incoming = JSON.parse(event.data);
    if (!Array.isArray(incoming) || typeof incoming[0] !== 'string') return;
  } catch {
    console.warn('Fehler beim Parsen:', event.data);
    return;
  }
  if (DEBUG) console.log('[WebSocket] Nachricht:', incoming);

  const type = incoming[0];
  switch (type) {
    case '*client-id*':
      // Server weist eine ID zu
      clientId = incoming[1];
      console.log('[Client] ID:', clientId);
      // Starte regelmäßige Pose-Updates
      setInterval(broadcastPose, 100);
      // Namen abfragen und im lokalen Mapping speichern
      const playerName = prompt("Bitte gib deinen Namen ein:");
      names[clientId] = playerName;
      scores[clientId] = scores[clientId] || 0;
      updateScoreboard();
      // Name an alle anderen senden
      sendRequest('*broadcast-message*', ['set-name', clientId, playerName]);
      // Host-Logik starten (Würfel spawnen)
      document.querySelector('a-scene')?.emit('ws-connected');
      break;

    case '*client-count*':
      // Anzahl verbundener Clients speichern
      clientCount = incoming[1];
      break;

    case '*client-enter*':
      // Neuer Spieler ist beigetreten → Weltzustand synchronisieren
      const enteringClientId = incoming[1];
      if (enteringClientId !== clientId) {
        // Skybox und Würfel teilen
        sendRequest('*broadcast-message*', ['skybox-change', currentSkyboxIsNight]);
        document.querySelectorAll('.enemy').forEach(enemy => {
          const pos = enemy.getAttribute('position');
          sendRequest('*broadcast-message*', ['enemy-spawn', enemy.id, pos.x, pos.y, pos.z]);
        });
        // Eigenen Namen und Pose an den neuen Spieler senden
        if (names[clientId]) {
          sendRequest('*broadcast-message*', ['set-name', clientId, names[clientId]]);
          broadcastPose();
        }
      }
      break;

    case '*client-exit*':
      // Spieler hat verlassen → Rig entfernen
      const peerEl = document.getElementById(`user-${incoming[1]}`);
      peerEl?.remove();
      delete peers[incoming[1]];
      break;

    case 'pose': {
      // Pose eines Mitspielers empfangen → Rig erstellen/aktualisieren
      const [senderId, posArr, rotArr] = incoming.slice(1);
      let rig = peers[senderId];
      if (!rig) {
        // Erstmaliges Erstellen
        rig = document.createElement('a-entity');
        rig.setAttribute('id', `user-${senderId}`);
        rig.setAttribute('position', `${posArr[0]} ${posArr[1]} ${posArr[2]}`);
        // Kopf-Box
        const head = document.createElement('a-entity');
        head.setAttribute('id', `user-head-${senderId}`);
        head.setAttribute('geometry', 'primitive: box; height:1.6; width:0.4; depth:0.2');
        head.setAttribute('material', 'color: blue');
        rig.appendChild(head);
        // Namensschild über Kopf
        const nameEl = document.createElement('a-entity');
        nameEl.setAttribute('id', `name-${senderId}`);
        nameEl.setAttribute(
          'text',
          'value: ' + (names[senderId] || `Spieler ${senderId}`) +
          '; align: center; width: 4; color: white;'
        );
        nameEl.setAttribute('position', '0 2 0');
        rig.appendChild(nameEl);
        document.querySelector('a-scene').appendChild(rig);
        peers[senderId] = rig;
      } else {
        // Bestehendes Rig aktualisieren
        rig.setAttribute('position', `${posArr[0]} ${posArr[1]} ${posArr[2]}`);
        rig.querySelector(`#user-head-${senderId}`)?.setAttribute(
          'rotation',
          `${rotArr[0]} ${rotArr[1]} ${rotArr[2]}`
        );
      }
      break;
    }

    case 'skybox-change':
      // Skybox zwischen Tag/Nacht umschalten
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
      // Name-Eintrag aktualisieren und Scoreboard neu zeichnen
      const [nid, newName] = incoming.slice(1);
      names[nid] = newName;
      scores[nid] = scores[nid] || 0;
      updateScoreboard();
      // Namensschild im Rig anpassen
      const labelEl = document.querySelector(`#user-${nid} #name-${nid}`);
      if (labelEl) {
        labelEl.setAttribute('text', 'value: ' + newName + '; align: center; width: 4; color: white;');
      }
      break;
    }

    case 'score-add': {
      // Punkte hinzufügen und Scoreboard neu zeichnen
      const [id, points] = incoming.slice(1);
      scores[id] = (scores[id] || 0) + points;
      updateScoreboard();
      break;
    }

    case 'enemy-spawn': {
      // Würfel erzeugen, sofern noch nicht besiegt
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
      // Würfel entfernen
      removeEnemyById(incoming[1]);
      break;

    case 'enemy-move': {
      // Würfelposition aktualisieren
      const [moveId, mx, my, mz] = incoming.slice(1);
      const moveTarget = document.getElementById(moveId);
      if (moveTarget) moveTarget.setAttribute('position', `${mx} ${my} ${mz}`);
      break;
    }
  }
});

// Bei Verbindungsende/Fehler aufräumen
socket.addEventListener('close', () => console.warn('[WebSocket] Verbindung geschlossen'));
socket.addEventListener('error', err => console.error('[WebSocket] Fehler:', err));

/* Benutzerdefinierte A-Frame-Komponenten */

// Vertikale Bewegung mit E/Q
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

// Skybox-Wechsel beim Anblick der Sonne
AFRAME.registerComponent('change-sky-on-gaze', {
  init: function () {
    this.sunVisible = false; this.timer = null; this.isNight = false;
    this.el.addEventListener('raycaster-intersection', evt => {
      if (evt.detail.els.includes(document.querySelector('#sun')) && !this.sunVisible) {
        this.sunVisible = true;
        this.timer = setTimeout(() => {
          const nightSky = document.querySelector('#skyNight');
          nightSky.removeAttribute('animation__fadein');
          nightSky.removeAttribute('animation__fadeout');
          this.isNight = !this.isNight;
          sendRequest('*broadcast-message*', ['skybox-change', this.isNight]);
          // Direkte lokale Aktualisierung
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

// Game-Manager: Spawnen, Schießen, Bewegung
AFRAME.registerComponent('game-manager', {
  init: function () {
    // Nur Host (clientId=0) spawnt Würfel
    this.el.sceneEl.addEventListener('ws-connected', () => {
      if (parseInt(clientId, 10) === 0) {
        this.spawnEnemies();
        setInterval(() => this.spawnEnemies(), 5000);
      }
    });
    const sceneEl = this.el.sceneEl;
    sceneEl.addEventListener('click', () => this.handleShoot());
    sceneEl.querySelectorAll('[laser-controls]').forEach(ctrl => {
      ctrl.addEventListener('triggerdown', () => this.handleShoot());
    });
  },

  spawnEnemies: function () {
    const scene = document.querySelector('a-scene');
    for (let i = 0; i < 5; i++) {
      const cube = document.createElement('a-box');
      const id = `enemy-${Date.now()}-${Math.random()}`;
      const x = (Math.random() - 0.5) * 100;
      const z = (Math.random() - 0.5) * 100;
      const baseY  = 140;
      const deltaY = (Math.random() - 0.5) * 20; // ±10
      const y      = Math.max(baseY + deltaY, 130); // nie unter 130
      cube.setAttribute('geometry', 'primitive: box; height:2; width:2; depth:2');
      cube.setAttribute('scale', '0.5 0.5 0.5');
      cube.setAttribute('material', 'color: red; shader: standard');
      cube.setAttribute('position', `${x} ${y} ${z}`);
      cube.setAttribute('class', 'enemy');
      cube.setAttribute('id', id);
      scene.appendChild(cube);
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

  handleShoot: function () {
    const cameraEl = document.querySelector('[camera]');
    const threeCam = cameraEl.getObject3D('camera');
    const dir      = new THREE.Vector3();
    threeCam.getWorldDirection(dir);
    const origin   = new THREE.Vector3();
    threeCam.getWorldPosition(origin);

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
        defeatedEnemies.add(el.id);
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

// Entfernt einen Würfel und räumt auf
function removeEnemyById(id) {
  const tgt = document.getElementById(id);
  if (!tgt) return console.warn('[Enemy Remove] nicht gefunden:', id);
  clearInterval(Number(tgt.getAttribute('data-move-interval')) || 0);
  tgt.setAttribute('visible', 'false');
  setTimeout(() => tgt.remove(), 50);
}
window.removeEnemyById = removeEnemyById;

// Tastatur-Zustand für vertical-move
const keys = {};
window.addEventListener('keydown', e => keys[e.key.toLowerCase()] = true);
window.addEventListener('keyup',   e => keys[e.key.toLowerCase()] = false);
window.sendRequest = sendRequest;
Object.defineProperty(window, 'clientId', { get: () => clientId });