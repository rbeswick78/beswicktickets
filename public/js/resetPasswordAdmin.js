document.addEventListener('DOMContentLoaded', () => {
  const resetPasswordModal = document.getElementById('reset-password-modal');
  const resetPasswordForm = document.getElementById('reset-password-form');
  const modalTitle = document.getElementById('reset-password-title');

  // Open the modal function
  window.openResetPasswordModal = (userId, username) => {
    resetPasswordModal.classList.remove('hidden');
    resetPasswordModal.classList.add('show');
    resetPasswordForm.dataset.userId = userId;
    modalTitle.textContent = `Reset Password for ${username}`;
  };

  // Close the modal when clicking outside
  window.addEventListener('click', (event) => {
    if (event.target === resetPasswordModal) {
      resetPasswordModal.classList.add('hidden');
      resetPasswordModal.classList.remove('show');
      resetPasswordForm.reset();
      modalTitle.textContent = 'Reset Password';
    }
  });

  // Handle form submission
  resetPasswordForm.addEventListener('submit', function(event) {
    event.preventDefault();
    const userId = this.dataset.userId;
    const formData = new FormData(this);
    const newPassword = formData.get('newPassword');

    fetch('/api/users/reset-password', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ userId, newPassword })
    })
    .then(response => {
        if (response.ok) {
            return response.text();
        } else {
            return response.text().then(text => { throw new Error(text) });
        }
    })
    .then(message => {
      alert(message);
      resetPasswordModal.classList.add('hidden');
      resetPasswordModal.classList.remove('show');
      this.reset();
    })
    .catch(err => {
        console.error('Error resetting password:', err);
        alert(`Error: ${err.message}`);
    });
  });
});






