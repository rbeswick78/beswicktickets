document.addEventListener('DOMContentLoaded', () => {
  const removeTicketModal = document.getElementById('remove-ticket-modal');
  const removeTicketsForm = document.getElementById('remove-tickets-form');
  const modalTitle = document.getElementById('remove-tickets-title');

  // Open the modal function
  window.openRemoveTicketsModal = (userId, username) => {
    removeTicketModal.classList.remove('hidden');
    removeTicketModal.classList.add('show');
    removeTicketsForm.dataset.userId = userId;
    modalTitle.textContent = `Remove tickets from ${username}`;
  };

  // Close the modal and reset the title
  window.addEventListener('click', (event) => {
    if (event.target === removeTicketModal) {
      removeTicketModal.classList.add('hidden');
      removeTicketModal.classList.remove('show');
      removeTicketsForm.reset();
      modalTitle.textContent = 'Remove Tickets';
    }
  });

  removeTicketsForm.addEventListener('submit', function(event) {
    event.preventDefault();
    const userId = this.dataset.userId;
    const formData = new FormData(this);
    const data = {
      userId: userId,
      quantity: parseInt(formData.get('quantity'), 10),
      reason: formData.get('reason')
    };

    fetch('/api/users/remove-tickets', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    })
    .then(response => response.text())
    .then(message => {
      // alert(message);
      removeTicketModal.classList.add('hidden');
      removeTicketModal.classList.remove('show');
      this.reset();
    })
    .catch(err => console.error('Error removing tickets:', err));
  });
});