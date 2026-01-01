  function setViewportHeight() {
    const vh = window.innerHeight * 0.01;
    document.documentElement.style.setProperty('--vh', `${vh}px`);
  }

  setViewportHeight();

  window.addEventListener('resize', setViewportHeight);
  window.addEventListener('orientationchange', setViewportHeight);