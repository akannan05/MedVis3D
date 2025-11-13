import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { loadOBJ } from './loader.js';
import '../css/styles.css';

const selectorDiv = document.getElementById('selector');

let models = [];

async function fetchModels() {
    const res = await fetch('../assets/models/models.json');
    models = await res.json();
    initSelector();
}

fetchModels();

const viewerDiv = document.getElementById('viewer');
const backBtn = document.getElementById('backBtn');

let scene, camera, renderer, controls, currentObject;

const raycaster = new THREE.Raycaster();
const clickMouse = new THREE.Vector2();
const moveMouse = new THREE.Vector2();
var draggable;

// --- Selector view ---
function initSelector() {
  selectorDiv.innerHTML = '';
  models.forEach(model => {
    const btn = document.createElement('button');
    btn.className = 'model-btn';
    btn.textContent = model.replace('.obj','');
    btn.onclick = () => loadViewer(model);
    selectorDiv.appendChild(btn);
  });
}

// --- Viewer view ---
async function loadViewer(modelName) {
  selectorDiv.style.display = 'none';
  viewerDiv.style.display = 'block';

  // Scene setup
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(75, window.innerWidth/window.innerHeight, 0.1, 1000);

  renderer = new THREE.WebGLRenderer({antialias:true});
  renderer.setSize(window.innerWidth, window.innerHeight);
  viewerDiv.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  // Lights
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
  scene.add(ambientLight);

  const dirLight = new THREE.DirectionalLight(0xffffff, 1);
  dirLight.position.set(1, 1, 1);
  scene.add(dirLight);
  scene.background = new THREE.Color(0x82DEED);

  // Load floor
  const floorGeometry = new THREE.BoxGeometry(150, 0.5, 100);
  const floorMaterial = new THREE.MeshBasicMaterial({color: 0xC9BFBD});
  const floor = new THREE.Mesh(floorGeometry, floorMaterial);
  scene.add(floor);
  floor.position.y = -0.25;
  floor.userData.draggable = false;
  floor.userData.name = "FLOOR"
  floor.userData.ground = true;

  // Load OBJ
  currentObject = await loadOBJ(`/assets/models/${modelName}`);
  scene.add(currentObject);
  currentObject.userData.draggable = true;

  // Center and scale object
  const box = new THREE.Box3().setFromObject(currentObject);
  const size = new THREE.Vector3();
  box.getSize(size);
  const center = new THREE.Vector3();
  box.getCenter(center);

  // Move object to origin
  currentObject.position.sub(center);

  // Optional: scale down if very large
  const maxDim = Math.max(size.x, size.y, size.z);
  if (maxDim > 100) {
    const scaleFactor = 100 / maxDim;
    currentObject.scale.set(scaleFactor, scaleFactor, scaleFactor);
  }

  // bringing object to level
  currentObject.position.y = (-1 * box.min.y);

  // Adjust camera distance based on object size
  camera.position.set(0, 0, maxDim * 1.5);
  camera.translateY(-1 * box.min.y);
  controls.target.set(0, 0, 0);
  controls.update();


  animate();
  window.addEventListener('resize', onWindowResize);
}

const onMouseClick = (event) => {
    if(draggable) {
        console.log(`dropping ${draggable.userData.name}`);
        draggable = null;
        return;
    }

    clickMouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    clickMouse.y = - (event.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(clickMouse, camera);
    const found = raycaster.intersectObjects(scene.children, true);

    if (found.length > 0){
        let current = found[0].object;
        while(current.parent.parent !== null){
            current = current.parent;
        }
        if(current.userData.draggable){
            draggable = current;
        }
        console.log(`found draggable object ${draggable.userData.name}`);
    }

}

const onMouseMove = (event) => {
    moveMouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    moveMouse.y = - (event.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(moveMouse, camera);
    const intersects = raycaster.intersectObjects(scene.children)

    for (let i = 0; i < intersects.length; i++){
        console.log(intersects[i].object.userData.name);
    }
}

function dragObject(){
    if(draggable != null){
        raycaster.setFromCamera(moveMouse, camera);
        const found = raycaster.intersectObjects(scene.children);
        if(found.length > 0) {
            for (let o of found) {
                if(!o.object.userData.ground){
                    continue;
                }
                else{
                    draggable.position.x = o.point.x;
                    draggable.position.z = o.point.z;
                }
            }
        }
    }
}


// mouse movement
window.addEventListener('mousemove', onMouseMove);
window.addEventListener('click', onMouseClick);


// --- Back button ---
backBtn.addEventListener('click', () => {
  if(currentObject) scene.remove(currentObject);
  renderer.dispose();
  viewerDiv.innerHTML = '<button id="backBtn">⟵</button>';
  viewerDiv.style.display = 'none';
  selectorDiv.style.display = 'flex';
  initSelector();
});

// --- Animation loop ---
function animate(){
  requestAnimationFrame(animate);

  dragObject();

  if(controls) controls.update();
  renderer.render(scene, camera);
}

// --- Handle resize ---
function onWindowResize(){
  camera.aspect = window.innerWidth/window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// --- Initialize ---
initSelector();
