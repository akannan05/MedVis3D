import argparse
import json
import os
import logging
from typing import List, Dict, Tuple, Optional

import numpy as np
from skimage import measure
import trimesh
import nibabel as nib

logging.basicConfig(level=logging.INFO, format='[%levelname)s] %(message)')

def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("-p", "--path", help="provide the path to the raw dataset", type=str)
    parser.add_argument("-t","--type", help="indicate whether you want training or test data.", type=str)
    parser.add_argument("num", help="indicate the index that you wish to visualize.", type=int)
    args = parser.parse_args()

    dataset_json = args.path

    numTraining, numTest, data = prep_json(dataset_json, args.type)

    if not data:
        print(f"[Test Visualization] Unable to access data of type {args.type}")
        return
    
    if args.type == "training":
        maxIndex = numTraining 
    else:
        maxIndex = numTest
    
    print(f"[Test Visualization] Visualizing a {args.type} sample (index {args.num})")

    visualize_spleen(args.type, args.num, maxIndex, data)

def prep_json(dataset_json: str, data_type: str="train"):
    with open(dataset_json, "r") as f:
        data = json.load(f)

    current_dir = os.path.dirname(dataset_json)
    
    numTraining = data["numTraining"]
    numTest = data["numTest"]
    data_dict = None

    if data_type not in ["training", "test"]:
        print(f"[Test Visualization] Something went wrong. Data of type {data_type} isn't on file!")
        return numTraining, numTest, data_dict
    
    data_dict = {}
    for i, item in enumerate(data[data_type]):
        new_item = {}
        new_item["image"] = os.path.join(current_dir, item["image"])
        if "label" in item:
            new_item["label"] = os.path.join(current_dir, item["label"])
        data_dict[i] = new_item
    
    return numTraining, numTest, data_dict

def visualize_spleen(viz_type: str, viz_index: int, max_index: int, data_dict):
    if viz_index < 0 or viz_index >= max_index:
        print(f"[Test Visualization] Your provided {viz_index} is out of range (max: {max_index})")
        return
    
    spacing = nib.load(data_dict[viz_index]["image"]).header.get_zooms()
    mask = None
    if viz_type == "training":
        mask = nib.load(data_dict[viz_index]["label"]).get_fdata()
        mask = np.squeeze(mask)
        mask = (mask > 0).astype(np.uint8)

    print(f"[Debug] Mask shape after squeeze: {mask.shape}")

    verts, faces, normals, values = measure.marching_cubes(mask, level=0.5)
    verts[:, 0] *= spacing[0]
    verts[:, 1] *= spacing[1]
    verts[:, 2] *= spacing[2]

    mesh = trimesh.Trimesh(vertices=verts, faces=faces)
    # mesh = mesh.simplify_quadric_decimation(20000)
    mesh.export(f"spleen_{viz_index}.obj")

if __name__ == "__main__":
    parse_args()