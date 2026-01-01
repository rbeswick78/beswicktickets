document.addEventListener('DOMContentLoaded', () => {
  const ticketModal = document.getElementById('ticket-modal');
  const addTicketsForm = document.getElementById('add-tickets-form');
  const modalTitle = document.getElementById('add-tickets-title');

  // Open the modal function
  window.openAddTicketsModal = (userId, username) => {
    ticketModal.classList.remove('hidden');
    ticketModal.classList.add('show');
    addTicketsForm.dataset.userId = userId;
    modalTitle.textContent = `Add tickets to ${username}`;
  };

  // Close the modal and reset the title
  window.addEventListener('click', (event) => {
    if (event.target === ticketModal) {
      ticketModal.classList.add('hidden');
      ticketModal.classList.remove('show');
      addTicketsForm.reset();
      modalTitle.textContent = 'Add Tickets';
    }
  });

  addTicketsForm.addEventListener('submit', function(event) {
    event.preventDefault();
    const userId = this.dataset.userId;
    const formData = new FormData(this);
    const data = {
      userId: userId,
      quantity: parseInt(formData.get('quantity')),
      reason: formData.get('reason')
    };

    fetch('/api/users/add-tickets', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    })
    .then(response => response.text())
    .then(message => {
      // alert(message);
      ticketModal.classList.add('hidden');
      ticketModal.classList.remove('show');
      this.reset();
    })
    .catch(err => console.error('Error adding tickets:', err));
  });
});