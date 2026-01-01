document.addEventListener('DOMContentLoaded', () => {
  const addUserModal = document.getElementById('add-user-modal');
  const createUserForm = document.getElementById('create-user-form');
  const openAddUserModalBtn = document.getElementById('open-add-user-modal');

  // Open the modal when the "Add User" button is clicked
  openAddUserModalBtn.addEventListener('click', () => {
    addUserModal.classList.remove('hidden');
    addUserModal.classList.add('show');
  });

  // Close the modal when clicking outside of the modal content
  window.addEventListener('click', (event) => {
    if (event.target === addUserModal) {
      addUserModal.classList.add('hidden');
      addUserModal.classList.remove('show');
      createUserForm.reset();
    }
  });

  // Handle form submission
  createUserForm.addEventListener('submit', function(event) {
    event.preventDefault();

    const formData = new FormData(this);
    const data = {
      username: formData.get('username'),
      password: formData.get('password'),
      role: formData.get('role')
    };

    fetch('/users/create-user', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    })
    .then(response => response.text())
    .then(message => {
      // alert(message);
      addUserModal.classList.add('hidden');
      addUserModal.classList.remove('show');
      this.reset();
    })
    .catch(err => console.error('Error creating user:', err));
  });
});