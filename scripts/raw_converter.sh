#!/bin/bash
# scripts/raw_converter.sh

# Base path to datasets
BASE_PATH="../assets/data"
ENV_PATH="../174a-venv/bin/python"

# Loop over all directories inside the base path
for DATA_DIR in "$BASE_PATH"/*/; do
    # Remove trailing slash for convenience
    DATA_DIR=${DATA_DIR%/}

    # Construct path to dataset.json
    JSON_PATH="$DATA_DIR/dataset.json"

    # Check if dataset.json exists
    if [ ! -f "$JSON_PATH" ]; then
        echo "No dataset.json found in $DATA_DIR, skipping..."
        continue
    fi

    # Loop over indices 0 to 41
    for IDX in $(seq 0 40); do
        echo "Processing $JSON_PATH with index $IDX..."
        "$ENV_PATH" nifti_loader.py --path="$JSON_PATH" --type="training" $IDX
    done
done
