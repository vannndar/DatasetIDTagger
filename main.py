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
# Script is now running INSIDE the dataset folder
DATASET_ROOT = Path(".") 
IMAGES_DIR = DATASET_ROOT / "images"
LABELS_DIR = DATASET_ROOT / "labels"
# We save our augmented/tagged data here
LABELED_DATA_DIR = DATASET_ROOT / "labeled_data"

# Ensure output directory exists
LABELED_DATA_DIR.mkdir(parents=True, exist_ok=True)
(LABELED_DATA_DIR / "train").mkdir(exist_ok=True)
(LABELED_DATA_DIR / "val").mkdir(exist_ok=True)

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
    filename: str
    split: str
    width: int
    height: int
    annotations: List[BBox]

# --- Helper Functions ---
def get_yolo_labels(split: str, filename: str) -> List[BBox]:
    """Reads original YOLO .txt file and converts to BBox objects."""
    txt_path = LABELS_DIR / split / f"{Path(filename).stem}.txt"
    bboxes = []
    if txt_path.exists():
        with open(txt_path, "r") as f:
            for line in f:
                parts = line.strip().split()
                if len(parts) >= 5:
                    # YOLO: class x y w h ...keypoints...
                    # We only care about box first
                    # Skipping keypoints for now in this visualization usage, 
                    # but we preserve them if we were to rewrite txt (which we aren't, we write json)
                    
                    bbox = [float(x) for x in parts[1:5]]
                    bboxes.append(BBox(yolo=bbox, status="unknown", cow_id=None))
    return bboxes

def get_saved_annotation(split: str, filename: str) -> Optional[ImageAnnotation]:
    """Checks if we already have a JSON file for this image."""
    json_path = LABELED_DATA_DIR / split / f"{Path(filename).stem}.json"
    if json_path.exists():
        with open(json_path, "r") as f:
            data = json.load(f)
            # Validate/Convert to Pydantic model
            return ImageAnnotation(**data)
    return None

# --- API Endpoints ---

@app.get("/")
def read_root(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

@app.get("/api/images/{split}")
def list_images(split: SplitEnum):
    """Returns list of image filenames for a split, with tagging status."""
    target_dir = IMAGES_DIR / split.value
    if not target_dir.exists():
        return []
        
    # Get all jpgs
    images = sorted([f.name for f in target_dir.glob("*.jpg")])
    
    response_list = []
    for img_name in images:
        # Check if labeled
        json_path = LABELED_DATA_DIR / split.value / f"{Path(img_name).stem}.json"
        
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
            txt_path = LABELS_DIR / split.value / f"{Path(img_name).stem}.txt"
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

@app.get("/api/image_file/{split}/{filename}")
def get_image_file(split: SplitEnum, filename: str):
    """Serves the raw image file."""
    file_path = IMAGES_DIR / split.value / filename
    if file_path.exists():
        return FileResponse(file_path)
    raise HTTPException(status_code=404, detail="Image not found")

@app.get("/api/annotation/{split}/{filename}")
def get_annotation(split: SplitEnum, filename: str):
    """Gets annotation data. Prioritizes JSON, falls back to YOLO txt."""
    
    # 1. Try Loading Saved JSON
    saved = get_saved_annotation(split.value, filename)
    if saved:
        return saved
    
    # 2. Fallback to calculating from YOLO txt + calculating dimensions logic?
    # Ideally frontend loads image first to calculate W/H, but we can do a quick check if needed.
    # For now, we will return a partial structure and let frontend fill W/H if missing, 
    # OR we open image here to check dim (slower but safer)
    
    from PIL import Image
    img_path = IMAGES_DIR / split.value / filename
    if not img_path.exists():
        raise HTTPException(status_code=404, detail="Image not found")
    
    with Image.open(img_path) as img:
        width, height = img.size
        
    yolo_boxes = get_yolo_labels(split.value, filename)
    
    return ImageAnnotation(
        filename=filename,
        split=split.value,
        width=width,
        height=height,
        annotations=yolo_boxes
    )

@app.post("/api/save/{split}/{filename}")
def save_annotation(split: SplitEnum, filename: str, data: ImageAnnotation = Body(...)):
    """Saves the current state to JSON."""
    json_path = LABELED_DATA_DIR / split.value / f"{Path(filename).stem}.json"
    
    with open(json_path, "w") as f:
        json.dump(data.dict(), f, indent=2)
        
    return {"status": "success", "file": str(json_path)}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
