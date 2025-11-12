import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';

export function loadOBJ(path){
  return new Promise((resolve, reject) => {
    const loader = new OBJLoader();
    loader.load(path, obj => {
      obj.traverse(child => {
        if(child.isMesh){
          child.material = new THREE.MeshPhongMaterial({color:0xff5555, shininess:50});
        }
      });
      resolve(obj);
    }, undefined, err => reject(err));
  });
}
