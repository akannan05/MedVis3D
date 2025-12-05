#!/usr/bin/env python3
"""
Fast NIfTI to OBJ conversion server for MedVis3D
Run this alongside the Vite dev server for fast mesh generation
"""

import http.server
import socketserver
import json
import tempfile
import os
import io
import gzip
from urllib.parse import parse_qs, urlparse

import numpy as np
from skimage import measure, morphology
from scipy import ndimage
import nibabel as nib
import trimesh

PORT = 3001

class NiftiHandler(http.server.BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        """Handle CORS preflight"""
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()
    
    def do_POST(self):
        """Handle NIfTI file upload and conversion"""
        if self.path.startswith('/convert'):
            self.handle_convert()
        else:
            self.send_error(404)
    
    def handle_convert(self):
        try:
            # Parse query parameters
            query = parse_qs(urlparse(self.path).query)
            threshold_mode = query.get('threshold', ['auto'])[0]
            custom_threshold = query.get('value', ['50'])[0]
            
            # Read the uploaded file
            content_length = int(self.headers['Content-Length'])
            file_data = self.rfile.read(content_length)
            
            print(f"Received {content_length} bytes, threshold mode: {threshold_mode}")
            
            # Process the NIfTI file
            obj_data, metadata = self.process_nifti(file_data, threshold_mode, custom_threshold)
            
            # Send response
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            
            response = {
                'success': True,
                'obj': obj_data,
                'metadata': metadata
            }
            self.wfile.write(json.dumps(response).encode())
            
        except Exception as e:
            print(f"Error: {e}")
            import traceback
            traceback.print_exc()
            
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            
            response = {'success': False, 'error': str(e)}
            self.wfile.write(json.dumps(response).encode())
    
    def process_nifti(self, file_data, threshold_mode, custom_threshold):
        """Convert NIfTI data to OBJ string"""
        
        # Check if gzipped
        if file_data[:2] == b'\x1f\x8b':
            file_data = gzip.decompress(file_data)
        
        # Save to temp file for nibabel
        with tempfile.NamedTemporaryFile(suffix='.nii', delete=False) as f:
            f.write(file_data)
            temp_path = f.name
        
        try:
            # Load NIfTI
            print("Loading NIfTI...")
            nii = nib.load(temp_path)
            data = nii.get_fdata()
            spacing = nii.header.get_zooms()[:3]
            
            print(f"Shape: {data.shape}, Spacing: {spacing}")
            print(f"Data range: {np.min(data):.1f} to {np.max(data):.1f}")
            
            # Determine threshold
            if threshold_mode == 'auto':
                # Find optimal threshold using Otsu-like method
                # Focus on non-background values
                non_bg = data[data > -500]
                if len(non_bg) > 0:
                    threshold = np.percentile(non_bg, 30)
                else:
                    threshold = 0
                print(f"Auto threshold: {threshold:.1f}")
            elif threshold_mode == 'soft':
                threshold = 50
            elif threshold_mode == 'bone':
                threshold = 300
            else:
                threshold = float(custom_threshold)
            
            print(f"Using threshold: {threshold}")
            
            # Create binary mask
            mask = (data > threshold).astype(np.uint8)
            print(f"Initial mask voxels: {np.sum(mask)}")
            
            if np.sum(mask) < 100:
                raise ValueError(f"No significant structure found at threshold {threshold}. Try a lower threshold.")
            
            # Clean up mask
            print("Cleaning mask...")
            mask = morphology.remove_small_objects(mask.astype(bool), min_size=1000)
            mask = morphology.binary_closing(mask, morphology.ball(2))
            mask = ndimage.binary_fill_holes(mask)
            mask = mask.astype(np.uint8)
            
            # Keep largest connected component
            print("Finding largest component...")
            labeled = measure.label(mask)
            regions = measure.regionprops(labeled)
            if regions:
                largest = max(regions, key=lambda r: r.area)
                mask = (labeled == largest.label).astype(np.uint8)
            
            print(f"Final mask voxels: {np.sum(mask)}")
            
            # Generate mesh with marching cubes
            print("Running marching cubes...")
            verts, faces, normals, _ = measure.marching_cubes(
                mask,
                level=0.5,
                spacing=tuple(float(s) for s in spacing),
                step_size=2,
                allow_degenerate=False
            )
            
            print(f"Generated: {len(verts)} vertices, {len(faces)} faces")
            
            # Create trimesh for processing
            print("Processing mesh...")
            mesh = trimesh.Trimesh(vertices=verts, faces=faces)
            
            # First pass: aggressive decimation to reduce complexity
            target_faces = 15000
            if len(mesh.faces) > target_faces:
                print(f"Decimating from {len(mesh.faces)} to ~{target_faces} faces...")
                try:
                    mesh = mesh.simplify_quadric_decimation(target_faces)
                    print(f"After decimation: {len(mesh.faces)} faces")
                except Exception as e:
                    print(f"Decimation failed: {e}")
            
            # VERY aggressive smoothing for ultra-smooth surface
            print("Applying ultra-smooth processing...")
            
            # Multiple passes of Laplacian smoothing
            for i in range(5):
                trimesh.smoothing.filter_laplacian(mesh, iterations=20, lamb=0.7)
            
            # Taubin smoothing to prevent shrinkage
            trimesh.smoothing.filter_taubin(mesh, iterations=50, lamb=0.5, mu=-0.53)
            
            # Final Humphrey pass for organic smoothness
            trimesh.smoothing.filter_humphrey(mesh, iterations=30, alpha=0.1, beta=0.6)
            
            # Subdivide for even smoother appearance (adds more triangles but smoother)
            print("Subdividing for smoothness...")
            mesh = mesh.subdivide()
            
            # Final smoothing pass after subdivision
            trimesh.smoothing.filter_laplacian(mesh, iterations=10, lamb=0.5)
            
            # Final decimation to keep performance good
            if len(mesh.faces) > 50000:
                print(f"Final decimation from {len(mesh.faces)} faces...")
                try:
                    mesh = mesh.simplify_quadric_decimation(50000)
                except:
                    pass
            
            # Recalculate normals
            mesh.fix_normals()
            
            # Get final vertices and normals
            verts = mesh.vertices
            normals = mesh.vertex_normals
            
            print(f"Final mesh: {len(verts)} vertices, {len(mesh.faces)} faces")
            
            # Center the mesh
            center = np.mean(verts, axis=0)
            verts = verts - center
            
            # Scale to reasonable size (target ~100 units max dimension)
            max_dim = np.max(np.abs(verts))
            if max_dim > 100:
                scale = 80 / max_dim
                verts = verts * scale
            
            # Merge close vertices for smooth shading
            print("Merging vertices for smooth shading...")
            mesh.merge_vertices(merge_tex=True, merge_norm=True)
            mesh.fix_normals()
            
            # Recompute vertex normals for smooth interpolation
            verts = mesh.vertices
            normals = mesh.vertex_normals
            
            # Build OBJ string with proper indexed geometry
            print("Building OBJ...")
            obj_lines = ["# Generated by MedVis3D", "# Smooth shaded mesh"]
            
            # Vertices
            for v in verts:
                obj_lines.append(f"v {v[0]:.6f} {v[1]:.6f} {v[2]:.6f}")
            
            # Vertex normals (for smooth shading)
            for n in normals:
                obj_lines.append(f"vn {n[0]:.6f} {n[1]:.6f} {n[2]:.6f}")
            
            # Smooth shading group
            obj_lines.append("s 1")
            
            # Faces with vertex normals (1-indexed)
            for f in mesh.faces:
                i1, i2, i3 = f[0] + 1, f[1] + 1, f[2] + 1
                obj_lines.append(f"f {i1}//{i1} {i2}//{i2} {i3}//{i3}")
            
            obj_data = "\n".join(obj_lines)
            
            metadata = {
                'vertices': len(verts),
                'faces': len(faces),
                'threshold': threshold,
                'spacing': [float(s) for s in spacing],
                'original_shape': list(data.shape)
            }
            
            print(f"Done! OBJ size: {len(obj_data) / 1024:.1f} KB")
            
            return obj_data, metadata
            
        finally:
            os.unlink(temp_path)


def main():
    with socketserver.TCPServer(("", PORT), NiftiHandler) as httpd:
        print(f"NIfTI conversion server running on http://localhost:{PORT}")
        print("Waiting for uploads...")
        httpd.serve_forever()


if __name__ == "__main__":
    main()

