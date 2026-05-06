const toolConfig = {
  merge: {
    title: "Merge PDF",
    description: "Upload multiple PDFs, preview each file, arrange the file order, then generate one merged PDF.",
    hint: "Choose two or more PDFs. Each card represents one complete file.",
    output: "we-love-pdf-merged.pdf",
  },
  split: {
    title: "Split PDF",
    description: "Upload a PDF, create custom or fixed page ranges, preview each range, then generate independent PDF files.",
    hint: "Choose one PDF. Ranges will be shown in the preview.",
    output: "we-love-pdf-split.zip",
  },
  compress: {
    title: "Compress PDF",
    description: "Upload a PDF, review pages, remove anything unnecessary, then generate a compressed output.",
    hint: "Choose one PDF.",
    output: "we-love-pdf-compressed.pdf",
  },
  organize: {
    title: "Organize PDF",
    description: "Upload a PDF, drag pages into order, remove pages, rotate pages, add blank pages, then generate the organized PDF.",
    hint: "Choose one or more PDFs. Page tools appear on each preview card.",
    output: "we-love-pdf-organized.pdf",
  },
  redact: {
    title: "Redact PDF",
    description: "Upload a PDF, search sensitive text, review marked matches, then generate a permanently redacted PDF.",
    hint: "Choose one PDF. Use OCR for scanned pages when available.",
    output: "we-love-pdf-redacted.pdf",
  },
  edit: {
    title: "PDF Editor",
    description: "Upload a PDF, preview and arrange pages, set the edit action, then generate the edited PDF.",
    hint: "Choose one PDF.",
    output: "we-love-pdf-edited.pdf",
  },
  excel: {
    title: "PDF to Excel",
    description: "Upload a PDF, preview the pages, remove anything unnecessary, then generate an Excel workbook.",
    hint: "Choose one PDF. Each selected page becomes one Excel sheet.",
    output: "we-love-pdf-excel.xlsx",
  },
  word: {
    title: "PDF to Word",
    description: "Upload a PDF, preview the pages, remove anything unnecessary, then generate a Word document.",
    hint: "Choose one PDF. Selected pages are converted into an editable Word document.",
    output: "we-love-pdf-word.docx",
  },
  ppt: {
    title: "PDF to PPT",
    description: "Upload a PDF, preview the pages, remove anything unnecessary, then generate a PowerPoint deck.",
    hint: "Choose one PDF. Each selected page becomes one slide.",
    output: "we-love-pdf-ppt.pptx",
  },
};

const state = {
  sessionId: localStorage.getItem("weLovePdfSession") || "",
  activeTool: document.body.dataset.activeTool || "",
  documents: [],
  split: {
    mode: "range",
    rangeMode: "custom",
    pagesMode: "all",
    ranges: [],
  },
  redact: {
    activePage: 1,
    marks: [],
    zoom: 1.25,
  },
  edit: {
    activePage: 1,
    zoom: 1.2,
    action: "text",
    imageData: "",
    objects: [],
    selectedObjectId: "",
    drag: null,
    resize: null,
  },
  organize: {
    blankCount: 0,
  },
};

const statusBox = document.getElementById("status");
const previewGrid = document.getElementById("previewGrid");
const previewEmpty = document.getElementById("previewEmpty");
const pageCount = document.getElementById("pageCount");

async function ensureSession() {
  if (state.sessionId) return state.sessionId;
  const res = await fetch("/api/session", { method: "POST" });
  const data = await res.json();
  state.sessionId = data.sessionId;
  localStorage.setItem("weLovePdfSession", state.sessionId);
  return state.sessionId;
}

function setStatus(message, isError = false) {
  if (!statusBox) return;
  statusBox.textContent = message;
  statusBox.classList.toggle("error", isError);
}

function safeBrowserError(data, fallback) {
  const message = typeof data?.error === "string" ? data.error.trim() : "";
  if (!message) return fallback;
  if (message.length > 160 || /traceback|exception|error:|\/tmp|\\|\/users\//i.test(message)) {
    return fallback;
  }
  return message;
}

function filterTools(category) {
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.filter === category));
  document.querySelectorAll(".tool-card").forEach((card) => {
    card.hidden = category !== "all" && card.dataset.category !== category;
  });
}

function filenameFromResponse(res, fallback) {
  const disposition = res.headers.get("Content-Disposition") || "";
  const match = disposition.match(/filename="?([^"]+)"?/i);
  return match ? match[1] : fallback;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function showCompletionPanel(filename) {
  const modal = document.getElementById("completionModal");
  const message = document.getElementById("completionMessage");
  if (!modal || !message) return;
  message.textContent = `Check your downloads folder for ${filename}.`;
  modal.hidden = false;
  document.getElementById("anotherTaskBtn")?.focus();
}

function handleCompletedDownload(res, blob) {
  const filename = filenameFromResponse(res, toolConfig[state.activeTool].output);
  downloadBlob(blob, filename);
  setStatus("");
  showCompletionPanel(filename);
}

function startAnotherTask() {
  document.getElementById("completionModal").hidden = true;
  clearPreview(true);
  window.location.href = "/";
}

function updatePreviewCount() {
  if (!previewGrid || !pageCount || !previewEmpty) return;
  if (state.activeTool === "redact") {
    const doc = firstDocument();
    const count = doc ? doc.pages.length : 0;
    pageCount.textContent = `${count} ${count === 1 ? "page" : "pages"}`;
    previewEmpty.hidden = count > 0;
    return;
  }
  if (state.activeTool === "edit") {
    const doc = firstDocument();
    const count = doc ? doc.pages.length : 0;
    pageCount.textContent = `${count} ${count === 1 ? "page" : "pages"}`;
    previewEmpty.hidden = count > 0;
    return;
  }
  if (state.activeTool === "organize") {
    const count = previewGrid.querySelectorAll(".organize-card").length;
    pageCount.textContent = `${count} ${count === 1 ? "page" : "pages"}`;
    previewEmpty.hidden = count > 0;
    return;
  }
  const selector = state.activeTool === "merge"
    ? ".merge-card"
    : state.activeTool === "split" && state.split.mode === "range"
      ? ".range-card"
      : state.activeTool === "split"
        ? ".split-card"
        : state.activeTool === "compress"
          ? ".compress-card"
          : state.activeTool === "edit"
            ? ".edit-card"
            : ".thumb";
  const noun = state.activeTool === "merge" ? "file" : state.activeTool === "split" && state.split.mode === "range" ? "range" : "page";
  const count = previewGrid.querySelectorAll(selector).length;
  pageCount.textContent = `${count} ${count === 1 ? noun : `${noun}s`}`;
  previewEmpty.hidden = count > 0;
}

function firstDocument() {
  return state.documents[0] || null;
}

function clampPage(value, total) {
  const page = Number.parseInt(value, 10) || 1;
  return Math.min(Math.max(page, 1), Math.max(total, 1));
}

function createIconButton(className, label, text) {
  const button = document.createElement("button");
  button.className = className;
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.textContent = text;
  return button;
}

function renderDocument(documentData, fileName) {
  if (state.activeTool === "merge") {
    const card = document.createElement("article");
    card.className = "merge-card";
    card.dataset.documentId = documentData.documentId;
    const removeButton = createIconButton("organize-remove", "Remove file", "x");
    const sheet = document.createElement("div");
    sheet.className = "organize-sheet";
    const img = document.createElement("img");
    img.src = `/api/document/${state.sessionId}/${documentData.documentId}/thumbnail/1`;
    img.alt = `${fileName} preview`;
    sheet.append(img);
    const name = document.createElement("strong");
    name.className = "merge-file-name";
    name.textContent = fileName;
    const pageCount = document.createElement("span");
    pageCount.className = "merge-page-count";
    pageCount.textContent = `${documentData.pages.length} ${documentData.pages.length === 1 ? "page" : "pages"}`;
    card.append(removeButton, sheet, name, pageCount);
    removeButton.addEventListener("click", () => {
      card.remove();
      updatePreviewCount();
    });
    previewGrid.append(card);
    updatePreviewCount();
    return;
  }

  if (state.activeTool === "split") {
    initializeSplitRanges(documentData);
    return;
  }

  if (state.activeTool === "redact") {
    initializeRedactViewer(documentData);
    return;
  }

  if (state.activeTool === "edit") {
    initializeEditViewer(documentData);
    return;
  }

  if (state.activeTool === "organize") {
    initializeOrganizer(documentData);
    return;
  }

  if (state.activeTool === "compress") {
    initializePageCardPreview(documentData, state.activeTool);
    return;
  }

  if (state.activeTool === "excel") {
    initializePageCardPreview(documentData, state.activeTool);
    return;
  }

  if (state.activeTool === "word" || state.activeTool === "ppt") {
    initializePageCardPreview(documentData, state.activeTool);
    return;
  }

  documentData.pages.forEach((page) => {
    const card = document.createElement("article");
    card.className = "thumb";
    card.dataset.documentId = documentData.documentId;
    card.dataset.page = page.page;
    const img = document.createElement("img");
    img.src = `/api/document/${state.sessionId}/${documentData.documentId}/thumbnail/${page.page}`;
    img.alt = `${fileName} page ${page.page}`;
    const footer = document.createElement("div");
    footer.className = "thumb-footer";
    const label = document.createElement("span");
    label.textContent = `${fileName} - ${page.page}`;
    const removeButton = createIconButton("remove-page", "Remove page", "x");
    footer.append(label, removeButton);
    card.append(img, footer);
    removeButton.addEventListener("click", () => {
      card.remove();
      updatePreviewCount();
    });
    previewGrid.append(card);
  });
  updatePreviewCount();
}

async function uploadFiles(files) {
  await ensureSession();
  if (!files.length) return;
  const appendUploads = state.activeTool === "organize" || state.activeTool === "merge";
  if (!appendUploads || state.documents.length === 0) {
    clearPreview(false);
  }
  setStatus("Rendering PDF thumbnails...");

  for (const file of files) {
    const formData = new FormData();
    formData.set("sessionId", state.sessionId);
    formData.set("file", file);
    const res = await fetch("/api/document", { method: "POST", body: formData });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: "Upload failed" }));
      setStatus(safeBrowserError(data, "Upload failed. Please check the PDF and try again."), true);
      return;
    }
    const documentData = await res.json();
    documentData.fileName = file.name;
    state.documents.push(documentData);
    renderDocument(documentData, file.name);
  }
  renderUploadedFiles();
  document.querySelector(".tool-sidebar")?.classList.toggle("has-uploaded-files", state.documents.length > 0);
  const input = document.getElementById("toolFiles");
  if (input) input.value = "";

  const message = state.activeTool === "split"
    ? "Preview ready. Adjust ranges, add ranges, or switch to Pages mode."
    : state.activeTool === "redact"
      ? "Preview ready. Search for text to mark it for redaction."
    : state.activeTool === "edit"
      ? "Preview ready. Choose an edit tool, then use the cursor on the PDF page to place it."
    : state.activeTool === "organize"
      ? "Preview ready. Drag pages, rotate pages, remove pages, or add blank pages."
    : state.activeTool === "merge"
      ? "Preview ready. Drag files into the merge order, then generate."
    : state.activeTool === "excel"
      ? "Preview ready. Remove pages you do not need, then generate the Excel workbook."
    : state.activeTool === "word"
      ? "Preview ready. Remove pages you do not need, then generate the Word document."
    : state.activeTool === "ppt"
      ? "Preview ready. Remove pages you do not need, then generate the PowerPoint deck."
    : "Preview ready. Drag pages into order, remove unwanted pages, then generate.";
  setStatus(message);
}

function selectedDocuments() {
  return Array.from(previewGrid.querySelectorAll(".merge-card")).map((card) => card.dataset.documentId);
}

function selectedPages() {
  if (state.activeTool === "edit") {
    const doc = firstDocument();
    return doc ? doc.pages.map((page) => ({ documentId: doc.documentId, page: page.page })) : [];
  }
  return Array.from(previewGrid.querySelectorAll(".thumb, .split-card, .compress-card, .edit-card, .excel-card, .word-card, .ppt-card")).map((thumb) => ({
    documentId: thumb.dataset.documentId,
    page: Number(thumb.dataset.page),
  }));
}

function initializePageCardPreview(documentData, toolName) {
  documentData.pages.forEach((page) => {
    const card = document.createElement("article");
    card.className = `${toolName}-card`;
    card.dataset.documentId = documentData.documentId;
    card.dataset.page = page.page;
    card.innerHTML = `
      <button class="organize-remove" type="button" aria-label="Remove page">x</button>
      <div class="organize-sheet">
        <img src="${pageThumb(documentData, page.page)}" alt="Page ${page.page}">
      </div>
      <strong class="organize-number">${page.page}</strong>
    `;
    card.querySelector(".organize-remove").addEventListener("click", () => {
      card.remove();
      updatePreviewCount();
    });
    previewGrid.append(card);
  });
  updatePreviewCount();
}

function initializeOrganizer(documentData) {
  previewGrid.querySelector(".organize-add-card")?.remove();
  documentData.pages.forEach((page) => {
    previewGrid.append(createOrganizerCard({
      type: "page",
      documentId: documentData.documentId,
      page: page.page,
      rotation: 0,
      width: page.width,
      height: page.height,
      thumbnail: pageThumb(documentData, page.page),
      label: `Page ${page.page}`,
    }));
  });
  addOrganizerBlankButton();
  updateOrganizerNumbers();
  updatePreviewCount();
}

function renderUploadedFiles() {
  const panel = document.getElementById("uploadedFilesPanel");
  const list = document.getElementById("uploadedFileList");
  if (!panel || !list) return;
  panel.hidden = state.documents.length === 0;
  list.innerHTML = "";
  state.documents.forEach((doc, index) => {
    const row = document.createElement("div");
    row.className = "uploaded-file-row";
    const dragHandle = document.createElement("span");
    dragHandle.textContent = "↕";
    const name = document.createElement("strong");
    name.textContent = `${String.fromCharCode(65 + index)}: ${doc.fileName || "Uploaded PDF"}`;
    row.append(dragHandle, name);
    list.append(row);
  });
}

function createOrganizerCard(data) {
  const card = document.createElement("article");
  card.className = "organize-card";
  card.dataset.type = data.type;
  card.dataset.rotation = String(data.rotation || 0);
  card.dataset.width = String(data.width || 595);
  card.dataset.height = String(data.height || 842);
  if (data.documentId) card.dataset.documentId = data.documentId;
  if (data.page) card.dataset.page = String(data.page);
  card.innerHTML = `
    <button class="organize-remove" type="button" aria-label="Remove page">x</button>
    <button class="organize-rotate" type="button" aria-label="Rotate page">↻</button>
    <div class="organize-sheet ${data.type === "blank" ? "blank-sheet" : ""}">
      ${data.thumbnail ? `<img src="${data.thumbnail}" alt="${data.label}">` : `<span>Blank</span>`}
    </div>
    <strong class="organize-number"></strong>
    <button class="organize-add-after" type="button" aria-label="Add blank page after this page">+</button>
  `;
  card.querySelector(".organize-remove").addEventListener("click", () => {
    card.remove();
    updateOrganizerNumbers();
    updatePreviewCount();
  });
  card.querySelector(".organize-rotate").addEventListener("click", () => {
    const next = (Number(card.dataset.rotation || 0) + 90) % 360;
    card.dataset.rotation = String(next);
    card.querySelector(".organize-sheet").style.transform = `rotate(${next}deg)`;
  });
  card.querySelector(".organize-add-after").addEventListener("click", () => insertBlankAfter(card));
  return card;
}

function insertBlankAfter(card) {
  state.organize.blankCount += 1;
  const width = Number(card?.dataset.width || 595);
  const height = Number(card?.dataset.height || 842);
  const blank = createOrganizerCard({
    type: "blank",
    rotation: 0,
    width,
    height,
    label: `Blank ${state.organize.blankCount}`,
  });
  if (card) {
    card.after(blank);
  } else {
    previewGrid.append(blank);
  }
  updateOrganizerNumbers();
  updatePreviewCount();
}

function addOrganizerBlankButton() {
  const button = document.createElement("button");
  button.className = "organize-add-card";
  button.type = "button";
  button.textContent = "+ Add blank page";
  button.addEventListener("click", () => {
    const cards = previewGrid.querySelectorAll(".organize-card");
    insertBlankAfter(cards[cards.length - 1] || null);
  });
  previewGrid.append(button);
}

function updateOrganizerNumbers() {
  Array.from(previewGrid.querySelectorAll(".organize-card")).forEach((card, index) => {
    card.querySelector(".organize-number").textContent = String(index + 1);
  });
}

function organizerItems() {
  return Array.from(previewGrid.querySelectorAll(".organize-card")).map((card) => ({
    type: card.dataset.type,
    documentId: card.dataset.documentId,
    page: Number(card.dataset.page || 0),
    rotation: Number(card.dataset.rotation || 0),
    width: Number(card.dataset.width || 595),
    height: Number(card.dataset.height || 842),
  }));
}

function initializeSplitRanges(documentData) {
  state.split.mode = "range";
  state.split.rangeMode = "custom";
  state.split.pagesMode = "all";
  const total = documentData.pages.length;
  state.split.ranges = [{ from: 1, to: total }];
  syncSplitControls();
  renderSplitPreview();
}

function pageThumb(documentData, pageNumber) {
  return `/api/document/${state.sessionId}/${documentData.documentId}/thumbnail/${pageNumber}`;
}

function renderSplitPreview() {
  const doc = firstDocument();
  previewGrid.innerHTML = "";
  if (!doc) {
    updatePreviewCount();
    return;
  }

  if (state.split.mode === "pages") {
    doc.pages.forEach((page) => {
      const card = document.createElement("article");
      card.className = "split-card";
      card.dataset.documentId = doc.documentId;
      card.dataset.page = page.page;
      card.innerHTML = `
        <button class="organize-remove" type="button" aria-label="Remove page">x</button>
        <div class="organize-sheet">
          <img src="${pageThumb(doc, page.page)}" alt="Page ${page.page}">
        </div>
        <strong class="organize-number">${page.page}</strong>
      `;
      card.querySelector(".organize-remove").addEventListener("click", () => {
        card.remove();
        updatePreviewCount();
      });
      previewGrid.append(card);
    });
    updatePreviewCount();
    return;
  }

  const ranges = splitRangesFromState();
  ranges.forEach((range, index) => {
    const from = range.from;
    const to = range.to;
    const card = document.createElement("article");
    card.className = "range-card";
    card.innerHTML = `
      <div class="range-title">Range ${index + 1}</div>
      <div class="range-box">
        <div class="range-page">
          <img src="${pageThumb(doc, from)}" alt="Range ${index + 1} from page ${from}">
          <span>${from}</span>
        </div>
        <strong class="range-ellipsis">...</strong>
        <div class="range-page">
          <img src="${pageThumb(doc, to)}" alt="Range ${index + 1} to page ${to}">
          <span>${to}</span>
        </div>
      </div>
    `;
    previewGrid.append(card);
  });
  updatePreviewCount();
}

function renderRangeControls() {
  const list = document.getElementById("rangeList");
  if (!list) return;
  const doc = firstDocument();
  const total = doc ? doc.pages.length : 1;
  list.innerHTML = "";
  state.split.ranges.forEach((range, index) => {
    const row = document.createElement("div");
    row.className = "range-control";
    row.innerHTML = `
      <div class="range-control-head">
        <strong>Range ${index + 1}</strong>
        <button class="remove-range" type="button" aria-label="Remove range">x</button>
      </div>
      <div class="range-inputs">
        <label><span>from page</span><input type="number" min="1" max="${total}" value="${range.from}" data-range-field="from"></label>
        <label><span>to</span><input type="number" min="1" max="${total}" value="${range.to}" data-range-field="to"></label>
      </div>
    `;
    row.querySelectorAll("input").forEach((input) => {
      input.addEventListener("change", () => {
        const field = input.dataset.rangeField;
        state.split.ranges[index][field] = clampPage(input.value, total);
        renderRangeControls();
        renderSplitPreview();
      });
    });
    row.querySelector(".remove-range").addEventListener("click", () => {
      if (state.split.ranges.length === 1) return;
      state.split.ranges.splice(index, 1);
      renderRangeControls();
      renderSplitPreview();
    });
    list.append(row);
  });
}

function syncSplitControls() {
  const isRange = state.split.mode === "range";
  document.getElementById("splitRangePanel").hidden = !isRange;
  document.getElementById("splitPagesPanel").hidden = isRange;
  document.querySelectorAll("[data-split-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.splitMode === state.split.mode);
  });
  document.querySelectorAll("[data-range-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.rangeMode === state.split.rangeMode);
  });
  document.querySelectorAll("[data-pages-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.pagesMode === state.split.pagesMode);
  });
  document.getElementById("customRangeControls").hidden = state.split.rangeMode !== "custom";
  document.getElementById("fixedRangeControls").hidden = state.split.rangeMode !== "fixed";
  renderRangeControls();
}

function setupSplitControls() {
  document.querySelectorAll("[data-split-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      state.split.mode = button.dataset.splitMode;
      syncSplitControls();
      renderSplitPreview();
    });
  });
  document.querySelectorAll("[data-range-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      state.split.rangeMode = button.dataset.rangeMode;
      syncSplitControls();
      renderSplitPreview();
    });
  });
  document.querySelectorAll("[data-pages-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      state.split.pagesMode = button.dataset.pagesMode;
      renderSplitPreview();
    });
  });
  document.getElementById("addRangeBtn")?.addEventListener("click", () => {
    const doc = firstDocument();
    const total = doc ? doc.pages.length : 1;
    const previous = state.split.ranges[state.split.ranges.length - 1] || { to: 0 };
    const from = Math.min(previous.to + 1, total);
    state.split.ranges.push({ from, to: total });
    renderRangeControls();
    renderSplitPreview();
  });
  document.getElementById("fixedRangeSize")?.addEventListener("change", renderSplitPreview);
  document.getElementById("mergeRanges")?.addEventListener("change", renderSplitPreview);
  syncSplitControls();
}

function initializeRedactViewer(documentData) {
  state.redact.activePage = 1;
  state.redact.marks = [];
  state.redact.zoom = 1.25;
  renderRedactViewer(documentData);
  renderMarkedList();
}

function renderRedactViewer(documentData) {
  previewGrid.innerHTML = `
    <div class="redact-viewer">
      <div class="redact-rail" id="redactRail"></div>
      <div class="redact-canvas-wrap">
        <div class="redact-toolbar">
          <button class="tool-button active" type="button">Redact</button>
          <span class="redact-badge" id="redactBadge">0</span>
          <div class="zoom-controls" aria-label="Preview zoom controls">
            <button id="redactZoomOut" type="button" aria-label="Zoom out">-</button>
            <span id="redactZoomLabel">125%</span>
            <button id="redactZoomIn" type="button" aria-label="Zoom in">+</button>
            <button id="redactZoomFit" type="button">Fit</button>
          </div>
        </div>
        <div class="redact-page-stage">
          <div class="redact-page-frame" id="redactPageFrame">
            <img id="redactMainPage" alt="PDF page preview">
            <div id="redactOverlay" class="redact-overlay"></div>
          </div>
        </div>
      </div>
    </div>
  `;
  const rail = document.getElementById("redactRail");
  documentData.pages.forEach((page) => {
    const button = document.createElement("button");
    button.className = "redact-thumb";
    button.type = "button";
    button.dataset.page = page.page;
    button.innerHTML = `
      <img src="${pageThumb(documentData, page.page)}" alt="Page ${page.page}">
      <span>${page.page}</span>
    `;
    button.addEventListener("click", () => {
      state.redact.activePage = page.page;
      renderRedactPage();
    });
    rail.append(button);
  });
  document.getElementById("redactZoomOut")?.addEventListener("click", () => setRedactZoom(state.redact.zoom - 0.15));
  document.getElementById("redactZoomIn")?.addEventListener("click", () => setRedactZoom(state.redact.zoom + 0.15));
  document.getElementById("redactZoomFit")?.addEventListener("click", () => setRedactZoom(1));
  renderRedactPage();
  updatePreviewCount();
}

function setRedactZoom(value) {
  state.redact.zoom = Math.min(Math.max(value, 0.65), 2.5);
  applyRedactZoom();
}

function applyRedactZoom() {
  const frame = document.getElementById("redactPageFrame");
  const label = document.getElementById("redactZoomLabel");
  if (frame) frame.style.setProperty("--redact-zoom", state.redact.zoom.toFixed(2));
  if (label) label.textContent = `${Math.round(state.redact.zoom * 100)}%`;
}

function renderRedactPage() {
  const doc = firstDocument();
  if (!doc) return;
  const page = doc.pages.find((item) => item.page === state.redact.activePage) || doc.pages[0];
  state.redact.activePage = page.page;
  document.querySelectorAll(".redact-thumb").forEach((thumb) => {
    thumb.classList.toggle("active", Number(thumb.dataset.page) === page.page);
  });
  const img = document.getElementById("redactMainPage");
  const overlay = document.getElementById("redactOverlay");
  if (!img || !overlay) return;
  img.src = `/api/document/${state.sessionId}/${doc.documentId}/preview/${page.page}`;
  applyRedactZoom();
  overlay.innerHTML = "";
  state.redact.marks.filter((mark) => mark.page === page.page).forEach((mark, index) => {
    const box = document.createElement("div");
    box.className = "redact-mark";
    const rect = mark.rect;
    box.style.left = `${(rect.x0 / mark.pageSize.width) * 100}%`;
    box.style.top = `${(rect.y0 / mark.pageSize.height) * 100}%`;
    box.style.width = `${((rect.x1 - rect.x0) / mark.pageSize.width) * 100}%`;
    box.style.height = `${((rect.y1 - rect.y0) / mark.pageSize.height) * 100}%`;
    box.title = mark.term;
    overlay.append(box);
  });
  const badge = document.getElementById("redactBadge");
  if (badge) badge.textContent = String(state.redact.marks.length);
}

function renderMarkedList() {
  const list = document.getElementById("markedList");
  const empty = document.getElementById("markedEmpty");
  if (!list || !empty) return;
  list.innerHTML = "";
  empty.hidden = state.redact.marks.length > 0;
  const groups = new Map();
  state.redact.marks.forEach((mark, index) => {
    if (!groups.has(mark.page)) groups.set(mark.page, []);
    groups.get(mark.page).push({ mark, index });
  });
  groups.forEach((items, page) => {
    const group = document.createElement("section");
    group.className = "marked-group";
    const title = document.createElement("h3");
    title.textContent = `Page ${page}`;
    group.append(title);
    items.forEach(({ mark, index }) => {
      const row = document.createElement("div");
      row.className = "marked-item";
      const icon = document.createElement("span");
      icon.className = "text-icon";
      icon.textContent = "T";
      const term = document.createElement("span");
      term.textContent = mark.term;
      const button = createIconButton("", "Remove mark", "x");
      row.append(icon, term, button);
      button.addEventListener("click", () => {
        state.redact.marks.splice(index, 1);
        renderMarkedList();
        renderRedactPage();
      });
      row.addEventListener("click", (event) => {
        if (event.target.tagName === "BUTTON") return;
        state.redact.activePage = mark.page;
        renderRedactPage();
      });
      group.append(row);
    });
    list.append(group);
  });
  renderRedactPage();
}

async function searchRedactText() {
  const doc = firstDocument();
  if (!doc) {
    setStatus("Upload a PDF before searching for redactions.", true);
    return;
  }
  const term = document.getElementById("redactSearch").value.trim();
  if (!term) {
    setStatus("Enter text to search.", true);
    return;
  }
  setStatus("Searching document...");
  const res = await fetch("/api/redact/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: state.sessionId,
      documentId: doc.documentId,
      term,
      ocr: document.getElementById("redactOcr").checked,
    }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "Search failed" }));
    setStatus(safeBrowserError(data, "Unable to search this PDF. Please try again."), true);
    return;
  }
  const data = await res.json();
  state.redact.marks.push(...data.matches);
  renderMarkedList();
  if (data.matches.length) {
    state.redact.activePage = data.matches[0].page;
    renderRedactPage();
    setStatus(`Marked ${data.matches.length} match${data.matches.length === 1 ? "" : "es"} for redaction.`);
  } else {
    setStatus(data.warning || "No matches found.", Boolean(data.warning));
  }
}

function setupRedactControls() {
  document.getElementById("redactSearchBtn")?.addEventListener("click", searchRedactText);
  document.getElementById("redactSearch")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      searchRedactText();
    }
  });
  document.getElementById("clearMarksBtn")?.addEventListener("click", () => {
    state.redact.marks = [];
    renderMarkedList();
    setStatus("");
  });
}

function initializeEditViewer(documentData) {
  state.edit.activePage = 1;
  state.edit.zoom = 1.2;
  state.edit.action = "text";
  state.edit.imageData = "";
  state.edit.objects = [];
  state.edit.selectedObjectId = "";
  state.edit.drag = null;
  state.edit.resize = null;
  const actionSelect = document.getElementById("editAction");
  if (actionSelect) actionSelect.value = "text";
  const pageInput = document.getElementById("editPage");
  if (pageInput) pageInput.value = "1";
  renderEditViewer(documentData);
}

function renderEditViewer(documentData) {
  previewGrid.innerHTML = `
    <div class="edit-viewer">
      <div class="edit-rail" id="editRail"></div>
      <div class="edit-canvas-wrap">
        <div class="edit-toolbar">
          <div class="edit-mode-toggle" aria-label="Edit mode">
            <button class="active" type="button">Annotate</button>
            <button type="button">Edit</button>
          </div>
          <button class="edit-tool active" type="button" data-edit-action="text" title="Add text">A|</button>
          <button class="edit-tool" type="button" data-edit-action="image" title="Upload image">▧</button>
          <button class="edit-tool" type="button" data-edit-action="highlight" title="Highlight">▰</button>
          <button class="edit-tool" type="button" data-edit-action="rectangle" title="Rectangle">□</button>
          <button class="edit-tool" type="button" data-edit-action="circle" title="Circle">○</button>
          <button class="edit-tool" type="button" data-edit-action="comment" title="Comment">☰</button>
          <input id="editImageInput" type="file" accept="image/png,image/jpeg" hidden>
          <div class="zoom-controls" aria-label="Editor zoom controls">
            <button id="editPrevPage" type="button" aria-label="Previous page">⌃</button>
            <button id="editNextPage" type="button" aria-label="Next page">⌄</button>
            <span id="editPageLabel">1 / ${documentData.pages.length}</span>
            <button id="editZoomOut" type="button" aria-label="Zoom out">-</button>
            <button id="editZoomIn" type="button" aria-label="Zoom in">+</button>
            <span id="editZoomLabel">120%</span>
          </div>
        </div>
        <div class="edit-page-stage">
          <div class="edit-page-frame" id="editPageFrame">
            <img id="editMainPage" alt="PDF page preview">
            <div id="editOverlay" class="edit-overlay"></div>
          </div>
        </div>
      </div>
    </div>
  `;
  const rail = document.getElementById("editRail");
  documentData.pages.forEach((page) => {
    const button = document.createElement("button");
    button.className = "edit-thumb";
    button.type = "button";
    button.dataset.page = page.page;
    button.innerHTML = `
      <img src="${pageThumb(documentData, page.page)}" alt="Page ${page.page}">
      <span>${page.page}</span>
    `;
    button.addEventListener("click", () => {
      state.edit.activePage = page.page;
      renderEditPage();
    });
    rail.append(button);
  });
  document.querySelectorAll(".edit-tool").forEach((button) => {
    button.addEventListener("click", () => setEditAction(button.dataset.editAction));
  });
  document.getElementById("editImageInput")?.addEventListener("change", handleEditImageUpload);
  document.getElementById("editZoomOut")?.addEventListener("click", () => setEditZoom(state.edit.zoom - 0.15));
  document.getElementById("editZoomIn")?.addEventListener("click", () => setEditZoom(state.edit.zoom + 0.15));
  document.getElementById("editPrevPage")?.addEventListener("click", () => setEditPage(state.edit.activePage - 1));
  document.getElementById("editNextPage")?.addEventListener("click", () => setEditPage(state.edit.activePage + 1));
  document.getElementById("editPageFrame")?.addEventListener("click", positionEditAction);
  document.addEventListener("keydown", deleteSelectedEditObject);
  renderEditPage();
  updatePreviewCount();
}

function setEditPage(pageNumber) {
  const doc = firstDocument();
  if (!doc) return;
  state.edit.activePage = clampPage(pageNumber, doc.pages.length);
  renderEditPage();
}

function setEditAction(action) {
  state.edit.action = action;
  document.querySelectorAll(".edit-tool").forEach((button) => {
    button.classList.toggle("active", button.dataset.editAction === action);
  });
  const select = document.getElementById("editAction");
  if (select && action !== "image") select.value = action;
  if (action === "image") document.getElementById("editImageInput")?.click();
}

function handleEditImageUpload(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.addEventListener("load", () => {
    state.edit.imageData = String(reader.result || "");
    setStatus("Image ready. Click the PDF page to place it.");
  });
  reader.readAsDataURL(file);
}

function setEditZoom(value) {
  state.edit.zoom = Math.min(Math.max(value, 0.65), 2.4);
  applyEditZoom();
}

function applyEditZoom() {
  const frame = document.getElementById("editPageFrame");
  const label = document.getElementById("editZoomLabel");
  if (frame) frame.style.setProperty("--edit-zoom", state.edit.zoom.toFixed(2));
  if (label) label.textContent = `${Math.round(state.edit.zoom * 100)}%`;
}

function renderEditPage() {
  const doc = firstDocument();
  if (!doc) return;
  const page = doc.pages.find((item) => item.page === state.edit.activePage) || doc.pages[0];
  state.edit.activePage = page.page;
  document.querySelectorAll(".edit-thumb").forEach((thumb) => {
    thumb.classList.toggle("active", Number(thumb.dataset.page) === page.page);
  });
  const img = document.getElementById("editMainPage");
  const pageInput = document.getElementById("editPage");
  const pageLabel = document.getElementById("editPageLabel");
  if (img) img.src = `/api/document/${state.sessionId}/${doc.documentId}/preview/${page.page}`;
  if (pageInput) pageInput.value = String(page.page);
  if (pageLabel) pageLabel.textContent = `${page.page} / ${doc.pages.length}`;
  applyEditZoom();
  renderEditOverlay();
}

function positionEditAction(event) {
  if (event.target.closest(".edit-placement")) return;
  const doc = firstDocument();
  const page = doc?.pages.find((item) => item.page === state.edit.activePage);
  const img = document.getElementById("editMainPage");
  if (!doc || !page || !img) return;
  const bounds = img.getBoundingClientRect();
  const xRatio = Math.min(Math.max((event.clientX - bounds.left) / bounds.width, 0), 1);
  const yRatio = Math.min(Math.max((event.clientY - bounds.top) / bounds.height, 0), 1);
  document.getElementById("editPage").value = String(page.page);
  document.getElementById("editX").value = String(Math.round(xRatio * page.width));
  document.getElementById("editY").value = String(Math.round(yRatio * page.height));
  if (state.edit.action === "highlight") {
    document.getElementById("editW").value = "180";
    document.getElementById("editH").value = "24";
  } else if (state.edit.action === "circle") {
    document.getElementById("editW").value = "90";
    document.getElementById("editH").value = "90";
  } else if (state.edit.action === "image") {
    document.getElementById("editW").value = "160";
    document.getElementById("editH").value = "100";
  }
  addEditObject(page, Number(document.getElementById("editX").value), Number(document.getElementById("editY").value));
  setStatus("Object placed. Drag it with the mouse to move it, then save changes.");
}

function addEditObject(page, x, y) {
  const action = state.edit.action;
  if (action === "image" && !state.edit.imageData) {
    setStatus("Choose an image first, then click the PDF page to place it.", true);
    document.getElementById("editImageInput")?.click();
    return;
  }
  const width = action === "highlight" ? 180 : action === "circle" ? 90 : action === "image" ? 160 : 180;
  const height = action === "highlight" ? 24 : action === "circle" ? 90 : action === "image" ? 100 : 40;
  const object = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    action,
    page: page.page,
    x,
    y,
    width,
    height,
    text: document.getElementById("editText")?.value || "",
    imageData: action === "image" ? state.edit.imageData : "",
    format: getEditFormatFromControls(),
  };
  state.edit.objects.push(object);
  state.edit.selectedObjectId = object.id;
  syncSelectedEditObjectFields(object);
  renderEditOverlay();
}

function getEditFormatFromControls() {
  return {
    fontFamily: document.getElementById("editFontFamily")?.value || "helvetica",
    fontSize: Number(document.getElementById("editFontSize")?.value || 14),
    color: document.getElementById("editTextColor")?.value || "#d11f1f",
    backgroundColor: document.getElementById("editBgEnabled")?.checked ? (document.getElementById("editBgColor")?.value || "#ffffff") : "",
    bold: document.getElementById("editBold")?.classList.contains("active") || false,
    italic: document.getElementById("editItalic")?.classList.contains("active") || false,
    underline: document.getElementById("editUnderline")?.classList.contains("active") || false,
  };
}

function applyEditFormatToControls(format) {
  const fontFamily = document.getElementById("editFontFamily");
  const fontSize = document.getElementById("editFontSize");
  const textColor = document.getElementById("editTextColor");
  const bgColor = document.getElementById("editBgColor");
  const bgEnabled = document.getElementById("editBgEnabled");
  if (fontFamily) fontFamily.value = format.fontFamily || "helvetica";
  if (fontSize) fontSize.value = String(format.fontSize || 14);
  if (textColor) textColor.value = format.color || "#d11f1f";
  if (bgColor) bgColor.value = format.backgroundColor || "#ffffff";
  if (bgEnabled) bgEnabled.checked = Boolean(format.backgroundColor);
  document.getElementById("editBold")?.classList.toggle("active", Boolean(format.bold));
  document.getElementById("editItalic")?.classList.toggle("active", Boolean(format.italic));
  document.getElementById("editUnderline")?.classList.toggle("active", Boolean(format.underline));
}

function applyEditObjectStyle(box, object) {
  const format = object.format || {};
  box.style.color = format.color || "#d11f1f";
  box.style.background = format.backgroundColor || (object.action === "highlight" ? "rgba(255, 204, 61, 0.4)" : "rgba(229, 50, 45, 0.1)");
  box.style.fontFamily = format.fontFamily === "times" ? "Times New Roman, serif" : format.fontFamily === "courier" ? "Courier New, monospace" : "Helvetica, Arial, sans-serif";
  box.style.fontSize = `${format.fontSize || 14}px`;
  box.style.fontWeight = format.bold ? "900" : "700";
  box.style.fontStyle = format.italic ? "italic" : "normal";
  box.style.textDecoration = format.underline ? "underline" : "none";
}

function syncSelectedEditObjectFields(object) {
  document.getElementById("editPage").value = String(object.page);
  document.getElementById("editX").value = String(Math.round(object.x));
  document.getElementById("editY").value = String(Math.round(object.y));
  document.getElementById("editW").value = String(Math.round(object.width));
  document.getElementById("editH").value = String(Math.round(object.height));
  document.getElementById("editText").value = object.text || "";
  const select = document.getElementById("editAction");
  if (select && object.action !== "image") select.value = object.action;
  state.edit.action = object.action;
  applyEditFormatToControls(object.format || getEditFormatFromControls());
}

function renderEditOverlay() {
  const overlay = document.getElementById("editOverlay");
  const doc = firstDocument();
  const page = doc?.pages.find((item) => item.page === state.edit.activePage);
  if (!overlay || !page) return;
  overlay.innerHTML = "";
  state.edit.objects.filter((object) => object.page === page.page).forEach((object) => {
    const box = document.createElement("div");
    box.className = `edit-placement edit-placement-${object.action}`;
    box.classList.toggle("selected", object.id === state.edit.selectedObjectId);
    box.dataset.objectId = object.id;
    box.style.left = `${(object.x / page.width) * 100}%`;
    box.style.top = `${(object.y / page.height) * 100}%`;
    box.style.width = `${(object.width / page.width) * 100}%`;
    box.style.height = `${(object.height / page.height) * 100}%`;
    applyEditObjectStyle(box, object);
    if (object.action === "text" || object.action === "comment") {
      box.textContent = object.text || (object.action === "comment" ? "Comment" : "Text");
      box.addEventListener("dblclick", beginInlineTextEdit);
      box.addEventListener("input", updateInlineText);
      box.addEventListener("blur", endInlineTextEdit);
    }
    if (object.id === state.edit.selectedObjectId) {
      const handle = document.createElement("span");
      handle.className = "edit-resize-handle";
      handle.addEventListener("pointerdown", startEditObjectResize);
      box.append(handle);
    }
    box.addEventListener("pointerdown", startEditObjectDrag);
    overlay.append(box);
  });
}

function startEditObjectDrag(event) {
  if (event.target.closest(".edit-resize-handle") || event.currentTarget.isContentEditable) return;
  event.preventDefault();
  event.stopPropagation();
  const target = event.currentTarget;
  const object = state.edit.objects.find((item) => item.id === target.dataset.objectId);
  const doc = firstDocument();
  const page = doc?.pages.find((item) => item.page === state.edit.activePage);
  const img = document.getElementById("editMainPage");
  if (!object || !page || !img) return;
  state.edit.selectedObjectId = object.id;
  syncSelectedEditObjectFields(object);
  document.querySelectorAll(".edit-placement").forEach((box) => {
    box.classList.toggle("selected", box.dataset.objectId === object.id);
  });
  const bounds = img.getBoundingClientRect();
  state.edit.drag = {
    id: object.id,
    startClientX: event.clientX,
    startClientY: event.clientY,
    startX: object.x,
    startY: object.y,
    pageWidth: page.width,
    pageHeight: page.height,
    imgWidth: bounds.width,
    imgHeight: bounds.height,
  };
  target.setPointerCapture(event.pointerId);
  target.addEventListener("pointermove", dragEditObject);
  target.addEventListener("pointerup", endEditObjectDrag, { once: true });
  target.addEventListener("pointercancel", endEditObjectDrag, { once: true });
}

function beginInlineTextEdit(event) {
  const box = event.currentTarget;
  const object = state.edit.objects.find((item) => item.id === box.dataset.objectId);
  if (!object || (object.action !== "text" && object.action !== "comment")) return;
  event.stopPropagation();
  state.edit.selectedObjectId = object.id;
  box.contentEditable = "true";
  box.classList.add("editing");
  box.focus();
  document.execCommand?.("selectAll", false, null);
}

function updateInlineText(event) {
  const object = state.edit.objects.find((item) => item.id === event.currentTarget.dataset.objectId);
  if (!object) return;
  object.text = event.currentTarget.textContent.trim();
  document.getElementById("editText").value = object.text;
}

function endInlineTextEdit(event) {
  event.currentTarget.contentEditable = "false";
  event.currentTarget.classList.remove("editing");
}

function dragEditObject(event) {
  const drag = state.edit.drag;
  if (!drag) return;
  const object = state.edit.objects.find((item) => item.id === drag.id);
  if (!object) return;
  const dx = ((event.clientX - drag.startClientX) / drag.imgWidth) * drag.pageWidth;
  const dy = ((event.clientY - drag.startClientY) / drag.imgHeight) * drag.pageHeight;
  object.x = Math.min(Math.max(drag.startX + dx, 0), drag.pageWidth - object.width);
  object.y = Math.min(Math.max(drag.startY + dy, 0), drag.pageHeight - object.height);
  syncSelectedEditObjectFields(object);
  positionEditBox(event.currentTarget, object, { width: drag.pageWidth, height: drag.pageHeight });
}

function endEditObjectDrag(event) {
  event.currentTarget.removeEventListener("pointermove", dragEditObject);
  state.edit.drag = null;
  state.edit.resize = null;
}

function startEditObjectResize(event) {
  event.preventDefault();
  event.stopPropagation();
  const box = event.currentTarget.closest(".edit-placement");
  const object = state.edit.objects.find((item) => item.id === box?.dataset.objectId);
  const doc = firstDocument();
  const page = doc?.pages.find((item) => item.page === state.edit.activePage);
  const img = document.getElementById("editMainPage");
  if (!box || !object || !page || !img) return;
  const bounds = img.getBoundingClientRect();
  state.edit.selectedObjectId = object.id;
  state.edit.resize = {
    id: object.id,
    startClientX: event.clientX,
    startClientY: event.clientY,
    startWidth: object.width,
    startHeight: object.height,
    pageWidth: page.width,
    pageHeight: page.height,
    imgWidth: bounds.width,
    imgHeight: bounds.height,
  };
  box.setPointerCapture(event.pointerId);
  box.addEventListener("pointermove", resizeEditObject);
  box.addEventListener("pointerup", endEditObjectResize, { once: true });
  box.addEventListener("pointercancel", endEditObjectResize, { once: true });
}

function resizeEditObject(event) {
  const resize = state.edit.resize;
  if (!resize) return;
  const object = state.edit.objects.find((item) => item.id === resize.id);
  if (!object) return;
  const dw = ((event.clientX - resize.startClientX) / resize.imgWidth) * resize.pageWidth;
  const dh = ((event.clientY - resize.startClientY) / resize.imgHeight) * resize.pageHeight;
  object.width = Math.max(18, resize.startWidth + dw);
  object.height = Math.max(12, resize.startHeight + dh);
  syncSelectedEditObjectFields(object);
  positionEditBox(event.currentTarget, object, { width: resize.pageWidth, height: resize.pageHeight });
}

function endEditObjectResize(event) {
  event.currentTarget.removeEventListener("pointermove", resizeEditObject);
  state.edit.resize = null;
}

function deleteSelectedEditObject(event) {
  if (state.activeTool !== "edit") return;
  if (event.key !== "Delete" && event.key !== "Backspace") return;
  const target = event.target;
  const tag = target?.tagName || "";
  if (target?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;
  if (!state.edit.selectedObjectId) return;
  const before = state.edit.objects.length;
  state.edit.objects = state.edit.objects.filter((object) => object.id !== state.edit.selectedObjectId);
  if (state.edit.objects.length === before) return;
  event.preventDefault();
  state.edit.selectedObjectId = "";
  renderEditOverlay();
  setStatus("Selected object deleted.");
}

function positionEditBox(box, object, page) {
  box.style.left = `${(object.x / page.width) * 100}%`;
  box.style.top = `${(object.y / page.height) * 100}%`;
  box.style.width = `${(object.width / page.width) * 100}%`;
  box.style.height = `${(object.height / page.height) * 100}%`;
}

function splitRangesFromState() {
  const doc = firstDocument();
  if (!doc) return [];
  const total = doc.pages.length;
  if (state.split.mode === "pages") {
    if (state.split.pagesMode === "all") {
      return doc.pages.map((page) => ({ from: page.page, to: page.page }));
    }
    return selectedPages().map((page) => ({ from: page.page, to: page.page }));
  }
  if (state.split.rangeMode === "fixed") {
    const size = clampPage(document.getElementById("fixedRangeSize").value, total);
    const ranges = [];
    for (let start = 1; start <= total; start += size) {
      ranges.push({ from: start, to: Math.min(start + size - 1, total) });
    }
    return ranges;
  }
  return state.split.ranges.map((range) => ({
    from: clampPage(range.from, total),
    to: clampPage(range.to, total),
  }));
}

function collectOptions() {
  if (state.activeTool === "compress") {
    return { level: document.getElementById("compressLevel").value };
  }
  if (state.activeTool === "split") {
    const doc = firstDocument();
    return {
      splitMode: state.split.mode,
      rangeMode: state.split.rangeMode,
      pagesMode: state.split.pagesMode,
      documentId: doc ? doc.documentId : "",
      ranges: splitRangesFromState(),
      mergeRanges: document.getElementById("mergeRanges")?.checked || false,
    };
  }
  if (state.activeTool === "redact") {
    return {
      terms: "",
      rects: state.redact.marks.map((mark) => ({
        page: mark.page,
        rect: mark.rect,
      })),
    };
  }
  if (state.activeTool === "organize") {
    return {
      items: organizerItems(),
    };
  }
  if (state.activeTool === "edit") {
    const action = state.edit.action === "image" ? "image" : document.getElementById("editAction").value;
    return {
      action,
      text: document.getElementById("editText").value,
      page: document.getElementById("editPage").value,
      x: document.getElementById("editX").value,
      y: document.getElementById("editY").value,
      width: document.getElementById("editW").value,
      height: document.getElementById("editH").value,
      imageData: state.edit.imageData,
      format: getEditFormatFromControls(),
      edits: state.edit.objects,
    };
  }
  return {};
}

async function generateOutput() {
  if (state.activeTool === "merge") {
    const documents = selectedDocuments();
    if (documents.length < 2) {
      setStatus("Merge needs at least two PDFs.", true);
      return;
    }
    setStatus("Generating output...");
    const res = await fetch("/api/generate/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: state.sessionId,
        documents,
        options: collectOptions(),
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: "Generation failed" }));
      setStatus(safeBrowserError(data, "Unable to generate the PDF. Please try again."), true);
      return;
    }
    const blob = await res.blob();
    handleCompletedDownload(res, blob);
    return;
  }

  if (state.activeTool === "split") {
    const doc = firstDocument();
    if (!doc) {
      setStatus("Upload one PDF before splitting.", true);
      return;
    }
    const options = collectOptions();
    const pages = state.split.mode === "pages" ? selectedPages() : [{ documentId: doc.documentId, page: 1 }];
    if (state.split.mode === "pages" && !pages.length) {
      setStatus("Keep at least one page in Pages mode.", true);
      return;
    }
    if (state.split.mode === "range" && !options.ranges.length) {
      setStatus("Add at least one split range.", true);
      return;
    }
    setStatus("Splitting PDF...");
    const res = await fetch("/api/generate/split", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: state.sessionId,
        pages,
        options,
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: "Split failed" }));
      setStatus(safeBrowserError(data, "Unable to split the PDF. Please try again."), true);
      return;
    }
    const blob = await res.blob();
    handleCompletedDownload(res, blob);
    return;
  }

  if (state.activeTool === "redact") {
    const doc = firstDocument();
    if (!doc) {
      setStatus("Upload a PDF before redacting.", true);
      return;
    }
    if (!state.redact.marks.length) {
      setStatus("Search and mark at least one item for redaction.", true);
      return;
    }
    setStatus("Redacting PDF...");
    const res = await fetch("/api/generate/redact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: state.sessionId,
        pages: doc.pages.map((page) => ({ documentId: doc.documentId, page: page.page })),
        options: collectOptions(),
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: "Redaction failed" }));
      setStatus(safeBrowserError(data, "Unable to redact the PDF. Please try again."), true);
      return;
    }
    const blob = await res.blob();
    handleCompletedDownload(res, blob);
    return;
  }

  if (state.activeTool === "organize") {
    const items = organizerItems();
    if (!items.length) {
      setStatus("Keep at least one page in the organizer.", true);
      return;
    }
    setStatus("Organizing PDF...");
    const doc = firstDocument();
    const res = await fetch("/api/generate/organize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: state.sessionId,
        pages: doc ? [{ documentId: doc.documentId, page: 1 }] : [],
        options: { items },
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: "Organize failed" }));
      setStatus(safeBrowserError(data, "Unable to organize the PDF. Please try again."), true);
      return;
    }
    const blob = await res.blob();
    handleCompletedDownload(res, blob);
    return;
  }

  const pages = selectedPages();
  if (!pages.length) {
    setStatus("Upload a PDF and keep at least one page in the preview.", true);
    return;
  }
  setStatus("Generating output...");
  const res = await fetch(`/api/generate/${state.activeTool}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: state.sessionId,
      pages,
      options: collectOptions(),
    }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "Generation failed" }));
    setStatus(safeBrowserError(data, "Unable to generate the PDF. Please try again."), true);
    return;
  }
  const blob = await res.blob();
  handleCompletedDownload(res, blob);
}

function clearPreview(resetInput = true) {
  state.documents = [];
  state.split.ranges = [];
  state.redact.marks = [];
  state.redact.activePage = 1;
  state.redact.zoom = 1.25;
  state.edit.activePage = 1;
  state.edit.zoom = 1.2;
  state.edit.action = "text";
  state.edit.imageData = "";
  state.edit.objects = [];
  state.edit.selectedObjectId = "";
  state.edit.drag = null;
  state.organize.blankCount = 0;
  if (previewGrid) previewGrid.innerHTML = "";
  renderUploadedFiles();
  document.querySelector(".tool-sidebar")?.classList.remove("has-uploaded-files");
  if (resetInput) {
    const input = document.getElementById("toolFiles");
    if (input) input.value = "";
  }
  updatePreviewCount();
  setStatus("");
}

function bindDropzone() {
  const zone = document.querySelector(".dropzone");
  const input = document.getElementById("toolFiles");
  if (!zone || !input) return;

  input.multiple = state.activeTool === "merge" || state.activeTool === "organize";
  input.addEventListener("change", () => uploadFiles(Array.from(input.files || [])));

  zone.addEventListener("dragover", (event) => {
    event.preventDefault();
    zone.classList.add("dragging");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("dragging"));
  zone.addEventListener("drop", (event) => {
    event.preventDefault();
    zone.classList.remove("dragging");
    input.files = event.dataTransfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function setupEditControls() {
  document.getElementById("editAction")?.addEventListener("change", (event) => {
    setEditAction(event.target.value);
    renderEditOverlay();
  });
  ["editText", "editPage", "editX", "editY", "editW", "editH"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", () => {
      const selected = state.edit.objects.find((object) => object.id === state.edit.selectedObjectId);
      if (selected && id === "editText") selected.text = document.getElementById(id).value;
      if (id === "editPage") setEditPage(document.getElementById(id).value);
      renderEditOverlay();
    });
  });
  ["editFontFamily", "editFontSize", "editTextColor", "editBgColor", "editBgEnabled"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", updateSelectedEditFormat);
    document.getElementById(id)?.addEventListener("change", updateSelectedEditFormat);
  });
  document.querySelectorAll("[data-format-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      button.classList.toggle("active");
      updateSelectedEditFormat();
    });
  });
}

function updateSelectedEditFormat() {
  const selected = state.edit.objects.find((object) => object.id === state.edit.selectedObjectId);
  if (!selected) return;
  selected.format = getEditFormatFromControls();
  renderEditOverlay();
}

function setupToolPage() {
  const config = toolConfig[state.activeTool];
  if (!config) return;
  document.getElementById("homeView").hidden = true;
  document.getElementById("toolView").hidden = false;
  document.querySelector(".tool-shell")?.classList.toggle("redact-shell", state.activeTool === "redact");
  document.querySelector(".tool-shell")?.classList.toggle("edit-shell", state.activeTool === "edit");
  document.querySelector(".preview-workspace")?.classList.toggle("redact-workspace", state.activeTool === "redact");
  document.querySelector(".preview-workspace")?.classList.toggle("edit-workspace", state.activeTool === "edit");
  previewGrid?.classList.toggle("redact-grid", state.activeTool === "redact");
  previewGrid?.classList.toggle("edit-grid", state.activeTool === "edit");
  previewGrid?.classList.toggle("organize-grid", state.activeTool === "organize" || state.activeTool === "merge" || state.activeTool === "split" || state.activeTool === "compress" || state.activeTool === "excel" || state.activeTool === "word" || state.activeTool === "ppt");
  document.getElementById("uploadedFilesPanel").hidden = state.documents.length === 0;
  document.getElementById("toolTitle").textContent = config.title;
  document.getElementById("toolDescription").textContent = config.description;
  document.getElementById("uploadHint").textContent = config.hint;
  document.getElementById("generateBtn").textContent = state.activeTool === "redact" ? "Redact" : state.activeTool === "edit" ? "Save changes" : `Generate ${config.title}`;
  document.getElementById("previewTitle").textContent = state.activeTool === "merge"
    ? "Arrange files before generating"
    : state.activeTool === "split"
      ? "Create ranges before splitting"
      : state.activeTool === "redact"
        ? "Review marked redactions"
      : state.activeTool === "edit"
        ? "Edit PDF"
      : state.activeTool === "organize"
        ? "Organize pages before generating"
      : state.activeTool === "excel"
        ? "Select pages for Excel conversion"
      : state.activeTool === "word"
        ? "Select pages for Word conversion"
      : state.activeTool === "ppt"
        ? "Select pages for PowerPoint conversion"
      : "Arrange pages before generating";
  document.getElementById("previewEmptyText").textContent = state.activeTool === "merge"
    ? "Then drag files into merge order, remove unwanted files, and click Generate."
    : state.activeTool === "split"
      ? "Then add custom ranges or switch to Pages mode and click Generate."
      : state.activeTool === "redact"
        ? "Then search sensitive text, review marks, and click Redact."
      : state.activeTool === "edit"
        ? "Use the toolbar to choose what to add, then click the PDF page to place it with the cursor."
      : state.activeTool === "organize"
        ? "Then drag pages, remove pages, rotate pages, add blank pages, and click Generate."
      : state.activeTool === "excel"
        ? "Then remove pages you do not need and click Generate to download an Excel workbook."
      : state.activeTool === "word"
        ? "Then remove pages you do not need and click Generate to download a Word document."
      : state.activeTool === "ppt"
        ? "Then remove pages you do not need and click Generate to download a PowerPoint deck."
      : "Then drag pages into order, remove unwanted pages, and click Generate.";

  document.querySelectorAll(".tool-options > *").forEach((option) => {
    option.hidden = true;
  });
  document.querySelectorAll(`.option-${state.activeTool}`).forEach((option) => {
    option.hidden = false;
  });

  if (state.activeTool === "split") setupSplitControls();
  if (state.activeTool === "redact") setupRedactControls();
  if (state.activeTool === "edit") setupEditControls();
  document.getElementById("uploadedAddFileBtn")?.addEventListener("click", () => document.getElementById("toolFiles")?.click());
  document.getElementById("uploadedResetBtn")?.addEventListener("click", () => clearPreview(true));
  bindDropzone();
  document.getElementById("generateBtn").addEventListener("click", generateOutput);
  document.getElementById("clearPreviewBtn").addEventListener("click", () => clearPreview(true));
  document.getElementById("anotherTaskBtn")?.addEventListener("click", startAnotherTask);

  if (window.Sortable) {
    Sortable.create(previewGrid, {
      animation: 130,
      disabled: state.activeTool === "redact" || state.activeTool === "edit",
      filter: ".organize-add-card",
      onEnd: () => {
        if (state.activeTool === "organize") updateOrganizerNumbers();
        updatePreviewCount();
      },
    });
  }
  updatePreviewCount();
}

function setupHomePage() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => filterTools(tab.dataset.filter));
  });
}

function cleanupSession() {
  if (!state.sessionId) return;
  const payload = JSON.stringify({ sessionId: state.sessionId });
  navigator.sendBeacon("/api/session/cleanup", new Blob([payload], { type: "application/json" }));
  localStorage.removeItem("weLovePdfSession");
  state.sessionId = "";
}

window.addEventListener("pagehide", cleanupSession);

ensureSession().catch(() => setStatus("Could not start a temporary session.", true));

if (state.activeTool) {
  setupToolPage();
} else {
  setupHomePage();
}
