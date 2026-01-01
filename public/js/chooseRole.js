document.addEventListener('DOMContentLoaded', () => {
  const dealerBtn = document.getElementById('dealer-btn');
  const playerBtn = document.getElementById('player-btn');

  dealerBtn?.addEventListener('click', () => {
    window.location.href = '/srm/dealer';
  });

  playerBtn?.addEventListener('click', () => {
    window.location.href = '/srm/player';
  });
});