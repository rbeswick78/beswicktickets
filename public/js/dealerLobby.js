document.addEventListener('DOMContentLoaded', () => {
  const createGameForm = document.getElementById('create-game-form');
  const newGameResult = document.getElementById('new-game-result');

  createGameForm.addEventListener('submit', (e) => {
    e.preventDefault();
    fetch('/srm/create-game', {
      method: 'POST'
    })
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          newGameResult.textContent =
            'Game created with code ' + data.code + '. Refresh to see it in Active Games.';
        } else {
          newGameResult.textContent = 'Error: ' + (data.error || 'Unknown error');
        }
      })
      .catch(err => {
        newGameResult.textContent = 'Error: ' + err;
      });
  });
});