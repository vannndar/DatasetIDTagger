
// --- Global State ---
const state = {
    currentSplit: 'train', // 'train' or 'val'
    imageList: [],
    currentImageIndex: -1,

    // Editor State
    imgObj: null, // HTMLImageElement
    annotationData: null,

    // Viewport
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    isDragging: false,
    lastMouseX: 0,
    lastMouseY: 0,

    // Interactivity
    hoveredBoxIndex: -1,
    selectedBoxIndex: -1,
};

const canvas = document.getElementById('main-canvas');
const ctx = canvas.getContext('2d');
const container = document.getElementById('canvas-container');

// --- Initialization ---
async function init() {
    await fetchImageList('train');
    window.addEventListener('resize', handleResize);
    handleResize();

    // Event Listeners
    container.addEventListener('wheel', handleWheel, { passive: false });
    container.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    // Hotkeys
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.key === 's') {
            e.preventDefault();
            editor.saveCurrent();
        }
    });

    // Input Enter key
    document.getElementById('cow-id-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') editor.confirmID();
    });
}

async function fetchImageList(split) {
    state.currentSplit = split;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelector(`.tab[onclick*="${split}"]`).classList.add('active');

    document.getElementById('image-list').innerHTML = '<div style="padding:10px; color:#888;">Loading images...</div>';

    try {
        const res = await fetch(`/api/images/${split}`);
        state.imageList = await res.json();
        renderGallery();
        updateStatusBar();
    } catch (err) {
        console.error("Failed to load list", err);
    }
}

function renderGallery() {
    const listEl = document.getElementById('image-list');
    listEl.innerHTML = '';

    state.imageList.forEach((item, idx) => {
        const div = document.createElement('div');
        div.className = `img-item ${item.status}`;
        if (idx === state.currentImageIndex) div.classList.add('active');

        let idSubset = item.labeled_ids.slice(0, 3).join(', ');
        if (item.labeled_ids.length > 3) idSubset += ` +${item.labeled_ids.length - 3}`;
        if (!idSubset) idSubset = "Unknown";

        div.innerHTML = `
            <div style="font-weight:500;">${item.filename}</div>
            <div class="img-meta">
                <span>Boxes: ${item.total_boxes}</span>
                <span title="${item.labeled_ids.join('\n')}">${idSubset}</span>
            </div>
        `;
        div.onclick = () => loadEditor(idx);
        listEl.appendChild(div);
    });
}

function updateStatusBar() {
    const total = state.imageList.length;
    const completed = state.imageList.filter(i => i.status === 'completed').length;
    const prog = state.imageList.filter(i => i.status === 'in_progress').length;
    document.getElementById('status-bar').innerText =
        `Total: ${total} | Done: ${completed} | WiP: ${prog}`;
}

async function loadEditor(index) {
    if (index < 0 || index >= state.imageList.length) return;

    // Save previous if needed? (We rely on manual save for now)

    state.currentImageIndex = index;
    renderGallery(); // Update active highlight

    const item = state.imageList[index];
    document.getElementById('current-filename').innerText = item.filename;

    // Load Image
    const imgUrl = `/api/image_file/${state.currentSplit}/${item.filename}`;
    const img = new Image();
    img.src = imgUrl;
    img.onload = () => {
        state.imgObj = img;
        state.scale = 1; // Reset zoom logic? Or keep fit
        state.offsetX = 0;
        state.offsetY = 0;
        fitImageToScreen();
        renderCanvas();
    };

    // Load Annotations
    const annotRes = await fetch(`/api/annotation/${state.currentSplit}/${item.filename}`);
    state.annotationData = await annotRes.json();
    renderCanvas();
}

// --- Canvas Logic ---

function handleResize() {
    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;
    renderCanvas();
}

function fitImageToScreen() {
    if (!state.imgObj) return;
    const scaleX = canvas.width / state.imgObj.width;
    const scaleY = canvas.height / state.imgObj.height;
    state.scale = Math.min(scaleX, scaleY) * 0.9;

    // Center it
    state.offsetX = (canvas.width - state.imgObj.width * state.scale) / 2;
    state.offsetY = (canvas.height - state.imgObj.height * state.scale) / 2;
    updateZoomDisplay();
}

function renderCanvas() {
    if (!state.imgObj) return;

    // Clear
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.translate(state.offsetX, state.offsetY);
    ctx.scale(state.scale, state.scale);

    // Draw Image (High Res)
    ctx.drawImage(state.imgObj, 0, 0);

    // Draw Boxes
    if (state.annotationData && state.annotationData.annotations) {
        const iw = state.imgObj.width;
        const ih = state.imgObj.height;

        state.annotationData.annotations.forEach((box, idx) => {
            // YOLO is x_center, y_center, w, h normalized
            const [xc, yc, w, h] = box.yolo;

            const px = (xc - w / 2) * iw;
            const py = (yc - h / 2) * ih;
            const pw = w * iw;
            const ph = h * ih;

            // Style
            ctx.lineWidth = 2 / state.scale; // Maintain visual thickness

            if (idx === state.selectedBoxIndex) {
                ctx.strokeStyle = '#00ff00';
                ctx.fillStyle = 'rgba(0, 255, 0, 0.2)';
            } else if (idx === state.hoveredBoxIndex) {
                ctx.strokeStyle = '#ffffff';
                ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
            } else if (box.status === 'labeled') {
                ctx.strokeStyle = '#4a90e2';
                ctx.fillStyle = 'rgba(74, 144, 226, 0.1)';
            } else {
                ctx.strokeStyle = '#ffa726'; // Unknown
                ctx.fillStyle = 'rgba(0,0,0,0)';
            }

            ctx.fillRect(px, py, pw, ph);
            ctx.strokeRect(px, py, pw, ph);

            // Draw Label
            if (idx === state.selectedBoxIndex || box.cow_id) {
                ctx.font = `${20 / state.scale}px Arial`;
                ctx.fillStyle = idx === state.selectedBoxIndex ? '#00ff00' : '#4a90e2';
                const text = box.cow_id ? `ID: ${box.cow_id}` : "Unknown";
                ctx.fillText(text, px, py - 5 / state.scale);
            }
        });
    }

    ctx.restore();
}

// --- Interaction Handlers ---

function handleWheel(e) {
    if (!state.imgObj) return;
    e.preventDefault();

    const zoomIntensity = 0.1;
    const direction = e.deltaY < 0 ? 1 : -1;
    const factor = 1 + (direction * zoomIntensity);

    // Zoom towards mouse pointer
    const mouseX = e.offsetX;
    const mouseY = e.offsetY;

    // Convert mouse to world space
    const worldX = (mouseX - state.offsetX) / state.scale;
    const worldY = (mouseY - state.offsetY) / state.scale;

    // Apply Zoom
    let newScale = state.scale * factor;
    newScale = Math.max(0.05, Math.min(10, newScale)); // Limits

    // Adjust Offset to keep mouse point stable
    state.offsetX = mouseX - worldX * newScale;
    state.offsetY = mouseY - worldY * newScale;
    state.scale = newScale;

    updateZoomDisplay();
    renderCanvas();

    // Hide input if zooming
    document.getElementById('id-input-box').style.display = 'none';
}

function handleMouseDown(e) {
    if (e.button === 0) { // Left Click
        if (state.hoveredBoxIndex !== -1) {
            // Select Box
            selectBox(state.hoveredBoxIndex, e.clientX, e.clientY);
        } else {
            // Start Drag
            state.isDragging = true;
            state.lastMouseX = e.clientX;
            state.lastMouseY = e.clientY;

            // Deselect
            state.selectedBoxIndex = -1;
            document.getElementById('id-input-box').style.display = 'none';
            renderCanvas();
        }
    }
}

function handleMouseMove(e) {
    if (!state.imgObj) return;

    if (state.isDragging) {
        const dx = e.clientX - state.lastMouseX;
        const dy = e.clientY - state.lastMouseY;
        state.offsetX += dx;
        state.offsetY += dy;
        state.lastMouseX = e.clientX;
        state.lastMouseY = e.clientY;
        renderCanvas();
    } else {
        // Warning: Heavy hit detection on mouse move?
        // Optimization: Debounce mousemove?
        // Convert mouse to Image Space
        // Canvas Rect
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        const imgX = (mx - state.offsetX) / state.scale;
        const imgY = (my - state.offsetY) / state.scale;

        const iw = state.imgObj.width;
        const ih = state.imgObj.height;

        let found = -1;
        if (state.annotationData && state.annotationData.annotations) {
            // Iterate backwards to find top-most
            for (let i = state.annotationData.annotations.length - 1; i >= 0; i--) {
                const box = state.annotationData.annotations[i];
                const [xc, yc, w, h] = box.yolo;

                const x1 = (xc - w / 2) * iw;
                const y1 = (yc - h / 2) * ih;
                const x2 = x1 + (w * iw);
                const y2 = y1 + (h * ih);

                if (imgX >= x1 && imgX <= x2 && imgY >= y1 && imgY <= y2) {
                    found = i;
                    break;
                }
            }
        }

        if (found !== state.hoveredBoxIndex) {
            state.hoveredBoxIndex = found;
            canvas.style.cursor = found !== -1 ? 'pointer' : 'default';
            renderCanvas();
        }
    }
}

function handleMouseUp() {
    state.isDragging = false;
}

// --- Functionality Exported to Global ---

function selectBox(index, clientX, clientY) {
    state.selectedBoxIndex = index;
    renderCanvas();

    // Show Input
    const box = state.annotationData.annotations[index];
    const inputContainer = document.getElementById('id-input-box');
    const inputField = document.getElementById('cow-id-input');

    inputField.value = box.cow_id || '';

    // Position input near the mouse click but keep inside viewport
    inputContainer.style.display = 'block';

    // Get relative to container
    const rect = container.getBoundingClientRect();
    let left = clientX - rect.left + 20;
    let top = clientY - rect.top;

    inputContainer.style.left = left + 'px';
    inputContainer.style.top = top + 'px';

    inputField.focus();
}

window.editor = {
    zoomIn: () => {
        state.scale *= 1.2;
        updateZoomDisplay();
        renderCanvas();
    },
    zoomOut: () => {
        state.scale /= 1.2;
        updateZoomDisplay();
        renderCanvas();
    },
    resetView: () => {
        fitImageToScreen();
        renderCanvas();
    },
    confirmID: () => {
        if (state.selectedBoxIndex === -1) return;

        const val = document.getElementById('cow-id-input').value.trim();
        const box = state.annotationData.annotations[state.selectedBoxIndex];

        if (val) {
            box.cow_id = val;
            box.status = 'labeled';
        } else {
            box.cow_id = null;
            box.status = 'unknown';
        }

        document.getElementById('id-input-box').style.display = 'none';
        state.selectedBoxIndex = -1;
        renderCanvas();
    },
    cancelID: () => {
        document.getElementById('id-input-box').style.display = 'none';
        state.selectedBoxIndex = -1;
        renderCanvas();
    },
    saveCurrent: async () => {
        if (!state.annotationData) return;

        const btn = document.querySelector('button.primary');
        const originalText = btn.innerText;
        btn.innerText = "Saving...";

        try {
            const url = `/api/save/${state.currentSplit}/${state.annotationData.filename}`;
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(state.annotationData)
            });
            const json = await res.json();

            if (json.status === 'success') {
                btn.innerText = "Saved!";
                setTimeout(() => btn.innerText = originalText, 1000);

                // Update local list visual immediately
                const item = state.imageList[state.currentImageIndex];

                // Recalculate status locally without refetching entire list to be snappy
                const annots = state.annotationData.annotations;
                const labeled = annots.filter(a => a.status === 'labeled');
                item.labeled_ids = labeled.map(a => a.cow_id);
                item.total_boxes = annots.length;

                if (labeled.length === annots.length && annots.length > 0) item.status = 'completed';
                else if (labeled.length > 0) item.status = 'in_progress';
                else item.status = 'touched';

                renderGallery(); // updates sidebar
            }
        } catch (e) {
            alert('Save failed: ' + e);
            btn.innerText = originalText;
        }
    }
};

function switchTab(split) {
    fetchImageList(split);
}

function updateZoomDisplay() {
    document.getElementById('zoom-level').innerText = Math.round(state.scale * 100) + '%';
}

// Start
init();
