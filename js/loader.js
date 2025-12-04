import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';

// =============================================================================
// SCALE & UNITS CONFIGURATION
// =============================================================================

// Default scale: 1 unit = 1 mm (medical imaging standard)
export const SCALE_CONFIG = {
  unitsPerMeter: 1000,  // 1000 mm per meter
  unitName: 'mm',
  unitNameSquared: 'mm²',
  unitNameCubed: 'mm³',
  
  // Conversion factors
  toMM: 1,
  toCM: 0.1,
  toM: 0.001,
  toInch: 0.0393701,
};

// Convert measurement to different units
export function convertDistance(value, toUnit = 'mm') {
  switch(toUnit) {
    case 'mm': return { value: value, unit: 'mm' };
    case 'cm': return { value: value * 0.1, unit: 'cm' };
    case 'm': return { value: value * 0.001, unit: 'm' };
    case 'inch': return { value: value * 0.0393701, unit: 'in' };
    default: return { value: value, unit: 'mm' };
  }
}

export function convertArea(value, toUnit = 'mm') {
  switch(toUnit) {
    case 'mm': return { value: value, unit: 'mm²' };
    case 'cm': return { value: value * 0.01, unit: 'cm²' };
    case 'm': return { value: value * 0.000001, unit: 'm²' };
    default: return { value: value, unit: 'mm²' };
  }
}

export function convertVolume(value, toUnit = 'mm') {
  switch(toUnit) {
    case 'mm': return { value: value, unit: 'mm³' };
    case 'cm': return { value: value * 0.001, unit: 'cm³' };
    case 'ml': return { value: value * 0.001, unit: 'mL' };  // 1 cm³ = 1 mL
    case 'm': return { value: value * 0.000000001, unit: 'm³' };
    default: return { value: value, unit: 'mm³' };
  }
}

export function formatMeasurement(value, unit, decimals = 2) {
  return `${value.toFixed(decimals)} ${unit}`;
}

// =============================================================================
// ORGANIC TISSUE MATERIAL
// =============================================================================

// Create realistic organ material with subsurface scattering simulation
export function createOrganMaterial(organType = 'liver') {
  const organColors = {
    liver: { color: 0x8B4513, emissive: 0x1a0505 },
    spleen: { color: 0x722F37, emissive: 0x150808 },
    kidney: { color: 0x8B0000, emissive: 0x100505 },
    heart: { color: 0xA52A2A, emissive: 0x120606 },
    lung: { color: 0xFFB6C1, emissive: 0x100808 },
    default: { color: 0xcc6666, emissive: 0x110505 }
  };

  const config = organColors[organType] || organColors.default;

  // Create a custom shader material for subsurface scattering effect
  const material = new THREE.MeshPhysicalMaterial({
    color: config.color,
    emissive: config.emissive,
    emissiveIntensity: 0.15,
    roughness: 0.7,
    metalness: 0.0,
    clearcoat: 0.1,
    clearcoatRoughness: 0.8,
    sheen: 0.3,
    sheenRoughness: 0.8,
    sheenColor: new THREE.Color(0xff8888),
    transmission: 0.05,  // Slight translucency
    thickness: 5.0,
    ior: 1.4,  // Index of refraction similar to tissue
    side: THREE.DoubleSide,
  });

  return material;
}

// Create material for internal/sliced surfaces
export function createSliceMaterial(organType = 'liver') {
  const sliceColors = {
    liver: 0xB85C38,
    spleen: 0x8B3A3A,
    kidney: 0xA0522D,
    heart: 0xCD5C5C,
    default: 0xBB6655
  };

  return new THREE.MeshPhysicalMaterial({
    color: sliceColors[organType] || sliceColors.default,
    emissive: 0x110505,
    emissiveIntensity: 0.1,
    roughness: 0.85,
    metalness: 0.0,
    clearcoat: 0.05,
    sheen: 0.2,
    sheenColor: new THREE.Color(0xffaaaa),
    side: THREE.DoubleSide,
  });
}

// =============================================================================
// MODEL LOADER
// =============================================================================

export function loadOBJ(path, options = {}) {
  const {
    organType = 'liver',
    scale = 1.0,  // Scale factor to apply
    centerModel = true,
  } = options;

  return new Promise((resolve, reject) => {
    const loader = new OBJLoader();
    loader.load(path, obj => {
      // Store metadata
      obj.userData.organType = organType;
      obj.userData.scale = scale;
      obj.userData.unitScale = SCALE_CONFIG.unitsPerMeter;
      
      obj.traverse(child => {
        if(child.isMesh) {
          // Apply organic tissue material
          child.material = createOrganMaterial(organType);
          
          // Enable shadows
          child.castShadow = true;
          child.receiveShadow = true;
          
          // Compute smooth normals
          if(child.geometry) {
            child.geometry.computeVertexNormals();
            
            // Apply scale if needed
            if(scale !== 1.0) {
              child.geometry.scale(scale, scale, scale);
            }
          }
        }
      });
      
      resolve(obj);
    }, 
    // Progress callback
    (xhr) => {
      if(xhr.lengthComputable) {
        const percent = (xhr.loaded / xhr.total) * 100;
        console.log(`Loading: ${percent.toFixed(1)}%`);
      }
    },
    // Error callback
    err => reject(err));
  });
}

// =============================================================================
// SOFT BODY PHYSICS HELPERS
// =============================================================================

// Create a simple spring-mass system for soft body deformation
export class SoftBodyMesh {
  constructor(mesh, stiffness = 0.3, damping = 0.8) {
    this.mesh = mesh;
    this.stiffness = stiffness;
    this.damping = damping;
    this.originalPositions = null;
    this.velocities = null;
    this.forces = null;
    this.initialized = false;
  }

  initialize() {
    if(!this.mesh.geometry || this.initialized) return;
    
    const positions = this.mesh.geometry.attributes.position;
    const count = positions.count;
    
    // Store original positions
    this.originalPositions = new Float32Array(count * 3);
    for(let i = 0; i < count * 3; i++) {
      this.originalPositions[i] = positions.array[i];
    }
    
    // Initialize velocities and forces
    this.velocities = new Float32Array(count * 3).fill(0);
    this.forces = new Float32Array(count * 3).fill(0);
    
    this.initialized = true;
  }

  // Apply an impulse at a point (for interaction)
  applyImpulse(worldPoint, force, radius = 10) {
    if(!this.initialized) this.initialize();
    
    const positions = this.mesh.geometry.attributes.position;
    const count = positions.count;
    
    // Convert world point to local space
    const localPoint = worldPoint.clone();
    this.mesh.worldToLocal(localPoint);
    
    for(let i = 0; i < count; i++) {
      const x = positions.getX(i);
      const y = positions.getY(i);
      const z = positions.getZ(i);
      
      const dx = x - localPoint.x;
      const dy = y - localPoint.y;
      const dz = z - localPoint.z;
      const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
      
      if(dist < radius) {
        const falloff = 1 - (dist / radius);
        const strength = falloff * falloff;
        
        this.velocities[i * 3] += force.x * strength;
        this.velocities[i * 3 + 1] += force.y * strength;
        this.velocities[i * 3 + 2] += force.z * strength;
      }
    }
  }

  // Update the soft body simulation
  update(deltaTime) {
    if(!this.initialized) return;
    
    const positions = this.mesh.geometry.attributes.position;
    const count = positions.count;
    const dt = Math.min(deltaTime, 0.033); // Cap at ~30fps
    
    for(let i = 0; i < count; i++) {
      const idx = i * 3;
      
      // Current position
      const x = positions.array[idx];
      const y = positions.array[idx + 1];
      const z = positions.array[idx + 2];
      
      // Original position
      const ox = this.originalPositions[idx];
      const oy = this.originalPositions[idx + 1];
      const oz = this.originalPositions[idx + 2];
      
      // Spring force towards original position
      const fx = (ox - x) * this.stiffness;
      const fy = (oy - y) * this.stiffness;
      const fz = (oz - z) * this.stiffness;
      
      // Update velocity with spring force and damping
      this.velocities[idx] = (this.velocities[idx] + fx * dt) * this.damping;
      this.velocities[idx + 1] = (this.velocities[idx + 1] + fy * dt) * this.damping;
      this.velocities[idx + 2] = (this.velocities[idx + 2] + fz * dt) * this.damping;
      
      // Update position
      positions.array[idx] += this.velocities[idx] * dt;
      positions.array[idx + 1] += this.velocities[idx + 1] * dt;
      positions.array[idx + 2] += this.velocities[idx + 2] * dt;
    }
    
    positions.needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
  }

  // Reset to original shape
  reset() {
    if(!this.initialized) return;
    
    const positions = this.mesh.geometry.attributes.position;
    for(let i = 0; i < this.originalPositions.length; i++) {
      positions.array[i] = this.originalPositions[i];
    }
    this.velocities.fill(0);
    positions.needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
  }
}
