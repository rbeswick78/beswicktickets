/* srm/util.js — small, app-state-free helpers for the SRM game board (Phase 5).
 *
 * Pure / DOM-only utilities with no dependency on the shared state object or any feature module,
 * so this is a leaf module that imports nothing. */

// Debug logging — flip DEBUG to true to enable verbose console output.
export const DEBUG = false;
export function dbg(...args) { if (DEBUG) console.log(...args); }

/** Helper: Promise-based delay */
export function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Stable id per batch so the server can dedupe a retried send (Phase 3.3 idempotency). uuid where
// available (secure contexts), with a best-effort fallback so non-secure dev origins still work.
export function makeBatchId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return `b-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Show a toast notification
 * @param {string} message
 * @param {string} type 'error' | 'success' | 'info'
 */
export function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;

    container.appendChild(toast);

    // Remove after 3 seconds
    setTimeout(() => {
        toast.style.animation = 'toastOut 0.3s forwards';
        toast.addEventListener('animationend', () => {
            toast.remove();
        });
    }, 3000);
}
