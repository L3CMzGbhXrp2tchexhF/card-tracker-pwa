import { putCatalog, getCatalog, addPending, getAllPending, deletePending, clearAllPending } from './db.js';

// ── State ──
let catalog = null;    // the full catalog object
let pendingList = [];  // cached pending entries
let currentCards = []; // cards displayed in the browse list
let currentSet = null; // { name, type, prefix, cards, parallels } of the selected set
let selectedCard = null; // card tapped for the add sheet
let ownedMap = new Map(); // "product|set|card_number" → total qty across all parallels

// Locked fields (browse mode only, session-only — not persisted)
let lockedFields = {
  parallel: null,      // { value: "Gold" } when locked, null when unlocked
  grade: null,
  location: null,
  price_bucket: null,
  status: null,
};

// Session state
let session = {
  active: false,
  location: null,        // tag name string
  product: null,         // product object from catalog
  selectedSets: [],      // set names chosen at setup
  selectedParallels: [], // parallel names chosen at setup
  activeSet: null,       // current set object (active tab)
  activeParallel: null,  // current parallel name (active chip)
  entries: [],           // [{card_number, set, parallel, id (pending db id)}]
};
let sessLongPressTimer = null;
let sessSheetContext = null; // { card, set } when add-sheet opened from session long-press

// ── DOM refs ──
const $ = id => document.getElementById(id);
const sportSelect    = $('sportSelect');
const productSelect  = $('productSelect');
const setSelect      = $('setSelect');
const cardSearch     = $('cardSearch');
const cardList       = $('cardList');
const pendingBadge   = $('pendingBadge');
const pendingListEl  = $('pendingList');
const catalogInfo    = $('catalogInfo');

// Session DOM refs
const sessSportSelect     = $('sessSportSelect');
const sessProductSelect   = $('sessProductSelect');
const sessSetPicker       = $('sessSetPicker');
const sessParallelPicker  = $('sessParallelPicker');
const sessLocationPicker  = $('sessLocationPicker');
const sessSetup          = $('sessionSetup');
const sessActive         = $('sessionActive');
const sessProductLabel   = $('sessProductLabel');
const sessLocationLabel  = $('sessLocationLabel');
const sessCountLabel     = $('sessCountLabel');
const sessParallelBar    = $('sessParallelBar');
const sessSetBar         = $('sessSetBar');
const sessCardSearch     = $('sessCardSearch');
const sessCardList       = $('sessCardList');
const undoBtn            = $('undoBtn');

const sheetOverlay   = $('sheetOverlay');
const addSheet       = $('addSheet');
const sheetTitle     = $('sheetTitle');
const sheetSubtitle  = $('sheetSubtitle');
const parallelPicker = $('parallelPicker');
const qtyInput       = $('qtyInput');
const serialInput    = $('serialInput');
const gradeSelect    = $('gradeSelect');
const locationPicker = $('locationPicker');
const statusPicker   = $('statusPicker');
const pricePicker    = $('pricePicker');
const notesInput     = $('notesInput');

// ── Init ──
async function init() {
  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  // Request persistent storage
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist();
  }

  // Load catalog from IndexedDB if previously saved
  const saved = await getCatalog();
  if (saved) {
    catalog = saved;
    onCatalogLoaded();
  }

  // Load pending list
  pendingList = await getAllPending();
  updatePendingBadge();

  // Wire up tabs
  document.querySelectorAll('.tab-bar button').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Wire up catalog loader
  $('loadCatalogBtn').addEventListener('click', () => $('catalogFile').click());
  $('catalogFile').addEventListener('change', onCatalogFileSelected);

  // Wire up cascade dropdowns
  sportSelect.addEventListener('change', onSportChanged);
  productSelect.addEventListener('change', onProductChanged);
  setSelect.addEventListener('change', onSetChanged);
  cardSearch.addEventListener('input', onSearchInput);

  // Wire up sheet
  sheetOverlay.addEventListener('click', closeSheet);
  $('qtyDown').addEventListener('click', () => { qtyInput.value = Math.max(1, +qtyInput.value - 1); });
  $('qtyUp').addEventListener('click', () => { qtyInput.value = Math.min(99, +qtyInput.value + 1); });
  $('confirmAddBtn').addEventListener('click', onConfirmAdd);

  // Wire up pending actions
  $('exportBtn').addEventListener('click', onExport);
  $('clearBtn').addEventListener('click', onClearAll);

  // Wire up lock buttons
  document.querySelectorAll('.lock-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleFieldLock(btn.dataset.field, btn);
    });
  });
  $('unlockAllBtn').addEventListener('click', unlockAllFields);

  // Wire up session
  sessSportSelect.addEventListener('change', onSessSportChanged);
  sessProductSelect.addEventListener('change', onSessProductChanged);
  $('sessSetSelectAll').addEventListener('click', () => { selectAllChips(sessSetPicker); onSessSetPickerChanged(); });
  $('sessSetClear').addEventListener('click', () => { clearAllChips(sessSetPicker); onSessSetPickerChanged(); });
  $('sessParSelectAll').addEventListener('click', () => { selectAllChips(sessParallelPicker); });
  $('sessParClear').addEventListener('click', () => { clearAllChips(sessParallelPicker); });
  $('startSessionBtn').addEventListener('click', startSession);
  $('endSessionBtn').addEventListener('click', endSession);
  undoBtn.addEventListener('click', undoLastSessionAdd);
  sessCardSearch.addEventListener('input', renderSessionCards);
}

// ── Tabs ──
function switchTab(name) {
  document.querySelectorAll('.tab-bar button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  $(name + 'Panel').classList.add('active');
  if (name === 'pending') renderPendingList();
}

// ── Catalog Loading ──
async function onCatalogFileSelected(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data.products || !data.tags) {
      showToast('Invalid catalog file. Expected products and tags.');
      return;
    }
    catalog = data;
    await putCatalog(catalog);
    onCatalogLoaded();
    switchTab('browse');
  } catch (err) {
    showToast('Failed to load catalog: ' + err.message, 4000);
  }
  e.target.value = '';
}

function buildOwnedMap() {
  ownedMap.clear();
  if (!catalog || !catalog.collection) return;
  for (const entry of catalog.collection) {
    const cardKey = `${entry.product}|${entry.set}|${entry.card_number}`;
    const existing = ownedMap.get(cardKey);
    if (existing) {
      existing.qty += entry.quantity;
      // Keep highest price / first grade found
      if (!existing.median_price && entry.median_price) {
        existing.median_price = entry.median_price;
      }
      if (!existing.grade && entry.grade) {
        existing.grade = entry.grade;
      }
    } else {
      ownedMap.set(cardKey, {
        qty: entry.quantity,
        median_price: entry.median_price || null,
        grade: entry.grade || null,
      });
    }
  }
}

function onCatalogLoaded() {
  buildOwnedMap();

  // Update catalog info display
  const nProducts = catalog.products.length;
  let nCards = 0;
  catalog.products.forEach(p => p.sets.forEach(s => { nCards += s.cards.length; }));
  const nTags = Object.values(catalog.tags).reduce((a, t) => a + t.length, 0);
  const nOwned = ownedMap.size;
  let nPriced = 0;
  ownedMap.forEach(v => { if (v.median_price) nPriced++; });
  catalogInfo.textContent = `Loaded: ${nProducts} products, ${nCards} cards, ${nTags} tags`;
  if (nOwned > 0) catalogInfo.textContent += `, ${nOwned} owned`;
  if (nPriced > 0) catalogInfo.textContent += `, ${nPriced} priced`;
  if (catalog.exported_at) {
    catalogInfo.textContent += `\nExported: ${catalog.exported_at}`;
  }

  // Populate sport dropdown
  const sports = [...new Set(catalog.products.map(p => p.sport))].sort();
  sportSelect.innerHTML = '<option value="">All Sports</option>' +
    sports.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  onSportChanged();

  // Populate session dropdowns
  sessSportSelect.innerHTML = '<option value="">All Sports</option>' +
    sports.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  onSessSportChanged();

  // Populate session location picker
  buildTagPicker(sessLocationPicker, catalog.tags.location || []);
}

// ── Cascade Dropdowns ──
function onSportChanged() {
  if (!catalog) return;
  const sport = sportSelect.value;
  const products = catalog.products
    .filter(p => !sport || p.sport === sport)
    .sort((a, b) => b.year.localeCompare(a.year) || a.name.localeCompare(b.name));
  productSelect.innerHTML = '<option value="">-- Select Product --</option>' +
    products.map((p, i) => `<option value="${i}" data-sport="${esc(p.sport)}">${esc(p.year)} ${esc(p.name)}</option>`).join('');
  // Store filtered products for index lookup
  productSelect._products = products;
  onProductChanged();
}

function onProductChanged() {
  const products = productSelect._products || [];
  const idx = productSelect.value;
  if (idx === '' || !products[idx]) {
    setSelect.innerHTML = '<option value="">--</option>';
    currentCards = [];
    renderCards();
    return;
  }
  const product = products[idx];
  setSelect.innerHTML = '<option value="">-- Select Set --</option>' +
    product.sets.map((s, i) => `<option value="${i}">${esc(s.name)} (${s.type})</option>`).join('');
  setSelect._sets = product.sets;
  setSelect._product = product;
  onSetChanged();
}

function onSetChanged() {
  const sets = setSelect._sets || [];
  const idx = setSelect.value;
  if (idx === '' || !sets[idx]) {
    currentSet = null;
    currentCards = [];
    renderCards();
    return;
  }
  currentSet = sets[idx];
  currentCards = currentSet.cards;
  cardSearch.value = '';
  renderCards();
}

// ── Search ──
function onSearchInput() {
  renderCards();
}

// ── Card Rendering ──
function renderCards() {
  const query = cardSearch.value.toLowerCase().trim();
  let cards = currentCards;
  if (query) {
    cards = cards.filter(c =>
      c.player.toLowerCase().includes(query) ||
      c.number.toLowerCase().includes(query) ||
      c.team.toLowerCase().includes(query) ||
      (c.card_name && c.card_name.toLowerCase().includes(query))
    );
  }

  if (!cards.length) {
    if (!currentSet) {
      cardList.innerHTML = '<div class="empty-state"><div class="icon">&#x1F4E6;</div><p>Select a product and set above to browse cards.</p></div>';
    } else if (query) {
      cardList.innerHTML = `<div class="empty-state"><p>No cards matching "${esc(query)}"</p></div>`;
    } else {
      cardList.innerHTML = '<div class="empty-state"><p>No cards in this set.</p></div>';
    }
    return;
  }

  const product = setSelect._product;
  cardList.innerHTML = cards.map(c => {
    const ownedEntry = product ? ownedMap.get(`${product.name}|${currentSet.name}|${c.number}`) : null;
    const owned = ownedEntry ? ownedEntry.qty : 0;
    const displayName = c.player || c.card_name || '(no player)';
    return `
    <div class="card-item${owned > 0 ? ' owned' : ''}" data-number="${esc(c.number)}">
      <span class="card-num">${esc(c.number)}</span>
      <div class="card-info">
        <div class="card-player">${esc(displayName)}</div>
        <div class="card-team">${esc(c.team)}${ownedEntry && ownedEntry.median_price ? ' <span class="card-price">$' + ownedEntry.median_price.toFixed(2) + '</span>' : ''}</div>
      </div>
      ${c.sp ? '<span class="card-sp">SP</span>' : ''}
      ${c.rookie ? '<span class="card-rc">RC</span>' : ''}
      ${ownedEntry && ownedEntry.grade ? `<span class="card-grade">${esc(ownedEntry.grade)}</span>` : ''}
      ${owned > 0 ? `<span class="owned-badge">${owned}</span>` : ''}
    </div>`;
  }).join('');

  cardList.querySelectorAll('.card-item').forEach(el => {
    el.addEventListener('click', () => {
      const num = el.dataset.number;
      const card = currentCards.find(c => c.number === num);
      if (card) openAddSheet(card);
    });
  });
}

// ── Add Card Sheet ──
function openAddSheet(card) {
  selectedCard = card;
  sheetTitle.textContent = `#${card.number} ${card.player || card.card_name || ''}`;

  const product = setSelect._product;
  sheetSubtitle.textContent = `${product.name} — ${currentSet.name}`;

  // Parallels — respect locked value
  parallelPicker.innerHTML = currentSet.parallels.map(p => {
    const style = p.color_hex ? `border-color:${p.color_hex}` : '';
    const shouldSelect = lockedFields.parallel
      ? p.name === lockedFields.parallel.value
      : p.is_base;
    return `<div class="tag-chip${shouldSelect ? ' selected' : ''}" data-value="${esc(p.name)}" style="${style}">${esc(p.name)}${p.serial_numbered ? ' /' + p.serial_numbered : ''}</div>`;
  }).join('');
  wireTagGroup(parallelPicker);

  // Fallback: if nothing selected (locked parallel not in this set), select base/first
  if (!parallelPicker.querySelector('.tag-chip.selected') && parallelPicker.firstElementChild) {
    const base = parallelPicker.querySelector('.tag-chip[data-value]') || parallelPicker.firstElementChild;
    // Prefer the base parallel
    const baseChip = [...parallelPicker.querySelectorAll('.tag-chip')].find(c => {
      const p = currentSet.parallels.find(pp => pp.name === c.dataset.value);
      return p && p.is_base;
    });
    (baseChip || parallelPicker.firstElementChild).classList.add('selected');
  }

  // Reset non-lockable fields
  qtyInput.value = 1;
  serialInput.value = '';
  notesInput.value = '';

  // Grade — respect locked value
  gradeSelect.value = lockedFields.grade ? lockedFields.grade.value : '';

  // Tags — respect locked values
  buildTagPicker(locationPicker, catalog.tags.location || []);
  if (lockedFields.location) preselectTag(locationPicker, lockedFields.location.value);

  buildTagPicker(pricePicker, catalog.tags.price_bucket || []);
  if (lockedFields.price_bucket) preselectTag(pricePicker, lockedFields.price_bucket.value);

  buildTagPicker(statusPicker, catalog.tags.status || []);
  if (lockedFields.status) preselectTag(statusPicker, lockedFields.status.value);

  // Show lock buttons (may be hidden by session long-press) and sync visuals
  document.querySelectorAll('.lock-btn').forEach(b => b.style.display = '');
  updateLockButtons();
  updateLockedVisuals();

  // Show sheet
  sheetOverlay.classList.add('visible');
  requestAnimationFrame(() => addSheet.classList.add('visible'));
}

function closeSheet() {
  addSheet.classList.remove('visible');
  setTimeout(() => sheetOverlay.classList.remove('visible'), 300);
  selectedCard = null;
  sessSheetContext = null;
}

function buildTagPicker(container, tags) {
  container.innerHTML = '<div class="tag-chip" data-value="">None</div>' +
    tags.map(t => {
      const style = t.color_hex ? `border-color:${t.color_hex}` : '';
      return `<div class="tag-chip" data-value="${esc(t.name)}" style="${style}">${esc(t.name)}</div>`;
    }).join('');
  wireTagGroup(container);
}

function wireTagGroup(container) {
  container.querySelectorAll('.tag-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      container.querySelectorAll('.tag-chip').forEach(c => c.classList.remove('selected'));
      chip.classList.add('selected');
    });
  });
}

function getSelected(container) {
  const sel = container.querySelector('.tag-chip.selected');
  return sel ? sel.dataset.value : '';
}

// Multi-select: toggle on click instead of radio
function wireMultiSelect(container, onChange) {
  container.querySelectorAll('.tag-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      chip.classList.toggle('selected');
      if (onChange) onChange();
    });
  });
}

function getMultiSelected(container) {
  return [...container.querySelectorAll('.tag-chip.selected')]
    .map(c => c.dataset.value);
}

function selectAllChips(container) {
  container.querySelectorAll('.tag-chip').forEach(c => c.classList.add('selected'));
}

function clearAllChips(container) {
  container.querySelectorAll('.tag-chip').forEach(c => c.classList.remove('selected'));
}

// ── Confirm Add ──
async function onConfirmAdd() {
  if (!selectedCard) return;

  const parallel = getSelected(parallelPicker);
  if (!parallel) {
    showToast('Please select a parallel.');
    return;
  }

  // Determine context: session long-press or browse add
  const fromSession = sessSheetContext !== null;
  const productName = fromSession ? session.product.name : setSelect._product.name;
  const setName = fromSession ? sessSheetContext.set.name : currentSet.name;

  const entry = {
    action: 'add',
    product: productName,
    set: setName,
    card_number: selectedCard.number,
    parallel: parallel,
    player: selectedCard.player,
    team: selectedCard.team,
    quantity: Math.max(1, +qtyInput.value || 1),
    serial_number: serialInput.value.trim() || null,
    grade: gradeSelect.value || null,
    notes: notesInput.value.trim() || null,
    tags: {},
    added_at: new Date().toISOString(),
  };

  const loc = getSelected(locationPicker);
  const price = getSelected(pricePicker);
  const status = getSelected(statusPicker);
  if (loc) entry.tags.location = loc;
  if (price) entry.tags.price_bucket = price;
  if (status) entry.tags.status = status;

  const id = await addPending(entry);
  entry.id = id;
  pendingList.push(entry);
  updatePendingBadge();

  // Track in session if opened from session long-press
  if (fromSession && session.active) {
    session.entries.push({
      card_number: selectedCard.number,
      set: setName,
      parallel: parallel,
      id: id,
    });
    sessCountLabel.textContent = session.entries.length + ' added';
    undoBtn.style.display = 'block';
  }

  // Update locked field values with current selections (in case user changed them)
  if (!fromSession) {
    Object.keys(lockedFields).forEach(field => {
      if (lockedFields[field] !== null) {
        lockedFields[field].value = getCurrentFieldValue(field);
      }
    });
  }

  closeSheet();

  if (fromSession) {
    sessSheetContext = null;
    renderSessionCards();
  }
}

// ── Pending ──
function updatePendingBadge() {
  const count = pendingList.length;
  pendingBadge.style.display = count > 0 ? 'flex' : 'none';
  pendingBadge.textContent = count;
  $('exportBtn').textContent = count > 0 ? `Export ${count} Changes` : 'Export Changes';
}

function renderPendingList() {
  if (!pendingList.length) {
    pendingListEl.innerHTML = '<div class="empty-state"><div class="icon">&#x2705;</div><p>No pending changes. Browse cards and tap to add them.</p></div>';
    return;
  }

  pendingListEl.innerHTML = pendingList.map(e => `
    <div class="pending-item" data-id="${e.id}">
      <div class="pending-info">
        <div class="pending-title">#${esc(e.card_number)} ${esc(e.player || '')} — ${esc(e.parallel)}</div>
        <div class="pending-sub">${esc(e.product)} / ${esc(e.set)}${e.quantity > 1 ? ' (x' + e.quantity + ')' : ''}${e.serial_number ? ' #' + esc(e.serial_number) : ''}</div>
      </div>
      <button class="pending-delete" data-id="${e.id}">&times;</button>
    </div>
  `).join('');

  pendingListEl.querySelectorAll('.pending-delete').forEach(btn => {
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const id = +btn.dataset.id;
      await deletePending(id);
      pendingList = pendingList.filter(e => e.id !== id);
      updatePendingBadge();
      renderPendingList();
    });
  });
}

// ── Export ──
async function onExport() {
  if (!pendingList.length) {
    showToast('No pending changes to export.');
    return;
  }

  const exportData = {
    format_version: 1,
    export_id: crypto.randomUUID(),
    exported_at: new Date().toISOString(),
    changes: pendingList.map(e => ({
      action: e.action,
      product: e.product,
      set: e.set,
      card_number: e.card_number,
      parallel: e.parallel,
      quantity: e.quantity,
      serial_number: e.serial_number,
      grade: e.grade,
      notes: e.notes,
      tags: e.tags || {},
    })),
  };

  const jsonStr = JSON.stringify(exportData, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const filename = generateExportFilename(pendingList.length);
  const file = new File([blob], filename, { type: 'application/json' });

  // Try Web Share API first (works on iOS Safari)
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return; // user cancelled
      // Fall through to copy fallback
    }
  }

  // Fallback: show JSON in a copyable textarea
  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay visible';
  overlay.style.display = 'flex';
  overlay.style.alignItems = 'center';
  overlay.style.justifyContent = 'center';
  overlay.style.padding = '20px';

  const box = document.createElement('div');
  box.style.cssText = 'background:var(--bg2); padding:16px; border-radius:12px; width:100%; max-width:400px; max-height:80vh; display:flex; flex-direction:column; gap:8px;';
  box.innerHTML = `
    <h3 style="color:var(--text)">Export JSON</h3>
    <p style="font-size:13px; color:var(--text2);">${pendingList.length} changes. Save as <strong style="color:var(--text)">${esc(filename)}</strong></p>
    <textarea class="export-area" style="flex:1; min-height:200px; width:100%; background:var(--bg); color:var(--text); border:1px solid var(--border); border-radius:8px; padding:8px; font-family:monospace; font-size:11px;" readonly></textarea>
    <button class="btn" id="copyExportBtn">Copy to Clipboard</button>
    <button class="btn btn-outline" id="closeExportBtn">Close</button>
  `;

  overlay.appendChild(box);
  document.body.appendChild(overlay);
  const ta = box.querySelector('textarea');
  ta.value = jsonStr;

  box.querySelector('#copyExportBtn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(jsonStr);
      box.querySelector('#copyExportBtn').textContent = 'Copied!';
      setTimeout(() => { box.querySelector('#copyExportBtn').textContent = 'Copy to Clipboard'; }, 2000);
    } catch {
      ta.select();
      document.execCommand('copy');
    }
  });

  const closeExport = () => { overlay.remove(); };
  box.querySelector('#closeExportBtn').addEventListener('click', closeExport);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeExport(); });
}

async function onClearAll() {
  if (!pendingList.length) return;
  if (!confirm(`Clear all ${pendingList.length} pending changes?`)) return;
  await clearAllPending();
  pendingList = [];
  updatePendingBadge();
  renderPendingList();
}

// ══════════════════════════════════════
// SESSION MODE
// ══════════════════════════════════════

function onSessSportChanged() {
  if (!catalog) return;
  const sport = sessSportSelect.value;
  const products = catalog.products
    .filter(p => !sport || p.sport === sport)
    .sort((a, b) => b.year.localeCompare(a.year) || a.name.localeCompare(b.name));
  sessProductSelect.innerHTML = '<option value="">-- Select Product --</option>' +
    products.map((p, i) => `<option value="${i}">${esc(p.year)} ${esc(p.name)}</option>`).join('');
  sessProductSelect._products = products;
  onSessProductChanged();
}

function onSessProductChanged() {
  const products = sessProductSelect._products || [];
  const idx = sessProductSelect.value;
  sessSetPicker.innerHTML = '';
  sessParallelPicker.innerHTML = '';
  if (idx === '' || !products[idx]) return;

  const product = products[idx];
  // Populate set multi-select
  sessSetPicker.innerHTML = product.sets.map(s =>
    `<div class="tag-chip" data-value="${esc(s.name)}">${esc(s.name)} (${s.cards.length})</div>`
  ).join('');
  wireMultiSelect(sessSetPicker, onSessSetPickerChanged);
}

function onSessSetPickerChanged() {
  const products = sessProductSelect._products || [];
  const idx = sessProductSelect.value;
  if (idx === '' || !products[idx]) return;
  const product = products[idx];

  const selectedSetNames = getMultiSelected(sessSetPicker);
  const selectedSets = product.sets.filter(s => selectedSetNames.includes(s.name));

  // Union of parallels across selected sets
  const seen = new Map();
  selectedSets.forEach(s => {
    s.parallels.forEach(p => {
      if (!seen.has(p.name)) seen.set(p.name, p);
    });
  });
  const parallels = [...seen.values()].sort((a, b) => {
    if (a.is_base && !b.is_base) return -1;
    if (!a.is_base && b.is_base) return 1;
    return a.name.localeCompare(b.name);
  });

  // Preserve previous selections
  const prevSelected = getMultiSelected(sessParallelPicker);

  sessParallelPicker.innerHTML = parallels.map(p => {
    const style = p.color_hex ? `border-color:${p.color_hex}` : '';
    const sel = prevSelected.includes(p.name) ? ' selected' : '';
    return `<div class="tag-chip${sel}" data-value="${esc(p.name)}" style="${style}">${esc(p.name)}${p.serial_numbered ? ' /' + p.serial_numbered : ''}</div>`;
  }).join('');
  wireMultiSelect(sessParallelPicker);
}

function startSession() {
  if (!catalog) { showToast('Load a catalog first.'); return; }

  const products = sessProductSelect._products || [];
  const idx = sessProductSelect.value;
  if (idx === '' || !products[idx]) { showToast('Select a product.'); return; }

  const selectedSetNames = getMultiSelected(sessSetPicker);
  if (!selectedSetNames.length) { showToast('Select at least one set.'); return; }

  const selectedParallelNames = getMultiSelected(sessParallelPicker);
  if (!selectedParallelNames.length) { showToast('Select at least one parallel.'); return; }

  const loc = getSelected(sessLocationPicker);
  if (!loc) { showToast('Select a location.'); return; }

  const product = products[idx];
  const selectedSets = product.sets.filter(s => selectedSetNames.includes(s.name));

  session.active = true;
  session.product = product;
  session.selectedSets = selectedSetNames;
  session.selectedParallels = selectedParallelNames;
  session.activeSet = selectedSets[0];
  session.activeParallel = selectedParallelNames[0];
  session.location = loc;
  session.entries = [];

  sessSetup.style.display = 'none';
  sessActive.style.display = 'flex';
  sessActive.style.flexDirection = 'column';

  sessProductLabel.textContent = product.year + ' ' + product.name;
  sessLocationLabel.textContent = loc;
  sessCountLabel.textContent = '0 added';

  renderSessionSetBar();
  renderSessionParallelBar();
  renderSessionCards();
}

function endSession() {
  const count = session.entries.length;
  if (count > 0 && !confirm(`End session? ${count} card(s) added to pending.`)) return;

  session.active = false;
  session.product = null;
  session.selectedSets = [];
  session.selectedParallels = [];
  session.activeSet = null;
  session.activeParallel = null;
  session.location = null;
  session.entries = [];

  sessActive.style.display = 'none';
  sessSetup.style.display = 'block';
  undoBtn.style.display = 'none';
  sessCardSearch.value = '';

  if (count > 0) switchTab('pending');
}

function renderSessionParallelBar() {
  if (!session.product || !session.activeSet) return;

  // Only show parallels that are in the user's selection AND exist in the active set
  const setParallels = session.activeSet.parallels.filter(
    p => session.selectedParallels.includes(p.name)
  );

  // If active parallel not available in this set, auto-switch
  const activeExists = setParallels.some(p => p.name === session.activeParallel);
  if (!activeExists && setParallels.length) {
    session.activeParallel = setParallels[0].name;
  }

  if (!setParallels.length) {
    sessParallelBar.innerHTML = '<span class="sess-no-match">No selected parallels in this set</span>';
    return;
  }

  sessParallelBar.innerHTML = setParallels.map(p => {
    const active = p.name === session.activeParallel ? ' active' : '';
    const style = p.color_hex ? `border-color:${p.color_hex}` : '';
    return `<button class="sess-chip-btn${active}" data-parallel="${esc(p.name)}" style="${style}">${esc(p.name)}${p.serial_numbered ? ' /' + p.serial_numbered : ''}</button>`;
  }).join('');

  sessParallelBar.querySelectorAll('.sess-chip-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      session.activeParallel = btn.dataset.parallel;
      sessParallelBar.querySelectorAll('.sess-chip-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
}

function renderSessionSetBar() {
  if (!session.product) return;
  // Only show sets the user selected at setup
  const sets = session.product.sets.filter(s => session.selectedSets.includes(s.name));

  sessSetBar.innerHTML = sets.map(s => {
    const active = session.activeSet && s.name === session.activeSet.name ? ' active' : '';
    return `<button class="sess-chip-btn${active}" data-set="${esc(s.name)}">${esc(s.name)} (${s.cards.length})</button>`;
  }).join('');

  sessSetBar.querySelectorAll('.sess-chip-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const setName = btn.dataset.set;
      session.activeSet = session.product.sets.find(s => s.name === setName) || null;
      sessSetBar.querySelectorAll('.sess-chip-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderSessionParallelBar();
      renderSessionCards();
    });
  });
}

function renderSessionCards() {
  if (!session.activeSet) {
    sessCardList.innerHTML = '<div class="empty-state"><p>Select a set above.</p></div>';
    return;
  }

  // Check if any selected parallels exist in this set
  const availableParallels = session.activeSet.parallels.filter(
    p => session.selectedParallels.includes(p.name)
  );
  if (!availableParallels.length) {
    sessCardList.innerHTML = '<div class="empty-state"><p>None of your selected parallels exist in this set.</p></div>';
    return;
  }

  const query = sessCardSearch.value.toLowerCase().trim();
  let cards = session.activeSet.cards;
  if (query) {
    cards = cards.filter(c =>
      c.player.toLowerCase().includes(query) ||
      c.number.toLowerCase().includes(query) ||
      c.team.toLowerCase().includes(query) ||
      (c.card_name && c.card_name.toLowerCase().includes(query))
    );
  }

  if (!cards.length) {
    sessCardList.innerHTML = query
      ? `<div class="empty-state"><p>No cards matching "${esc(query)}"</p></div>`
      : '<div class="empty-state"><p>No cards in this set.</p></div>';
    return;
  }

  // Build a count map for badges: key = "setName|cardNumber"
  const countMap = {};
  session.entries.forEach(e => {
    const key = e.set + '|' + e.card_number;
    countMap[key] = (countMap[key] || 0) + 1;
  });

  sessCardList.innerHTML = cards.map(c => {
    const key = session.activeSet.name + '|' + c.number;
    const count = countMap[key] || 0;
    const displayName = c.player || c.card_name || '(no player)';
    return `
      <div class="sess-card" data-number="${esc(c.number)}">
        <span class="card-num">${esc(c.number)}</span>
        <div class="card-info">
          <div class="card-player">${esc(displayName)}</div>
          <div class="card-team">${esc(c.team)}</div>
        </div>
        ${c.sp ? '<span class="card-sp">SP</span>' : ''}
        ${c.rookie ? '<span class="card-rc">RC</span>' : ''}
        ${count > 0 ? `<span class="sess-card-badge">${count}</span>` : ''}
      </div>`;
  }).join('');

  // Wire tap and long-press
  sessCardList.querySelectorAll('.sess-card').forEach(el => {
    const num = el.dataset.number;
    const card = session.activeSet.cards.find(c => c.number === num);
    if (!card) return;

    let longPressFired = false;

    // Tap = instant add (click fires after touchend)
    el.addEventListener('click', (e) => {
      if (longPressFired) { e.preventDefault(); return; }
      onSessionCardTap(card);
    });

    // Long-press = open full add sheet
    el.addEventListener('touchstart', () => {
      longPressFired = false;
      sessLongPressTimer = setTimeout(() => {
        longPressFired = true;
        sessLongPressTimer = null;
        onSessionCardLongPress(card);
      }, 500);
    }, { passive: true });

    el.addEventListener('touchend', () => {
      if (sessLongPressTimer) { clearTimeout(sessLongPressTimer); sessLongPressTimer = null; }
    });

    el.addEventListener('touchmove', () => {
      if (sessLongPressTimer) { clearTimeout(sessLongPressTimer); sessLongPressTimer = null; }
      longPressFired = false;
    });
  });
}

async function onSessionCardTap(card) {
  if (!session.active || !session.activeSet) return;

  const entry = {
    action: 'add',
    product: session.product.name,
    set: session.activeSet.name,
    card_number: card.number,
    parallel: session.activeParallel,
    player: card.player,
    team: card.team,
    quantity: 1,
    serial_number: null,
    grade: null,
    notes: null,
    tags: { location: session.location },
    added_at: new Date().toISOString(),
  };

  const id = await addPending(entry);
  entry.id = id;
  pendingList.push(entry);

  session.entries.push({
    card_number: card.number,
    set: session.activeSet.name,
    parallel: session.activeParallel,
    id: id,
  });

  // Update UI
  updatePendingBadge();
  sessCountLabel.textContent = session.entries.length + ' added';
  undoBtn.style.display = 'block';

  // Update the badge on this card's row without re-rendering everything
  const row = sessCardList.querySelector(`.sess-card[data-number="${CSS.escape(card.number)}"]`);
  if (row) {
    const key = session.activeSet.name + '|' + card.number;
    const count = session.entries.filter(e => e.set + '|' + e.card_number === key).length;
    let badge = row.querySelector('.sess-card-badge');
    if (badge) {
      badge.textContent = count;
    } else {
      badge = document.createElement('span');
      badge.className = 'sess-card-badge';
      badge.textContent = count;
      row.appendChild(badge);
    }
    // Tap-flash
    row.classList.remove('just-added');
    void row.offsetWidth; // force reflow to restart animation
    row.classList.add('just-added');
    setTimeout(() => row.classList.remove('just-added'), 400);
  }
}

function onSessionCardLongPress(card) {
  if (!session.active || !session.activeSet) return;

  sessSheetContext = { card, set: session.activeSet };

  selectedCard = card;
  sheetTitle.textContent = `#${card.number} ${card.player || card.card_name || ''}`;
  sheetSubtitle.textContent = `${session.product.name} — ${session.activeSet.name}`;

  // Parallels from current set
  parallelPicker.innerHTML = session.activeSet.parallels.map(p => {
    const selected = p.name === session.activeParallel ? ' selected' : '';
    const style = p.color_hex ? `border-color:${p.color_hex}` : '';
    return `<div class="tag-chip${selected}" data-value="${esc(p.name)}" style="${style}">${esc(p.name)}${p.serial_numbered ? ' /' + p.serial_numbered : ''}</div>`;
  }).join('');
  wireTagGroup(parallelPicker);

  qtyInput.value = 1;
  serialInput.value = '';
  gradeSelect.value = '';
  notesInput.value = '';

  // Tags — pre-select session location
  buildTagPicker(locationPicker, catalog.tags.location || []);
  preselectTag(locationPicker, session.location);
  buildTagPicker(pricePicker, catalog.tags.price_bucket || []);
  buildTagPicker(statusPicker, catalog.tags.status || []);

  // Hide lock buttons in session context (they only apply to browse mode)
  document.querySelectorAll('.lock-btn').forEach(b => b.style.display = 'none');
  $('unlockAllBtn').style.display = 'none';

  sheetOverlay.classList.add('visible');
  requestAnimationFrame(() => addSheet.classList.add('visible'));
}

async function undoLastSessionAdd() {
  if (!session.entries.length) return;

  const last = session.entries.pop();
  await deletePending(last.id);
  pendingList = pendingList.filter(e => e.id !== last.id);

  updatePendingBadge();
  sessCountLabel.textContent = session.entries.length + ' added';
  if (!session.entries.length) undoBtn.style.display = 'none';

  renderSessionCards();
}

// ── Locked Fields ──
function getCurrentFieldValue(field) {
  switch (field) {
    case 'parallel': return getSelected(parallelPicker);
    case 'grade': return gradeSelect.value;
    case 'location': return getSelected(locationPicker);
    case 'price_bucket': return getSelected(pricePicker);
    case 'status': return getSelected(statusPicker);
    default: return '';
  }
}

function toggleFieldLock(field, btn) {
  if (lockedFields[field] !== null) {
    lockedFields[field] = null;
    btn.textContent = '\u{1F513}';
    btn.classList.remove('locked');
  } else {
    lockedFields[field] = { value: getCurrentFieldValue(field) };
    btn.textContent = '\u{1F512}';
    btn.classList.add('locked');
  }
  updateLockedVisuals();
}

function updateLockButtons() {
  document.querySelectorAll('.lock-btn').forEach(btn => {
    const field = btn.dataset.field;
    if (lockedFields[field] !== null) {
      btn.textContent = '\u{1F512}';
      btn.classList.add('locked');
    } else {
      btn.textContent = '\u{1F513}';
      btn.classList.remove('locked');
    }
  });
}

function updateLockedVisuals() {
  const anyLocked = Object.values(lockedFields).some(v => v !== null);
  $('unlockAllBtn').style.display = anyLocked ? 'block' : 'none';
  parallelPicker.classList.toggle('field-locked', lockedFields.parallel !== null);
  gradeSelect.classList.toggle('field-locked', lockedFields.grade !== null);
  locationPicker.classList.toggle('field-locked', lockedFields.location !== null);
  pricePicker.classList.toggle('field-locked', lockedFields.price_bucket !== null);
  statusPicker.classList.toggle('field-locked', lockedFields.status !== null);
}

function unlockAllFields() {
  Object.keys(lockedFields).forEach(k => { lockedFields[k] = null; });
  updateLockButtons();
  updateLockedVisuals();
}

function preselectTag(container, value) {
  container.querySelectorAll('.tag-chip').forEach(c => c.classList.remove('selected'));
  const target = container.querySelector(`.tag-chip[data-value="${CSS.escape(value)}"]`);
  if (target) target.classList.add('selected');
}

// ── Toast ──
function showToast(msg, duration = 2000) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('visible');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('visible'), duration);
}

// ── Export Filename ──
function generateExportFilename(count) {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toTimeString().slice(0, 5).replace(':', '');
  return `cards_${date}_${time}_${count}ch.json`;
}

// ── Helpers ──
function esc(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ── Boot ──
init();
