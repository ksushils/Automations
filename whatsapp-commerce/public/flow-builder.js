// Drag-and-drop WhatsApp flow builder (no dependencies).
// Usage: openFlowBuilder({ root, flow, api, onClose, products })
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const TYPES = {
    message: { icon: '💬', label: 'Text + buttons', color: '#128c4a', make: () => ({ text: 'Hi {{name}}! How can we help?', buttons: [] }) },
    media: { icon: '🖼️', label: 'Media + buttons', color: '#0f7b8a', base: 'message', make: () => ({ text: 'Caption', image: 'https://', buttons: [] }) },
    list: { icon: '📋', label: 'List menu', color: '#3d6fd1', make: () => ({ text: 'Choose an option 👇', button: 'Options', rows: [{ title: 'Option 1' }, { title: 'Option 2' }] }) },
    question: { icon: '❓', label: 'Ask a question', color: '#8a5cd1', make: () => ({ text: "What's your email?", save: 'email', validate: 'email' }) },
    product: { icon: '🛍️', label: 'Single product', color: '#c46a12', make: () => ({ productId: '' }) },
    products: { icon: '🛒', label: 'Multi product', color: '#c46a12', make: () => ({ text: 'Our bestsellers 👇', productIds: [], category: '' }) },
    template: { icon: '⚡', label: 'Template', color: '#b5470b', make: () => ({ name: '', language: 'en_GB' }) },
    form: { icon: '📝', label: 'WhatsApp form', color: '#8a5cd1', make: () => ({ text: 'Please fill in this short form 👇', flowId: '', cta: 'Open form', screen: '' }) },
    tag: { icon: '🏷️', label: 'Add / remove tag', color: '#5d6b63', make: () => ({ add: ['lead'], remove: [] }) },
    delay: { icon: '⏱️', label: 'Wait', color: '#5d6b63', make: () => ({ minutes: 60 }) },
    webhook: { icon: '🔗', label: 'Send to webhook', color: '#5d6b63', make: () => ({ url: 'https://' }) },
    handover: { icon: '🙋', label: 'Talk to human', color: '#c0392b', make: () => ({ text: '' }) },
    action: { icon: '🏪', label: 'Open shop menu', color: '#128c4a', make: () => ({ action: 'menu' }) },
    end: { icon: '⏹️', label: 'End', color: '#5d6b63', make: () => ({}) },
  };
  const ACTIONS = [['menu', 'Main menu'], ['browse', 'Browse categories'], ['cart', 'View cart'], ['checkout', 'Checkout'], ['status', 'Order status']];

  // Which outputs a node has: [{ key, label }] – key "next" or "b:<i>" / "r:<i>"
  function outputs(s) {
    if (s.type === 'message') return s.buttons?.length ? s.buttons.map((b, i) => ({ key: `b:${i}`, label: b.title || `Button ${i + 1}` })) : [{ key: 'next', label: 'Next' }];
    if (s.type === 'list') return (s.rows || []).map((r, i) => ({ key: `r:${i}`, label: r.title || `Row ${i + 1}` }));
    if (['question', 'tag', 'delay', 'webhook', 'template', 'form'].includes(s.type)) return [{ key: 'next', label: s.type === 'form' ? 'After submit' : 'Next' }];
    return [];
  }
  const getLink = (s, key) => (key === 'next' ? s.next : key.startsWith('b:') ? s.buttons?.[+key.slice(2)]?.goto : s.rows?.[+key.slice(2)]?.goto);
  function setLink(s, key, target) {
    if (key === 'next') s.next = target;
    else if (key.startsWith('b:')) s.buttons[+key.slice(2)].goto = target;
    else s.rows[+key.slice(2)].goto = target;
  }
  function preview(s) {
    switch (s.type) {
      case 'message': return (s.image && s.image !== 'https://' ? '🖼️ ' : '') + (s.text || '');
      case 'list': return s.text;
      case 'question': return `${s.text}\n→ saves to “${s.save}”`;
      case 'product': return s.productId ? `Product: ${s.productId}` : 'Choose a product';
      case 'products': return s.category ? `Category: ${s.category}` : `${(s.productIds || []).length} products`;
      case 'template': return s.name || 'Choose a template';
      case 'form': return `${s.text}\n[ ${s.cta || 'Open form'} ]${s.flowId ? '' : ' – set Flow ID'}`;
      case 'tag': return [...(s.add || []).map((t) => '+' + t), ...(s.remove || []).map((t) => '−' + t)].join(' ');
      case 'delay': return `Wait ${s.minutes} min`;
      case 'webhook': return s.url;
      case 'handover': return s.text || 'Pass the chat to the team';
      case 'action': return (ACTIONS.find((a) => a[0] === s.action) || [, s.action])[1];
      default: return '';
    }
  }

  window.openFlowBuilder = function ({ root, flow, api, onClose, products = [], templates = [] }) {
    const f = structuredClone(flow || { name: 'New automation', active: true, triggers: { keywords: ['hi'], match: 'exact', welcome: false, adIds: [], start: null }, steps: [] });
    f.triggers ||= {};
    f.triggers.keywords ||= [];
    // make sure every step has id + position (also upgrades simple list flows)
    let seq = 1;
    const newId = () => { let id; do id = 's' + seq++; while (f.steps.some((x) => x.id === id)); return id; };
    f.steps.forEach((s, i) => { s.id ||= newId(); s.x ??= 340 + (i % 3) * 300; s.y ??= 60 + Math.floor(i / 3) * 260; });
    f.steps.forEach((s, i) => { if (s.next === undefined && outputs(s).some((o) => o.key === 'next') && f.steps[i + 1]) s.next = f.steps[i + 1].id; });
    if (f.triggers.start === undefined || f.triggers.start === null) f.triggers.start = f.steps[0]?.id || null;
    const start = f.triggers.layout || { x: 30, y: 40 };
    let selected = 'start';
    let dirty = false;

    root.innerHTML = `
      <div class="fb">
        <div class="fb-top">
          <button class="btn ghost" data-fb="back">← Back</button>
          <input class="fb-name" value="${esc(f.name)}" aria-label="Flow name">
          <label class="fb-active"><input type="checkbox" ${f.active !== false ? 'checked' : ''}> Active</label>
          <span class="mute fb-status"></span>
          <button class="btn" data-fb="save">Save changes</button>
        </div>
        <div class="fb-body">
          <div class="fb-palette"><div class="fb-h">CONTENTS</div>${Object.entries(TYPES).map(([k, t]) => `<button class="fb-tool" draggable="true" data-type="${k}" title="Drag onto the canvas or click to add"><span>${t.icon}</span>${t.label}</button>`).join('')}</div>
          <div class="fb-canvas-wrap"><div class="fb-canvas"><svg class="fb-edges"></svg></div></div>
          <div class="fb-inspector"></div>
        </div>
      </div>`;
    const $ = (sel) => root.querySelector(sel);
    const canvas = $('.fb-canvas');
    const svg = $('.fb-edges');
    const inspector = $('.fb-inspector');
    const status = (t) => ($('.fb-status').textContent = t);
    const markDirty = () => { dirty = true; status('Unsaved changes'); };

    function nodeHtml(s) {
      const t = TYPES[s.image !== undefined && s.type === 'message' ? 'media' : s.type] || TYPES.end;
      return `<div class="fb-node ${selected === s.id ? 'sel' : ''}" data-id="${esc(s.id)}" style="left:${s.x}px;top:${s.y}px">
        <div class="fb-node-h" style="border-left-color:${t.color}"><span>${t.icon} ${esc(t.label)}</span><button class="fb-x" data-del="${esc(s.id)}" title="Delete">✕</button></div>
        <div class="fb-node-b">${esc(preview(s)).replace(/\n/g, '<br>') || '<span class="mute">(empty)</span>'}</div>
        ${outputs(s).map((o) => `<div class="fb-out"><span>${esc(o.label)}</span><span class="fb-port" data-from="${esc(s.id)}" data-key="${esc(o.key)}" title="Drag to connect"></span></div>`).join('')}
        <span class="fb-in" data-in="${esc(s.id)}"></span>
      </div>`;
    }
    function startHtml() {
      const kw = f.triggers.keywords || [];
      return `<div class="fb-node fb-start ${selected === 'start' ? 'sel' : ''}" data-id="start" style="left:${start.x}px;top:${start.y}px">
        <div class="fb-node-h" style="border-left-color:#128c4a"><span>🚀 Flow start</span></div>
        <div class="fb-node-b">${kw.length ? kw.map((k) => `<span class="fb-chip">${esc(k)}</span>`).join('') : '<span class="mute">No keywords</span>'}
          <div class="mute" style="margin-top:4px">${f.triggers.match === 'contains' ? 'Message contains a keyword' : 'Message is exactly a keyword'}${f.triggers.welcome ? ' · first message' : ''}${(f.triggers.adIds || []).length ? ' · ads' : ''}</div></div>
        <div class="fb-out"><span>Start</span><span class="fb-port" data-from="start" data-key="start"></span></div>
      </div>`;
    }

    function portPos(el) {
      const c = canvas.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return { x: r.left - c.left + r.width / 2, y: r.top - c.top + r.height / 2 };
    }
    function drawEdges(temp) {
      const paths = [];
      root.querySelectorAll('.fb-port').forEach((p) => {
        const from = p.dataset.from, key = p.dataset.key;
        const target = from === 'start' ? f.triggers.start : getLink(f.steps.find((s) => s.id === from), key);
        const inEl = target && root.querySelector(`.fb-in[data-in="${CSS.escape(String(target))}"]`);
        if (!inEl) return;
        const a = portPos(p), b = portPos(inEl);
        const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
        paths.push(`<path d="M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}" class="fb-edge"/><circle cx="${b.x}" cy="${b.y}" r="4" class="fb-edge-dot"/>`);
      });
      if (temp) paths.push(`<path d="M${temp.a.x},${temp.a.y} C${temp.a.x + 60},${temp.a.y} ${temp.b.x - 60},${temp.b.y} ${temp.b.x},${temp.b.y}" class="fb-edge temp"/>`);
      svg.innerHTML = paths.join('');
    }
    function render() {
      canvas.querySelectorAll('.fb-node').forEach((n) => n.remove());
      canvas.insertAdjacentHTML('beforeend', startHtml() + f.steps.map(nodeHtml).join(''));
      const maxX = Math.max(1200, ...f.steps.map((s) => s.x + 400)), maxY = Math.max(900, ...f.steps.map((s) => s.y + 400));
      canvas.style.width = maxX + 'px';
      canvas.style.height = maxY + 'px';
      svg.setAttribute('width', maxX);
      svg.setAttribute('height', maxY);
      requestAnimationFrame(() => drawEdges());
      renderInspector();
    }

    // ---------- inspector ----------
    const field = (label, html) => `<label>${label}</label>${html}`;
    function renderInspector() {
      if (selected === 'start') {
        inspector.innerHTML = `<h3>🚀 Flow start</h3>
          ${field('Keywords (comma separated)', `<input data-i="keywords" value="${esc((f.triggers.keywords || []).join(', '))}">`)}
          ${field('Match', `<select data-i="match"><option value="exact" ${f.triggers.match !== 'contains' ? 'selected' : ''}>Message is exactly a keyword</option><option value="contains" ${f.triggers.match === 'contains' ? 'selected' : ''}>Message contains a keyword</option></select>`)}
          ${field('Also start on a customer’s first ever message', `<select data-i="welcome"><option value="false">No</option><option value="true" ${f.triggers.welcome ? 'selected' : ''}>Yes</option></select>`)}
          ${field('Click-to-WhatsApp ad IDs (comma) – start when someone comes from these ads', `<input data-i="adIds" value="${esc((f.triggers.adIds || []).join(', '))}">`)}
          <p class="mute">Drag from the ● on a block to another block to connect them. Variables: {{name}}, {{phone}}, {{attr.email}}.</p>`;
      } else {
        const s = f.steps.find((x) => x.id === selected);
        if (!s) { inspector.innerHTML = '<p class="mute">Select a block</p>'; return; }
        const t = TYPES[s.image !== undefined && s.type === 'message' ? 'media' : s.type];
        let h = `<h3>${t.icon} ${t.label}</h3>`;
        if (s.type === 'form') h += field('Message text', `<textarea data-i="text">${esc(s.text)}</textarea>`) + field('Flow ID (WhatsApp Manager → Flows)', `<input data-i="flowId" value="${esc(s.flowId)}">`) + field('Button label', `<input data-i="cta" value="${esc(s.cta)}" maxlength="20">`) + field('First screen ID (optional)', `<input data-i="screen" value="${esc(s.screen || '')}">`) + '<p class="mute">Build the form in Meta’s Flow builder and publish it. Every field the customer submits is saved to the contact (e.g. {{attr.date}}).</p>';
        if (['message', 'list', 'question', 'products', 'handover'].includes(s.type)) h += field(s.type === 'handover' ? 'Message (optional)' : 'Message text', `<textarea data-i="text">${esc(s.text)}</textarea>`);
        if (s.type === 'message' && s.image !== undefined) h += field('Image URL', `<input data-i="image" value="${esc(s.image)}">`);
        if (s.type === 'message') h += `<label>Buttons (max 3 – each can lead somewhere different)</label>${(s.buttons || []).map((b, i) => `<div class="fb-rowedit"><input data-btn="${i}" value="${esc(b.title)}" maxlength="20"><button class="btn ghost" data-rmbtn="${i}">✕</button></div>`).join('')}${(s.buttons || []).length < 3 ? '<button class="btn ghost" data-addbtn>+ Add button</button>' : ''}`;
        if (s.type === 'list') h += field('Menu button label', `<input data-i="button" value="${esc(s.button)}" maxlength="20">`) + `<label>Rows (max 10)</label>${(s.rows || []).map((r, i) => `<div class="fb-rowedit"><input data-row="${i}" value="${esc(r.title)}" maxlength="24" placeholder="Title"><input data-rowd="${i}" value="${esc(r.description || '')}" maxlength="72" placeholder="Description"><button class="btn ghost" data-rmrow="${i}">✕</button></div>`).join('')}${(s.rows || []).length < 10 ? '<button class="btn ghost" data-addrow>+ Add row</button>' : ''}`;
        if (s.type === 'question') h += field('Save answer as', `<input data-i="save" value="${esc(s.save)}" placeholder="email, name, budget…">`) + field('Validate', `<select data-i="validate">${['any', 'email', 'number', 'phone'].map((v) => `<option ${s.validate === v ? 'selected' : ''}>${v}</option>`).join('')}</select>`);
        if (s.type === 'product') h += field('Product', products.length ? `<select data-i="productId"><option value="">Choose…</option>${products.map((p) => `<option value="${esc(p.id)}" ${String(s.productId) === String(p.id) ? 'selected' : ''}>${esc(p.title)}</option>`).join('')}</select>` : `<input data-i="productId" value="${esc(s.productId)}" placeholder="Product ID">`);
        if (s.type === 'products') h += field('Category ID (or leave empty and pick products)', `<input data-i="category" value="${esc(s.category || '')}">`) + field('Product IDs (comma)', `<input data-i="productIds" value="${esc((s.productIds || []).join(', '))}">`) + (products.length ? `<p class="mute">Products: ${products.slice(0, 30).map((p) => `${esc(p.title)} = <code>${esc(p.id)}</code>`).join(', ')}</p>` : '');
        if (s.type === 'template') h += field('Approved template', templates.length ? `<select data-i="name"><option value="">Choose…</option>${templates.filter((x) => x.status === 'APPROVED').map((x) => `<option ${x.name === s.name ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>` : `<input data-i="name" value="${esc(s.name)}">`) + field('Language', `<input data-i="language" value="${esc(s.language || 'en_GB')}">`);
        if (s.type === 'tag') h += field('Add tags (comma)', `<input data-i="add" value="${esc((s.add || []).join(', '))}">`) + field('Remove tags (comma)', `<input data-i="remove" value="${esc((s.remove || []).join(', '))}">`);
        if (s.type === 'delay') h += field('Wait (minutes)', `<input type="number" min="1" data-i="minutes" value="${esc(s.minutes)}">`) + '<p class="mute">Free-form messages only reach customers within 24h of their last message – use a Template block after long waits.</p>';
        if (s.type === 'webhook') h += field('URL (receives the contact & answers as JSON)', `<input data-i="url" value="${esc(s.url)}">`);
        if (s.type === 'action') h += field('Hand over to', `<select data-i="action">${ACTIONS.map(([k, l]) => `<option value="${k}" ${s.action === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`);
        const outs = outputs(s);
        if (outs.length) h += `<label>Connections</label>${outs.map((o) => { const tg = getLink(s, o.key); const tn = f.steps.find((x) => x.id === tg); return `<div class="mute">${esc(o.label)} → ${tn ? esc(TYPES[tn.type]?.label || tn.type) + ` (${esc(tn.id)})` : 'not connected'} ${tg ? `<button class="btn ghost" data-unlink="${esc(o.key)}">unlink</button>` : ''}</div>`; }).join('')}`;
        h += `<p><button class="btn ghost" data-dup>Duplicate</button> <button class="btn ghost" data-del="${esc(s.id)}">Delete block</button></p>`;
        inspector.innerHTML = h;
      }
    }
    const csv = (v) => String(v).split(',').map((x) => x.trim()).filter(Boolean);
    inspector.addEventListener('input', (e) => {
      const el = e.target;
      if (selected === 'start') {
        const k = el.dataset.i;
        if (k === 'keywords') f.triggers.keywords = csv(el.value.toLowerCase());
        if (k === 'adIds') f.triggers.adIds = csv(el.value);
        if (k === 'match') f.triggers.match = el.value;
        if (k === 'welcome') f.triggers.welcome = el.value === 'true';
      } else {
        const s = f.steps.find((x) => x.id === selected);
        const k = el.dataset.i;
        if (k) s[k] = ['add', 'remove', 'productIds'].includes(k) ? csv(el.value) : k === 'minutes' ? Number(el.value) : el.value;
        if (el.dataset.btn !== undefined) s.buttons[+el.dataset.btn].title = el.value;
        if (el.dataset.row !== undefined) s.rows[+el.dataset.row].title = el.value;
        if (el.dataset.rowd !== undefined) s.rows[+el.dataset.rowd].description = el.value;
      }
      markDirty();
      const id = selected;
      const node = canvas.querySelector(`.fb-node[data-id="${CSS.escape(id)}"]`);
      if (node) {
        const tmp = document.createElement('div');
        tmp.innerHTML = id === 'start' ? startHtml() : nodeHtml(f.steps.find((x) => x.id === id));
        node.replaceWith(tmp.firstElementChild);
        drawEdges();
      }
    });
    inspector.addEventListener('change', (e) => { if (e.target.tagName === 'SELECT') renderInspector(); });
    inspector.addEventListener('click', (e) => {
      const s = f.steps.find((x) => x.id === selected);
      const b = e.target.closest('button');
      if (!b || !s && selected !== 'start') return;
      if (b.hasAttribute('data-addbtn')) { (s.buttons ||= []).push({ title: `Option ${s.buttons.length + 1}` }); delete s.next; }
      else if (b.dataset.rmbtn !== undefined) { s.buttons.splice(+b.dataset.rmbtn, 1); }
      else if (b.hasAttribute('data-addrow')) (s.rows ||= []).push({ title: `Option ${s.rows.length + 1}` });
      else if (b.dataset.rmrow !== undefined) s.rows.splice(+b.dataset.rmrow, 1);
      else if (b.dataset.unlink) setLink(s, b.dataset.unlink, undefined);
      else if (b.hasAttribute('data-dup')) { const c = structuredClone(s); c.id = newId(); c.x += 40; c.y += 40; delete c.next; (c.buttons || []).forEach((x) => delete x.goto); (c.rows || []).forEach((x) => delete x.goto); f.steps.push(c); selected = c.id; }
      else if (b.dataset.del) return removeNode(b.dataset.del);
      else return;
      markDirty();
      render();
    });

    function addNode(type, x, y) {
      const def = TYPES[type];
      const s = { id: newId(), type: def.base || type, ...def.make(), x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) };
      f.steps.push(s);
      if (!f.triggers.start) f.triggers.start = s.id;
      selected = s.id;
      markDirty();
      render();
    }
    function removeNode(id) {
      f.steps = f.steps.filter((s) => s.id !== id);
      for (const s of f.steps) {
        if (s.next === id) delete s.next;
        (s.buttons || []).forEach((b) => b.goto === id && delete b.goto);
        (s.rows || []).forEach((r) => r.goto === id && delete r.goto);
      }
      if (f.triggers.start === id) f.triggers.start = null;
      selected = 'start';
      markDirty();
      render();
    }

    // ---------- palette: click or drag to add ----------
    root.querySelectorAll('.fb-tool').forEach((b) => {
      b.addEventListener('click', () => {
        // place in free space: below the lowest block in the visible column
        const wrap = $('.fb-canvas-wrap');
        const x = wrap.scrollLeft + Math.min(320, Math.max(20, wrap.clientWidth - 260));
        let y = wrap.scrollTop + 40;
        root.querySelectorAll('.fb-node').forEach((n) => {
          const nx = parseFloat(n.style.left), ny = parseFloat(n.style.top);
          if (nx < x + 240 && nx + 240 > x) y = Math.max(y, ny + n.offsetHeight + 30);
        });
        addNode(b.dataset.type, x, y);
        requestAnimationFrame(() => { const el = canvas.querySelector('.fb-node.sel'); el?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); });
      });
      b.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/fb-type', b.dataset.type));
    });
    canvas.addEventListener('dragover', (e) => e.preventDefault());
    canvas.addEventListener('drop', (e) => {
      const type = e.dataTransfer.getData('text/fb-type');
      if (!type) return;
      e.preventDefault();
      const c = canvas.getBoundingClientRect();
      addNode(type, e.clientX - c.left - 120, e.clientY - c.top - 20);
    });

    // ---------- moving nodes & connecting ports ----------
    let drag = null;
    canvas.addEventListener('pointerdown', (e) => {
      const port = e.target.closest('.fb-port');
      const del = e.target.closest('[data-del]');
      if (del) { e.stopPropagation(); return removeNode(del.dataset.del); }
      const node = e.target.closest('.fb-node');
      const c = canvas.getBoundingClientRect();
      if (port) {
        drag = { kind: 'link', from: port.dataset.from, key: port.dataset.key, a: portPos(port) };
        canvas.setPointerCapture(e.pointerId);
        e.preventDefault();
        return;
      }
      if (node) {
        const id = node.dataset.id;
        if (selected !== id) { selected = id; root.querySelectorAll('.fb-node').forEach((n) => n.classList.toggle('sel', n.dataset.id === id)); renderInspector(); }
        if (!e.target.closest('.fb-node-h')) return;
        const obj = id === 'start' ? start : f.steps.find((s) => s.id === id);
        drag = { kind: 'move', node, obj, dx: e.clientX - c.left - obj.x, dy: e.clientY - c.top - obj.y };
        canvas.setPointerCapture(e.pointerId);
        e.preventDefault();
      }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const c = canvas.getBoundingClientRect();
      const x = e.clientX - c.left, y = e.clientY - c.top;
      if (drag.kind === 'move') {
        drag.obj.x = Math.max(0, Math.round(x - drag.dx));
        drag.obj.y = Math.max(0, Math.round(y - drag.dy));
        drag.node.style.left = drag.obj.x + 'px';
        drag.node.style.top = drag.obj.y + 'px';
        drag.moved = true;
        drawEdges();
      } else drawEdges({ a: drag.a, b: { x, y } });
    });
    canvas.addEventListener('pointerup', (e) => {
      if (!drag) return;
      const d = drag;
      drag = null;
      if (d.kind === 'move') { if (d.moved) markDirty(); return render(); }
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.fb-node');
      const tid = target?.dataset.id;
      if (tid && tid !== 'start' && tid !== d.from) {
        if (d.from === 'start') f.triggers.start = tid;
        else setLink(f.steps.find((s) => s.id === d.from), d.key, tid);
        markDirty();
      }
      render();
    });

    // ---------- top bar ----------
    $('.fb-name').addEventListener('input', (e) => { f.name = e.target.value; markDirty(); });
    $('.fb-active input').addEventListener('change', (e) => { f.active = e.target.checked; markDirty(); });
    root.querySelector('[data-fb="back"]').onclick = () => { if (!dirty || confirm('Discard unsaved changes?')) onClose(); };
    root.querySelector('[data-fb="save"]').onclick = async () => {
      f.triggers.layout = { x: start.x, y: start.y };
      status('Saving…');
      try {
        const saved = await api(f.id ? 'PUT' : 'POST', f.id ? `/flows/${f.id}` : '/flows', f);
        f.id = saved.flow.id;
        dirty = false;
        status('✅ Saved');
      } catch (e) { status('⚠️ ' + e.message); }
    };
    render();
  };

  // Ready-made flows to start from
  window.FLOW_PRESETS = [
    { name: 'Welcome menu', triggers: { keywords: ['hi', 'hello', 'help'], match: 'exact', welcome: true }, steps: [
      { id: 's1', type: 'message', text: 'Hi {{name}} 👋 Welcome! What would you like to do?', buttons: [{ title: '🛍️ Shop now', goto: 's2' }, { title: '📦 Track order', goto: 's3' }, { title: '🙋 Talk to us', goto: 's4' }], x: 320, y: 40 },
      { id: 's2', type: 'action', action: 'browse', x: 620, y: 20 }, { id: 's3', type: 'action', action: 'status', x: 620, y: 160 }, { id: 's4', type: 'handover', text: '', x: 620, y: 300 }] },
    { name: 'Lead capture', triggers: { keywords: ['quote', 'wholesale', 'enquiry'], match: 'contains' }, steps: [
      { id: 's1', type: 'question', text: "Great! What's your name?", save: 'name', validate: 'any', next: 's2', x: 320, y: 40 },
      { id: 's2', type: 'question', text: 'Thanks {{name}}! Your email?', save: 'email', validate: 'email', next: 's3', x: 620, y: 40 },
      { id: 's3', type: 'list', text: 'What are you interested in?', button: 'Choose', rows: [{ title: 'Wholesale', goto: 's4' }, { title: 'Custom order', goto: 's4' }, { title: 'Something else', goto: 's4' }], x: 320, y: 240 },
      { id: 's4', type: 'tag', add: ['lead'], next: 's5', x: 620, y: 240 },
      { id: 's5', type: 'handover', text: 'Thanks {{name}}! Our team will get back to you shortly 🙌', x: 620, y: 400 }] },
    { name: 'Opening hours FAQ', triggers: { keywords: ['hours', 'open', 'opening'], match: 'contains' }, steps: [
      { id: 's1', type: 'message', text: '🕘 We are open Mon–Sat 9am–6pm. Order on WhatsApp any time!', buttons: [{ title: '🛍️ Shop now', goto: 's2' }], x: 320, y: 40 }, { id: 's2', type: 'action', action: 'browse', x: 620, y: 40 }] },
  ];
})();
