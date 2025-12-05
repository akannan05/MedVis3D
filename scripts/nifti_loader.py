#!/usr/bin/env python3
"""
NIfTI to OBJ Converter for Medical Visualization

This script converts NIfTI medical imaging files (segmentation masks) to OBJ 3D meshes
suitable for web-based visualization. It preserves the real-world scale from the
imaging metadata.

Usage:
    python nifti_loader.py -p /path/to/dataset.json -t training 0
    python nifti_loader.py --nifti /path/to/file.nii.gz --output liver_0.obj
    
Dependencies:
    pip install numpy nibabel scikit-image trimesh
"""

import argparse
import json
import os
import logging
from typing import List, Dict, Tuple, Optional

import numpy as np
from skimage import measure
import trimesh

try:
    import nibabel as nib
except ImportError:
    print("Error: nibabel not installed. Run: pip install nibabel")
    exit(1)

logging.basicConfig(level=logging.INFO, format='[%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)

# =============================================================================
# CONFIGURATION
# =============================================================================

# Output directory for generated OBJ files
OUTPUT_DIR = "../public/assets/models"

# Organ type mapping for naming
ORGAN_TYPES = {
    1: "liver",
    2: "spleen", 
    3: "kidney_left",
    4: "kidney_right",
    5: "stomach",
    6: "gallbladder",
    7: "pancreas",
    8: "aorta",
    9: "inferior_vena_cava",
    10: "portal_vein",
    11: "hepatic_veins",
    13: "esophagus",
    14: "small_bowel",
    15: "duodenum",
    16: "colon",
}

# =============================================================================
# MESH GENERATION
# =============================================================================

def nifti_to_mesh(nifti_path: str, label_value: int = 1, 
                  smooth_iterations: int = 10) -> Tuple[trimesh.Trimesh, dict]:
    """
    Convert a NIfTI segmentation mask to a 3D mesh.
    
    Args:
        nifti_path: Path to the NIfTI file
        label_value: The label value to extract (default 1 for binary masks)
        smooth_iterations: Number of Laplacian smoothing iterations
        
    Returns:
        Tuple of (trimesh.Trimesh, metadata dict with spacing info)
    """
    logger.info(f"Loading NIfTI file: {nifti_path}")
    
    # Load the NIfTI file
    nii = nib.load(nifti_path)
    data = nii.get_fdata()
    
    # Get voxel spacing (mm per voxel)
    spacing = nii.header.get_zooms()[:3]
    logger.info(f"Voxel spacing (mm): {spacing}")
    
    # Get affine transform for orientation
    affine = nii.affine
    
    # Squeeze if needed
    if len(data.shape) > 3:
        data = np.squeeze(data)
    
    # Create binary mask
    if label_value is not None:
        mask = (data == label_value).astype(np.uint8)
    else:
        mask = (data > 0).astype(np.uint8)
    
    logger.info(f"Mask shape: {mask.shape}")
    logger.info(f"Non-zero voxels: {np.sum(mask)}")
    
    if np.sum(mask) == 0:
        raise ValueError("No voxels found with the specified label value")
    
    # Generate mesh using marching cubes
    logger.info("Running marching cubes...")
    verts, faces, normals, values = measure.marching_cubes(
        mask, 
        level=0.5,
        spacing=spacing,  # Apply spacing directly in marching cubes
        step_size=1,
        allow_degenerate=False
    )
    
    logger.info(f"Generated mesh: {len(verts)} vertices, {len(faces)} faces")
    
    # Create trimesh object
    mesh = trimesh.Trimesh(vertices=verts, faces=faces, vertex_normals=normals)
    
    # Clean up the mesh
    mesh.remove_degenerate_faces()
    mesh.remove_duplicate_faces()
    mesh.remove_unreferenced_vertices()
    
    # Optional: Smooth the mesh for better appearance
    if smooth_iterations > 0:
        logger.info(f"Smoothing mesh ({smooth_iterations} iterations)...")
        trimesh.smoothing.filter_laplacian(mesh, iterations=smooth_iterations)
    
    # Recalculate normals after smoothing
    mesh.fix_normals()
    
    # Calculate mesh statistics
    bounds = mesh.bounds
    size = bounds[1] - bounds[0]
    center = mesh.centroid
    volume = mesh.volume if mesh.is_watertight else None
    
    metadata = {
        "spacing_mm": list(spacing),
        "bounds_mm": bounds.tolist(),
        "size_mm": size.tolist(),
        "center_mm": center.tolist(),
        "volume_mm3": volume,
        "volume_ml": volume / 1000 if volume else None,
        "num_vertices": len(mesh.vertices),
        "num_faces": len(mesh.faces),
        "is_watertight": mesh.is_watertight
    }
    
    logger.info(f"Mesh size (mm): {size}")
    if volume:
        logger.info(f"Volume: {volume:.2f} mm³ ({volume/1000:.2f} mL)")
    
    return mesh, metadata


def export_mesh(mesh: trimesh.Trimesh, output_path: str, metadata: dict = None):
    """Export mesh to OBJ format with optional metadata JSON."""
    
    # Ensure output directory exists
    os.makedirs(os.path.dirname(output_path) if os.path.dirname(output_path) else '.', exist_ok=True)
    
    # Export OBJ
    mesh.export(output_path, file_type='obj')
    logger.info(f"Exported mesh to: {output_path}")
    
    # Export metadata JSON alongside
    if metadata:
        meta_path = output_path.replace('.obj', '_meta.json')
        with open(meta_path, 'w') as f:
            json.dump(metadata, f, indent=2)
        logger.info(f"Exported metadata to: {meta_path}")


# =============================================================================
# DATASET PROCESSING (for Medical Segmentation Decathlon format)
# =============================================================================

def prep_json(dataset_json: str, data_type: str = "training"):
    """Parse Medical Segmentation Decathlon dataset.json format."""
    with open(dataset_json, "r") as f:
        data = json.load(f)

    current_dir = os.path.dirname(dataset_json)
    
    num_training = data.get("numTraining", 0)
    num_test = data.get("numTest", 0)
    
    if data_type not in ["training", "test"]:
        logger.error(f"Invalid data type: {data_type}")
        return num_training, num_test, None
    
    data_dict = {}
    for i, item in enumerate(data.get(data_type, [])):
        new_item = {}
        new_item["image"] = os.path.join(current_dir, item["image"])
        if "label" in item:
            new_item["label"] = os.path.join(current_dir, item["label"])
        data_dict[i] = new_item
    
    return num_training, num_test, data_dict


def process_dataset_sample(data_dict: dict, index: int, organ_name: str = "organ",
                          output_dir: str = OUTPUT_DIR):
    """Process a single sample from a dataset."""
    
    if index not in data_dict:
        logger.error(f"Index {index} not found in dataset")
        return
    
    sample = data_dict[index]
    
    if "label" not in sample:
        logger.error("No label file found for this sample")
        return
    
    label_path = sample["label"]
    output_path = os.path.join(output_dir, f"{organ_name}_{index}.obj")
    
    try:
        mesh, metadata = nifti_to_mesh(label_path)
        metadata["source_file"] = os.path.basename(label_path)
        metadata["organ_type"] = organ_name
        export_mesh(mesh, output_path, metadata)
        
        # Update models.json
        update_models_json(output_dir)
        
    except Exception as e:
        logger.error(f"Failed to process sample: {e}")
        raise


def update_models_json(output_dir: str):
    """Update the models.json file with all available OBJ files."""
    models_json_path = os.path.join(output_dir, "models.json")
    
    # Find all OBJ files
    obj_files = sorted([f for f in os.listdir(output_dir) if f.endswith('.obj')])
    
    with open(models_json_path, 'w') as f:
        json.dump(obj_files, f, indent=2)
    
    logger.info(f"Updated models.json with {len(obj_files)} models")


# =============================================================================
# COMMAND LINE INTERFACE
# =============================================================================

def parse_args():
    parser = argparse.ArgumentParser(
        description="Convert NIfTI medical images to OBJ meshes"
    )
    
    # Dataset mode
    parser.add_argument("-p", "--path", 
                       help="Path to dataset.json file", 
                       type=str)
    parser.add_argument("-t", "--type", 
                       help="Dataset type: training or test", 
                       type=str,
                       default="training")
    parser.add_argument("num", 
                       help="Sample index to process", 
                       type=int,
                       nargs='?')
    
    # Single file mode
    parser.add_argument("--nifti", 
                       help="Path to a single NIfTI file", 
                       type=str)
    parser.add_argument("--output", 
                       help="Output OBJ file path", 
                       type=str)
    parser.add_argument("--organ", 
                       help="Organ type name", 
                       type=str,
                       default="organ")
    parser.add_argument("--label", 
                       help="Label value to extract (default: 1)", 
                       type=int,
                       default=1)
    parser.add_argument("--smooth", 
                       help="Smoothing iterations (default: 10)", 
                       type=int,
                       default=10)
    
    return parser.parse_args()


def main():
    args = parse_args()
    
    # Ensure output directory exists
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    
    if args.nifti:
        # Single file mode
        output_path = args.output or os.path.join(OUTPUT_DIR, f"{args.organ}_0.obj")
        
        try:
            mesh, metadata = nifti_to_mesh(
                args.nifti, 
                label_value=args.label,
                smooth_iterations=args.smooth
            )
            metadata["organ_type"] = args.organ
            export_mesh(mesh, output_path, metadata)
            update_models_json(OUTPUT_DIR)
            
        except Exception as e:
            logger.error(f"Failed: {e}")
            return 1
            
    elif args.path and args.num is not None:
        # Dataset mode
        num_training, num_test, data_dict = prep_json(args.path, args.type)
        
        if not data_dict:
            logger.error(f"Unable to load {args.type} data")
            return 1
        
        max_index = num_training if args.type == "training" else num_test
        
        if args.num < 0 or args.num >= max_index:
            logger.error(f"Index {args.num} out of range (max: {max_index})")
            return 1
        
        logger.info(f"Processing {args.type} sample {args.num}")
        process_dataset_sample(data_dict, args.num, args.organ, OUTPUT_DIR)
        
    else:
        print("Usage:")
        print("  Dataset mode: python nifti_loader.py -p /path/to/dataset.json -t training 0")
        print("  Single file:  python nifti_loader.py --nifti /path/to/file.nii.gz --organ liver")
        return 1
    
    return 0


if __name__ == "__main__":
    exit(main())
