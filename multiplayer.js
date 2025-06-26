const DEBUG = true;
const serverAddr = 'wss://nosch.uber.space/web-rooms/';
const roomName = 'minecraft-vr-room';

let clientId = null;
let clientCount = 0;
let peers = {};
let currentSkyboxIsNight = false;
let scores = {};
const defeatedEnemies = new Set();
const names = {};

// --- AudioContext für Soundeffekte ---
const audioContext = new (window.AudioContext || window.webkitAudioContext)();
function playHitSound() {
  const osc = audioContext.createOscillator();
  const gainNode = audioContext.createGain();
  osc.type = 'square';
  osc.frequency.value = 440;
  osc.connect(gainNode);
  gainNode.connect(audioContext.destination);
  gainNode.gain.setValueAtTime(0.1, audioContext.currentTime);
  osc.start();
  osc.stop(audioContext.currentTime + 0.1);
}

// --- WebSocket-Verbindung ---
const socket = new WebSocket(serverAddr);
let lastPose = { position: null, rotation: null };

function sendRequest(...message) {
  if (socket.readyState !== WebSocket.OPEN) {
    console.warn('[sendRequest] WebSocket nicht offen:', message);
    return;
  }
  socket.send(JSON.stringify(message));
}

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

function broadcastPose() {
  const head = document.getElementById('head');
  if (!head?.object3D) return;
  const worldPos = new THREE.Vector3();
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
  const changed = !lastPose.position ||
    ['x','y','z'].some(a => Math.abs(position[a] - lastPose.position[a]) > 0.01) ||
    ['x','y','z'].some(a => Math.abs(rotation[a] - lastPose.rotation[a]) > 1);
  if (!changed) return;
  lastPose = { position, rotation };
  sendRequest(
    '*broadcast-message*',
    ['pose', clientId, [position.x, position.y, position.z], [rotation.x, rotation.y, rotation.z]]
  );
}

socket.addEventListener('open', () => {
  sendRequest('*enter-room*', roomName);
  sendRequest('*subscribe-client-count*');
  sendRequest('*subscribe-client-enter-exit*');
  // ask existing clients to send current skybox state
  sendRequest('*broadcast-message*', ['request-skybox', clientId]);
  setInterval(() => sendRequest('*ping*'), 30000);
});

socket.addEventListener('message', ({ data }) => {
  if (!data) return;
  let incoming;
  try {
    incoming = JSON.parse(data);
    if (!Array.isArray(incoming) || typeof incoming[0] !== 'string') return;
  } catch {
    console.warn('Parse-Error:', data);
    return;
  }
  if (DEBUG) console.log('[WS Nachricht]', incoming);
  const [type, ...args] = incoming;

  switch (type) {
    case '*client-id*': {
      clientId = args[0];
      setInterval(broadcastPose, 100);
      const playerName = prompt("Bitte gib deinen Namen ein:");
      names[clientId] = playerName;
      scores[clientId] = scores[clientId] || 0;
      updateScoreboard();
      sendRequest('*broadcast-message*', ['set-name', clientId, playerName]);
      document.querySelector('a-scene')?.emit('ws-connected');
      break;
    }

    case '*client-count*':
      clientCount = args[0];
      break;

    case '*client-enter*': {
      const newId = args[0];
      if (newId === clientId) break;
      // Skybox-Status
      sendRequest('*broadcast-message*', ['skybox-change', currentSkyboxIsNight]);
      // Enemies
      document.querySelectorAll('.enemy').forEach(enemy => {
        const { x, y, z } = enemy.getAttribute('position');
        sendRequest('*broadcast-message*', ['enemy-spawn', enemy.id, x, y, z]);
      });
      // Namen
      Object.entries(names).forEach(([id, name]) => {
        sendRequest('*broadcast-message*', ['set-name', id, name]);
      });
      // Scores
      Object.entries(scores).forEach(([id, score]) => {
        sendRequest('*broadcast-message*', ['set-score', id, score]);
      });
      broadcastPose();
      break;
    }

    case '*client-exit*': {
      const goneId = args[0];
      document.getElementById(`user-${goneId}`)?.remove();
      delete peers[goneId];
      break;
    }

    case 'pose': {
      const [senderId, posArr, rotArr] = args;
      let rig = peers[senderId];
      if (!rig) {
        rig = document.createElement('a-entity');
        rig.id = `user-${senderId}`;
        rig.setAttribute('position', `${posArr[0]} ${posArr[1]} ${posArr[2]}`);
        const head = document.createElement('a-entity');
        head.id = `user-head-${senderId}`;
        head.setAttribute('geometry', 'primitive: box; height:1.6; width:0.4; depth:0.2');
        head.setAttribute('material', 'color: blue');
        rig.appendChild(head);
        const nameEl = document.createElement('a-entity');
        nameEl.id = `name-${senderId}`;
        nameEl.setAttribute('text', `value: ${names[senderId]||`Spieler ${senderId}`}; align:center; width:4; color:white`);
        nameEl.setAttribute('position', '0 2 0');
        rig.appendChild(nameEl);
        document.querySelector('a-scene').appendChild(rig);
        peers[senderId] = rig;
      } else {
        rig.setAttribute('position', `${posArr[0]} ${posArr[1]} ${posArr[2]}`);
        rig.querySelector(`#user-head-${senderId}`)
           .setAttribute('rotation', `${rotArr[0]} ${rotArr[1]} ${rotArr[2]}`);
      }
      break;
    }

    case 'skybox-change': {
      currentSkyboxIsNight = args[0];
      const nightSky = document.querySelector('#skyNight');
      nightSky.removeAttribute('animation__fadein');
      nightSky.removeAttribute('animation__fadeout');
      nightSky.setAttribute(
        currentSkyboxIsNight ? 'animation__fadein' : 'animation__fadeout',
        { property: 'material.opacity', to: currentSkyboxIsNight ? 1 : 0, dur: 2000 }
      );
      break;
    }

    case 'set-name': {
      const [nid, newName] = args;
      names[nid] = newName;
      scores[nid] = scores[nid] || 0;
      updateScoreboard();
      const labelEl = document.querySelector(`#user-${nid} #name-${nid}`);
      if (labelEl) labelEl.setAttribute('text', `value: ${newName}; align:center; width:4; color:white`);
      break;
    }

    case 'score-add': {
      const [id, pts] = args;
      scores[id] = (scores[id] || 0) + pts;
      updateScoreboard();
      break;
    }

    case 'set-score': {
      const [id, pts] = args;
      scores[id] = pts;
      updateScoreboard();
      break;
    }
    case 'request-skybox': {
      const [targetId] = args;
      // only existing clients respond
      if (targetId !== clientId) {
        sendRequest('*broadcast-message*', ['skybox-change', currentSkyboxIsNight]);
      }
      break;
    }

    case 'enemy-spawn': {
      const [eid, ex, ey, ez] = args;
      if (defeatedEnemies.has(eid)) return;
      if (!document.getElementById(eid)) {
        const cube = document.createElement('a-box');
        cube.id = eid;
        cube.setAttribute('position', `${ex} ${ey} ${ez}`);
        cube.setAttribute('geometry', 'primitive: box; height:2; width:2; depth:2');
        cube.setAttribute('scale', '0.5 0.5 0.5');
        cube.setAttribute('material', 'color: red; shader: standard');
        cube.classList.add('enemy');
        document.querySelector('a-scene').appendChild(cube);
        this.moveEnemy?.call(this, cube);
      }
      break;
    }

    case 'enemy-hit':
      removeEnemyById(args[0]);
      break;

    case 'enemy-move': {
      const [mid, mx, my, mz] = args;
      const el = document.getElementById(mid);
      if (el) el.setAttribute('position', `${mx} ${my} ${mz}`);
      break;
    }
  }
});

socket.addEventListener('close', () => console.warn('[WS] Verbindung geschlossen'));
socket.addEventListener('error', err => console.error('[WS] Fehler:', err));

// --- A-Frame Components ---

AFRAME.registerComponent('vertical-move', {
  schema: { speed: { type: 'number', default: 0.2 } },
  tick() {
    const pos = this.el.getAttribute('position');
    if (document.activeElement !== document.body) return;
    if (keys['e']) pos.y += this.data.speed;
    if (keys['q']) pos.y -= this.data.speed;
    this.el.setAttribute('position', pos);
  }
});

AFRAME.registerComponent('change-sky-on-gaze', {
  init() {
    this.sunVisible = false;
    this.timer = null;
    this.isNight = false;
    this.el.addEventListener('raycaster-intersection', evt => {
      if (
        evt.detail.els.includes(document.querySelector('#sun')) &&
        !this.sunVisible
      ) {
        this.sunVisible = true;
        this.timer = setTimeout(() => {
          const nightSky = document.querySelector('#skyNight');
          nightSky.removeAttribute('animation__fadein');
          nightSky.removeAttribute('animation__fadeout');
          this.isNight = !this.isNight;
          sendRequest('*broadcast-message*', ['skybox-change', this.isNight]);
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
        clearTimeout(this.timer);
        this.sunVisible = false;
      }
    });
  }
});

AFRAME.registerComponent('game-manager', {
  init() {
    this.el.sceneEl.addEventListener('ws-connected', () => {
      this.spawnEnemies();
      setInterval(() => this.spawnEnemies(), 5000);
    });
    const sceneEl = this.el.sceneEl;
    sceneEl.addEventListener('click', () => this.handleShoot());
    sceneEl.querySelectorAll('[laser-controls]')
           .forEach(ctrl => ctrl.addEventListener('triggerdown', () => this.handleShoot()));
  },

  spawnEnemies() {
    const scene = document.querySelector('a-scene');
    // Höhe an der Spieler-Kopfhöhe orientieren
    const headEl = document.getElementById('head');
    let baseY = 1.6; // Fallback, falls kein Head-Objekt
    if (headEl?.object3D) {
      const worldPos = new THREE.Vector3();
      headEl.object3D.getWorldPosition(worldPos);
      baseY = worldPos.y;
    }
    console.log('[GameManager] Spawning at player height ≈', baseY);
    for (let i = 0; i < 5; i++) {
      const cube = document.createElement('a-box');
      const id = `enemy-${Date.now()}-${Math.random()}`;
      // Spawn mit leichter Streuung um Kopf-Höhe ±0.5 m
      const y = baseY + (Math.random() - 0.5) * 1.0;
      const x = (Math.random() - 0.5) * 10;
      const z = (Math.random() - 0.5) * 10;
      cube.setAttribute('geometry', 'primitive: box; height:2; width:2; depth:2');
      cube.setAttribute('scale', '0.5 0.5 0.5');
      cube.setAttribute('material', 'color: red; shader: standard');
      cube.setAttribute('position', `${x} ${y} ${z}`);
      cube.classList.add('enemy');
      cube.id = id;
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

  moveEnemy(cube) {
    const iv = setInterval(() => {
      const pos = cube.getAttribute('position');
      const newPos = {
        x: pos.x + (Math.random() - 0.5) * 4,
        y: pos.y,
        z: pos.z + (Math.random() - 0.5) * 4
      };
      cube.setAttribute('position', newPos);
      sendRequest('*broadcast-message*', ['enemy-move', cube.id, newPos.x, newPos.y, newPos.z]);
    }, 500);
    cube.setAttribute('data-move-interval', iv);
  },

  handleShoot() {
    const camEl = document.querySelector('[camera]');
    const cam = camEl.getObject3D('camera');
    const dir = new THREE.Vector3(); cam.getWorldDirection(dir);
    const origin = new THREE.Vector3(); cam.getWorldPosition(origin);
    const ray = new THREE.Raycaster(origin, dir);
    const enemies = [];
    document.querySelectorAll('.enemy').forEach(el =>
      el.object3D.traverse(o => { if (o.isMesh) { o.el = el; enemies.push(o); } })
    );
    const hits = ray.intersectObjects(enemies, true);
    if (!hits.length) return;
    const el = hits[0].object.el;
    if (!defeatedEnemies.has(el.id)) {
      defeatedEnemies.add(el.id);
      playHitSound();
      el.setAttribute('color', 'white');
      setTimeout(() => el.setAttribute('color', 'red'), 100);
      sendRequest('*broadcast-message*', ['enemy-hit', el.id]);
      sendRequest('*broadcast-message*', ['score-add', clientId, 100]);
      scores[clientId] = (scores[clientId] || 0) + 100;
      updateScoreboard();
      removeEnemyById(el.id);
    }
  }
});

function removeEnemyById(id) {
  const tgt = document.getElementById(id);
  if (!tgt) return console.warn('[Enemy Remove] nicht gefunden:', id);
  clearInterval(Number(tgt.getAttribute('data-move-interval')) || 0);
  tgt.setAttribute('visible', 'false');
  setTimeout(() => tgt.remove(), 50);
}

const keys = {};
window.addEventListener('keydown', e => keys[e.key.toLowerCase()] = true);
window.addEventListener('keyup',   e => keys[e.key.toLowerCase()] = false);
window.sendRequest = sendRequest;
Object.defineProperty(window, 'clientId', { get: () => clientId });
