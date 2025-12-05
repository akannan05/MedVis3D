import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// =============================================================================
// NIFTI FILE PROCESSOR
// Uses Python backend for fast, high-quality mesh generation
// =============================================================================

const CONVERSION_SERVER = 'http://localhost:3001';

/**
 * Load and process a NIfTI file via the Python conversion server
 */
export async function loadNiftiFile(file, options = {}) {
  const { threshold = 'auto', thresholdValue = 50 } = options;
  
  // Build query string
  const params = new URLSearchParams({
    threshold: threshold === 'auto' ? 'auto' : 
               threshold === 50 ? 'soft' :
               threshold === 300 ? 'bone' : 'custom',
    value: thresholdValue.toString()
  });
  
  try {
    // Send file to conversion server
    const response = await fetch(`${CONVERSION_SERVER}/convert?${params}`, {
      method: 'POST',
      body: file,
      headers: {
        'Content-Type': 'application/octet-stream'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Server error: ${response.status}`);
    }
    
    const result = await response.json();
    
    if (!result.success) {
      throw new Error(result.error || 'Conversion failed');
    }
    
    // Parse OBJ data
    const loader = new OBJLoader();
    const obj = loader.parse(result.obj);
    
    // Apply material and settings
    obj.traverse(child => {
      if (child.isMesh) {
        // Merge vertices to ensure smooth normals work properly
        if (child.geometry) {
          // Merge duplicate vertices for proper normal interpolation
          child.geometry = mergeVertices(child.geometry);
          
          // Recompute smooth normals after merging
          child.geometry.computeVertexNormals();
        }
        
        // Smooth organic tissue material
        child.material = new THREE.MeshStandardMaterial({
          color: 0xCC8877,  // Warm organ tone
          roughness: 0.65,
          metalness: 0.0,
          side: THREE.DoubleSide,
          flatShading: false,  // SMOOTH shading - interpolate normals
        });
        
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    
    // Store metadata
    obj.userData.metadata = result.metadata;
    
    return obj;
    
  } catch (error) {
    // Check if server is not running
    if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
      throw new Error('Conversion server not running. Please start it with: python3 server.py');
    }
    throw error;
  }
}
