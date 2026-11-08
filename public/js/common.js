export async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    if (typeof body === 'string') { opts.headers['Content-Type'] = 'text/csv'; opts.body = body; }
    else { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  }
  const res = await fetch(url, opts);
  if (res.status === 401 && !url.startsWith('/api/login')) {
    location.href = '/login';
    throw new Error('Sesi habis');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

export function toast(msg, isError = false) {
  let box = $('#toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toasts';
    document.body.appendChild(box);
  }
  const t = document.createElement('div');
  t.className = 'toast' + (isError ? ' error' : '');
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => t.remove(), isError ? 6000 : 3000);
}

export async function logout() {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login';
}

// ---------- Dialog buatan sendiri (pengganti confirm/prompt/alert bawaan browser) ----------
// Bawaan browser menampilkan "localhost:3000 says" dan tidak bisa diberi gaya.
function uiDialog({ title, message, input, ok = 'OK', cancel = 'Batal', danger = false, value = '', placeholder = '' }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'ui-dialog';
    d.innerHTML = `
      <form method="dialog">
        ${title ? `<h3 class="ui-title">${esc(title)}</h3>` : ''}
        ${message ? `<div class="ui-msg">${esc(message)}</div>` : ''}
        ${input ? `<input class="ui-input" autocomplete="off" placeholder="${esc(placeholder)}" value="${esc(value)}">` : ''}
        <div class="ui-btns">
          ${cancel !== null ? `<button value="cancel" type="button" class="ui-cancel">${esc(cancel)}</button>` : ''}
          <button value="ok" class="${danger ? 'danger-solid' : 'primary'} ui-ok">${esc(ok)}</button>
        </div>
      </form>`;
    document.body.appendChild(d);
    const field = $('.ui-input', d);
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      d.close();
      d.remove();
      resolve(result);
    };
    $('form', d).addEventListener('submit', (e) => {
      e.preventDefault();
      finish(input ? field.value : true);
    });
    $('.ui-cancel', d)?.addEventListener('click', () => finish(input ? null : false));
    d.addEventListener('cancel', (e) => { e.preventDefault(); finish(input ? null : cancel === null ? true : false); });
    d.showModal();
    (field || $('.ui-ok', d)).focus();
    if (field) field.select();
  });
}

/** Konfirmasi Ya/Batal. danger:true = tombol merah (hapus, kosongkan, dll.) */
export const confirmBox = (message, opts = {}) => uiDialog({ message, ok: 'Ya', ...opts });
/** Minta isian teks. Hasil: teks, atau null kalau dibatalkan. */
export const promptBox = (message, opts = {}) => uiDialog({ message, input: true, ok: 'Simpan', ...opts });
/** Pemberitahuan dengan satu tombol. */
export const alertBox = (message, opts = {}) => uiDialog({ message, cancel: null, ok: 'Tutup', ...opts });
