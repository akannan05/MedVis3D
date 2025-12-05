import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { loadOBJ } from './loader.js';
import '../css/styles-new.css';

// =============================================================================
// INITIALIZATION
// =============================================================================

const viewerDiv = document.getElementById('viewer');

let models = [];

let modelCurrentName = null;

let states = ["default", "move", "cut", "measure"];
let currentState = null; // 0: default, 1: move, 2: cut, 3: measure

// constants for the selector ui
const HORIZONTAL_PRE_CLONES = 5;
const INERTIA_DECAY = 0.95;
const INERTIA_MIN_VEL = 0.1;

// load models; initialize selector UI
async function fetchModels() {
  const res = await fetch('../assets/models/models.json');
  models = await res.json();
  initSelector();
}

// initialize renderer
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  alpha: true
});
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(viewerDiv.clientWidth, viewerDiv.clientHeight);
renderer.setClearColor(0x000000, 0);  // transparent

viewerDiv.appendChild(renderer.domElement);

// =============================================================================
// UI CREATION (Selector Carousels)
// =============================================================================

function initSelector() {
  const organMap = {};
  models.forEach(modelFile => {
    const match = modelFile.match(/^(.+?)_(\d+)\.obj$/);
    if (match) {
      const organName = match[1];
      const id = match[2];
      if (!organMap[organName]) organMap[organName] = [];
      organMap[organName].push(id);
    }
  });

  createVerticalOrganCarousel(organMap);
  createHorizontalIdCarousel();
}

function createVerticalOrganCarousel(organMap) {
  const container = document.getElementById('organCarouselContainer');
  container.innerHTML = '';

  const organCarousel = document.createElement('div');
  organCarousel.id = 'organCarousel';

  const organList = document.createElement('div');
  organList.id = 'organList';

  // Pure, non-duplicated organ names
  let organNames = Object.keys(organMap).sort();
  if (organNames.length === 0) organNames = ['(empty)'];

  organNames.forEach((organName) => {
    const item = document.createElement('div');
    item.className = 'organItem';
    item.textContent = organName;

    item.addEventListener('click', () => {
      console.log("Selected organ:", organName);
      populateIdCarousel(organName, organMap[organName]);

      document.querySelectorAll('.organItem').forEach(it => it.classList.remove('selected'));
      item.classList.add('selected');
    });

    organList.appendChild(item);
  });

  organCarousel.appendChild(organList);
  container.appendChild(organCarousel);
}


function createHorizontalIdCarousel() {
  const container = document.getElementById('idCarouselContainer');
  container.innerHTML = '';

  const idCarousel = document.createElement('div');
  idCarousel.id = 'idCarousel';

  const leftArrow = document.createElement('div');
  leftArrow.className = 'arrow-btn horizontal';
  leftArrow.textContent = '◀';

  const idList = document.createElement('div');
  idList.id = 'idList';

  const rightArrow = document.createElement('div');
  rightArrow.className = 'arrow-btn horizontal';
  rightArrow.textContent = '▶';

  leftArrow.onclick = () => idList.scrollBy({ left: -120, behavior: 'smooth' });
  rightArrow.onclick = () => idList.scrollBy({ left: +120, behavior: 'smooth' });

  idCarousel.appendChild(leftArrow);
  idCarousel.appendChild(idList);
  idCarousel.appendChild(rightArrow);

  container.appendChild(idCarousel);

  // inertia
  addInertiaScrolling(idList, 'horizontal');
}

function populateIdCarousel(organName, ids) {
  const idList = document.getElementById('idList');
  idList.innerHTML = '';

  // sort numerically
  let mainIds = ids.sort((a,b) => parseInt(a) - parseInt(b));
  if (mainIds.length === 0) mainIds = ['0'];

  // if only 1 id, expand a little for feel
  if (mainIds.length === 1) mainIds = Array(3).fill(mainIds[0]);

  // build clones
  const pre = mainIds.slice(-HORIZONTAL_PRE_CLONES);
  const post = mainIds.slice(0, HORIZONTAL_PRE_CLONES);
  const sequence = [...pre, ...mainIds, ...post];

  sequence.forEach((id, idx) => {
    const item = document.createElement('div');
    item.className = 'idItem';
    item.textContent = id;
    item.dataset.mainIndex = ((idx - pre.length) % mainIds.length + mainIds.length) % mainIds.length;

    item.addEventListener('click', () => {
      const realId = mainIds[item.dataset.mainIndex];
      const modelFile = `${organName}_${realId}.obj`;
      // mark selected visually
      document.querySelectorAll('.idItem').forEach(it => it.classList.remove('selected'));
      item.classList.add('selected');
      loadViewer(modelFile);
    });

    idList.appendChild(item);
  });

  // center scroll on the main region after layout
  requestAnimationFrame(() => {
    const first = idList.querySelector('.idItem');
    const itemW = first ? first.offsetWidth + getGapX(idList) : 60;
    idList.scrollLeft = HORIZONTAL_PRE_CLONES * itemW;
  });

  // wrap logic same as vertical
  idList.addEventListener('scroll', () => {
    const first = idList.querySelector('.idItem');
    if (!first) return;
    const itemW = first.offsetWidth + getGapX(idList);
    const totalItems = idList.children.length;
    const mainCount = totalItems - HORIZONTAL_PRE_CLONES * 2;

    const currentIndex = Math.round(idList.scrollLeft / itemW);
    if (currentIndex < HORIZONTAL_PRE_CLONES) {
      idList.scrollLeft += itemW * mainCount;
    } else if (currentIndex >= HORIZONTAL_PRE_CLONES + mainCount) {
      idList.scrollLeft -= itemW * mainCount;
    }
  });
}

// =============================================================================
// OBJ LOADER + SCENE + CAMERA CONTROL
// =============================================================================

// --- Three.js objects ---
let scene = new THREE.Scene();
let camera = new THREE.PerspectiveCamera(
  50,
  viewerDiv.clientWidth / viewerDiv.clientHeight,
  0.1,
  5000
);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.04;
controls.enableZoom = false;  // we will handle zoom manually

// Light
const light = new THREE.DirectionalLight(0xffffff, 2);
light.position.set(3, 3, 5);
scene.add(light);

// Track camera defaults
let defaultCamPos = new THREE.Vector3();
let defaultCamLook = new THREE.Vector3();

// WASD movement variables
const moveSpeed = 3.5;
let moveForward = false;
let moveBackward = false;
let moveLeft = false;
let moveRight = false;
let moveUp = false;
let moveDown = false;

// store current object reference
let currentObjMesh = null;


// MASTER FUNCTION — called when selecting OBJ
async function loadViewer(modelFile) {
  modelCurrentName = modelFile;
  currentState = states[0]; // "default"

  console.log("Loading model:", modelFile);

  // remove old model if exists
  if (currentObjMesh) scene.remove(currentObjMesh);

  const objPath = `../assets/models/${modelFile}`;
  currentObjMesh = await loadOBJ(objPath);

  // center & scale
  currentObjMesh.position.set(0, 0, 0);
  currentObjMesh.rotation.set(0, 0, 0);

  // compute bounding box
  const box = new THREE.Box3().setFromObject(currentObjMesh);
  const center = box.getCenter(new THREE.Vector3());
  currentObjMesh.position.sub(center);

  // scale object into frame
  const size = box.getSize(new THREE.Vector3()).length();
  const scaleFactor = 160 / size;
  currentObjMesh.scale.setScalar(scaleFactor);

  scene.add(currentObjMesh);

  // reset camera
  camera.position.set(0, 0, 200);
  camera.lookAt(0, 0, 0);
  controls.target.set(0, 0, 0);

  defaultCamPos.copy(camera.position);
  defaultCamLook.copy(controls.target);

  animate();
}

// animate:

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  handleCameraMovement();
  renderer.render(scene, camera);
}

// camera movements:

function handleCameraMovement() {
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);

  if (moveForward) camera.position.addScaledVector(dir, moveSpeed);
  if (moveBackward) camera.position.addScaledVector(dir, -moveSpeed);
  if (moveRight) camera.position.addScaledVector(
    new THREE.Vector3().crossVectors(dir, camera.up).normalize(),
    moveSpeed
  );
  if (moveLeft) camera.position.addScaledVector(
    new THREE.Vector3().crossVectors(dir, camera.up).normalize(),
    -moveSpeed
  );
  if (moveUp) camera.position.y += moveSpeed;
  if (moveDown) camera.position.y -= moveSpeed;
}

// camera listeners:

window.addEventListener('keydown', (e) => {
  if (e.key === 'w') moveForward = true;
  if (e.key === 's') moveBackward = true;
  if (e.key === 'a') moveLeft = true;
  if (e.key === 'd') moveRight = true;
  if (e.key === ' ') moveUp = true;
  if (e.key === 'Shift') moveDown = true;

  // backspace = reset
  if (e.key === 'Backspace') {
    camera.position.copy(defaultCamPos);
    controls.target.copy(defaultCamLook);
    console.log("Camera reset");
  }
});

window.addEventListener('keyup', (e) => {
  if (e.key === 'w') moveForward = false;
  if (e.key === 's') moveBackward = false;
  if (e.key === 'a') moveLeft = false;
  if (e.key === 'd') moveRight = false;
  if (e.key === ' ') moveUp = false;
  if (e.key === 'Shift') moveDown = false;
});


// =============================================================================
// Helpers
// =============================================================================

function getGapY(container) {
  // compute vertical gap between flex children by reading computed style of first two items
  const first = container.children[0];
  if (!first) return 0;
  const style = window.getComputedStyle(first);
  // fallback: assume 6px if not definable
  return parseFloat(style.marginBottom || 6);
}

function getGapX(container) {
  const first = container.children[0];
  if (!first) return 0;
  const style = window.getComputedStyle(first);
  // we used gap on the parent; however computed gap may not be present on children; fallback to 6
  // There is no straightforward cross-browser way to read gap; use 6px fallback
  return 6;
}

// Add simple inertia scrolling on wheel/trackpad dragging + touch
function addInertiaScrolling(el, dir = 'horizontal') {
  let velocity = 0;
  let rafId = null;
  let lastTime = 0;

  // wheel handler: convert wheel delta to velocity
  el.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    // deltaMode normalization: assume pixel mode (most browsers)
    const delta = (dir === 'vertical') ? ev.deltaY : ev.deltaX || ev.deltaY;
    velocity += delta * 0.5; // scaling
    if (!rafId) {
      lastTime = performance.now();
      rafId = requestAnimationFrame(step);
    }
  }, { passive: false });

  // pointer/touch drag support (basic)
  let dragging = false;
  let startPos = 0;
  let lastPos = 0;
  let lastDragTime = 0;

  el.addEventListener('pointerdown', (ev) => {
    dragging = true;
    el.setPointerCapture(ev.pointerId);
    startPos = dir === 'vertical' ? ev.clientY : ev.clientX;
    lastPos = startPos;
    lastDragTime = performance.now();
    velocity = 0;
  });

  el.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    const pos = dir === 'vertical' ? ev.clientY : ev.clientX;
    const delta = lastPos - pos;
    if (dir === 'vertical') el.scrollTop += delta; else el.scrollLeft += delta;
    const now = performance.now();
    velocity = (delta) / Math.max(1, now - lastDragTime) * 16; // normalize to ~60fps delta
    lastPos = pos;
    lastDragTime = now;
  });

  el.addEventListener('pointerup', (ev) => {
    dragging = false;
    try { el.releasePointerCapture(ev.pointerId); } catch(e) {}
    if (!rafId) {
      lastTime = performance.now();
      rafId = requestAnimationFrame(step);
    }
  });

  function step(time) {
    const dt = time - lastTime;
    lastTime = time;

    if (Math.abs(velocity) > INERTIA_MIN_VEL) {
      if (dir === 'vertical') el.scrollTop += velocity * (dt / 16);
      else el.scrollLeft += velocity * (dt / 16);
      velocity *= Math.pow(INERTIA_DECAY, dt / 16);
      rafId = requestAnimationFrame(step);
    } else {
      velocity = 0;
      rafId = null;
    }
  }
}

// =============================================================================
// MAIN
// =============================================================================

fetchModels();
