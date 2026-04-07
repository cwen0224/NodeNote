class ConnectionNamingDialog {
  constructor() {
    this.popup = null;
    this.closeHandler = null;
    this.outsideClickHandler = null;
  }

  open({
    x,
    y,
    initialKey = '',
    historyNames = [],
    onConfirm,
  }) {
    this.close();

    const popup = document.createElement('div');
    popup.id = 'naming-popup';
    popup.className = 'glass-panel';
    popup.style.left = `${x}px`;
    popup.style.top = `${y}px`;

    const historyHtml = Array.from(historyNames)
      .map((name) => `<div class="history-item">${name}</div>`)
      .join('');

    popup.innerHTML = `
      <div style="font-size:0.8rem; margin-bottom:4px; opacity:0.7;">連線名稱 (Key)</div>
      <input type="text" id="naming-input" placeholder="例如: next, trigger..." autofocus>
      <div class="history-list">${historyHtml}</div>
    `;

    document.body.appendChild(popup);
    const input = popup.querySelector('#naming-input');
    input.value = String(initialKey ?? '');
    input.focus();
    input.select();

    const confirm = (name) => {
      const trimmed = String(name ?? '').trim();
      if (trimmed) {
        onConfirm?.(trimmed);
      }
      this.close();
    };

    this.closeHandler = (event) => {
      if (event.key === 'Enter') {
        confirm(input.value);
      }
      if (event.key === 'Escape') {
        this.close();
      }
    };

    input.addEventListener('keydown', this.closeHandler);

    popup.querySelectorAll('.history-item').forEach((item) => {
      item.addEventListener('click', () => confirm(item.innerText));
    });

    this.outsideClickHandler = (event) => {
      if (!popup.contains(event.target)) {
        this.close();
      }
    };

    setTimeout(() => document.addEventListener('mousedown', this.outsideClickHandler), 10);
    this.popup = popup;
  }

  close() {
    if (this.popup) {
      const input = this.popup.querySelector('#naming-input');
      if (input && this.closeHandler) {
        input.removeEventListener('keydown', this.closeHandler);
      }
      this.popup.remove();
      this.popup = null;
    }

    if (this.outsideClickHandler) {
      document.removeEventListener('mousedown', this.outsideClickHandler);
      this.outsideClickHandler = null;
    }

    this.closeHandler = null;
  }
}

export const connectionNamingDialog = new ConnectionNamingDialog();
