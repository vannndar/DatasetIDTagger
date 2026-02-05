
// --- Global State ---
const state = {
    currentDataset: null,
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

const keysPressed = {}; // Track held keys for smooth movement

const canvas = document.getElementById('main-canvas');
const ctx = canvas.getContext('2d');
const container = document.getElementById('canvas-container');

// --- Initialization ---
async function init() {
    await fetchDatasets();
    window.addEventListener('resize', handleResize);
    handleResize();

    // Event Listeners
    container.addEventListener('wheel', handleWheel, { passive: false });
    container.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    // Global Hotkeys
    window.addEventListener('keydown', handleGlobalKeydown);
    window.addEventListener('keyup', (e) => {
        keysPressed[e.key] = false;
        // Also clear Ctrl if released
        if (e.key === 'Control') keysPressed['Control'] = false;
    });

    // Start Animation Loop for smooth panning
    requestAnimationFrame(updateLoop);

    // Input specific logic
    const input = document.getElementById('cow-id-input');
    input.addEventListener('keydown', (e) => {
        // We stop propagation so global keys don't trigger (like WASD typing)
        // BUT we need to handle Tab explicitly here.
        e.stopPropagation();

        if (e.key === 'Enter') {
            editor.confirmID();
        } else if (e.key === 'Escape') {
            editor.cancelID();
        } else if (e.key === 'Tab') {
            e.preventDefault(); // Stop creating a tab character or moving focus naturally
            const idx = state.selectedBoxIndex; // Capture before save wipes it
            editor.confirmID(); // Save whatever is there
            cycleSelection(e.shiftKey ? -1 : 1, idx); // Move to next box using preserved index
        }
    });
}

function updateLoop() {
    if (state.currentDataset && document.getElementById('app').style.display !== 'none') {
        let dx = 0;
        let dy = 0;
        const speed = 10; // Pixels per frame - smooth!

        // Panning Logic (WASD or Ctrl+Arrows)
        const isCtrl = keysPressed['Control'];

        if (keysPressed['w'] || keysPressed['W'] || (isCtrl && keysPressed['ArrowUp'])) {
            dy += speed;
        }
        if (keysPressed['s'] || keysPressed['S'] || (isCtrl && keysPressed['ArrowDown'])) {
            dy -= speed;
        }
        if (keysPressed['a'] || keysPressed['A'] || (isCtrl && keysPressed['ArrowLeft'])) {
            dx += speed;
        }
        if (keysPressed['d'] || keysPressed['D'] || (isCtrl && keysPressed['ArrowRight'])) {
            dx -= speed;
        }

        if (dx !== 0 || dy !== 0) {
            panView(dx, dy);
        }
    }
    requestAnimationFrame(updateLoop);
}

function handleGlobalKeydown(e) {
    keysPressed[e.key] = true;
    if (e.key === 'Control') keysPressed['Control'] = true;

    if (!state.currentDataset || document.getElementById('app').style.display === 'none') return;

    // Ignore if input is focused (handled separately)
    if (document.activeElement === document.getElementById('cow-id-input')) return;

    // --- Navigation (Images) ---
    if (e.key === 'ArrowRight' && !e.ctrlKey) {
        e.preventDefault();
        loadNextImage();
    } else if (e.key === 'ArrowLeft' && !e.ctrlKey) {
        e.preventDefault();
        loadPrevImage();
    }

    // --- Zoom ---
    else if (e.key === 'ArrowUp' && !e.ctrlKey) {
        e.preventDefault();
        window.editor.zoomIn();
    } else if (e.key === 'ArrowDown' && !e.ctrlKey) {
        e.preventDefault();
        window.editor.zoomOut();
    }

    // --- Fit View ---
    else if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        window.editor.resetView();
    }

    // --- Selection (Tab) ---
    else if (e.key === 'Tab') {
        e.preventDefault();
        cycleSelection(e.shiftKey ? -1 : 1);
    }

    // --- Save ---
    else if (e.ctrlKey && e.key === 's') {
        e.preventDefault();
        editor.saveCurrent();
    }

    // Note: Panning is handled in updateLoop via keysPressed
}

function panView(dx, dy) {
    state.offsetX += dx;
    state.offsetY += dy;
    renderCanvas();
}

function loadNextImage() {
    if (state.currentImageIndex < state.imageList.length - 1) {
        loadEditor(state.currentImageIndex + 1);
    }
}

function loadPrevImage() {
    if (state.currentImageIndex > 0) {
        loadEditor(state.currentImageIndex - 1);
    }
}

function cycleSelection(direction, overrideStartIndex = null) {
    if (!state.annotationData || !state.annotationData.annotations.length) return;

    const annots = state.annotationData.annotations;

    // Sort boxes from left to right for logical tabbing
    // We create a temporary array of indices with their X positions
    const sortedIndices = annots.map((box, i) => ({
        index: i,
        x: box.yolo[0] // x_center
    })).sort((a, b) => a.x - b.x);

    // Find current index in this sorted list
    let currentSortedIdx = -1;
    let startIdx = (overrideStartIndex !== null) ? overrideStartIndex : state.selectedBoxIndex;

    if (startIdx !== -1) {
        currentSortedIdx = sortedIndices.findIndex(item => item.index === startIdx);
    }

    let nextSortedIdx = currentSortedIdx + direction;

    // Wrap around? Or stop? Let's wrap
    if (nextSortedIdx >= sortedIndices.length) nextSortedIdx = 0;
    if (nextSortedIdx < 0) nextSortedIdx = sortedIndices.length - 1;

    const targetRealIndex = sortedIndices[nextSortedIdx].index;

    // Calculate click coordinates for the box to properly position input
    // We need 'screen' coordinates for the input box
    const box = annots[targetRealIndex];
    if (state.imgObj) {
        const iw = state.imgObj.width;
        const ih = state.imgObj.height;
        const [xc, yc, w, h] = box.yolo;

        // Center of box in canvas coords
        const px = (xc * iw * state.scale) + state.offsetX;
        const py = (yc * ih * state.scale) + state.offsetY;

        // Add canvas container offset
        const rect = container.getBoundingClientRect();
        const clientX = rect.left + px;
        const clientY = rect.top + py;

        selectBox(targetRealIndex, clientX, clientY);
    }
}

// --- API & State ---

async function fetchDatasets() {
    try {
        const res = await fetch('/api/datasets');
        const datasets = await res.json();

        const grid = document.getElementById('dataset-grid');
        grid.innerHTML = '';

        if (datasets.length === 0) {
            grid.innerHTML = '<div style="color:#e0e0e0;">No datasets found in dataset/ folder. (Must end with _dataset)</div>';
        }

        datasets.forEach(ds => {
            const card = document.createElement('div');
            card.className = 'dataset-card';
            card.innerHTML = `
                <div class="ds-title">${ds.name}</div>
                <div class="ds-stat">${ds.image_count} Images</div>
            `;
            card.onclick = () => loadDataset(ds.name);
            grid.appendChild(card);
        });
    } catch (err) {
        console.error("Failed to load datasets", err);
        document.getElementById('dataset-grid').innerHTML = '<div style="color:red;">Failed to load datasets from API.</div>';
    }
}

function loadDataset(name) {
    state.currentDataset = name;
    document.getElementById('dataset-picker').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    handleResize();
    fetchImageList('train');
}

function exitToHome() {
    state.currentDataset = null;
    document.getElementById('app').style.display = 'none';
    document.getElementById('dataset-picker').style.display = 'flex';
    fetchDatasets();
}

async function fetchImageList(split) {
    if (!state.currentDataset) return;

    state.currentSplit = split;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelector(`.tab[onclick*="${split}"]`).classList.add('active');

    document.getElementById('image-list').innerHTML = '<div style="padding:10px; color:#888;">Loading images...</div>';

    try {
        const res = await fetch(`/api/images/${state.currentDataset}/${split}`);
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

        // Adding a thumbnail placeholder or something to make it look like "Gallery"?
        // User asked "Where is mode gallery".
        // Let's stick to list but maybe call it "Gallery Panel"

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
        `DS: ${state.currentDataset} | Total: ${total} | Done: ${completed} | WiP: ${prog}`;
}

async function loadEditor(index) {
    if (index < 0 || index >= state.imageList.length) return;

    state.currentImageIndex = index;
    renderGallery();

    // Scroll active item into view
    const activeEl = document.querySelector('.img-item.active');
    if (activeEl) {
        activeEl.scrollIntoView({ behavior: 'auto', block: 'center' });
    }

    const item = state.imageList[index];
    document.getElementById('current-filename').innerText = item.filename;

    const imgUrl = `/api/image_file/${state.currentDataset}/${state.currentSplit}/${item.filename}`;
    const img = new Image();
    img.src = imgUrl;
    img.onload = () => {
        state.imgObj = img;
        fitImageToScreen();
        renderCanvas();
    };

    const annotRes = await fetch(`/api/annotation/${state.currentDataset}/${state.currentSplit}/${item.filename}`);
    state.annotationData = await annotRes.json();

    // Sort logic for tab is calculated on fly, so no need to sort data structure
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

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.translate(state.offsetX, state.offsetY);
    ctx.scale(state.scale, state.scale);

    ctx.drawImage(state.imgObj, 0, 0);

    if (state.annotationData && state.annotationData.annotations) {
        const iw = state.imgObj.width;
        const ih = state.imgObj.height;

        state.annotationData.annotations.forEach((box, idx) => {
            const [xc, yc, w, h] = box.yolo;

            const px = (xc - w / 2) * iw;
            const py = (yc - h / 2) * ih;
            const pw = w * iw;
            const ph = h * ih;

            ctx.lineWidth = 2 / state.scale;

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
                ctx.strokeStyle = '#ffa726';
                ctx.fillStyle = 'rgba(0,0,0,0)';
            }

            ctx.fillRect(px, py, pw, ph);
            ctx.strokeRect(px, py, pw, ph);

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

function handleWheel(e) {
    if (!state.imgObj) return;
    e.preventDefault();

    const zoomIntensity = 0.1;
    const direction = e.deltaY < 0 ? 1 : -1;
    const factor = 1 + (direction * zoomIntensity);

    const mouseX = e.offsetX;
    const mouseY = e.offsetY;

    const worldX = (mouseX - state.offsetX) / state.scale;
    const worldY = (mouseY - state.offsetY) / state.scale;

    let newScale = state.scale * factor;
    newScale = Math.max(0.05, Math.min(10, newScale));

    state.offsetX = mouseX - worldX * newScale;
    state.offsetY = mouseY - worldY * newScale;
    state.scale = newScale;

    updateZoomDisplay();
    renderCanvas();

    // Don't close input if we are just scrolling? Better to close to avoid detached input
    document.getElementById('id-input-box').style.display = 'none';
}

function handleMouseDown(e) {
    // Ignore clicks inside the input box or toolbar
    if (e.target.closest('#id-input-box') || e.target.closest('#toolbar')) return;

    if (e.button === 0) {
        if (state.hoveredBoxIndex !== -1) {
            selectBox(state.hoveredBoxIndex, e.clientX, e.clientY);
        } else {
            state.isDragging = true;
            state.lastMouseX = e.clientX;
            state.lastMouseY = e.clientY;

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
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        const imgX = (mx - state.offsetX) / state.scale;
        const imgY = (my - state.offsetY) / state.scale;

        const iw = state.imgObj.width;
        const ih = state.imgObj.height;

        let found = -1;
        if (state.annotationData && state.annotationData.annotations) {
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

    inputContainer.style.display = 'block';

    // Get relative to container
    const rect = container.getBoundingClientRect();
    let left = clientX - rect.left + 20;
    let top = clientY - rect.top;

    // Bounds check to keep input on screen
    if (left + 150 > rect.width) left = clientX - rect.left - 150;
    if (top + 60 > rect.height) top = clientY - rect.top - 60;

    inputContainer.style.left = left + 'px';
    inputContainer.style.top = top + 'px';

    // Autofocus
    setTimeout(() => {
        inputField.focus();
        inputField.select(); // Select all text so user can overwrite ID easily
    }, 10);
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
        // If nothing selected, maybe we were called via Enter key on global?
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
            const url = `/api/save/${state.currentDataset}/${state.currentSplit}/${state.annotationData.filename}`;
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(state.annotationData)
            });
            const json = await res.json();

            if (json.status === 'success') {
                btn.innerText = "Saved!";
                setTimeout(() => btn.innerText = originalText, 1000);

                const item = state.imageList[state.currentImageIndex];

                const annots = state.annotationData.annotations;
                const labeled = annots.filter(a => a.status === 'labeled');
                item.labeled_ids = labeled.map(a => a.cow_id);
                item.total_boxes = annots.length;

                if (labeled.length === annots.length && annots.length > 0) item.status = 'completed';
                else if (labeled.length > 0) item.status = 'in_progress';
                else item.status = 'touched';

                renderGallery();
            }
        } catch (e) {
            alert('Save failed: ' + e);
            btn.innerText = originalText;
        }
    }
};

function switchTab(split) {
    if (state.currentDataset) {
        fetchImageList(split);
    }
}

function updateZoomDisplay() {
    document.getElementById('zoom-level').innerText = Math.round(state.scale * 100) + '%';
}

// Start
init();
