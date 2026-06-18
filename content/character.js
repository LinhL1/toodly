// Guard against double injection (e.g. if the script somehow runs twice).
if (!window.__toodlyInjected) {
  window.__toodlyInjected = true;

  const host = document.createElement('div');
  const shadow = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = `
    .btn {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 2147483647;
      width: 48px;
      height: 48px;
      border-radius: 50%;
      background: #fafaf8;
      border: 1px solid rgba(26,26,26,0.18);
      box-shadow: 0 1px 6px rgba(0,0,0,0.07);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      transition: opacity 0.15s;
    }
    .btn:hover { opacity: 0.75; }

    @keyframes toodly-pulse {
      0%   { opacity: 1; }
      35%  { opacity: 0.25; }
      100% { opacity: 1; }
    }
    .btn.pulse .dots {
      animation: toodly-pulse 1.2s ease-in-out;
    }
    @media (prefers-reduced-motion: reduce) {
      .btn.pulse .dots { animation: none; }
    }
  `;

  const btn = document.createElement('button');
  btn.className = 'btn';
  btn.title = 'Toodly';
  // 5-dot cluster mark — abstract, matches the off-white/near-black palette
  btn.innerHTML = `
    <svg class="dots" width="22" height="22" viewBox="0 0 22 22"
         fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="11" cy="5"  r="2.1" fill="#1a1a1a"/>
      <circle cx="5"  cy="11" r="2.1" fill="#1a1a1a"/>
      <circle cx="17" cy="11" r="2.1" fill="#1a1a1a"/>
      <circle cx="7"  cy="17" r="2.1" fill="#1a1a1a"/>
      <circle cx="15" cy="17" r="2.1" fill="#1a1a1a"/>
    </svg>
  `;

  btn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'TOODLY_OPEN_PANEL' });
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type !== 'TOODLY_TASK_COMPLETED') return;
    // Restart animation by removing/re-adding the class.
    btn.classList.remove('pulse');
    void btn.offsetWidth; // force reflow so the animation restarts cleanly
    btn.classList.add('pulse');
    btn.addEventListener('animationend', () => btn.classList.remove('pulse'), { once: true });
  });

  shadow.appendChild(style);
  shadow.appendChild(btn);
  document.documentElement.appendChild(host);
}
