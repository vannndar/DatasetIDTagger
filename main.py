import os
import json
from enum import Enum
from pathlib import Path
from typing import List, Optional, Dict

from fastapi import FastAPI, HTTPException, Body
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import FileResponse, JSONResponse
from fastapi.requests import Request
from pydantic import BaseModel

app = FastAPI(title="Cow Tagger Tool")

# --- Configuration ---
# Root folder containing all datasets
# Structure: dataset/
#               bucket_1_dataset/
#                   images/
#                   labels/
#                   labeled_data/
DATASET_ROOT = Path("dataset")
# Ensure the root dataset folder exists
DATASET_ROOT.mkdir(exist_ok=True)

# Mount static files
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

# --- Data Models ---
class SplitEnum(str, Enum):
    train = "train"
    val = "val"

class BBox(BaseModel):
    # Normalized YOLO coordinates: x_center, y_center, width, height
    yolo: List[float] 
    
    # Optional status for UI
    status: str = "unknown" # 'unknown', 'labeled'
    cow_id: Optional[str] = None # 1-6 digit string

class ImageAnnotation(BaseModel):
    dataset: Optional[str] = None
    filename: str
    split: str
    width: int
    height: int
    annotations: List[BBox]

# --- Helper Functions ---
def get_dataset_path(dataset_name: str) -> Path:
    path = DATASET_ROOT / dataset_name
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Dataset {dataset_name} not found")
    return path

def get_yolo_labels(dataset_name: str, split: str, filename: str) -> List[BBox]:
    """Reads original YOLO .txt file and converts to BBox objects."""
    ds_path = get_dataset_path(dataset_name)
    txt_path = ds_path / "labels" / split / f"{Path(filename).stem}.txt"
    bboxes = []
    if txt_path.exists():
        with open(txt_path, "r") as f:
            for line in f:
                parts = line.strip().split()
                if len(parts) >= 5:
                    # YOLO: class x y w h
                    bbox = [float(x) for x in parts[1:5]]
                    bboxes.append(BBox(yolo=bbox, status="unknown", cow_id=None))
    return bboxes

def get_saved_annotation(dataset_name: str, split: str, filename: str) -> Optional[ImageAnnotation]:
    """Checks if we already have a JSON file for this image."""
    ds_path = get_dataset_path(dataset_name)
    json_path = ds_path / "labeled_data" / split / f"{Path(filename).stem}.json"
    if json_path.exists():
        with open(json_path, "r") as f:
            data = json.load(f)
            return ImageAnnotation(**data)
    return None

# --- API Endpoints ---

@app.get("/")
def read_root(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

@app.get("/api/datasets")
def list_datasets():
    """Lists all available datasets (folders ending in _dataset) and their stats."""
    datasets = []
    if not DATASET_ROOT.exists():
        return []
        
    for item in DATASET_ROOT.iterdir():
        if item.is_dir() and item.name.endswith("_dataset"):
            # Count images
            img_count = 0
            # Check train/val inside images
            img_dir = item / "images"
            if img_dir.exists():
                for split in ["train", "val"]:
                    split_dir = img_dir / split
                    if split_dir.exists():
                        img_count += len(list(split_dir.glob("*.jpg")))
            
            datasets.append({
                "name": item.name,
                "image_count": img_count
            })
    return datasets

@app.get("/api/images/{dataset_name}/{split}")
def list_images(dataset_name: str, split: SplitEnum):
    """Returns list of image filenames for a split, with tagging status."""
    ds_path = get_dataset_path(dataset_name)
    target_dir = ds_path / "images" / split.value
    
    # Ensure labeled_data structure exists for this dataset
    labeled_dir = ds_path / "labeled_data" / split.value
    labeled_dir.mkdir(parents=True, exist_ok=True)
    
    if not target_dir.exists():
        return []
        
    # Get all jpgs
    images = sorted([f.name for f in target_dir.glob("*.jpg")])
    
    response_list = []
    for img_name in images:
        # Check if labeled
        json_path = labeled_dir / f"{Path(img_name).stem}.json"
        
        status = "untouched"
        cow_ids = []
        box_count = 0
        
        if json_path.exists():
            with open(json_path, "r") as f:
                data = json.load(f)
                annots = data.get("annotations", [])
                box_count = len(annots)
                labeled_count = sum(1 for a in annots if a.get("status") == "labeled")
                
                if labeled_count == box_count and box_count > 0:
                    status = "completed"
                elif labeled_count > 0:
                    status = "in_progress"
                else:
                    status = "touched" # Saved but no IDs yet
                
                cow_ids = [a.get("cow_id") for a in annots if a.get("cow_id")]
        
        else:
            # Check original label count
            txt_path = ds_path / "labels" / split.value / f"{Path(img_name).stem}.txt"
            if txt_path.exists():
                with open(txt_path, "r") as f:
                    box_count = sum(1 for line in f if line.strip())
        
        response_list.append({
            "filename": img_name,
            "status": status,
            "total_boxes": box_count,
            "labeled_ids": cow_ids
        })
        
    return response_list

@app.get("/api/image_file/{dataset_name}/{split}/{filename}")
def get_image_file(dataset_name: str, split: SplitEnum, filename: str):
    """Serves the raw image file."""
    ds_path = get_dataset_path(dataset_name)
    file_path = ds_path / "images" / split.value / filename
    if file_path.exists():
        return FileResponse(file_path)
    raise HTTPException(status_code=404, detail="Image not found")

@app.get("/api/annotation/{dataset_name}/{split}/{filename}")
def get_annotation(dataset_name: str, split: SplitEnum, filename: str):
    """Gets annotation data. Prioritizes JSON, falls back to YOLO txt."""
    
    # 1. Try Loading Saved JSON
    saved = get_saved_annotation(dataset_name, split.value, filename)
    if saved:
        return saved
    
    # 2. Fallback to calculating from YOLO txt
    from PIL import Image
    ds_path = get_dataset_path(dataset_name)
    img_path = ds_path / "images" / split.value / filename
    
    if not img_path.exists():
        raise HTTPException(status_code=404, detail="Image not found")
    
    with Image.open(img_path) as img:
        width, height = img.size
        
    yolo_boxes = get_yolo_labels(dataset_name, split.value, filename)
    
    return ImageAnnotation(
        dataset=dataset_name,
        filename=filename,
        split=split.value,
        width=width,
        height=height,
        annotations=yolo_boxes
    )

@app.post("/api/save/{dataset_name}/{split}/{filename}")
def save_annotation(dataset_name: str, split: SplitEnum, filename: str, data: ImageAnnotation = Body(...)):
    """Saves the current state to JSON."""
    ds_path = get_dataset_path(dataset_name)
    save_dir = ds_path / "labeled_data" / split.value
    # Ensure it exists
    save_dir.mkdir(parents=True, exist_ok=True)
    
    json_path = save_dir / f"{Path(filename).stem}.json"
    
    with open(json_path, "w") as f:
        json.dump(data.dict(), f, indent=2)
        
    return {"status": "success", "file": str(json_path)}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
