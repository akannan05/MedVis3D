import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { loadOBJ, createSliceMaterial, createOrganMaterial, convertDistance, convertArea, formatMeasurement, SoftBodyMesh } from './loader.js';
import { loadNiftiFile } from './niftiProcessor.js';
import '../css/styles.css';

// =============================================================================
// MEASUREMENT UNITS CONFIGURATION
// =============================================================================

// Current display unit preference
let _displayUnit = 'mm'; // 'mm', 'cm', 'm'
let _softBodyEnabled = true;

// =============================================================================
// STATE MANAGEMENT
// =============================================================================

// DOM Elements
const viewerDiv = document.getElementById('viewer');
const folderViewDiv = document.getElementById('folderView');

// Scene Graph
let scene, camera, renderer, controls, currentObject;

// Global State
let models = [];
let currentModelName = null;
let mode = 'default'; // 'default' | 'cut' | 'move' | 'measure'
let _sceneInitialized = false;

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
  dragPlaneY: 0, // Y position for the horizontal drag plane
  shiftHeld: false, // Whether shift is held for Y-axis movement
  lastMouseY: 0, // Last mouse Y position for vertical dragging
  initialY: 0, // Initial Y position when starting vertical drag
  gravityDisabled: false, // Disable gravity when object is manually lifted
};

// Measure Mode State
let _measureState = {
  enabled: false,
  measureType: 'distance', // 'distance' | 'area'
  raycaster: new THREE.Raycaster(),
  mouse: new THREE.Vector2(),
  // Distance measurement
  pointA: null,           // First clicked point (THREE.Vector3)
  pointB: null,           // Second clicked point (THREE.Vector3)
  markerA: null,          // Sphere mesh for point A
  markerB: null,          // Sphere mesh for point B
  line: null,             // Line connecting the two points
  measurements: [],       // Array of completed measurements { markerA, markerB, line, label, distance }
  // Area measurement
  areaPoints: [],         // Array of clicked points for area polygon
  areaMarkers: [],        // Array of sphere meshes for area points
  areaLines: [],          // Array of lines connecting area points
  previewLine: null,      // Preview line from last point to cursor
  areaMesh: null,         // Filled polygon mesh for current area
  areaResults: [],        // Array of completed area measurements { markers, lines, mesh, area }
};

// Slice Mode State (real mesh cutting)
let _sliceState = {
  enabled: false,
  raycaster: new THREE.Raycaster(),
  mouse: new THREE.Vector2(),
  dragging: false,
  startPoint: null,
  endPoint: null,
  startClientX: 0,
  startClientY: 0,
  slicedPieces: [],       // Array of sliced mesh pieces
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
  cloneA.visible = true;

  cloneB.position.copy(sourceObject.position);
  cloneB.quaternion.copy(sourceObject.quaternion);
  cloneB.scale.copy(sourceObject.scale);
  cloneB.updateMatrixWorld(true);
  cloneB.position.addScaledVector(normal, -gap);
  cloneB.visible = true;

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
        folderViewDiv.classList.remove('open');
        loadViewer(modelFile);
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
  
  // Remove old upload panel if exists
  const oldUploadPanel = document.getElementById('uploadPanel');
  if (oldUploadPanel) oldUploadPanel.remove();

  const sidebar = document.createElement('div');
  sidebar.id = 'leftSidebar';
  
  // Upload/Load button
  const uploadBtn = document.createElement('button');
  uploadBtn.className = 'sidebar-btn upload-btn';
  uploadBtn.innerHTML = '📂';
  uploadBtn.title = 'Load NIfTI file';
  uploadBtn.onclick = (e) => {
    e.stopPropagation();
    toggleUploadPanel();
  };
  sidebar.appendChild(uploadBtn);
  
  // Separator
  const sep = document.createElement('div');
  sep.className = 'sidebar-separator';
  sidebar.appendChild(sep);
  
  const buttons = ['Move', 'Cut', 'Inspect'];
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
  
  // Create upload panel (hidden by default)
  createUploadPanel();

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
    // Use the new slice mode (real mesh cutting)
    if(mode === 'measure') exitMeasureMode();
    if(mode === 'move') exitMoveMode();
    if(mode === 'cut') exitCutMode();
    enterSliceMode();
  } else if (tool === 'Move') {
    if(mode === 'measure') exitMeasureMode();
    if(mode === 'cut') exitCutMode();
    if(mode === 'slice') exitSliceMode();
    enterMoveMode();
  } else if (tool === 'Measure') {
    if(mode === 'slice') exitSliceMode();
    enterMeasureMode();
  } else {
    if (mode === 'cut') exitCutMode();
    if (mode === 'move') exitMoveMode();
    if (mode === 'measure') exitMeasureMode();
    if (mode === 'slice') exitSliceMode();
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
  if (mode === 'measure') exitMeasureMode();
  
  // Clear all measurements
  if(_measureState.measurements) {
    _measureState.measurements.forEach(m => {
      if(m.markerA) { scene.remove(m.markerA); m.markerA.geometry.dispose(); m.markerA.material.dispose(); }
      if(m.markerB) { scene.remove(m.markerB); m.markerB.geometry.dispose(); m.markerB.material.dispose(); }
      if(m.line) { scene.remove(m.line); m.line.geometry.dispose(); m.line.material.dispose(); }
    });
    _measureState.measurements = [];
  }
  
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
  scene.background = new THREE.Color(0x1a1a2e);
  
  // Add subtle fog for depth (reduced density)
  scene.fog = new THREE.FogExp2(0x1a1a2e, 0.001);
  
  camera = new THREE.PerspectiveCamera(60, window.innerWidth/window.innerHeight, 0.1, 5000);
  
  // Enhanced renderer with advanced features
  renderer = new THREE.WebGLRenderer({ 
    antialias: true, 
    alpha: true,
    powerPreference: 'high-performance',
    stencil: false,
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  
  // Shadow configuration
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  
  // Tone mapping for realistic lighting
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.5;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  
  viewerDiv.appendChild(renderer.domElement);
  
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.minDistance = 10;
  controls.maxDistance = 500;
  
  // Improved lighting setup for realistic rendering
  _setupLighting();
  
  // Create environment map for reflections
  _createEnvironmentMap();
  
  requestAnimationFrame(animate);
  window.addEventListener('resize', onWindowResize);
  
  _sceneInitialized = true;
}

function _setupLighting() {
  // Strong ambient light for base illumination
  const ambientLight = new THREE.AmbientLight(0xffffff, 2.0);
  scene.add(ambientLight);
  
  // Hemisphere light for natural sky/ground gradient
  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 2.0);
  hemiLight.position.set(0, 200, 0);
  scene.add(hemiLight);
  
  // Main directional light (simpler, more reliable than spotlight)
  const mainLight = new THREE.DirectionalLight(0xffffff, 3.0);
  mainLight.position.set(50, 100, 50);
  mainLight.castShadow = true;
  mainLight.shadow.mapSize.width = 2048;
  mainLight.shadow.mapSize.height = 2048;
  mainLight.shadow.camera.near = 1;
  mainLight.shadow.camera.far = 500;
  mainLight.shadow.camera.left = -100;
  mainLight.shadow.camera.right = 100;
  mainLight.shadow.camera.top = 100;
  mainLight.shadow.camera.bottom = -100;
  mainLight.shadow.bias = -0.0001;
  scene.add(mainLight);
  
  // Fill light (from opposite side)
  const fillLight = new THREE.DirectionalLight(0xaaccff, 2.0);
  fillLight.position.set(-80, 60, -40);
  scene.add(fillLight);
  
  // Front light for visibility
  const frontLight = new THREE.DirectionalLight(0xffffff, 2.0);
  frontLight.position.set(0, 50, 100);
  scene.add(frontLight);
  
  // Rim light for edge definition (backlight)
  const rimLight = new THREE.DirectionalLight(0xffeedd, 1.5);
  rimLight.position.set(30, 30, -80);
  scene.add(rimLight);
  
  // Warm accent light from below (simulates reflected light from table)
  const bounceLight = new THREE.PointLight(0xffddcc, 50, 200);
  bounceLight.position.set(0, -20, 0);
  scene.add(bounceLight);
}

function _createEnvironmentMap() {
  // Create a simple gradient environment map for subtle reflections
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  pmremGenerator.compileEquirectangularShader();
  
  // Create a simple environment using a cube render target
  const envScene = new THREE.Scene();
  envScene.background = new THREE.Color(0x202030);
  
  // Add some colored lights to the env scene for interesting reflections
  const envLight1 = new THREE.PointLight(0x6688aa, 1, 100);
  envLight1.position.set(10, 10, 10);
  envScene.add(envLight1);
  
  const envLight2 = new THREE.PointLight(0xaa8866, 1, 100);
  envLight2.position.set(-10, -10, 10);
  envScene.add(envLight2);
  
  // Generate environment map
  const cubeRenderTarget = new THREE.WebGLCubeRenderTarget(256);
  const cubeCamera = new THREE.CubeCamera(0.1, 100, cubeRenderTarget);
  cubeCamera.update(renderer, envScene);
  
  scene.environment = cubeRenderTarget.texture;
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

function _createEmptyGroundPlane() {
  // Create a default ground plane when no object is loaded
  const planeY = -50;
  const planeSize = 300;
  const defaultPlaneGeo = new THREE.PlaneGeometry(planeSize, planeSize);
  const defaultPlaneMat = new THREE.MeshStandardMaterial({
    color: 0x2a2a35,
    roughness: 0.95,
    metalness: 0.0,
    side: THREE.DoubleSide
  });
  const defaultPlane = new THREE.Mesh(defaultPlaneGeo, defaultPlaneMat);
  defaultPlane.rotation.x = -Math.PI/2;
  defaultPlane.position.y = planeY;
  defaultPlane.receiveShadow = true;
  scene.add(defaultPlane);
  _cutState.plane = defaultPlane;
  
  // Store ground plane bounds
  _moveState.groundBounds = {
    minX: -planeSize/2,
    maxX: planeSize/2,
    minZ: -planeSize/2,
    maxZ: planeSize/2,
    y: planeY
  };
  
  // Position camera
  camera.position.set(80, 60, 120);
  controls.target.set(0, 0, 0);
  controls.update();
}

function _createGroundPlane() {
  if (!currentObject) return;
  
  // Remove old plane if exists
  if (_cutState.plane) {
    scene.remove(_cutState.plane);
    _cutState.plane.geometry.dispose();
    _cutState.plane.material.dispose();
  }
  
  const box = new THREE.Box3().setFromObject(currentObject);
  const size = new THREE.Vector3();
  box.getSize(size);
  const center = new THREE.Vector3();
  box.getCenter(center);

  const planeY = box.min.y - center.y - 0.01;
  const planeWidth = Math.max(size.x, size.z) * 6 + 20;
  const planeHeight = Math.max(size.x, size.z) * 6 + 20;
  const defaultPlaneGeo = new THREE.PlaneGeometry(planeWidth, planeHeight);
  const defaultPlaneMat = new THREE.MeshStandardMaterial({
    color: 0x2a2a35,
    roughness: 0.95,
    metalness: 0.0,
    side: THREE.DoubleSide
  });
  const defaultPlane = new THREE.Mesh(defaultPlaneGeo, defaultPlaneMat);
  defaultPlane.rotation.x = -Math.PI/2;
  defaultPlane.position.y = planeY;
  defaultPlane.receiveShadow = true;
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
    <div class="telemetry-title">✋ MOVE MODE (V)</div>
    <div class="move-status" id="moveStatus">Click and drag object. Hold <strong>Shift</strong> to move vertically.</div>
    
    <div class="telemetry-section">
      <div class="telemetry-label">Corner Positions:</div>
      <div id="telemetry-corner-fl" class="telemetry-value">FL: --.-- | --.--</div>
      <div id="telemetry-corner-fr" class="telemetry-value">FR: --.-- | --.--</div>
      <div id="telemetry-corner-bl" class="telemetry-value">BL: --.-- | --.--</div>
      <div id="telemetry-corner-br" class="telemetry-value">BR: --.-- | --.--</div>
    </div>
    
    <div class="move-controls">
      <div class="control-hint">🖱️ Left-click + drag: Move object</div>
      <div class="control-hint">⇧ + drag: Move up/down</div>
      <div class="control-hint">🖱️ Right-click + drag: Rotate view</div>
      <div class="control-hint">🖱️ Scroll: Zoom</div>
    </div>
  `;
  
  telemetryDiv.innerHTML = html;
  viewerDiv.appendChild(telemetryDiv);
}

function _updateMoveTelemetry() {
  if(mode !== 'move') return;
  
  // Get the object to track - either sliced pieces or current object
  const targetObj = (_sliceState.slicedPieces && _sliceState.slicedPieces.length > 0)
    ? _sliceState.slicedPieces[0]
    : currentObject;
  
  if(!targetObj) return;
  
  const cornerFL = document.getElementById('telemetry-corner-fl');
  const cornerFR = document.getElementById('telemetry-corner-fr');
  const cornerBL = document.getElementById('telemetry-corner-bl');
  const cornerBR = document.getElementById('telemetry-corner-br');
  
  if(!cornerFL || !cornerFR || !cornerBL || !cornerBR) return;
  
  // Calculate and update corner positions
  const objBox = new THREE.Box3().setFromObject(targetObj);
  const objSize = new THREE.Vector3();
  objBox.getSize(objSize);
  const center = new THREE.Vector3();
  objBox.getCenter(center);
  const halfWidth = objSize.x / 2;
  const halfDepth = objSize.z / 2;
  
  const corners = {
    fl: { x: center.x - halfWidth, z: center.z - halfDepth },
    fr: { x: center.x + halfWidth, z: center.z - halfDepth },
    bl: { x: center.x - halfWidth, z: center.z + halfDepth },
    br: { x: center.x + halfWidth, z: center.z + halfDepth }
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
  
  // Get the object to track
  const targetObj = (_sliceState.slicedPieces && _sliceState.slicedPieces.length > 0)
    ? _sliceState.slicedPieces[0]
    : currentObject;
  
  if(!targetObj) return;
  
  // Create spheres for the 4 base corners
  const geometry = new THREE.SphereGeometry(2, 12, 12);
  const material = new THREE.MeshBasicMaterial({
    color: 0x00ff00, // Neon green
    wireframe: false,
  });
  
  // Get actual bounding box corners
  const objBox = new THREE.Box3().setFromObject(targetObj);
  const groundY = _moveState.groundBounds ? _moveState.groundBounds.y : objBox.min.y;
  
  // Create 4 corner spheres at the actual bounding box corners
  const cornerPositions = [
    { x: objBox.min.x, z: objBox.min.z }, // Front-left (min x, min z)
    { x: objBox.max.x, z: objBox.min.z }, // Front-right (max x, min z)
    { x: objBox.min.x, z: objBox.max.z }, // Back-left (min x, max z)
    { x: objBox.max.x, z: objBox.max.z }  // Back-right (max x, max z)
  ];
  
  cornerPositions.forEach(pos => {
    const sphere = new THREE.Mesh(geometry, material.clone());
    sphere.position.set(pos.x, groundY + 2, pos.z);
    scene.add(sphere);
    _moveState.cornerIndicators.push(sphere);
  });
}

function _updateCornerIndicators() {
  if(!_moveState.cornerIndicators || _moveState.cornerIndicators.length === 0) return;
  
  // Get the object to track
  const targetObj = (_sliceState.slicedPieces && _sliceState.slicedPieces.length > 0)
    ? _sliceState.slicedPieces[0]
    : currentObject;
  
  if(!targetObj) return;
  
  // Get actual bounding box corners
  const objBox = new THREE.Box3().setFromObject(targetObj);
  const groundY = _moveState.groundBounds ? _moveState.groundBounds.y : objBox.min.y;
  
  const cornerPositions = [
    { x: objBox.min.x, z: objBox.min.z }, // Front-left (min x, min z)
    { x: objBox.max.x, z: objBox.min.z }, // Front-right (max x, min z)
    { x: objBox.min.x, z: objBox.max.z }, // Back-left (min x, max z)
    { x: objBox.max.x, z: objBox.max.z }  // Back-right (max x, max z)
  ];
  
  // Update each corner indicator position
  _moveState.cornerIndicators.forEach((indicator, index) => {
    const pos = cornerPositions[index];
    indicator.position.set(pos.x, groundY + 2, pos.z);
  });
}


// =============================================================================
// MOVE MODE: KEYBOARD CONTROL (VERTICAL MOVEMENT)
// =============================================================================

function _onMoveKeyDown(event) {
  if(mode !== 'move') return;
  
  // 'G' key to re-enable gravity and drop the object
  if(event.key === 'G' || event.key === 'g') {
    _moveState.gravityDisabled = false;
    _updateMoveStatus();
    return;
  }
  
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
  
  // Exit other modes first
  if(mode === 'slice') exitSliceMode();
  if(mode === 'cut') exitCutMode();
  if(mode === 'measure') exitMeasureMode();
  
  mode = 'move';

  // Setup orbit controls for move mode (right-click to rotate view)
  if(controls && controls.dispose) controls.dispose();
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.autoRotate = false;
  controls.mouseButtons = {
    LEFT: null,           // Disable left click (we use it for dragging)
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT: THREE.MOUSE.ROTATE  // Right click for rotation
  };
  controls.touches = {
    ONE: null,
    TWO: THREE.TOUCH.DOLLY_ROTATE
  };
  controls.target.set(0, 0, 0);
  controls.update();

  _moveState.enabled = true;
  _moveState.groundPlane = _cutState.plane;
  _moveState.isMouseDown = false;
  _moveState.draggable = null;

  // Hide other cursors
  const sc = document.getElementById('scissorCursor');
  if(sc) sc.style.display = 'none';
  const sliceCursor = document.getElementById('sliceCursor');
  if(sliceCursor) sliceCursor.style.display = 'none';

  // Create move UI
  _createMoveUI();

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
  
  _updateSidebarButtonState('Move');
}

function _createMoveUI() {
  // Create move cursor
  let cursor = document.getElementById('moveCursor');
  if(cursor) cursor.remove();
  cursor = document.createElement('div');
  cursor.id = 'moveCursor';
  cursor.textContent = '✋';
  cursor.style.position = 'absolute';
  cursor.style.pointerEvents = 'none';
  cursor.style.display = 'block';
  cursor.style.zIndex = '30';
  cursor.style.fontSize = '24px';
  viewerDiv.appendChild(cursor);
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
  
  // Remove move cursor
  const moveCursor = document.getElementById('moveCursor');
  if(moveCursor) moveCursor.remove();
  
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
  
  _updateSidebarButtonState(null);
}

function _onMoveMouseDown(event) {
  if(event.button !== 0) return; // Only left click
  
  const rect = viewerDiv.getBoundingClientRect();
  _moveState.clickMouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  _moveState.clickMouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  _moveState.raycaster.setFromCamera(_moveState.clickMouse, camera);
  
  // Get objects to check - either sliced pieces or current object
  const objectsToCheck = (_sliceState.slicedPieces && _sliceState.slicedPieces.length > 0)
    ? _sliceState.slicedPieces
    : (currentObject ? [currentObject] : []);
  
  let closestHit = null;
  let closestDist = Infinity;
  let hitObject = null;
  
  objectsToCheck.forEach(obj => {
    const intersects = _moveState.raycaster.intersectObject(obj, true);
    if(intersects.length > 0 && intersects[0].distance < closestDist) {
      closestDist = intersects[0].distance;
      closestHit = intersects[0];
      hitObject = obj;
    }
  });

  if(closestHit && hitObject) {
    _moveState.isMouseDown = true;
    _moveState.draggable = hitObject;
    _moveState.shiftHeld = event.shiftKey;
    _moveState.lastMouseY = event.clientY;
    
    // Store the Y position for the drag plane
    const box = new THREE.Box3().setFromObject(hitObject);
    const center = new THREE.Vector3();
    box.getCenter(center);
    _moveState.dragPlaneY = center.y;
    _moveState.initialY = hitObject.position.y;
    
    // Calculate offset from object position to click point on the drag plane
    const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -_moveState.dragPlaneY);
    const clickOnPlane = new THREE.Vector3();
    _moveState.raycaster.ray.intersectPlane(dragPlane, clickOnPlane);
    
    if(clickOnPlane) {
      _moveState.clickOffset.copy(clickOnPlane).sub(hitObject.position);
    }
    
    // Change cursor to grabbing
    const cursor = document.getElementById('moveCursor');
    if(cursor) cursor.textContent = event.shiftKey ? '↕️' : '✊';
    
    // Update status
    _updateMoveStatus();
  }
}

function _onMoveMouseMove(event) {
  const rect = viewerDiv.getBoundingClientRect();
  _moveState.moveMouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  _moveState.moveMouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  
  // Update cursor position
  const cursor = document.getElementById('moveCursor');
  if(cursor) {
    cursor.style.left = (event.clientX + 15) + 'px';
    cursor.style.top = (event.clientY + 15) + 'px';
  }
  
  // Update shift state while dragging
  if(_moveState.isMouseDown) {
    const wasShift = _moveState.shiftHeld;
    _moveState.shiftHeld = event.shiftKey;
    
    // If shift state changed, update the reference points
    if(wasShift !== event.shiftKey && _moveState.draggable) {
      if(event.shiftKey) {
        // Switching to Y mode - store current mouse Y as reference
        _moveState.lastMouseY = event.clientY;
        _moveState.initialY = _moveState.draggable.position.y;
      } else {
        // Switching to XZ mode - update drag plane to current Y
        _moveState.dragPlaneY = _moveState.draggable.position.y;
      }
      
      // Update cursor
      if(cursor) cursor.textContent = event.shiftKey ? '↕️' : '✊';
      _updateMoveStatus();
    }
  }
  
  if(_moveState.draggable && _moveState.isMouseDown) {
    if(_moveState.shiftHeld) {
      // SHIFT held: Move in Y axis based on mouse Y movement
      const deltaY = (_moveState.lastMouseY - event.clientY) * 0.5; // Invert and scale
      let newY = _moveState.initialY + deltaY;
      
      // Don't go below ground plane
      if(_moveState.groundBounds) {
        const objBox = new THREE.Box3().setFromObject(_moveState.draggable);
        const objHeight = objBox.max.y - objBox.min.y;
        const minY = _moveState.groundBounds.y + (objHeight / 2) + 0.1;
        newY = Math.max(minY, newY);
      }
      
      _moveState.draggable.position.y = newY;
      
      // Disable gravity permanently when object is lifted above ground
      if(newY > (_moveState.groundBounds?.y || 0) + 1) {
        _moveState.gravityDisabled = true;
      }
      
      // Reset velocity
      if(_moveState.draggable.userData.velocity) {
        _moveState.draggable.userData.velocity.y = 0;
      }
      _velocity.y = 0;
      
    } else {
      // Normal: Move in XZ plane
      _moveState.raycaster.setFromCamera(_moveState.moveMouse, camera);
      
      // Create a horizontal plane at the current object Y position
      const currentY = _moveState.draggable.position.y;
      const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -currentY);
      const intersectPoint = new THREE.Vector3();
      
      if(_moveState.raycaster.ray.intersectPlane(dragPlane, intersectPoint)) {
        // Calculate new position
        let newX = intersectPoint.x - _moveState.clickOffset.x;
        let newZ = intersectPoint.z - _moveState.clickOffset.z;
        
        // Apply bounds checking if enabled
        if(_moveState.groundBounds) {
          const bounds = _moveState.groundBounds;
          const objBox = new THREE.Box3().setFromObject(_moveState.draggable);
          const objSize = new THREE.Vector3();
          objBox.getSize(objSize);
          
          const halfWidth = objSize.x / 2;
          const halfDepth = objSize.z / 2;
          
          // Clamp to bounds
          newX = Math.max(bounds.minX + halfWidth, Math.min(bounds.maxX - halfWidth, newX));
          newZ = Math.max(bounds.minZ + halfDepth, Math.min(bounds.maxZ - halfDepth, newZ));
        }
        
        _moveState.draggable.position.x = newX;
        _moveState.draggable.position.z = newZ;
      }
    }
  }
}

function _onMoveMouseUp(event) {
  if(event.button !== 0) return; // Only left click
  _moveState.isMouseDown = false;
  _moveState.draggable = null;
  _moveState.clickOffset.set(0, 0, 0);
  _moveState.shiftHeld = false;
  
  // Change cursor back to open hand
  const cursor = document.getElementById('moveCursor');
  if(cursor) cursor.textContent = '✋';
  
  _updateMoveStatus();
}

function _updateMoveStatus() {
  const status = document.getElementById('moveStatus');
  if(!status) return;
  
  if(_moveState.isMouseDown) {
    if(_moveState.shiftHeld) {
      status.innerHTML = '<strong>↕️ VERTICAL MODE</strong> - Drag up/down to change height';
    } else {
      status.innerHTML = '<strong>✊ DRAGGING</strong> - Hold Shift for vertical movement';
    }
  } else if(_moveState.gravityDisabled) {
    status.innerHTML = 'Object floating. Press <strong>G</strong> to drop. Hold <strong>Shift</strong> + drag for vertical.';
  } else {
    status.innerHTML = 'Click and drag object. Hold <strong>Shift</strong> to move vertically.';
  }
}

// =============================================================================
// MEASURE MODE: STATE MANAGEMENT
// =============================================================================

function enterMeasureMode() {
  if(!currentObject || !_readyForCut()) return;
  if(mode === 'measure') return;
  
  // Exit other modes first
  if(mode === 'cut') exitCutMode();
  if(mode === 'move') exitMoveMode();
  
  mode = 'measure';
  _measureState.enabled = true;
  _measureState.measureType = 'distance';
  _measureState.pointA = null;
  _measureState.pointB = null;
  _measureState.areaPoints = [];
  _measureState.areaMarkers = [];
  _measureState.areaLines = [];

  // Hide scissor cursor in measure mode
  const sc = document.getElementById('scissorCursor');
  if(sc) sc.style.display = 'none';

  // Create measure UI
  _createMeasureUI();

  // Setup orbit controls for measure mode (right-click to rotate)
  if(controls && controls.dispose) controls.dispose();
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.autoRotate = false;
  controls.mouseButtons = {
    LEFT: null,           // Disable left click (we use it for measuring)
    MIDDLE: THREE.MOUSE.MIDDLE,
    RIGHT: THREE.MOUSE.ROTATE  // Right click for rotation
  };
  controls.touches = {
    ONE: null,
    TWO: null
  };
  controls.target.set(0, 0, 0);
  controls.update();

  // Add event listeners
  viewerDiv.addEventListener('click', _onMeasureClick);
  viewerDiv.addEventListener('mousemove', _onMeasureMouseMove);
  window.addEventListener('keydown', _onMeasureKeyDown);
  
  // Update sidebar button state
  _updateSidebarButtonState('Measure');
}

function exitMeasureMode() {
  if(mode !== 'measure') return;
  mode = 'default';
  _measureState.enabled = false;

  // Remove temporary markers if measurement wasn't completed
  if(_measureState.markerA && !_measureState.pointB) {
    scene.remove(_measureState.markerA);
    _measureState.markerA.geometry.dispose();
    _measureState.markerA.material.dispose();
    _measureState.markerA = null;
  }
  if(_measureState.line && !_measureState.pointB) {
    scene.remove(_measureState.line);
    _measureState.line.geometry.dispose();
    _measureState.line.material.dispose();
    _measureState.line = null;
  }

  // Clean up area measurement in progress
  _clearCurrentAreaMeasurement();

  _measureState.pointA = null;
  _measureState.pointB = null;
  _measureState.measureType = 'distance';

  // Remove measure UI
  const measurePanel = document.getElementById('measurePanel');
  if(measurePanel) measurePanel.remove();
  
  const measureCursor = document.getElementById('measureCursor');
  if(measureCursor) measureCursor.remove();

  // Remove event listeners
  viewerDiv.removeEventListener('click', _onMeasureClick);
  viewerDiv.removeEventListener('mousemove', _onMeasureMouseMove);
  window.removeEventListener('keydown', _onMeasureKeyDown);

  // Restore default orbit controls
  if(controls && controls.dispose) controls.dispose();
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.set(0, 0, 0);
  controls.update();
  
  // Update sidebar button state
  _updateSidebarButtonState(null);
}

function _createMeasureUI() {
  // Create measure cursor
  let cursor = document.getElementById('measureCursor');
  if(cursor) cursor.remove();
  cursor = document.createElement('div');
  cursor.id = 'measureCursor';
  cursor.textContent = '📏';
  cursor.style.position = 'absolute';
  cursor.style.pointerEvents = 'none';
  cursor.style.display = 'block';
  cursor.style.zIndex = '30';
  cursor.style.fontSize = '20px';
  viewerDiv.appendChild(cursor);

  // Create measure panel
  let panel = document.getElementById('measurePanel');
  if(panel) panel.remove();
  panel = document.createElement('div');
  panel.id = 'measurePanel';
  panel.innerHTML = `
    <div class="measure-title" id="measureTitle">📏 DISTANCE MODE (M)</div>
    <div class="measure-mode-toggle">
      <button id="distanceModeBtn" class="mode-btn active">Distance</button>
      <button id="areaModeBtn" class="mode-btn">Area (A)</button>
    </div>
    <div class="measure-unit-select">
      <label>Units:</label>
      <select id="unitSelect">
        <option value="mm" ${_displayUnit === 'mm' ? 'selected' : ''}>Millimeters (mm)</option>
        <option value="cm" ${_displayUnit === 'cm' ? 'selected' : ''}>Centimeters (cm)</option>
        <option value="m" ${_displayUnit === 'm' ? 'selected' : ''}>Meters (m)</option>
      </select>
    </div>
    <div class="measure-instructions" id="measureInstructions">Click two points on the model to measure distance</div>
    <div class="measure-status" id="measureStatus">Waiting for first point...</div>
    <div class="measure-distance" id="measureDistance"></div>
    <div class="measure-history" id="measureHistory"></div>
    <button id="clearMeasurementsBtn" class="measure-clear-btn">Clear All</button>
  `;
  viewerDiv.appendChild(panel);

  // Add button handlers
  document.getElementById('clearMeasurementsBtn').onclick = _clearAllMeasurements;
  document.getElementById('distanceModeBtn').onclick = () => _switchMeasureType('distance');
  document.getElementById('areaModeBtn').onclick = () => _switchMeasureType('area');
  document.getElementById('unitSelect').onchange = (e) => {
    _displayUnit = e.target.value;
    _updateMeasureHistory();
  };
}

function _onMeasureKeyDown(event) {
  if(mode !== 'measure') return;
  
  if(event.key === 'a' || event.key === 'A') {
    event.preventDefault();
    // Toggle between distance and area mode
    if(_measureState.measureType === 'distance') {
      _switchMeasureType('area');
    } else {
      _switchMeasureType('distance');
    }
  }
  
  // Escape to cancel current measurement
  if(event.key === 'Escape') {
    if(_measureState.measureType === 'area' && _measureState.areaPoints.length > 0) {
      _clearCurrentAreaMeasurement();
      const status = document.getElementById('measureStatus');
      if(status) status.textContent = 'Area measurement cancelled. Click to start new area.';
    } else if(_measureState.measureType === 'distance' && _measureState.pointA) {
      if(_measureState.markerA) {
        scene.remove(_measureState.markerA);
        _measureState.markerA.geometry.dispose();
        _measureState.markerA.material.dispose();
        _measureState.markerA = null;
      }
      if(_measureState.line) {
        scene.remove(_measureState.line);
        _measureState.line.geometry.dispose();
        _measureState.line.material.dispose();
        _measureState.line = null;
      }
      _measureState.pointA = null;
      const status = document.getElementById('measureStatus');
      if(status) status.textContent = 'Measurement cancelled. Click to start new measurement.';
    }
  }
  
  // Enter to complete area measurement
  if(event.key === 'Enter' && _measureState.measureType === 'area') {
    if(_measureState.areaPoints.length >= 3) {
      _completeAreaMeasurement();
    }
  }
}

function _switchMeasureType(type) {
  if(_measureState.measureType === type) return;
  
  // Clear any in-progress measurement
  if(_measureState.measureType === 'distance') {
    if(_measureState.markerA) {
      scene.remove(_measureState.markerA);
      _measureState.markerA.geometry.dispose();
      _measureState.markerA.material.dispose();
      _measureState.markerA = null;
    }
    if(_measureState.line) {
      scene.remove(_measureState.line);
      _measureState.line.geometry.dispose();
      _measureState.line.material.dispose();
      _measureState.line = null;
    }
    _measureState.pointA = null;
    _measureState.pointB = null;
  } else {
    _clearCurrentAreaMeasurement();
  }
  
  _measureState.measureType = type;
  
  // Update UI
  const title = document.getElementById('measureTitle');
  const instructions = document.getElementById('measureInstructions');
  const status = document.getElementById('measureStatus');
  const cursor = document.getElementById('measureCursor');
  const distanceBtn = document.getElementById('distanceModeBtn');
  const areaBtn = document.getElementById('areaModeBtn');
  const distanceDisplay = document.getElementById('measureDistance');
  
  if(type === 'distance') {
    if(title) title.textContent = '📏 DISTANCE MODE';
    if(instructions) instructions.textContent = 'Click two points on the model to measure distance';
    if(status) status.textContent = 'Waiting for first point...';
    if(cursor) cursor.textContent = '📏';
    if(distanceBtn) distanceBtn.classList.add('active');
    if(areaBtn) areaBtn.classList.remove('active');
  } else {
    if(title) title.textContent = '📐 AREA MODE';
    if(instructions) instructions.innerHTML = 'Click points to draw polygon. Press <strong>Enter</strong> to complete or click near first point.';
    if(status) status.textContent = 'Click to place first point...';
    if(cursor) cursor.textContent = '📐';
    if(distanceBtn) distanceBtn.classList.remove('active');
    if(areaBtn) areaBtn.classList.add('active');
  }
  if(distanceDisplay) distanceDisplay.innerHTML = '';
}

function _onMeasureMouseMove(event) {
  const cursor = document.getElementById('measureCursor');
  if(cursor) {
    cursor.style.left = (event.clientX + 15) + 'px';
    cursor.style.top = (event.clientY + 15) + 'px';
  }

  const rect = viewerDiv.getBoundingClientRect();
  _measureState.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  _measureState.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  _measureState.raycaster.setFromCamera(_measureState.mouse, camera);

  const objectToRaycast = (_cutState.clones && _cutState.clones.length > 0) 
    ? _cutState.clones 
    : currentObject;
  
  const intersects = _measureState.raycaster.intersectObject(objectToRaycast, true);

  if(_measureState.measureType === 'distance') {
    // Distance mode: preview line from point A to cursor
    if(_measureState.pointA && !_measureState.pointB && intersects.length > 0) {
      const hoverPoint = intersects[0].point;
      _updatePreviewLine(_measureState.pointA, hoverPoint);
    }
  } else {
    // Area mode: preview line from last point to cursor
    if(_measureState.areaPoints.length > 0 && intersects.length > 0) {
      const hoverPoint = intersects[0].point;
      const lastPoint = _measureState.areaPoints[_measureState.areaPoints.length - 1];
      _updateAreaPreviewLine(lastPoint, hoverPoint);
      
      // Update preview area display
      const previewPoints = [..._measureState.areaPoints, hoverPoint];
      if(previewPoints.length >= 3) {
        const previewArea = _calculatePolygonArea(previewPoints);
        const distanceDisplay = document.getElementById('measureDistance');
        if(distanceDisplay) {
          distanceDisplay.innerHTML = `<em>Preview: ${previewArea.toFixed(2)} sq units</em>`;
        }
      }
    }
  }
}

function _onMeasureClick(event) {
  if(event.button !== 0) return; // Only left click

  const rect = viewerDiv.getBoundingClientRect();
  _measureState.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  _measureState.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  _measureState.raycaster.setFromCamera(_measureState.mouse, camera);

  const objectToRaycast = (_cutState.clones && _cutState.clones.length > 0) 
    ? _cutState.clones 
    : currentObject;
  
  const intersects = _measureState.raycaster.intersectObject(objectToRaycast, true);

  if(intersects.length > 0) {
    const clickPoint = intersects[0].point.clone();

    if(_measureState.measureType === 'distance') {
      _handleDistanceClick(clickPoint);
    } else {
      _handleAreaClick(clickPoint);
    }
  }
}

function _handleDistanceClick(clickPoint) {
  if(!_measureState.pointA) {
    // First point
    _measureState.pointA = clickPoint;
    _measureState.markerA = _createMeasureMarker(clickPoint, 0x00ff88);
    scene.add(_measureState.markerA);
    
    const status = document.getElementById('measureStatus');
    if(status) status.textContent = 'Click second point to measure...';
  } else {
    // Second point - complete measurement
    _measureState.pointB = clickPoint;
    _measureState.markerB = _createMeasureMarker(clickPoint, 0xff8800);
    scene.add(_measureState.markerB);

    // Calculate distance
    const distance = _measureState.pointA.distanceTo(_measureState.pointB);

    // Create permanent line
    const lineGeometry = new THREE.BufferGeometry().setFromPoints([
      _measureState.pointA,
      _measureState.pointB
    ]);
    const lineMaterial = new THREE.LineBasicMaterial({ 
      color: 0xffff00,
      linewidth: 2
    });
    const permanentLine = new THREE.Line(lineGeometry, lineMaterial);
    scene.add(permanentLine);

    // Remove preview line if exists
    if(_measureState.line) {
      scene.remove(_measureState.line);
      _measureState.line.geometry.dispose();
      _measureState.line.material.dispose();
      _measureState.line = null;
    }

    // Store measurement
    const measurement = {
      type: 'distance',
      markerA: _measureState.markerA,
      markerB: _measureState.markerB,
      line: permanentLine,
      distance: distance,
      pointA: _measureState.pointA.clone(),
      pointB: _measureState.pointB.clone()
    };
    _measureState.measurements.push(measurement);

    // Update UI with converted units
    const converted = convertDistance(distance, _displayUnit);
    const distanceDisplay = document.getElementById('measureDistance');
    if(distanceDisplay) {
      distanceDisplay.innerHTML = `<strong>Distance: ${formatMeasurement(converted.value, converted.unit)}</strong>`;
    }

    const status = document.getElementById('measureStatus');
    if(status) status.textContent = 'Measurement complete! Click to start new measurement.';

    // Update history
    _updateMeasureHistory();

    // Reset for next measurement
    _measureState.pointA = null;
    _measureState.pointB = null;
    _measureState.markerA = null;
    _measureState.markerB = null;
  }
}

function _handleAreaClick(clickPoint) {
  const status = document.getElementById('measureStatus');
  
  // Check if clicking near the first point to close the polygon
  if(_measureState.areaPoints.length >= 3) {
    const firstPoint = _measureState.areaPoints[0];
    const distToFirst = clickPoint.distanceTo(firstPoint);
    
    // If close enough to first point, complete the area
    if(distToFirst < 3) {
      _completeAreaMeasurement();
      return;
    }
  }
  
  // Add new point
  _measureState.areaPoints.push(clickPoint);
  
  // Create marker for this point
  const markerColor = _measureState.areaPoints.length === 1 ? 0x00ff88 : 0x00aaff;
  const marker = _createMeasureMarker(clickPoint, markerColor);
  scene.add(marker);
  _measureState.areaMarkers.push(marker);
  
  // Create line from previous point to this point
  if(_measureState.areaPoints.length > 1) {
    const prevPoint = _measureState.areaPoints[_measureState.areaPoints.length - 2];
    const lineGeometry = new THREE.BufferGeometry().setFromPoints([prevPoint, clickPoint]);
    const lineMaterial = new THREE.LineBasicMaterial({ color: 0x00ffff, linewidth: 2 });
    const line = new THREE.Line(lineGeometry, lineMaterial);
    scene.add(line);
    _measureState.areaLines.push(line);
  }
  
  // Update status
  const pointCount = _measureState.areaPoints.length;
  if(status) {
    if(pointCount < 3) {
      status.textContent = `${pointCount} point${pointCount > 1 ? 's' : ''} placed. Need at least 3 points for area.`;
    } else {
      status.textContent = `${pointCount} points. Press Enter or click near first point (green) to complete.`;
    }
  }
  
  // Update preview mesh
  if(_measureState.areaPoints.length >= 3) {
    _updateAreaPreviewMesh();
  }
}

function _completeAreaMeasurement() {
  if(_measureState.areaPoints.length < 3) return;
  
  // Remove preview line
  if(_measureState.previewLine) {
    scene.remove(_measureState.previewLine);
    _measureState.previewLine.geometry.dispose();
    _measureState.previewLine.material.dispose();
    _measureState.previewLine = null;
  }
  
  // Create closing line from last point to first point
  const firstPoint = _measureState.areaPoints[0];
  const lastPoint = _measureState.areaPoints[_measureState.areaPoints.length - 1];
  const closingLineGeometry = new THREE.BufferGeometry().setFromPoints([lastPoint, firstPoint]);
  const closingLineMaterial = new THREE.LineBasicMaterial({ color: 0x00ffff, linewidth: 2 });
  const closingLine = new THREE.Line(closingLineGeometry, closingLineMaterial);
  scene.add(closingLine);
  _measureState.areaLines.push(closingLine);
  
  // Calculate area
  const area = _calculatePolygonArea(_measureState.areaPoints);
  
  // Create permanent filled mesh
  const areaMesh = _createAreaMesh(_measureState.areaPoints, 0x00ffaa, 0.4);
  if(areaMesh) {
    scene.add(areaMesh);
  }
  
  // Store the completed area measurement
  const areaResult = {
    type: 'area',
    markers: [..._measureState.areaMarkers],
    lines: [..._measureState.areaLines],
    mesh: areaMesh,
    area: area,
    points: _measureState.areaPoints.map(p => p.clone())
  };
  _measureState.areaResults.push(areaResult);
  _measureState.measurements.push(areaResult);
  
  // Update UI with converted units
  const converted = convertArea(area, _displayUnit);
  const distanceDisplay = document.getElementById('measureDistance');
  if(distanceDisplay) {
    distanceDisplay.innerHTML = `<strong>Area: ${formatMeasurement(converted.value, converted.unit)}</strong>`;
  }
  
  const status = document.getElementById('measureStatus');
  if(status) status.textContent = 'Area complete! Click to start new area measurement.';
  
  // Update history
  _updateMeasureHistory();
  
  // Reset for next measurement (but keep the visuals)
  _measureState.areaPoints = [];
  _measureState.areaMarkers = [];
  _measureState.areaLines = [];
  _measureState.areaMesh = null;
}

function _updateAreaPreviewLine(fromPoint, toPoint) {
  if(_measureState.previewLine) {
    scene.remove(_measureState.previewLine);
    _measureState.previewLine.geometry.dispose();
    _measureState.previewLine.material.dispose();
  }
  
  const geometry = new THREE.BufferGeometry().setFromPoints([fromPoint, toPoint]);
  const material = new THREE.LineDashedMaterial({ 
    color: 0x00ffff,
    dashSize: 2,
    gapSize: 1
  });
  _measureState.previewLine = new THREE.Line(geometry, material);
  _measureState.previewLine.computeLineDistances();
  scene.add(_measureState.previewLine);
}

function _updateAreaPreviewMesh() {
  // Remove old preview mesh
  if(_measureState.areaMesh) {
    scene.remove(_measureState.areaMesh);
    _measureState.areaMesh.geometry.dispose();
    _measureState.areaMesh.material.dispose();
    _measureState.areaMesh = null;
  }
  
  // Create new preview mesh
  _measureState.areaMesh = _createAreaMesh(_measureState.areaPoints, 0x00ffaa, 0.2);
  if(_measureState.areaMesh) {
    scene.add(_measureState.areaMesh);
  }
}

function _createAreaMesh(points, color, opacity) {
  if(points.length < 3) return null;
  
  // Create a shape from the points by projecting onto a best-fit plane
  const center = new THREE.Vector3();
  points.forEach(p => center.add(p));
  center.divideScalar(points.length);
  
  // Calculate normal using first 3 points
  const v1 = new THREE.Vector3().subVectors(points[1], points[0]);
  const v2 = new THREE.Vector3().subVectors(points[2], points[0]);
  const normal = new THREE.Vector3().crossVectors(v1, v2).normalize();
  
  // Create basis vectors for the plane
  const up = new THREE.Vector3(0, 1, 0);
  let tangent = new THREE.Vector3().crossVectors(normal, up);
  if(tangent.length() < 0.001) {
    tangent = new THREE.Vector3().crossVectors(normal, new THREE.Vector3(1, 0, 0));
  }
  tangent.normalize();
  const bitangent = new THREE.Vector3().crossVectors(normal, tangent).normalize();
  
  // Project points onto 2D plane
  const points2D = points.map(p => {
    const relative = new THREE.Vector3().subVectors(p, center);
    return new THREE.Vector2(
      relative.dot(tangent),
      relative.dot(bitangent)
    );
  });
  
  // Create shape
  const shape = new THREE.Shape();
  shape.moveTo(points2D[0].x, points2D[0].y);
  for(let i = 1; i < points2D.length; i++) {
    shape.lineTo(points2D[i].x, points2D[i].y);
  }
  shape.closePath();
  
  // Create geometry
  const geometry = new THREE.ShapeGeometry(shape);
  
  // Transform vertices back to 3D
  const positions = geometry.attributes.position;
  for(let i = 0; i < positions.count; i++) {
    const x2d = positions.getX(i);
    const y2d = positions.getY(i);
    
    const pos3d = center.clone()
      .addScaledVector(tangent, x2d)
      .addScaledVector(bitangent, y2d);
    
    positions.setXYZ(i, pos3d.x, pos3d.y, pos3d.z);
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  
  // Create material
  const material = new THREE.MeshBasicMaterial({
    color: color,
    transparent: true,
    opacity: opacity,
    side: THREE.DoubleSide,
    depthWrite: false
  });
  
  return new THREE.Mesh(geometry, material);
}

function _calculatePolygonArea(points) {
  if(points.length < 3) return 0;
  
  // Use the Shoelace formula adapted for 3D
  // First, find the best-fit plane and project points
  const center = new THREE.Vector3();
  points.forEach(p => center.add(p));
  center.divideScalar(points.length);
  
  // Calculate normal using first 3 points
  const v1 = new THREE.Vector3().subVectors(points[1], points[0]);
  const v2 = new THREE.Vector3().subVectors(points[2], points[0]);
  const normal = new THREE.Vector3().crossVectors(v1, v2).normalize();
  
  // Create basis vectors for the plane
  const up = new THREE.Vector3(0, 1, 0);
  let tangent = new THREE.Vector3().crossVectors(normal, up);
  if(tangent.length() < 0.001) {
    tangent = new THREE.Vector3().crossVectors(normal, new THREE.Vector3(1, 0, 0));
  }
  tangent.normalize();
  const bitangent = new THREE.Vector3().crossVectors(normal, tangent).normalize();
  
  // Project points onto 2D plane
  const points2D = points.map(p => {
    const relative = new THREE.Vector3().subVectors(p, center);
    return {
      x: relative.dot(tangent),
      y: relative.dot(bitangent)
    };
  });
  
  // Shoelace formula
  let area = 0;
  const n = points2D.length;
  for(let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += points2D[i].x * points2D[j].y;
    area -= points2D[j].x * points2D[i].y;
  }
  
  return Math.abs(area) / 2;
}

function _clearCurrentAreaMeasurement() {
  // Remove markers
  _measureState.areaMarkers.forEach(m => {
    scene.remove(m);
    m.geometry.dispose();
    m.material.dispose();
  });
  _measureState.areaMarkers = [];
  
  // Remove lines
  _measureState.areaLines.forEach(l => {
    scene.remove(l);
    l.geometry.dispose();
    l.material.dispose();
  });
  _measureState.areaLines = [];
  
  // Remove preview line
  if(_measureState.previewLine) {
    scene.remove(_measureState.previewLine);
    _measureState.previewLine.geometry.dispose();
    _measureState.previewLine.material.dispose();
    _measureState.previewLine = null;
  }
  
  // Remove preview mesh
  if(_measureState.areaMesh) {
    scene.remove(_measureState.areaMesh);
    _measureState.areaMesh.geometry.dispose();
    _measureState.areaMesh.material.dispose();
    _measureState.areaMesh = null;
  }
  
  _measureState.areaPoints = [];
}

function _createMeasureMarker(position, color) {
  const geometry = new THREE.SphereGeometry(1.5, 16, 16);
  const material = new THREE.MeshBasicMaterial({ color: color });
  const marker = new THREE.Mesh(geometry, material);
  marker.position.copy(position);
  return marker;
}

function _updatePreviewLine(pointA, pointB) {
  if(_measureState.line) {
    scene.remove(_measureState.line);
    _measureState.line.geometry.dispose();
    _measureState.line.material.dispose();
  }

  const geometry = new THREE.BufferGeometry().setFromPoints([pointA, pointB]);
  const material = new THREE.LineDashedMaterial({ 
    color: 0xffff00,
    dashSize: 2,
    gapSize: 1
  });
  _measureState.line = new THREE.Line(geometry, material);
  _measureState.line.computeLineDistances();
  scene.add(_measureState.line);

  // Show preview distance with unit conversion
  const distance = pointA.distanceTo(pointB);
  const converted = convertDistance(distance, _displayUnit);
  const distanceDisplay = document.getElementById('measureDistance');
  if(distanceDisplay) {
    distanceDisplay.innerHTML = `<em>Preview: ${formatMeasurement(converted.value, converted.unit)}</em>`;
  }
}

function _updateMeasureHistory() {
  const history = document.getElementById('measureHistory');
  if(!history) return;

  if(_measureState.measurements.length === 0) {
    history.innerHTML = '';
    return;
  }

  let html = '<div class="measure-history-title">Measurements:</div>';
  _measureState.measurements.forEach((m, i) => {
    if(m.type === 'area') {
      const converted = convertArea(m.area, _displayUnit);
      html += `<div class="measure-history-item area-item">#${i + 1}: 📐 ${formatMeasurement(converted.value, converted.unit)}</div>`;
    } else {
      const converted = convertDistance(m.distance, _displayUnit);
      html += `<div class="measure-history-item">#${i + 1}: 📏 ${formatMeasurement(converted.value, converted.unit)}</div>`;
    }
  });
  history.innerHTML = html;
}

function _clearAllMeasurements() {
  // Remove all measurement visuals from scene
  _measureState.measurements.forEach(m => {
    if(m.type === 'area') {
      // Clear area measurement
      if(m.markers) {
        m.markers.forEach(marker => {
          scene.remove(marker);
          marker.geometry.dispose();
          marker.material.dispose();
        });
      }
      if(m.lines) {
        m.lines.forEach(line => {
          scene.remove(line);
          line.geometry.dispose();
          line.material.dispose();
        });
      }
      if(m.mesh) {
        scene.remove(m.mesh);
        m.mesh.geometry.dispose();
        m.mesh.material.dispose();
      }
    } else {
      // Clear distance measurement
      if(m.markerA) {
        scene.remove(m.markerA);
        m.markerA.geometry.dispose();
        m.markerA.material.dispose();
      }
      if(m.markerB) {
        scene.remove(m.markerB);
        m.markerB.geometry.dispose();
        m.markerB.material.dispose();
      }
      if(m.line) {
        scene.remove(m.line);
        m.line.geometry.dispose();
        m.line.material.dispose();
      }
    }
  });
  _measureState.measurements = [];
  _measureState.areaResults = [];

  // Clear current distance measurement in progress
  if(_measureState.markerA) {
    scene.remove(_measureState.markerA);
    _measureState.markerA.geometry.dispose();
    _measureState.markerA.material.dispose();
    _measureState.markerA = null;
  }
  if(_measureState.line) {
    scene.remove(_measureState.line);
    _measureState.line.geometry.dispose();
    _measureState.line.material.dispose();
    _measureState.line = null;
  }
  _measureState.pointA = null;
  _measureState.pointB = null;

  // Clear current area measurement in progress
  _clearCurrentAreaMeasurement();

  // Update UI
  const distanceDisplay = document.getElementById('measureDistance');
  if(distanceDisplay) distanceDisplay.innerHTML = '';
  
  const status = document.getElementById('measureStatus');
  if(status) {
    if(_measureState.measureType === 'distance') {
      status.textContent = 'Waiting for first point...';
    } else {
      status.textContent = 'Click to place first point...';
    }
  }
  
  _updateMeasureHistory();
}

function _updateSidebarButtonState(activeTool) {
  const buttons = document.querySelectorAll('#leftSidebar .sidebar-btn');
  buttons.forEach(btn => {
    if(btn.textContent === activeTool) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
}

// =============================================================================
// SLICE MODE: REAL MESH CUTTING WITH CAPPED FACES
// =============================================================================

function enterSliceMode() {
  if(!currentObject || !_readyForCut()) return;
  if(mode === 'slice') return;
  
  // Exit other modes first
  if(mode === 'cut') exitCutMode();
  if(mode === 'move') exitMoveMode();
  if(mode === 'measure') exitMeasureMode();
  
  mode = 'slice';
  _sliceState.enabled = true;
  _sliceState.dragging = false;
  _sliceState.startPoint = null;
  _sliceState.endPoint = null;

  // Create slice UI
  _createSliceUI();

  // Setup orbit controls for slice mode (right-click to rotate)
  if(controls && controls.dispose) controls.dispose();
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.mouseButtons = {
    LEFT: null,
    MIDDLE: THREE.MOUSE.MIDDLE,
    RIGHT: THREE.MOUSE.ROTATE
  };
  controls.target.set(0, 0, 0);
  controls.update();

  // Add event listeners
  viewerDiv.addEventListener('pointerdown', _onSlicePointerDown);
  viewerDiv.addEventListener('pointermove', _onSlicePointerMove);
  window.addEventListener('pointerup', _onSlicePointerUp);
  
  _updateSidebarButtonState('Cut');
}

function exitSliceMode() {
  if(mode !== 'slice') return;
  mode = 'default';
  _sliceState.enabled = false;

  // Remove slice UI
  const slicePanel = document.getElementById('slicePanel');
  if(slicePanel) slicePanel.remove();
  
  const sliceCursor = document.getElementById('sliceCursor');
  if(sliceCursor) sliceCursor.remove();
  
  const sliceLineSvg = document.getElementById('sliceLineSvg');
  if(sliceLineSvg) sliceLineSvg.remove();

  // Remove event listeners
  viewerDiv.removeEventListener('pointerdown', _onSlicePointerDown);
  viewerDiv.removeEventListener('pointermove', _onSlicePointerMove);
  window.removeEventListener('pointerup', _onSlicePointerUp);

  // Restore default orbit controls
  if(controls && controls.dispose) controls.dispose();
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.set(0, 0, 0);
  controls.update();
  
  _updateSidebarButtonState(null);
}

function _createSliceUI() {
  // Create slice cursor
  let cursor = document.getElementById('sliceCursor');
  if(cursor) cursor.remove();
  cursor = document.createElement('div');
  cursor.id = 'sliceCursor';
  cursor.textContent = '🔪';
  cursor.style.position = 'absolute';
  cursor.style.pointerEvents = 'none';
  cursor.style.display = 'block';
  cursor.style.zIndex = '30';
  cursor.style.fontSize = '24px';
  viewerDiv.appendChild(cursor);

  // Create slice line SVG
  let svg = document.getElementById('sliceLineSvg');
  if(svg) svg.remove();
  svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('id', 'sliceLineSvg');
  svg.style.position = 'absolute';
  svg.style.left = '0';
  svg.style.top = '0';
  svg.style.width = '100%';
  svg.style.height = '100%';
  svg.style.pointerEvents = 'none';
  svg.style.zIndex = '29';
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  line.setAttribute('id', 'sliceLine');
  line.setAttribute('stroke', 'rgba(255, 100, 100, 0.9)');
  line.setAttribute('stroke-width', '3');
  line.setAttribute('stroke-dasharray', '10,5');
  line.setAttribute('visibility', 'hidden');
  svg.appendChild(line);
  viewerDiv.appendChild(svg);

  // Create slice panel
  let panel = document.getElementById('slicePanel');
  if(panel) panel.remove();
  panel = document.createElement('div');
  panel.id = 'slicePanel';
  panel.innerHTML = `
    <div class="slice-title">🔪 SLICE MODE (C)</div>
    <div class="slice-instructions">Draw a line across the model to slice it into two pieces</div>
    <div class="slice-status" id="sliceStatus">Click and drag to draw slice line...</div>
    <div class="slice-count" id="sliceCount">Pieces: 1</div>
    <button id="resetSliceBtn" class="slice-reset-btn">Reset Model</button>
  `;
  viewerDiv.appendChild(panel);

  document.getElementById('resetSliceBtn').onclick = _resetSlicedModel;
  _updateSliceCount();
}

function _onSlicePointerMove(event) {
  const cursor = document.getElementById('sliceCursor');
  if(cursor) {
    cursor.style.left = (event.clientX + 15) + 'px';
    cursor.style.top = (event.clientY + 15) + 'px';
  }

  if(!_sliceState.dragging) return;
  
  const line = document.getElementById('sliceLine');
  if(!line) return;
  
  line.setAttribute('x1', _sliceState.startClientX);
  line.setAttribute('y1', _sliceState.startClientY);
  line.setAttribute('x2', event.clientX);
  line.setAttribute('y2', event.clientY);
  line.setAttribute('visibility', 'visible');
  
  // Update end point
  _updateSliceRaycastPoint(event, point => { _sliceState.endPoint = point; });
}

function _onSlicePointerDown(event) {
  if(event.button !== 0) return;
  
  _sliceState.dragging = true;
  _sliceState.startClientX = event.clientX;
  _sliceState.startClientY = event.clientY;
  
  _updateSliceRaycastPoint(event, point => { _sliceState.startPoint = point; });
  
  const status = document.getElementById('sliceStatus');
  if(status) status.textContent = 'Drawing slice line...';
}

function _onSlicePointerUp(event) {
  if(!_sliceState.dragging) return;
  _sliceState.dragging = false;
  
  const line = document.getElementById('sliceLine');
  if(line) line.setAttribute('visibility', 'hidden');
  
  if(_sliceState.startPoint && _sliceState.endPoint) {
    const status = document.getElementById('sliceStatus');
    if(status) status.textContent = 'Slicing...';
    
    // Perform the actual slice
    _performRealSlice(_sliceState.startPoint, _sliceState.endPoint);
    
    if(status) status.textContent = 'Slice complete! Draw another line to slice again.';
  }
  
  _sliceState.startPoint = null;
  _sliceState.endPoint = null;
}

function _updateSliceRaycastPoint(event, callback) {
  if(!scene || !camera) return callback(null);
  
  const rect = viewerDiv.getBoundingClientRect();
  _sliceState.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  _sliceState.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  _sliceState.raycaster.setFromCamera(_sliceState.mouse, camera);
  
  // Get objects to raycast against
  const objectsToCheck = _sliceState.slicedPieces.length > 0 
    ? _sliceState.slicedPieces 
    : (currentObject ? [currentObject] : []);
  
  let closestIntersect = null;
  let closestDistance = Infinity;
  
  objectsToCheck.forEach(obj => {
    const intersects = _sliceState.raycaster.intersectObject(obj, true);
    if(intersects.length > 0 && intersects[0].distance < closestDistance) {
      closestDistance = intersects[0].distance;
      closestIntersect = intersects[0];
    }
  });
  
  if(closestIntersect) {
    callback(closestIntersect.point.clone());
  } else {
    // If no hit, project onto a plane at object center
    const targetObj = objectsToCheck[0] || currentObject;
    if(targetObj) {
      const box = new THREE.Box3().setFromObject(targetObj);
      const center = new THREE.Vector3();
      box.getCenter(center);
      
      const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1).applyQuaternion(camera.quaternion), -center.dot(new THREE.Vector3(0, 0, 1).applyQuaternion(camera.quaternion)));
      const point = new THREE.Vector3();
      _sliceState.raycaster.ray.intersectPlane(plane, point);
      if(point) callback(point);
    }
  }
}

function _performRealSlice(startPoint, endPoint) {
  if(!startPoint || !endPoint) return;
  
  // Get the objects to slice
  const objectsToSlice = _sliceState.slicedPieces.length > 0 
    ? [..._sliceState.slicedPieces]
    : [currentObject];
  
  // Calculate the slice plane
  const sliceDir = new THREE.Vector3().subVectors(endPoint, startPoint).normalize();
  const camDir = new THREE.Vector3();
  camera.getWorldDirection(camDir);
  
  // Normal is perpendicular to both slice direction and camera direction
  const planeNormal = new THREE.Vector3().crossVectors(sliceDir, camDir).normalize();
  if(planeNormal.length() < 0.001) return;
  
  // Create the cutting plane
  const midPoint = new THREE.Vector3().addVectors(startPoint, endPoint).multiplyScalar(0.5);
  const slicePlane = new THREE.Plane().setFromNormalAndCoplanarPoint(planeNormal, midPoint);
  
  // Clear old sliced pieces
  _sliceState.slicedPieces.forEach(piece => {
    scene.remove(piece);
  });
  _sliceState.slicedPieces = [];
  
  // Hide original object
  if(currentObject) currentObject.visible = false;
  
  // Slice each object
  const newPieces = [];
  objectsToSlice.forEach(obj => {
    const pieces = _sliceMesh(obj, slicePlane);
    pieces.forEach(piece => {
      scene.add(piece);
      newPieces.push(piece);
    });
  });
  
  _sliceState.slicedPieces = newPieces;
  
  // Separate the pieces slightly
  if(newPieces.length >= 2) {
    const separation = 2;
    newPieces.forEach((piece, index) => {
      const direction = index % 2 === 0 ? 1 : -1;
      piece.position.addScaledVector(planeNormal, separation * direction);
    });
  }
  
  _updateSliceCount();
}

function _sliceMesh(object, plane) {
  const results = [];
  
  object.traverse(child => {
    if(child.isMesh && child.geometry) {
      const sliced = _sliceGeometry(child, plane);
      results.push(...sliced);
    }
  });
  
  return results;
}

function _sliceGeometry(mesh, plane) {
  const geometry = mesh.geometry.clone();
  geometry.applyMatrix4(mesh.matrixWorld);
  
  if(!geometry.index) {
    geometry.setIndex([...Array(geometry.attributes.position.count).keys()]);
  }
  
  const positions = geometry.attributes.position;
  const indices = geometry.index.array;
  
  // Classify vertices
  const vertexSides = [];
  for(let i = 0; i < positions.count; i++) {
    const v = new THREE.Vector3(
      positions.getX(i),
      positions.getY(i),
      positions.getZ(i)
    );
    vertexSides[i] = plane.distanceToPoint(v);
  }
  
  // Build triangles for each side
  const trianglesA = [];
  const trianglesB = [];
  const edgeCuts = new Map(); // Store intersection points for cap generation
  const capPointsA = [];
  const capPointsB = [];
  
  for(let i = 0; i < indices.length; i += 3) {
    const i0 = indices[i];
    const i1 = indices[i + 1];
    const i2 = indices[i + 2];
    
    const d0 = vertexSides[i0];
    const d1 = vertexSides[i1];
    const d2 = vertexSides[i2];
    
    const v0 = new THREE.Vector3(positions.getX(i0), positions.getY(i0), positions.getZ(i0));
    const v1 = new THREE.Vector3(positions.getX(i1), positions.getY(i1), positions.getZ(i1));
    const v2 = new THREE.Vector3(positions.getX(i2), positions.getY(i2), positions.getZ(i2));
    
    const s0 = d0 >= 0;
    const s1 = d1 >= 0;
    const s2 = d2 >= 0;
    
    // All on one side
    if(s0 === s1 && s1 === s2) {
      if(s0) {
        trianglesA.push(v0, v1, v2);
      } else {
        trianglesB.push(v0, v1, v2);
      }
      continue;
    }
    
    // Triangle crosses the plane - need to split it
    const verts = [v0, v1, v2];
    const dists = [d0, d1, d2];
    const sides = [s0, s1, s2];
    
    // Find the lone vertex
    let loneIdx;
    if(s0 !== s1 && s0 !== s2) loneIdx = 0;
    else if(s1 !== s0 && s1 !== s2) loneIdx = 1;
    else loneIdx = 2;
    
    const lone = verts[loneIdx];
    const other1 = verts[(loneIdx + 1) % 3];
    const other2 = verts[(loneIdx + 2) % 3];
    const loneDist = dists[loneIdx];
    const dist1 = dists[(loneIdx + 1) % 3];
    const dist2 = dists[(loneIdx + 2) % 3];
    
    // Calculate intersection points
    const t1 = loneDist / (loneDist - dist1);
    const t2 = loneDist / (loneDist - dist2);
    
    const int1 = new THREE.Vector3().lerpVectors(lone, other1, t1);
    const int2 = new THREE.Vector3().lerpVectors(lone, other2, t2);
    
    // Store cap edge points
    capPointsA.push(int1.clone(), int2.clone());
    capPointsB.push(int1.clone(), int2.clone());
    
    // Create triangles
    if(sides[loneIdx]) {
      // Lone vertex is on side A
      trianglesA.push(lone.clone(), int1.clone(), int2.clone());
      trianglesB.push(int1.clone(), other1.clone(), other2.clone());
      trianglesB.push(int1.clone(), other2.clone(), int2.clone());
    } else {
      // Lone vertex is on side B
      trianglesB.push(lone.clone(), int1.clone(), int2.clone());
      trianglesA.push(int1.clone(), other1.clone(), other2.clone());
      trianglesA.push(int1.clone(), other2.clone(), int2.clone());
    }
  }
  
  const meshes = [];
  
  // Create mesh A
  if(trianglesA.length >= 3) {
    const geoA = _createGeometryFromTriangles(trianglesA);
    
    // Add cap to side A
    if(capPointsA.length >= 4) {
      _addCapToGeometry(geoA, capPointsA, plane.normal.clone().negate());
    }
    
    geoA.computeVertexNormals();
    
    const matA = new THREE.MeshStandardMaterial({
      color: 0xcc4444,
      roughness: 0.6,
      metalness: 0.1,
      side: THREE.DoubleSide
    });
    
    const meshA = new THREE.Mesh(geoA, matA);
    meshA.castShadow = true;
    meshA.receiveShadow = true;
    meshes.push(meshA);
  }
  
  // Create mesh B
  if(trianglesB.length >= 3) {
    const geoB = _createGeometryFromTriangles(trianglesB);
    
    // Add cap to side B
    if(capPointsB.length >= 4) {
      _addCapToGeometry(geoB, capPointsB, plane.normal.clone());
    }
    
    geoB.computeVertexNormals();
    
    const matB = new THREE.MeshStandardMaterial({
      color: 0xcc4444,
      roughness: 0.6,
      metalness: 0.1,
      side: THREE.DoubleSide
    });
    
    const meshB = new THREE.Mesh(geoB, matB);
    meshB.castShadow = true;
    meshB.receiveShadow = true;
    meshes.push(meshB);
  }
  
  return meshes;
}

function _createGeometryFromTriangles(triangles) {
  const positions = [];
  triangles.forEach(v => {
    positions.push(v.x, v.y, v.z);
  });
  
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  
  return geometry;
}

function _addCapToGeometry(geometry, capPoints, normal) {
  if(capPoints.length < 4) return;
  
  // Find center of cap points
  const center = new THREE.Vector3();
  capPoints.forEach(p => center.add(p));
  center.divideScalar(capPoints.length);
  
  // Sort points around center to form a proper polygon
  const sortedPoints = _sortPointsAroundCenter(capPoints, center, normal);
  
  if(sortedPoints.length < 3) return;
  
  // Create fan triangulation from center
  const capTriangles = [];
  for(let i = 0; i < sortedPoints.length; i++) {
    const next = (i + 1) % sortedPoints.length;
    capTriangles.push(
      center.x, center.y, center.z,
      sortedPoints[i].x, sortedPoints[i].y, sortedPoints[i].z,
      sortedPoints[next].x, sortedPoints[next].y, sortedPoints[next].z
    );
  }
  
  // Merge with existing geometry
  const existingPositions = geometry.attributes.position.array;
  const newPositions = new Float32Array(existingPositions.length + capTriangles.length);
  newPositions.set(existingPositions);
  newPositions.set(capTriangles, existingPositions.length);
  
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(newPositions, 3));
}

function _sortPointsAroundCenter(points, center, normal) {
  // Remove duplicates
  const uniquePoints = [];
  const threshold = 0.01;
  
  points.forEach(p => {
    let isDuplicate = false;
    for(const up of uniquePoints) {
      if(p.distanceTo(up) < threshold) {
        isDuplicate = true;
        break;
      }
    }
    if(!isDuplicate) uniquePoints.push(p.clone());
  });
  
  if(uniquePoints.length < 3) return uniquePoints;
  
  // Create local coordinate system on the cap plane
  const up = new THREE.Vector3(0, 1, 0);
  let tangent = new THREE.Vector3().crossVectors(normal, up);
  if(tangent.length() < 0.001) {
    tangent = new THREE.Vector3().crossVectors(normal, new THREE.Vector3(1, 0, 0));
  }
  tangent.normalize();
  const bitangent = new THREE.Vector3().crossVectors(normal, tangent).normalize();
  
  // Calculate angles
  const pointsWithAngles = uniquePoints.map(p => {
    const relative = new THREE.Vector3().subVectors(p, center);
    const x = relative.dot(tangent);
    const y = relative.dot(bitangent);
    const angle = Math.atan2(y, x);
    return { point: p, angle: angle };
  });
  
  // Sort by angle
  pointsWithAngles.sort((a, b) => a.angle - b.angle);
  
  return pointsWithAngles.map(pa => pa.point);
}

function _updateSliceCount() {
  const countEl = document.getElementById('sliceCount');
  if(countEl) {
    const count = _sliceState.slicedPieces.length || 1;
    countEl.textContent = `Pieces: ${count}`;
  }
}

async function _resetSlicedModel() {
  // Remove sliced pieces
  _sliceState.slicedPieces.forEach(piece => {
    scene.remove(piece);
    if(piece.geometry) piece.geometry.dispose();
    if(piece.material) piece.material.dispose();
  });
  _sliceState.slicedPieces = [];
  
  // Show and reload original object
  if(currentObject) {
    currentObject.visible = true;
  }
  
  // Reload the model fresh
  if(currentModelName) {
    await _reloadCurrentModel();
  }
  
  _updateSliceCount();
  
  const status = document.getElementById('sliceStatus');
  if(status) status.textContent = 'Model reset. Draw a line to slice.';
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
  if(sc) sc.style.display = 'block';
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
  
  // Skip gravity if manually disabled (object was lifted)
  if(_moveState.gravityDisabled) {
    _updateBoundingBoxVisualization();
    return;
  }
  
  const planeY = _cutState.plane.position.y;
  
  // Handle sliced pieces physics
  if(_sliceState.slicedPieces && _sliceState.slicedPieces.length > 0) {
    _sliceState.slicedPieces.forEach(piece => {
      // Initialize velocity for each piece if not set
      if(!piece.userData.velocity) {
        piece.userData.velocity = new THREE.Vector3(0, 0, 0);
      }
      
      piece.userData.velocity.y += GRAVITY * delta;
      piece.position.y += piece.userData.velocity.y * delta;

      const box = new THREE.Box3().setFromObject(piece);
      
      if(box.min.y < planeY){
        const offset = planeY - box.min.y;
        piece.position.y += offset;
        piece.userData.velocity.y = 0;
      }
    });
  }
  // If we have cut clones, apply physics to them instead of original
  else if(_cutState.clones && _cutState.clones.length > 0) {
    _cutState.clones.forEach(clone => {
      _velocity.y += GRAVITY * delta;
      clone.position.y += _velocity.y * delta;

      const box = new THREE.Box3().setFromObject(clone);
      
      if(box.min.y < planeY){
        const offset = planeY - box.min.y;
        clone.position.y += offset;
        _velocity.y = 0;
      }
    });
  } else if(currentObject && currentObject.visible) {
    // Apply physics to original object if no cuts yet (in move, default, or cut modes)
    _velocity.y += GRAVITY * delta;
    currentObject.position.y += _velocity.y * delta;

    const box = new THREE.Box3().setFromObject(currentObject);
    
    if(box.min.y < planeY){
      const offset = planeY - box.min.y;
      currentObject.position.y += offset;
      _velocity.y = 0;
    }
  }

  if(mode === 'cut') {
    _constrainToBounds();
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
// GLOBAL KEYBOARD SHORTCUTS
// =============================================================================

function _onGlobalKeyDown(event) {
  // Don't trigger shortcuts if typing in an input field
  if(event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') return;
  
  if(event.key === 'm' || event.key === 'M') {
    event.preventDefault();
    if(mode === 'measure') {
      exitMeasureMode();
    } else {
      enterMeasureMode();
    }
  }
  
  if(event.key === 'c' || event.key === 'C') {
    event.preventDefault();
    if(mode === 'slice') {
      exitSliceMode();
    } else {
      enterSliceMode();
    }
  }
  
  if(event.key === 'v' || event.key === 'V') {
    event.preventDefault();
    if(mode === 'move') {
      exitMoveMode();
    } else {
      enterMoveMode();
    }
  }
  
  // Escape to exit any mode
  if(event.key === 'Escape') {
    if(mode === 'move') exitMoveMode();
    else if(mode === 'slice') exitSliceMode();
    else if(mode === 'cut') exitCutMode();
    // Measure mode handles its own Escape
  }
}

// =============================================================================
// FILE UPLOAD PANEL (Sidebar UI)
// =============================================================================

let _uploadPanelOpen = false;

function createUploadPanel() {
  const panel = document.createElement('div');
  panel.id = 'uploadPanel';
  panel.className = 'upload-panel';
  panel.innerHTML = `
    <div class="panel-header">
      <h3>Load NIfTI File</h3>
      <button class="panel-close" onclick="toggleUploadPanel()">×</button>
    </div>
    <div class="upload-dropzone-small" id="dropZone">
      <span class="drop-icon-small">📁</span>
      <p>Drop .nii file here</p>
      <p class="upload-hint-small">or click to browse</p>
    </div>
    <input type="file" id="fileInput" accept=".nii,.nii.gz,.gz" style="display: none;">
    <div class="upload-options-small">
      <label>
        <span>Threshold:</span>
        <select id="thresholdSelect">
          <option value="auto" selected>Auto</option>
          <option value="soft">Soft tissue</option>
          <option value="bone">Bone</option>
          <option value="custom">Custom</option>
        </select>
      </label>
      <label id="customThresholdLabel" style="display: none;">
        <input type="number" id="customThreshold" value="50" min="-1000" max="3000" placeholder="HU value">
      </label>
    </div>
    <div id="uploadStatus" class="upload-status-small"></div>
    <div id="uploadProgress" class="upload-progress-small" style="display: none;">
      <div class="progress-bar-small"><div class="progress-fill"></div></div>
      <p class="progress-text-small">Processing...</p>
    </div>
  `;
  
  viewerDiv.appendChild(panel);
  
  // Setup event listeners
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  const thresholdSelect = document.getElementById('thresholdSelect');
  const customLabel = document.getElementById('customThresholdLabel');
  
  // Threshold selector
  thresholdSelect.addEventListener('change', () => {
    customLabel.style.display = thresholdSelect.value === 'custom' ? 'block' : 'none';
  });
  
  // Click to open file dialog
  dropZone.addEventListener('click', (e) => {
    if (e.target.tagName !== 'SELECT' && e.target.tagName !== 'INPUT') {
      fileInput.click();
    }
  });
  
  // File input change
  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleFileUpload(e.target.files[0]);
    }
  });
  
  // Drag and drop
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
  
  dropZone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
  });
  
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    
    if (e.dataTransfer.files.length > 0) {
      handleFileUpload(e.dataTransfer.files[0]);
    }
  });
  
  // Also allow dropping anywhere on the viewer
  viewerDiv.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (!_uploadPanelOpen) {
      toggleUploadPanel();
    }
  });
  
  viewerDiv.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer.files.length > 0) {
      handleFileUpload(e.dataTransfer.files[0]);
    }
  });
}

function toggleUploadPanel() {
  const panel = document.getElementById('uploadPanel');
  if (!panel) return;
  
  _uploadPanelOpen = !_uploadPanelOpen;
  panel.classList.toggle('open', _uploadPanelOpen);
  
  // Update button state
  const uploadBtn = document.querySelector('.upload-btn');
  if (uploadBtn) {
    uploadBtn.classList.toggle('active', _uploadPanelOpen);
  }
}

// Make toggleUploadPanel available globally for the close button
window.toggleUploadPanel = toggleUploadPanel;

async function handleFileUpload(file) {
  const status = document.getElementById('uploadStatus');
  const progress = document.getElementById('uploadProgress');
  const progressFill = progress?.querySelector('.progress-fill');
  const progressText = progress?.querySelector('.progress-text');
  
  // Validate file
  const fileName = file.name.toLowerCase();
  if (!fileName.endsWith('.nii') && !fileName.endsWith('.nii.gz') && !fileName.endsWith('.gz')) {
    if (status) {
      status.textContent = '❌ Invalid file type';
      status.className = 'upload-status-small error';
    }
    return;
  }
  
  // Get threshold option
  const thresholdSelect = document.getElementById('thresholdSelect');
  const customThreshold = document.getElementById('customThreshold');
  let threshold = thresholdSelect?.value || 'auto';
  let thresholdValue = 50;
  
  if (threshold === 'custom') {
    thresholdValue = parseFloat(customThreshold?.value || 50);
  } else if (threshold === 'soft') {
    thresholdValue = 50;
  } else if (threshold === 'bone') {
    thresholdValue = 300;
  }
  
  // Show progress
  if (status) status.textContent = '';
  if (progress) {
    progress.style.display = 'block';
    if (progressFill) progressFill.style.width = '10%';
    if (progressText) progressText.textContent = `Loading...`;
  }
  
  try {
    if (progressFill) progressFill.style.width = '30%';
    if (progressText) progressText.textContent = 'Processing...';
    
    await new Promise(r => setTimeout(r, 50));
    
    if (progressFill) progressFill.style.width = '50%';
    if (progressText) progressText.textContent = 'Generating mesh...';
    
    // Load and process the NIfTI file via server
    const mesh = await loadNiftiFile(file, { threshold, thresholdValue });
    
    if (progressFill) progressFill.style.width = '80%';
    if (progressText) progressText.textContent = 'Rendering...';
    
    await new Promise(r => setTimeout(r, 50));
    
    // Load the mesh into the viewer
    await loadNiftiMesh(mesh, file.name);
    
    if (progressFill) progressFill.style.width = '100%';
    if (progressText) progressText.textContent = 'Done!';
    
    // Close the upload panel after success
    setTimeout(() => {
      if (_uploadPanelOpen) toggleUploadPanel();
      if (progress) progress.style.display = 'none';
    }, 500);
    
  } catch (error) {
    console.error('Error loading NIfTI:', error);
    if (progress) progress.style.display = 'none';
    if (status) {
      status.textContent = `❌ ${error.message}`;
      status.className = 'upload-status-small error';
    }
  }
}

async function loadNiftiMesh(mesh, fileName) {
  currentModelName = fileName;

  // Clear existing object if any
  if (currentObject) {
    scene.remove(currentObject);
    currentObject.traverse(child => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) {
          child.material.forEach(m => m.dispose());
        } else {
          child.material.dispose();
        }
      }
    });
  }

  // Use the mesh directly
  currentObject = new THREE.Group();
  currentObject.add(mesh);
  scene.add(currentObject);

  _positionModel();
  _createGroundPlane();

  // Reset camera to view the new object
  camera.position.set(100 * 0.6, 100 * 0.45, 100 * 1.0);
  controls.target.set(0, 0, 0);
  controls.update();
  
  // Reset physics state
  _velocity.set(0, 0, 0);
  _moveState.gravityDisabled = false;
}

function initViewer() {
  // Hide selector, show viewer
  document.getElementById('selector').style.display = 'none';
  viewerDiv.style.display = 'block';
  
  // Initialize scene
  _initializeScene();
  
  // Create the GUI with upload functionality
  createGUI(null);
  
  // Create an empty ground plane
  _createEmptyGroundPlane();
}

// =============================================================================
// APP ENTRY POINT
// =============================================================================

// Add global keyboard listener
window.addEventListener('keydown', _onGlobalKeyDown);

// Initialize the viewer directly
initViewer();