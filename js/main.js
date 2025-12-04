import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { loadOBJ } from './loader.js';
import '../css/styles.css';

// =============================================================================
// STATE MANAGEMENT
// =============================================================================

// DOM Elements
const viewerDiv = document.getElementById('viewer');
const folderViewDiv = document.getElementById('folderView');

// Scene Graph
let scene, camera, renderer, controls, currentObject, currentObjectFile;

// Global State
let models = [];
let currentModelName = null;
let mode = 'default'; // 'default' | 'cut'
let _sceneInitialized = false;
let visibleClone = true;  // true = cloneA, false = cloneB

// Physics State
let _velocity = new THREE.Vector3();
const GRAVITY = -60;

// Bounding Box State
let _boundingBoxMesh = null;
let _boundingBoxEnabled = false;

// Cut Mode State
let _cutState = {
  enabled: false,
  plane: null,
  clones: null,
  prevCamera: null,
  prevControls: null,
  orthoHalf: 0,
  boundsMargin: 0.1,
};

// Cut Interaction State
let _cutHandlers = {
  dragging: false,
  startPoint: null,
  endPoint: null,
  mouse: new THREE.Vector2(),
  raycaster: new THREE.Raycaster(),
};

// Move Mode State
let _moveState = {
  enabled: false,
  draggable: null,
  raycaster: new THREE.Raycaster(),
  clickMouse: new THREE.Vector2(),
  moveMouse: new THREE.Vector2(),
  groundPlane: null,
  groundBounds: null,
  isMouseDown: false,
  clickOffset: new THREE.Vector3(), // Offset from object position to click point
  cornerIndicators: [], // Visual indicators for the 4 base corners
};

// =============================================================================
// INITIALIZATION
// =============================================================================

async function fetchModels() {
  const res = await fetch('../assets/models/models.json');
  models = await res.json();
  initSelector();
}

// =============================================================================
// CUT MODE: INTERACTION HANDLERS
// =============================================================================

function _onCutPointerMove(e){
  const sc = document.getElementById('scissorCursor');
  if(sc){
    sc.style.left = (e.clientX + 12) + 'px';
    sc.style.top = (e.clientY + 12) + 'px';
  }
  if(!_cutHandlers.dragging) return;
  const line = document.getElementById('cutLine');
  if(!line) return;
  line.setAttribute('x1', _cutHandlers._startClientX);
  line.setAttribute('y1', _cutHandlers._startClientY);
  line.setAttribute('x2', e.clientX);
  line.setAttribute('y2', e.clientY);
  line.setAttribute('visibility','visible');
  _updateRaycastPoint(e, point => { _cutHandlers.endPoint = point; });
}

function _onCutPointerDown(e){
  if(e.button !== 0) return;
  _cutHandlers.dragging = true;
  _cutHandlers._startClientX = e.clientX;
  _cutHandlers._startClientY = e.clientY;
  _updateRaycastPoint(e, point => { _cutHandlers.startPoint = point; });
}

function _onCutPointerUp(e){
  if(!_cutHandlers.dragging) return;
  _cutHandlers.dragging = false;
  const line = document.getElementById('cutLine');
  if(line) line.setAttribute('visibility','hidden');
  const sc = document.getElementById('scissorCursor');
  if(sc) sc.style.display = 'block';
  if(_cutHandlers.startPoint && _cutHandlers.endPoint){
    console.log('Performing cut with start:', _cutHandlers.startPoint, 'end:', _cutHandlers.endPoint);
    _performCut(_cutHandlers.startPoint, _cutHandlers.endPoint);
    console.log('Cut performed. Clones:', _cutState.clones.length);
  }
  _cutHandlers.startPoint = null;
  _cutHandlers.endPoint = null;
}

function _updateRaycastPoint(e, cb){
  if(!scene || !camera) return cb(null);
  const rect = viewerDiv.getBoundingClientRect();
  _cutHandlers.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  _cutHandlers.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  _cutHandlers.raycaster.setFromCamera(_cutHandlers.mouse, camera);
  
  const objectToRaycast = (_cutState.clones && _cutState.clones.length > 0) 
    ? _cutState.clones 
    : currentObject;
    
  const intersects = _cutHandlers.raycaster.intersectObject(objectToRaycast, true);
  
  if(intersects && intersects.length > 0){
    // If we hit the object, use that point
    cb(intersects[0].point.clone());
  } else {
    // If we don't hit the object, find the closest point on the bounding box
    const box = new THREE.Box3().setFromObject(objectToRaycast);
    const rayOrigin = _cutHandlers.raycaster.ray.origin;
    const rayDir = _cutHandlers.raycaster.ray.direction;
    
    // Find the closest point on the bounding box to the ray
    const closestPoint = new THREE.Vector3();
    box.clampPoint(rayOrigin, closestPoint);
    
    // If ray origin is outside box, use the closest point on the surface
    if(!box.containsPoint(rayOrigin)) {
      // Get the point on the ray that is closest to the box
      const t = Math.max(0, rayDir.dot(closestPoint.clone().sub(rayOrigin)));
      const pointOnRay = rayOrigin.clone().addScaledVector(rayDir, t);
      box.clampPoint(pointOnRay, closestPoint);
      cb(closestPoint);
    } else {
      // Ray origin is inside box, use it
      cb(rayOrigin.clone());
    }
  }
}

// =============================================================================
// CUT MODE: VISUAL CUTTING
// =============================================================================

function _performCut(pStart, pEnd){
  if(!pStart || !pEnd) return;
  
  // Get the bounding box of the object(s) to cut
  const objectToCut = (_cutState.clones && _cutState.clones.length > 0) 
    ? _cutState.clones[0]
    : currentObject;
  
  if (!objectToCut) return;
  
  const box = new THREE.Box3().setFromObject(objectToCut);
  const boxCenter = new THREE.Vector3();
  box.getCenter(boxCenter);
  const boxSize = new THREE.Vector3();
  box.getSize(boxSize);
  const boxDiagonal = boxSize.length();
  
  // Calculate the direction of the cut line
  const dir = pEnd.clone().sub(pStart).normalize();
  
  // Get camera direction for the normal
  const camDir = new THREE.Vector3();
  camera.getWorldDirection(camDir);
  
  // Calculate normal perpendicular to both the cut direction and camera direction
  const normal = dir.clone().cross(camDir).normalize();
  if(normal.length() < 1e-6) return;
  
  // Extend the cut line through the entire bounding box
  // Find the two extreme points along the cut direction that bound the object
  const maxDist = boxDiagonal;
  const extendedStart = pStart.clone().addScaledVector(dir, -maxDist);
  const extendedEnd = pStart.clone().addScaledVector(dir, maxDist);
  
  // Create the cutting plane from the extended line and normal
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, pStart);

  renderer.localClippingEnabled = true;
  
  // Hide the original object(s)
  if(_cutState.clones && _cutState.clones.length > 0) {
    _cutState.clones.forEach(c => c.visible = false);
  } else {
    currentObject.visible = false;
  }

  // Create new clones if we haven't already cut
  if(!_cutState.clones || _cutState.clones.length === 0) {
    _cutState.clones = [];
  } else {
    // Remove old clones
    _cutState.clones.forEach(c => scene.remove(c));
    _cutState.clones = [];
  }

  // Get the object to clone (use the original if we haven't cut, or the first clone)
  const sourceObject = (_cutState.clones && _cutState.clones.length > 0) 
    ? _cutState.clones[0]
    : currentObject;

  const cloneA = sourceObject.clone(true);
  const cloneB = sourceObject.clone(true);

  _applyClippingMaterial(cloneA, plane);
  
  const planeNeg = plane.clone().negate();
  _applyClippingMaterial(cloneB, planeNeg);

  const gap = Math.max(0.02, sourceObject.scale.length() * 0.002);
  cloneA.position.copy(sourceObject.position);
  cloneA.quaternion.copy(sourceObject.quaternion);
  cloneA.scale.copy(sourceObject.scale);
  cloneA.updateMatrixWorld(true);
  cloneA.position.addScaledVector(normal, gap);
  cloneA.visible = visibleClone;

  cloneB.position.copy(sourceObject.position);
  cloneB.quaternion.copy(sourceObject.quaternion);
  cloneB.scale.copy(sourceObject.scale);
  cloneB.updateMatrixWorld(true);
  cloneB.position.addScaledVector(normal, -gap);
  cloneB.visible = !visibleClone;

  scene.add(cloneA);
  scene.add(cloneB);
  _cutState.clones = [cloneA, cloneB];
  
  _cutState.cutPerformed = true;
}

function _applyClippingMaterial(obj, plane) {
  obj.traverse(node => {
    if(node.isMesh){
      const mats = Array.isArray(node.material) ? node.material : [node.material];
      const clonedMats = mats.map(m => m.clone());
      
      clonedMats.forEach(m => {
        m.side = THREE.DoubleSide;
        m.clippingPlanes = [plane];
        m.clipShadows = true;
        m.clipIntersection = false;
        m.needsUpdate = true;
      });
      
      node.material = Array.isArray(node.material) ? clonedMats : clonedMats[0];
    }
  });
}

// press C to toggle between the 2 slices
window.addEventListener('keydown', cloneChange);
function cloneChange(event){
  if(event.key === 'C' || event.key === 'c'){
    visibleClone = !visibleClone;
    console.log(visibleClone);
    if(_cutState.clones && _cutState.clones.length > 0){
      _cutState.clones[0].visible = visibleClone;
      _cutState.clones[1].visible = !visibleClone
    }
  }
}

// =============================================================================
// UI: FOLDER VIEW & SELECTOR
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

  folderViewDiv.innerHTML = '';
  const folderContainer = document.createElement('div');
  folderContainer.id = 'folderViewContainer';

  Object.keys(organMap).sort().forEach(organName => {
    const organDiv = document.createElement('div');
    organDiv.className = 'organ-item';

    const organToggle = document.createElement('div');
    organToggle.className = 'organ-toggle';
    const arrow = document.createElement('span');
    arrow.className = 'arrow';
    arrow.textContent = '▶';
    const label = document.createElement('span');
    label.textContent = organName;
    organToggle.appendChild(arrow);
    organToggle.appendChild(label);

    const idList = document.createElement('div');
    idList.className = 'id-list';
    idList.style.display = 'none';

    organMap[organName].sort((a, b) => parseInt(a) - parseInt(b)).forEach(id => {
      const idItem = document.createElement('div');
      idItem.className = 'id-item';
      idItem.textContent = id;
      idItem.onclick = (e) => {
        e.stopPropagation();
        const modelFile = `${organName}_${id}.obj`;
        currentObjectFile = modelFile;
        folderViewDiv.classList.remove('open');
        loadViewer(currentObjectFile);
      };
      idList.appendChild(idItem);
    });

    organToggle.onclick = () => {
      const isOpen = idList.style.display !== 'none';
      idList.style.display = isOpen ? 'none' : 'block';
      arrow.textContent = isOpen ? '▶' : '▼';
    };

    organDiv.appendChild(organToggle);
    organDiv.appendChild(idList);
    folderContainer.appendChild(organDiv);
  });

  folderViewDiv.appendChild(folderContainer);

  let toggleBtn = document.getElementById('folderViewToggle');
  if (!toggleBtn) {
    toggleBtn = document.createElement('button');
    toggleBtn.id = 'folderViewToggle';
    toggleBtn.textContent = '☰';
    toggleBtn.title = 'Toggle Folder View';
    toggleBtn.onclick = () => folderViewDiv.classList.toggle('open');
    document.body.appendChild(toggleBtn);
  }

  if (!window._folderClickHandlerAttached) {
    document.addEventListener('click', (e) => {
      if (!folderViewDiv.contains(e.target) && !toggleBtn.contains(e.target)) {
        folderViewDiv.classList.remove('open');
      }
    });
    window._folderClickHandlerAttached = true;
  }
}

// =============================================================================
// UI: SIDEBAR & CONTROLS
// =============================================================================

function createGUI(modelName) {
  const oldSidebar = document.getElementById('leftSidebar');
  if (oldSidebar) oldSidebar.remove();

  const sidebar = document.createElement('div');
  sidebar.id = 'leftSidebar';
  
  const buttons = ['Move', 'Cut', 'Measure', 'Inspect'];
  buttons.forEach(btnText => {
    const btn = document.createElement('button');
    btn.className = 'sidebar-btn';
    btn.textContent = btnText;
    btn.title = `Click to enter ${btnText} mode`;
    btn.onclick = (e) => {
      e.stopPropagation();
      handleToolClick(btnText);
    };
    sidebar.appendChild(btn);
  });

  viewerDiv.appendChild(sidebar);

  let bboxBtn = document.getElementById('boundingBoxBtn');
  if (bboxBtn) bboxBtn.remove();
  bboxBtn = document.createElement('button');
  bboxBtn.id = 'boundingBoxBtn';
  bboxBtn.textContent = '□';
  bboxBtn.title = 'Toggle Bounding Box';
  bboxBtn.onclick = () => toggleBoundingBox();
  viewerDiv.appendChild(bboxBtn);
  
  _createCutUI();
}

function _createCutUI() {
  let sc = document.getElementById('scissorCursor');
  if (sc) sc.remove();
  sc = document.createElement('div');
  sc.id = 'scissorCursor';
  sc.textContent = '✂';
  sc.style.position = 'absolute';
  sc.style.pointerEvents = 'none';
  sc.style.display = 'none';
  sc.style.zIndex = 30;
  viewerDiv.appendChild(sc);

  let svg = document.getElementById('cutLineSvg');
  if (svg) svg.remove();
  svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('id', 'cutLineSvg');
  svg.style.position = 'absolute';
  svg.style.left = '0';
  svg.style.top = '0';
  svg.style.width = '100%';
  svg.style.height = '100%';
  svg.style.pointerEvents = 'none';
  svg.style.zIndex = 29;
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  line.setAttribute('id','cutLine');
  line.setAttribute('stroke','rgba(255,255,255,0.9)');
  line.setAttribute('stroke-width','2');
  line.setAttribute('visibility','hidden');
  svg.appendChild(line);
  viewerDiv.appendChild(svg);
}

async function handleToolClick(tool) {
  if (tool === 'Cut') {
    if(currentModelName) await loadViewer(currentModelName);
    enterCutMode();
  } else if (tool === 'Move') {
    enterMoveMode();
  } else {
    if (mode === 'cut') exitCutMode();
    if (mode === 'move') exitMoveMode();
    mode = 'default';
    if (currentModelName) await _reloadCurrentModel();
  }
}

// =============================================================================
// UI: BOUNDING BOX
// =============================================================================

function toggleBoundingBox() {
  if (!currentObject || !scene) return;

  const btn = document.getElementById('boundingBoxBtn');
  
  if (_boundingBoxEnabled) {
    if (_boundingBoxMesh) {
      scene.remove(_boundingBoxMesh);
      _boundingBoxMesh.geometry.dispose();
      _boundingBoxMesh.material.dispose();
      _boundingBoxMesh = null;
    }
    _boundingBoxEnabled = false;
    btn.classList.remove('active');
  } else {
    const box = new THREE.Box3().setFromObject(currentObject);
    const size = new THREE.Vector3();
    box.getSize(size);
    const center = new THREE.Vector3();
    box.getCenter(center);

    const geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
    const material = new THREE.LineBasicMaterial({
      color: 0xffffff,
      linewidth: 1,
    });

    const wireframeGeometry = new THREE.EdgesGeometry(geometry);
    _boundingBoxMesh = new THREE.LineSegments(wireframeGeometry, material);
    _boundingBoxMesh.position.copy(center);

    scene.add(_boundingBoxMesh);
    
    // Also draw ground plane bounds if they exist
    if(_moveState.groundBounds) {
      const bounds = _moveState.groundBounds;
      const width = bounds.maxX - bounds.minX;
      const depth = bounds.maxZ - bounds.minZ;
      
      const groundBoundsGeometry = new THREE.BoxGeometry(width, 0.01, depth);
      const groundBoundsMaterial = new THREE.LineBasicMaterial({
        color: 0xffffff,
        linewidth: 1,
      });
      const groundBoundsWireframe = new THREE.EdgesGeometry(groundBoundsGeometry);
      const groundBoundsMesh = new THREE.LineSegments(groundBoundsWireframe, groundBoundsMaterial);
      // Position at the center of the bounds at the ground plane height
      groundBoundsMesh.position.set(
        (bounds.minX + bounds.maxX) / 2,
        bounds.y,
        (bounds.minZ + bounds.maxZ) / 2
      );
      scene.add(groundBoundsMesh);
      _boundingBoxMesh.groundBoundsMesh = groundBoundsMesh;
    }
    
    _boundingBoxEnabled = true;
    btn.classList.add('active');
  }
}

// =============================================================================
// VIEWER: MODEL LOADING
// =============================================================================

async function loadViewer(modelName) {
  viewerDiv.style.display = 'block';
  currentModelName = modelName;

  if (_sceneInitialized) {
    _clearScene();
  } else {
    _initializeScene();
  }

  createGUI(modelName);

  currentObject = await loadOBJ(`/assets/models/${modelName}`);
  scene.add(currentObject);

  _positionModel();
  _createGroundPlane();

  camera.position.set(100 * 0.6, 100 * 0.45, 100 * 1.0);
  controls.target.set(0, 0, 0);
  controls.update();
}

function _clearScene() {
  if (mode === 'cut') exitCutMode();
  if (mode === 'move') exitMoveMode();
  mode = 'default';
  
  if (_boundingBoxMesh) {
    scene.remove(_boundingBoxMesh);
    if(_boundingBoxMesh.groundBoundsMesh) {
      scene.remove(_boundingBoxMesh.groundBoundsMesh);
      _boundingBoxMesh.groundBoundsMesh.geometry.dispose();
      _boundingBoxMesh.groundBoundsMesh.material.dispose();
    }
    _boundingBoxMesh.geometry.dispose();
    _boundingBoxMesh.material.dispose();
    _boundingBoxMesh = null;
    _boundingBoxEnabled = false;
    const btn = document.getElementById('boundingBoxBtn');
    if (btn) btn.classList.remove('active');
  }
  
  if (currentObject) scene.remove(currentObject);
  if (_cutState.plane) scene.remove(_cutState.plane);
  if (_cutState.clones) {
    _cutState.clones.forEach(c => scene.remove(c));
    _cutState.clones = null;
  }
  currentObject = null;
  _cutState.plane = null;
  
  const sc = document.getElementById('scissorCursor');
  if (sc) sc.remove();
  const svg = document.getElementById('cutLineSvg');
  if (svg) svg.remove();
}

function _initializeScene() {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(75, window.innerWidth/window.innerHeight, 0.1, 1000);
  renderer = new THREE.WebGLRenderer({antialias:true});
  renderer.setSize(window.innerWidth, window.innerHeight);
  viewerDiv.appendChild(renderer.domElement);
  
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
  scene.add(ambientLight);
  const dirLight = new THREE.DirectionalLight(0xffffff, 1);
  dirLight.position.set(1, 1, 1);
  scene.add(dirLight);
  
  requestAnimationFrame(animate);
  window.addEventListener('resize', onWindowResize);
  
  _sceneInitialized = true;
}

function _positionModel() {
  const box = new THREE.Box3().setFromObject(currentObject);
  const size = new THREE.Vector3();
  box.getSize(size);
  const center = new THREE.Vector3();
  box.getCenter(center);

  currentObject.position.sub(center);

  const maxDim = Math.max(size.x, size.y, size.z);
  if (maxDim > 100) {
    const scaleFactor = 100 / maxDim;
    currentObject.scale.set(scaleFactor, scaleFactor, scaleFactor);
  }
}

function _createGroundPlane() {
  const box = new THREE.Box3().setFromObject(currentObject);
  const size = new THREE.Vector3();
  box.getSize(size);
  const center = new THREE.Vector3();
  box.getCenter(center);

  const planeY = box.min.y - center.y - 0.01;
  const planeWidth = Math.max(size.x, size.z) * 6 + 20;
  const planeHeight = Math.max(size.x, size.z) * 6 + 20;
  const defaultPlaneGeo = new THREE.PlaneGeometry(planeWidth, planeHeight);
  const defaultPlaneMat = new THREE.MeshPhongMaterial({color:0xC2A76B, side: THREE.DoubleSide});
  const defaultPlane = new THREE.Mesh(defaultPlaneGeo, defaultPlaneMat);
  defaultPlane.rotation.x = -Math.PI/2;
  defaultPlane.position.y = planeY;
  scene.add(defaultPlane);
  _cutState.plane = defaultPlane;

  // Calculate actual bounds from the plane mesh using Box3
  // This accounts for any transformations or positioning of the plane
  const planeBox = new THREE.Box3().setFromObject(defaultPlane);
  
  // Store ground plane bounds for move mode
  _moveState.groundBounds = {
    minX: planeBox.min.x,
    maxX: planeBox.max.x,
    minZ: planeBox.min.z,
    maxZ: planeBox.max.z,
    y: planeY
  };

  console.log('=== GROUND PLANE DEBUG ===');
  console.log('Object bounding box:', { minX: box.min.x.toFixed(2), maxX: box.max.x.toFixed(2), minZ: box.min.z.toFixed(2), maxZ: box.max.z.toFixed(2) });
  console.log('Object position:', { x: currentObject.position.x.toFixed(2), y: currentObject.position.y.toFixed(2), z: currentObject.position.z.toFixed(2) });
  console.log('Object center:', { x: center.x.toFixed(2), y: center.y.toFixed(2), z: center.z.toFixed(2) });
  console.log('Plane position:', { x: defaultPlane.position.x.toFixed(2), y: defaultPlane.position.y.toFixed(2), z: defaultPlane.position.z.toFixed(2) });
  console.log('Plane Box3:', { minX: planeBox.min.x.toFixed(2), maxX: planeBox.max.x.toFixed(2), minZ: planeBox.min.z.toFixed(2), maxZ: planeBox.max.z.toFixed(2) });
  console.log('Ground Plane Bounds:', {
    minX: _moveState.groundBounds.minX.toFixed(2),
    maxX: _moveState.groundBounds.maxX.toFixed(2),
    minZ: _moveState.groundBounds.minZ.toFixed(2),
    maxZ: _moveState.groundBounds.maxZ.toFixed(2),
    width: (planeBox.max.x - planeBox.min.x).toFixed(2),
    depth: (planeBox.max.z - planeBox.min.z).toFixed(2)
  });

  _velocity.set(0, 0, 0);
}

async function _reloadCurrentModel(){
  try{
    if(currentObject){
      scene.remove(currentObject);
    }
    if(_cutState.clones){
      _cutState.clones.forEach(c => scene.remove(c));
      _cutState.clones = null;
    }
    const obj = await loadOBJ(`/assets/models/${currentModelName}`);
    currentObject = obj;
    scene.add(currentObject);
    _positionModel();

    if(!controls){
      controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
    }
    controls.target.set(0,0,0);
    controls.update();
  }catch(err){
    console.error('Failed to reload model', err);
  }
}

// =============================================================================
// MOVE MODE: TELEMETRY
// =============================================================================

function _createMoveTelemetry() {
  let telemetryDiv = document.getElementById('moveTelemetry');
  if(telemetryDiv) telemetryDiv.remove();
  
  telemetryDiv = document.createElement('div');
  telemetryDiv.id = 'moveTelemetry';
  
  const html = `
    <div class="telemetry-title">MOVE TELEMETRY</div>
    
    <div class="telemetry-section">
      <div class="telemetry-label">Corner Positions:</div>
      <div id="telemetry-corner-fl" class="telemetry-value">FL: --.-- | --.--</div>
      <div id="telemetry-corner-fr" class="telemetry-value">FR: --.-- | --.--</div>
      <div id="telemetry-corner-bl" class="telemetry-value">BL: --.-- | --.--</div>
      <div id="telemetry-corner-br" class="telemetry-value">BR: --.-- | --.--</div>
    </div>
  `;
  
  telemetryDiv.innerHTML = html;
  viewerDiv.appendChild(telemetryDiv);
}

function _updateMoveTelemetry() {
  if(mode !== 'move' || !currentObject) return;
  
  const cornerFL = document.getElementById('telemetry-corner-fl');
  const cornerFR = document.getElementById('telemetry-corner-fr');
  const cornerBL = document.getElementById('telemetry-corner-bl');
  const cornerBR = document.getElementById('telemetry-corner-br');
  
  if(!cornerFL || !cornerFR || !cornerBL || !cornerBR) return;
  
  // Calculate and update corner positions
  const objBox = new THREE.Box3().setFromObject(currentObject);
  const objSize = new THREE.Vector3();
  objBox.getSize(objSize);
  const halfWidth = objSize.x / 2;
  const halfDepth = objSize.z / 2;
  
  const corners = {
    fl: { x: currentObject.position.x - halfWidth, z: currentObject.position.z - halfDepth },
    fr: { x: currentObject.position.x + halfWidth, z: currentObject.position.z - halfDepth },
    bl: { x: currentObject.position.x - halfWidth, z: currentObject.position.z + halfDepth },
    br: { x: currentObject.position.x + halfWidth, z: currentObject.position.z + halfDepth }
  };
  
  cornerFL.textContent = `FL: ${corners.fl.x.toFixed(2)} | ${corners.fl.z.toFixed(2)}`;
  cornerFR.textContent = `FR: ${corners.fr.x.toFixed(2)} | ${corners.fr.z.toFixed(2)}`;
  cornerBL.textContent = `BL: ${corners.bl.x.toFixed(2)} | ${corners.bl.z.toFixed(2)}`;
  cornerBR.textContent = `BR: ${corners.br.x.toFixed(2)} | ${corners.br.z.toFixed(2)}`;
  
  // Update corner indicators
  _updateCornerIndicators();
}

function _createCornerIndicators() {
  // Remove old indicators if they exist
  _moveState.cornerIndicators.forEach(indicator => {
    scene.remove(indicator);
    indicator.geometry.dispose();
    indicator.material.dispose();
  });
  _moveState.cornerIndicators = [];
  
  // Create spheres for the 4 base corners
  const geometry = new THREE.SphereGeometry(4, 12, 12);
  const material = new THREE.MeshBasicMaterial({
    color: 0x00ff00, // Neon green
    emissive: 0x00ff00,
    wireframe: false,
  });
  
  // Get actual bounding box corners
  const objBox = new THREE.Box3().setFromObject(currentObject);
  
  // Create 4 corner spheres at the actual bounding box corners
  const cornerPositions = [
    { x: objBox.min.x, z: objBox.min.z }, // Front-left (min x, min z)
    { x: objBox.max.x, z: objBox.min.z }, // Front-right (max x, min z)
    { x: objBox.min.x, z: objBox.max.z }, // Back-left (min x, max z)
    { x: objBox.max.x, z: objBox.max.z }  // Back-right (max x, max z)
  ];
  
  cornerPositions.forEach(pos => {
    const sphere = new THREE.Mesh(geometry, material.clone());
    sphere.position.set(pos.x, _moveState.groundBounds.y + 4, pos.z);
    scene.add(sphere);
    _moveState.cornerIndicators.push(sphere);
  });
}

function _updateCornerIndicators() {
  if(!_moveState.cornerIndicators || _moveState.cornerIndicators.length === 0 || !currentObject) return;
  
  // Get actual bounding box corners
  const objBox = new THREE.Box3().setFromObject(currentObject);
  
  const cornerPositions = [
    { x: objBox.min.x, z: objBox.min.z }, // Front-left (min x, min z)
    { x: objBox.max.x, z: objBox.min.z }, // Front-right (max x, min z)
    { x: objBox.min.x, z: objBox.max.z }, // Back-left (min x, max z)
    { x: objBox.max.x, z: objBox.max.z }  // Back-right (max x, max z)
  ];
  
  // Update each corner indicator position
  _moveState.cornerIndicators.forEach((indicator, index) => {
    const pos = cornerPositions[index];
    indicator.position.set(pos.x, _moveState.groundBounds.y + 4, pos.z);
  });
}


// =============================================================================
// MOVE MODE: KEYBOARD CONTROL (VERTICAL MOVEMENT)
// =============================================================================

function _onMoveKeyDown(event) {
  if(mode !== 'move') return;
  if(!_moveState.draggable) return; // Only act if dragging object

  const planeY = _moveState.groundPlane ? _moveState.groundPlane.position.y : 0;
  const velocityStep = 15; // Change Y speed increment

  if(event.key === 'T' || event.key === 't') {
    // Move up
    _velocity.y = velocityStep;
  } else if(event.key === 'R' || event.key === 'r') {
    // Move down
    const box = new THREE.Box3().setFromObject(_moveState.draggable);
    // Only move down if above ground
    if(box.min.y > planeY + 0.01) {
      _velocity.y = -velocityStep;
    }
  }
}

function _onMoveKeyUp(event) {
  if(event.key === 'T' || event.key === 't' || event.key === 'R' || event.key === 'r') {
    _velocity.y = 0; // Stop vertical impulse when key released
  }
}

// =============================================================================
// MOVE MODE: STATE MANAGEMENT
// =============================================================================

function enterMoveMode() {
  if(!currentObject || !_readyForCut()) return;
  if(mode === 'move') return;
  if(mode === 'cut') exitCutMode();
  mode = 'move';

  // Setup orbit controls for move mode (right-click to rotate)
  if(controls && controls.dispose) controls.dispose();
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.autoRotate = false;
  controls.mouseButtons = {
    LEFT: null,           // Disable left click (we use it for dragging)
    MIDDLE: THREE.MOUSE.MIDDLE,
    RIGHT: THREE.MOUSE.ROTATE  // Right click for rotation
  };
  controls.touches = {
    ONE: null,
    TWO: null
  };
  controls.target.set(0, 0, 0);
  controls.update();

  _moveState.enabled = true;
  _moveState.groundPlane = _cutState.plane;
  _moveState.isMouseDown = false;
  _moveState.draggable = null;

  // Hide scissor cursor in move mode
  const sc = document.getElementById('scissorCursor');
  if(sc) sc.style.display = 'none';

  // Show telemetry
  _createMoveTelemetry();
  const telemetryDiv = document.getElementById('moveTelemetry');
  if(telemetryDiv) telemetryDiv.classList.add('active');
  _updateMoveTelemetry();
  
  // Create corner indicators
  _createCornerIndicators();

  viewerDiv.addEventListener('mousedown', _onMoveMouseDown);
  viewerDiv.addEventListener('mousemove', _onMoveMouseMove);
  viewerDiv.addEventListener('mouseup', _onMoveMouseUp);
  window.addEventListener('keydown', _onMoveKeyDown);
  window.addEventListener('keyup', _onMoveKeyUp);
}

function exitMoveMode() {
  if(mode !== 'move') return;
  mode = 'default';

  _moveState.enabled = false;
  _moveState.draggable = null;
  _moveState.isMouseDown = false;

  // Hide telemetry
  const telemetryDiv = document.getElementById('moveTelemetry');
  if(telemetryDiv) telemetryDiv.classList.remove('active');
  
  // Remove corner indicators
  _moveState.cornerIndicators.forEach(indicator => {
    scene.remove(indicator);
    indicator.geometry.dispose();
    indicator.material.dispose();
  });
  _moveState.cornerIndicators = [];

  viewerDiv.removeEventListener('mousedown', _onMoveMouseDown);
  viewerDiv.removeEventListener('mousemove', _onMoveMouseMove);
  viewerDiv.removeEventListener('mouseup', _onMoveMouseUp);

  window.removeEventListener('keydown', _onMoveKeyDown);
  window.removeEventListener('keyup', _onMoveKeyUp);

  // Restore default orbit controls
  if(controls && controls.dispose) controls.dispose();
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.set(0, 0, 0);
  controls.update();
}

function _onMoveMouseDown(event) {
  if(event.button !== 0) return; // Only left click
  
  _moveState.isMouseDown = true;
  _moveState.clickMouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  _moveState.clickMouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
  _moveState.raycaster.setFromCamera(_moveState.clickMouse, camera);
  
  const found = _moveState.raycaster.intersectObjects(scene.children, true);

  if(found.length > 0) {
    let current = found[0].object;
    while(current.parent && current.parent.parent !== null) {
      current = current.parent;
    }
    if(current === currentObject || (currentObject.children && currentObject.children.includes(current))) {
      _moveState.draggable = currentObject;
      // Store the offset from the object center to the click point
      const clickPoint = found[0].point;
      _moveState.clickOffset.copy(clickPoint).sub(_moveState.draggable.position);
    }
  }
}

function _onMoveMouseMove(event) {
  _moveState.moveMouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  _moveState.moveMouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
  _moveState.raycaster.setFromCamera(_moveState.moveMouse, camera);
  
  if(_moveState.draggable && _moveState.isMouseDown) {
    const intersects = _moveState.raycaster.intersectObjects(scene.children);

    // Find intersection with ground plane
    for(let o of intersects) {
      if(o.object === _moveState.groundPlane) {
        // Get the target position by applying the click offset
        let newPos = o.point.clone().sub(_moveState.clickOffset);
        let newX = newPos.x;
        let newZ = newPos.z;
        
        // Check corner-based bounds - verify all 4 base corners stay within bounds
        if(_moveState.groundBounds) {
          const bounds = _moveState.groundBounds;
          const objBox = new THREE.Box3().setFromObject(_moveState.draggable);
          const objSize = new THREE.Vector3();
          objBox.getSize(objSize);
          
          // Get the current bounding box relative to object's current position
          const halfWidth = objSize.x / 2;
          const halfDepth = objSize.z / 2;
          
          // Calculate the 4 base corners at the proposed new position
          const corners = [
            { x: newX - halfWidth, z: newZ - halfDepth }, // Front-left
            { x: newX + halfWidth, z: newZ - halfDepth }, // Front-right
            { x: newX - halfWidth, z: newZ + halfDepth }, // Back-left
            { x: newX + halfWidth, z: newZ + halfDepth }  // Back-right
          ];
          
          // Check if any corner is outside bounds
          let canMove = true;
          for(let corner of corners) {
            if(corner.x < bounds.minX || corner.x > bounds.maxX || 
               corner.z < bounds.minZ || corner.z > bounds.maxZ) {
              canMove = false;
              break;
            }
          }
          
          // Only update position if all corners are within bounds
          if(canMove) {
            _moveState.draggable.position.x = newX;
            _moveState.draggable.position.z = newZ;
          }
        } else {
          _moveState.draggable.position.x = newX;
          _moveState.draggable.position.z = newZ;
        }
        break;
      }
    }
  }
}

function _onMoveMouseUp(event) {
  if(event.button !== 0) return; // Only left click
  _moveState.isMouseDown = false;
  _moveState.draggable = null;
  _moveState.clickOffset.set(0, 0, 0);
}

// =============================================================================
// CUT MODE: STATE MANAGEMENT
// =============================================================================

function enterCutMode(){
  if(!currentObject || !_readyForCut()) return;
  if(mode === 'cut') return;
  mode = 'cut';



  
  const box = new THREE.Box3().setFromObject(currentObject);
  const size = new THREE.Vector3();
  box.getSize(size);
  const center = new THREE.Vector3();
  box.getCenter(center);

  let planeY;
  if(!_cutState.plane){
    planeY = box.min.y - 0.01;
    const planeGeo = new THREE.PlaneGeometry(Math.max(size.x, size.z) * 4 + 10, Math.max(size.x, size.z) * 4 + 10);
    const planeMat = new THREE.MeshPhongMaterial({color:0xC2A76B, side: THREE.DoubleSide});
    const planeMesh = new THREE.Mesh(planeGeo, planeMat);
    planeMesh.rotation.x = -Math.PI/2;
    planeMesh.position.y = planeY;
    scene.add(planeMesh);
    _cutState.plane = planeMesh;
  } else {
    _cutState.plane.visible = true;
    planeY = _cutState.plane.position.y;
  }

  _cutState.prevCamera = camera;
  _cutState.prevControls = controls;
  _velocity.set(0, 0, 0);
  if(renderer) renderer.localClippingEnabled = true;

  const maxXZ = Math.max(size.x, size.z) * 1.5 + 1;
  const half = Math.max(maxXZ, 5);
  _cutState.orthoHalf = half;
  const orthoCam = new THREE.OrthographicCamera(-half, half, half, -half, 0.1, 1000);
  orthoCam.position.set(center.x + half * 0.25, planeY + half * 1.2, center.z + half * 0.25);
  orthoCam.up.set(0, 1, 0);
  orthoCam.lookAt(center.x, planeY, center.z);
  orthoCam.updateProjectionMatrix();

  camera = orthoCam;
  if(controls && controls.dispose) controls.dispose();
  
  // Create orbit-like controls for cut mode with right-click for rotation
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.autoRotate = false;
  controls.mouseButtons = {
    LEFT: null,           // Disable left click (we use it for cutting)
    MIDDLE: THREE.MOUSE.MIDDLE,
    RIGHT: THREE.MOUSE.ROTATE  // Right click for rotation
  };
  controls.touches = {
    ONE: null,
    TWO: null
  };
  controls.target.set(center.x, planeY, center.z);
  controls.update();

  _cutState.enabled = true;
  const correction = Math.max(0, (box.max.y - box.min.y) * 0.05);
  currentObject.position.y = Math.max(currentObject.position.y, planeY + correction + 0.001);
  
  const sc = document.getElementById('scissorCursor');
  if(sc){
     sc.style.display = 'block';
  }
  viewerDiv.addEventListener('pointermove', _onCutPointerMove);
  viewerDiv.addEventListener('pointerdown', _onCutPointerDown);
  window.addEventListener('pointerup', _onCutPointerUp);
}

function exitCutMode(){
  if(mode !== 'cut') return;
  mode = 'default';
  if(_cutState.plane){
    _cutState.plane.visible = true;
  }

  if(_cutState.prevCamera){
    camera = _cutState.prevCamera;
    try{
      controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.target.set(0,0,0);
      controls.update();
    }catch(e){
      controls = _cutState.prevControls;
    }
    _cutState.prevCamera = null;
    _cutState.prevControls = null;
  }
  _cutState.enabled = false;

  const sc = document.getElementById('scissorCursor');
  if(sc) sc.remove();
  const svg = document.getElementById('cutLineSvg');
  if(svg) svg.remove();
  viewerDiv.removeEventListener('pointermove', _onCutPointerMove);
  viewerDiv.removeEventListener('pointerdown', _onCutPointerDown);
  window.removeEventListener('pointerup', _onCutPointerUp);

  if(_cutState.clones){
    _cutState.clones.forEach(c => {
      scene.remove(c);
    });
    _cutState.clones = null;
  }
  if(currentObject) currentObject.visible = true;
  renderer.localClippingEnabled = false;
}

function _readyForCut(){
  return !!(scene && currentObject && camera && renderer);
}

// =============================================================================
// PHYSICS: GRAVITY & COLLISION
// =============================================================================

function _updatePhysics(delta){
  if(!_cutState.plane) return;
  
  // If we have cut clones, apply physics to them instead of original
  if(_cutState.clones && _cutState.clones.length > 0) {
    _cutState.clones.forEach(clone => {
      _velocity.y += GRAVITY * delta;
      clone.position.y += _velocity.y * delta;

      const box = new THREE.Box3().setFromObject(clone);
      const planeY = _cutState.plane.position.y;
      
      if(box.min.y < planeY){
        const offset = planeY - box.min.y;
        clone.position.y += offset;
        _velocity.y = 0;
      }
    });
  } else if(currentObject) {
    // Apply physics to original object if no cuts yet (in move, default, or cut modes)
    _velocity.y += GRAVITY * delta;
    currentObject.position.y += _velocity.y * delta;

    const box = new THREE.Box3().setFromObject(currentObject);
    const planeY = _cutState.plane.position.y;
    
    if(box.min.y < planeY){
      const offset = planeY - box.min.y;
      currentObject.position.y += offset;
      _velocity.y = 0;
    }
  }

  if(mode === 'cut') {
   // _constrainToBounds();
  }

  _updateBoundingBoxVisualization();
}

function _constrainToBounds() {
  const half = _cutState.orthoHalf;
  const margin = _cutState.boundsMargin;
  const left = camera.position.x - half + margin;
  const right = camera.position.x + half - margin;
  const top = camera.position.z - half + margin;
  const bottom = camera.position.z + half - margin;

  // Constrain clones if they exist, otherwise constrain original object
  const objectsToConstrain = (_cutState.clones && _cutState.clones.length > 0) 
    ? _cutState.clones 
    : (currentObject ? [currentObject] : []);

  objectsToConstrain.forEach(obj => {
    const box = new THREE.Box3().setFromObject(obj);
    
    if(box.min.x < left) {
      obj.position.x += left - box.min.x;
    }
    if(box.max.x > right) {
      obj.position.x += right - box.max.x;
    }
    
    if(box.min.z < top) {
      obj.position.z += top - box.min.z;
    }
    if(box.max.z > bottom) {
      obj.position.z += bottom - box.max.z;
    }
  });
}

function _updateBoundingBoxVisualization() {
  if (!_boundingBoxEnabled || !_boundingBoxMesh) return;
  
  // If we have cut clones, show bounding box around all of them
  if(_cutState.clones && _cutState.clones.length > 0) {
    const groupBox = new THREE.Box3();
    _cutState.clones.forEach(clone => {
      groupBox.expandByObject(clone);
    });
    const center = new THREE.Vector3();
    groupBox.getCenter(center);
    _boundingBoxMesh.position.copy(center);
  } else if(currentObject) {
    // Show bounding box around original object
    const box = new THREE.Box3().setFromObject(currentObject);
    const center = new THREE.Vector3();
    box.getCenter(center);
    _boundingBoxMesh.position.copy(center);
  }
}

function _updateCutPhysics(delta){
  _updatePhysics(delta);
}

// =============================================================================
// ANIMATION & RENDERING
// =============================================================================

let _lastTime = performance.now();
function animate(time){
  requestAnimationFrame(animate);
  const t = time || performance.now();
  const delta = Math.min(0.1, (t - _lastTime) / 1000);
  _lastTime = t;

  if(controls) controls.update();
  _updatePhysics(delta);
  _updateGroundPlaneVisibility();
  _updateMoveTelemetry();
  if(renderer && scene && camera) renderer.render(scene, camera);
}

function _updateGroundPlaneVisibility() {
  if (!_cutState.plane || !camera) return;
  
  const planeY = _cutState.plane.position.y;
  const cameraY = camera.position.y;
  
  // Make plane invisible when camera is below it
  if (cameraY < planeY) {
    _cutState.plane.visible = false;
  } else {
    _cutState.plane.visible = true;
  }
}

function onWindowResize(){
  renderer.setSize(window.innerWidth, window.innerHeight);
  if(!camera) return;
  
  if(camera.isPerspectiveCamera){
    camera.aspect = window.innerWidth/window.innerHeight;
    camera.updateProjectionMatrix();
  } else if(camera.isOrthographicCamera){
    const half = _cutState.orthoHalf || 10;
    const aspect = window.innerWidth / window.innerHeight;
    camera.left = -half * aspect;
    camera.right = half * aspect;
    camera.top = half;
    camera.bottom = -half;
    camera.updateProjectionMatrix();
  }
}

// =============================================================================
// APP ENTRY POINT
// =============================================================================

fetchModels();
loadViewer('spleen_0.obj');